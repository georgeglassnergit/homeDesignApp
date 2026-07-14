import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Reusable viewer: renderer, camera, orbit controls, lighting, resize, render loop.
// Knows nothing about the home model — it just displays whatever group you add.
export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdedad2);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 500);
  camera.position.set(10, 8, 12);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1.2, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.15);
  sun.position.set(9, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 0.5, far: 60 });
  scene.add(sun);

  function frame(box, dist = 1.5) {
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fitDist = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360))) * dist;
    camera.position.set(center.x + fitDist * 0.8, center.y + fitDist * 0.7, center.z + fitDist * 0.9);
    controls.target.copy(center);
    camera.near = maxDim / 100; camera.far = maxDim * 100; camera.updateProjectionMatrix();
    controls.update();
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // Per-frame hooks. The viewer stays model-agnostic; callers (e.g. the cutaway updater)
  // register here to run just before each render — used for camera-relative visibility.
  const frameHooks = [];
  function onFrame(cb) { frameHooks.push(cb); return () => { const i = frameHooks.indexOf(cb); if (i >= 0) frameHooks.splice(i, 1); }; }

  let raf;
  function start() {
    const tick = () => {
      controls.update();
      for (const cb of frameHooks) cb();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stop() { cancelAnimationFrame(raf); }

  return { renderer, scene, camera, controls, frame, start, stop, onFrame };
}
