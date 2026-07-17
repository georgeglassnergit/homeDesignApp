// edit/commands.js — every user edit is a command with do()/undo() on the PLAIN model.
// This is what gives undo/redo for free and keeps the model the single source of truth.
// Scene rebuild is a pure function of the model after each command (done by the view layer).
// Model/view separation: ZERO Three.js in here — commands only touch the plain Project.

import { findLevel, findWall, findOpening } from '../core/model.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

// Add a wall to a level. `wall` must already be a model wall (from createWall, with id).
export function addWall(levelId, wall) {
  return {
    name: 'Add wall',
    do(project) {
      const lvl = findLevel(project, levelId);
      if (!lvl) throw new Error(`addWall: missing level ${levelId}`);
      lvl.walls.push(wall);
    },
    undo(project) {
      const lvl = findLevel(project, levelId);
      lvl.walls = lvl.walls.filter(w => w.id !== wall.id);
    },
  };
}

// Move one endpoint ('a'|'b') of a wall to a new {x,z}.
// Coalesce continuous drags -> commit one command on pointer-up (keeps the undo stack sane).
export function moveWallVertex(levelId, wallId, end, pt) {
  let prev = null;
  return {
    name: 'Move wall vertex',
    do(project) {
      const w = findWall(findLevel(project, levelId), wallId);
      if (!w) throw new Error(`moveWallVertex: missing wall ${wallId}`);
      prev = { x: w[end].x, z: w[end].z };
      w[end] = { x: pt.x, z: pt.z };
    },
    undo(project) {
      const w = findWall(findLevel(project, levelId), wallId);
      if (w && prev) w[end] = prev;
    },
  };
}

// Remove a wall and any openings that reference it (captured for lossless undo).
// Openings are captured with their original array indices so undo restores them in
// place — keeping the save file byte-identical across a remove→undo round-trip.
export function removeWall(levelId, wallId) {
  let removedWall = null, removedOpenings = [], wallIndex = -1;
  return {
    name: 'Remove wall',
    do(project) {
      const lvl = findLevel(project, levelId);
      if (!lvl) throw new Error(`removeWall: missing level ${levelId}`);
      wallIndex = lvl.walls.findIndex(w => w.id === wallId);
      if (wallIndex < 0) throw new Error(`removeWall: missing wall ${wallId}`);
      removedWall = lvl.walls[wallIndex];
      lvl.walls.splice(wallIndex, 1);
      removedOpenings = [];
      for (let i = 0; i < lvl.openings.length; i++) {
        if (lvl.openings[i].wallId === wallId) removedOpenings.push({ index: i, opening: lvl.openings[i] });
      }
      lvl.openings = lvl.openings.filter(o => o.wallId !== wallId);
    },
    undo(project) {
      const lvl = findLevel(project, levelId);
      lvl.walls.splice(wallIndex, 0, removedWall);
      // captured ascending, so re-inserting ascending lands each opening at its old index
      for (const { index, opening } of removedOpenings) lvl.openings.splice(index, 0, opening);
    },
  };
}

// Add an opening (door/window). `opening` must already be a model opening (from createOpening, with id + wallId).
export function addOpening(levelId, opening) {
  return {
    name: `Add ${opening.kind}`,
    do(project) {
      const lvl = findLevel(project, levelId);
      if (!lvl) throw new Error(`addOpening: missing level ${levelId}`);
      if (!findWall(lvl, opening.wallId)) throw new Error(`addOpening: missing wall ${opening.wallId}`);
      lvl.openings.push(opening);
    },
    undo(project) {
      const lvl = findLevel(project, levelId);
      lvl.openings = lvl.openings.filter(o => o.id !== opening.id);
    },
  };
}

export function removeOpening(levelId, openingId) {
  let removed = null, idx = -1;
  return {
    name: 'Remove opening',
    do(project) {
      const lvl = findLevel(project, levelId);
      if (!lvl) throw new Error(`removeOpening: missing level ${levelId}`);
      idx = lvl.openings.findIndex(o => o.id === openingId);
      if (idx < 0) throw new Error(`removeOpening: missing opening ${openingId}`);
      removed = lvl.openings[idx];
      lvl.openings.splice(idx, 1);
    },
    undo(project) {
      const lvl = findLevel(project, levelId);
      lvl.openings.splice(idx, 0, removed);
    },
  };
}

// Resize a wall by exact dimensions (the Pro-seam "exact-dimensions" edit). `changes` may
// carry any of { length, thickness, height } in METERS. `length` moves endpoint b along the
// existing a→b direction, keeping a fixed (a degenerate zero-length wall has no direction, so
// length is ignored there). The FULL prior geometry (a, b, thickness, height) is captured and
// restored on undo, so a resize→undo round-trip is byte-identical (the Phase 1 guarantee).
export function resizeWall(levelId, wallId, changes = {}) {
  let prev = null;
  return {
    name: 'Resize wall',
    do(project) {
      const w = findWall(findLevel(project, levelId), wallId);
      if (!w) throw new Error(`resizeWall: missing wall ${wallId}`);
      prev = { a: { x: w.a.x, z: w.a.z }, b: { x: w.b.x, z: w.b.z }, thickness: w.thickness, height: w.height };
      if (changes.thickness != null) w.thickness = changes.thickness;
      if (changes.height != null) w.height = changes.height;
      if (changes.length != null) {
        const dx = w.b.x - w.a.x, dz = w.b.z - w.a.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-9) w.b = { x: w.a.x + (dx / len) * changes.length, z: w.a.z + (dz / len) * changes.length };
      }
    },
    undo(project) {
      const w = findWall(findLevel(project, levelId), wallId);
      if (w && prev) { w.a = prev.a; w.b = prev.b; w.thickness = prev.thickness; w.height = prev.height; }
    },
  };
}

// Resize an opening by exact dimensions. `changes` may carry any of { width, height, sill,
// offset } in METERS. Prior values are captured for a lossless undo. The caller is expected to
// re-run validateProject (which enforces fit within the wall) and roll back on failure.
export function resizeOpening(levelId, openingId, changes = {}) {
  let prev = null;
  return {
    name: 'Resize opening',
    do(project) {
      const o = findOpening(findLevel(project, levelId), openingId);
      if (!o) throw new Error(`resizeOpening: missing opening ${openingId}`);
      prev = { width: o.width, height: o.height, sill: o.sill, offset: o.offset };
      for (const k of ['width', 'height', 'sill', 'offset']) if (changes[k] != null) o[k] = changes[k];
    },
    undo(project) {
      const o = findOpening(findLevel(project, levelId), openingId);
      if (o && prev) Object.assign(o, prev);
    },
  };
}

// Set the view mode (S5: 'exterior' | 'cutaway'). This is a DISPLAY preference, not
// geometry — it lives in project.meta.view so it round-trips with the save file, and it
// is undoable like any other edit. do()/undo() touch only meta, so scene geometry (and
// the object count) is untouched; the view layer reads meta.view to toggle visibility.
export function setView(view) {
  let prev;
  return {
    name: `View: ${view}`,
    do(project) {
      if (!project.meta || typeof project.meta !== 'object') project.meta = {};
      prev = project.meta.view;
      project.meta.view = view;
    },
    undo(project) {
      if (prev === undefined) delete project.meta.view;
      else project.meta.view = prev;
    },
  };
}

// Group several commands into one undo/redo unit (e.g. dragging a shared corner moves
// every wall touching it as a single edit). do() applies in order; undo() reverses order.
export function composite(name, subcommands) {
  const cmds = subcommands.filter(Boolean);
  return {
    name: name || 'Edit',
    do(project) { for (const c of cmds) c.do(project); },
    undo(project) { for (let i = cmds.length - 1; i >= 0; i--) cmds[i].undo(project); },
  };
}

// Replace the whole project contents with a template/starter, mutating in place so the
// container identity (and any references to it) is preserved. Undo restores a snapshot.
const PROJECT_KEYS = ['schemaVersion', 'name', 'units', 'site', 'materials', 'levels', 'furniture', 'meta'];
export function loadTemplate(newProject) {
  let snapshot = null;
  return {
    name: 'Load template',
    do(project) {
      snapshot = {};
      for (const k of PROJECT_KEYS) snapshot[k] = clone(project[k]);
      const src = clone(newProject);
      for (const k of PROJECT_KEYS) project[k] = src[k];
    },
    undo(project) {
      for (const k of PROJECT_KEYS) project[k] = snapshot[k];
    },
  };
}
