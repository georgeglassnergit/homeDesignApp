// edit/tools.js — the tool state machine (S2/S3). VIEW-LAYER-CONTRACT.md §3.
// Translates plan-view pointer gestures into model commands, commits them through
// the history stack, and asks the view to rebuild. The model stays the single
// source of truth; this file never stores geometry and never touches Three.js
// (so it loads in the engine-independent test suite — proving that separation).

import { TOOL } from '../app/state.js';
import { createWall, createOpening, wallLength, findLevel, findWall } from '../core/model.js';
import { addWall, moveWallVertex, removeWall, addOpening, removeOpening, composite } from './commands.js';
import { snapPoint } from './snapping.js';

const MIN_WALL = 0.05;        // ignore accidental zero-length wall clicks (m)
const VERTEX_TOL_PX = 12;     // grab radius for corner drag
const WALL_TOL_PX = 12;       // click radius for selecting / placing on a wall

// Feature ids the toolbar registers under (Simple/Pro seam lives in app/state.js).
export const TOOL_FEATURE = {
  [TOOL.SELECT]: 'draw-wall',       // select/orbit is always on; grouped with drawing
  [TOOL.DRAW_WALL]: 'draw-wall',
  [TOOL.PLACE_DOOR]: 'place-door',
  [TOOL.PLACE_WINDOW]: 'place-window',
};

export class ToolController {
  // rebuild() is called after every committed edit — the view re-derives the scene
  // (and redraws the plan) purely from the mutated model.
  constructor({ state, history, project, planView, levelId, rebuild, onMessage }) {
    Object.assign(this, { state, history, project, planView, levelId, rebuild });
    this.onMessage = onMessage || (() => {});
    this._chain = null;    // in-progress wall polyline: { prev:{x,z} }
    this._drag = null;     // in-progress corner drag: { verts:[{wallId,end}], from:{x,z}, to:{x,z} }
    this.preview = null;   // rubber-band point for the plan renderer (view-only)
  }

  // The active level, resolved live so a template swap (which replaces the level and
  // its id) never leaves the controller pointing at a stale level.
  get level() { return findLevel(this.project, this.levelId) || this.project.levels[0] || null; }
  _lid() { const lv = this.level; return lv ? lv.id : this.levelId; }

  setTool(name) {
    // Simple/Pro seam: only switch to a tool available in the current mode.
    this.state.setTool(name);
    this._chain = null; this._drag = null; this.preview = null;
    return this.state.activeTool === name;
  }

  // Snap a pointer position through the active snapping/constraint settings (the Pro-seam
  // "snapping-constraints"). `anchor` is the point a segment is drawn/dragged from (for angle
  // snap); `excludeKeys` is the dragged corner's endpoints, so it never snaps onto itself.
  // Settings are data — Simple keeps safe defaults, Pro edits them live. Returns { x, z }.
  _snap(world, { anchor = null, excludeKeys = null } = {}) {
    const walls = this.level ? this.level.walls : [];
    const p = snapPoint(world, { settings: this.state.snap, walls, anchor, excludeKeys });
    return { x: p.x, z: p.z };
  }

  _emit(msg) { this.state.message = msg; this.onMessage(msg); }

  pointerDown(world) {
    switch (this.state.activeTool) {
      case TOOL.DRAW_WALL:   return this._drawWallDown(world);
      case TOOL.PLACE_DOOR:  return this._placeOpeningDown(world, 'door');
      case TOOL.PLACE_WINDOW:return this._placeOpeningDown(world, 'window');
      case TOOL.SELECT:
      default:               return this._selectDown(world);
    }
  }

  pointerMove(world) {
    if (this._drag) { this._drag.to = this._snap(world, { excludeKeys: this._drag.excludeKeys }); this.preview = this._drag.to; return; }
    if (this._chain) { this.preview = this._snap(world, { anchor: this._chain.prev }); return; }
    this.preview = null;
  }

  pointerUp(world) {
    if (this._drag) return this._commitDrag(world);
  }

  // --- select / drag a corner ------------------------------------------------
  _selectDown(world) {
    const walls = this.level ? this.level.walls : [];
    const vhit = this.planView.nearestVertex(world, walls, VERTEX_TOL_PX);
    if (vhit) {
      // grab EVERY wall endpoint sharing this corner so both adjoining walls move together
      const verts = this.planView.verticesAt(vhit.point, walls);
      // exclude the grabbed endpoints from vertex-snapping so the corner never snaps to itself
      const excludeKeys = new Set(verts.map((v) => v.wallId + ':' + v.end));
      this._drag = { verts, excludeKeys, from: { x: vhit.point.x, z: vhit.point.z }, to: { x: vhit.point.x, z: vhit.point.z } };
      this.state.selection = { kind: 'wall', id: vhit.wallId };
      return;
    }
    const whit = this.planView.nearestWallHit(world, walls, WALL_TOL_PX);
    this.state.selection = whit ? { kind: 'wall', id: whit.wallId } : null;
  }

  _commitDrag(world) {
    const to = this._snap(world, { excludeKeys: this._drag.excludeKeys });
    const { verts, from } = this._drag;
    this._drag = null; this.preview = null;
    if (Math.hypot(to.x - from.x, to.z - from.z) < 1e-4) return; // no real move -> no command
    const cmd = composite('Move corner', verts.map(v => moveWallVertex(this._lid(), v.wallId, v.end, to)));
    this.history.execute(cmd);
    this.rebuild();
  }

  // --- draw a chain of walls (click each corner; Esc / finishChain ends it) ---
  _drawWallDown(world) {
    // first corner has no anchor; later corners angle-snap relative to the previous one
    const p = this._chain ? this._snap(world, { anchor: this._chain.prev }) : this._snap(world);
    if (!this._chain) { this._chain = { prev: p }; this.preview = p; return; }
    const prev = this._chain.prev;
    if (Math.hypot(p.x - prev.x, p.z - prev.z) < MIN_WALL) return; // ignore duplicate click
    const wall = createWall(prev, p);
    this.history.execute(addWall(this._lid(), wall));
    this.rebuild();
    this._chain.prev = p; this.preview = p;
  }

  finishChain() { this._chain = null; this.preview = null; }

  // Rubber-band segment for the plan renderer (view-only; no model access needed).
  previewSegment() {
    if (this._drag && this.preview) return { from: this._drag.from, to: this.preview, kind: 'drag' };
    if (this._chain && this.preview) return { from: this._chain.prev, to: this.preview, kind: 'wall' };
    return null;
  }

  // --- place a door/window on the clicked wall (S3) ---------------------------
  _placeOpeningDown(world, kind) {
    const walls = this.level ? this.level.walls : [];
    const hit = this.planView.nearestWallHit(world, walls, WALL_TOL_PX);
    if (!hit) { this._emit('Click on a wall to place a ' + kind); return; }
    const wall = findWall(this.level, hit.wallId);
    const template = createOpening(wall.id, kind);          // default door/window size
    const len = wallLength(wall);
    // center the opening on the click, then clamp so it fits within the wall
    let offset = hit.offset - template.width / 2;
    offset = Math.max(0, Math.min(offset, len - template.width));
    if (len < template.width) { this._emit(`Wall too short for a ${kind}`); return; }
    const opening = createOpening(wall.id, kind, { offset });
    this.history.execute(addOpening(this._lid(), opening));
    this.rebuild();
    this.state.selection = { kind: 'opening', id: opening.id };
  }

  // --- selection-level actions ------------------------------------------------
  deleteSelection() {
    const sel = this.state.selection;
    if (!sel) return false;
    const cmd = sel.kind === 'wall' ? removeWall(this._lid(), sel.id) : removeOpening(this._lid(), sel.id);
    this.history.execute(cmd);
    this.state.selection = null;
    this.rebuild();
    return true;
  }

  undo() { if (this.history.undo()) { this.state.selection = null; this.rebuild(); return true; } return false; }
  redo() { if (this.history.redo()) { this.state.selection = null; this.rebuild(); return true; } return false; }
}
