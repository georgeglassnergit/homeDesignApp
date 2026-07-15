import * as THREE from 'three';
import { stepWalk, stepLook, lookDir, clampToBounds, levelBoundsXZ, eyeHeight, WALK_SPEED } from './walk.js';

// viewer/walkCamera.js — the THREE-side of the walk-through (S6). It owns NO geometry and
// NO model state: it reads plain {x,z,yaw,pitch} from the pure walk math and writes them onto
// the viewer's existing perspective camera each frame. Orbit vs. walk is pure view state.
//
// While walking, orbit input is disabled and a per-frame hook (registered on the viewer)
// integrates WASD movement + drag-look and aims the camera. Leaving walk restores orbit.
export function createWalkController(viewer, opts = {}) {
  const dom = viewer.renderer.domElement;
  const speed = opts.speed ?? WALK_SPEED;
  const pad = opts.pad ?? 0.4;                 // stay this far off the exterior walls (m)

  const keys = { forward: false, back: false, left: false, right: false };
  let look = { yaw: 0, pitch: 0 };
  let pos = { x: 0, z: 0 };
  let eyeY = eyeHeight(null);
  let bounds = null;
  let active = false;
  let dragging = false, lastX = 0, lastY = 0;
  let lastT = 0;                                // ms timestamp of previous integration
  let removeHook = null;

  const KEY_MAP = {
    KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  };
  const onKeyDown = (e) => { const k = KEY_MAP[e.code]; if (k) { keys[k] = true; e.preventDefault(); } };
  const onKeyUp = (e) => { const k = KEY_MAP[e.code]; if (k) { keys[k] = false; e.preventDefault(); } };

  const onPointerDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; try { dom.setPointerCapture(e.pointerId); } catch { /* headless */ } };
  const onPointerMove = (e) => {
    if (!dragging) return;
    look = stepLook(look, e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
    aim();
  };
  const onPointerUp = (e) => { dragging = false; try { dom.releasePointerCapture(e.pointerId); } catch { /* headless */ } };

  // Point the camera from `pos`/`eyeY` along the current yaw/pitch.
  function aim() {
    viewer.camera.position.set(pos.x, eyeY, pos.z);
    const d = lookDir(look.yaw, look.pitch);
    viewer.camera.lookAt(pos.x + d.x, eyeY + d.y, pos.z + d.z);
  }

  // Advance movement by dt seconds (extracted so the headless harness can step deterministically).
  function integrate(dt) {
    pos = clampToBounds(stepWalk(pos, look.yaw, keys, dt, speed), bounds);
    aim();
  }

  const onFrame = () => {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : lastT + 16;
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt <= 0 || dt > 0.1) dt = 0.016;        // clamp huge/negative gaps (tab-out, first frame)
    integrate(dt);
  };

  // Enter walk mode. `walls` bounds the walker; `start` overrides spawn {x,z,yaw}.
  function enable(walls, level, start = {}) {
    if (active) return;
    active = true;
    bounds = levelBoundsXZ(walls, pad);
    eyeY = eyeHeight(level);
    const b = levelBoundsXZ(walls, 0);
    pos = { x: start.x ?? (b ? (b.minX + b.maxX) / 2 : 0), z: start.z ?? (b ? (b.minZ + b.maxZ) / 2 : 0) };
    pos = clampToBounds(pos, bounds);
    look = { yaw: start.yaw ?? 0, pitch: 0 };
    viewer.controls.enabled = false;
    lastT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    addEventListener('pointerup', onPointerUp);
    removeHook = viewer.onFrame(onFrame);
    aim();
  }

  // Leave walk mode: unwire input, restore orbit control.
  function disable() {
    if (!active) return;
    active = false;
    keys.forward = keys.back = keys.left = keys.right = false;
    dragging = false;
    if (removeHook) { removeHook(); removeHook = null; }
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointermove', onPointerMove);
    removeEventListener('pointerup', onPointerUp);
    viewer.controls.enabled = true;
  }

  return {
    enable, disable, integrate,
    isActive: () => active,
    setKey: (k, v) => { if (k in keys) keys[k] = v; },
    getState: () => ({ pos: { ...pos }, eyeY, yaw: look.yaw, pitch: look.pitch, active }),
  };
}
