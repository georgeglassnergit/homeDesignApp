// edit/commands.js — every user edit is a command with do()/undo() on the PLAIN model.
// This is what gives undo/redo for free and keeps the model the single source of truth.
// Scene rebuild is a pure function of the model after each command (done by the view layer).
// Model/view separation: ZERO Three.js in here — commands only touch the plain Project.

import { findLevel, findWall, findOpening, stackElevations } from '../core/model.js';
import { DEFAULT_ROOF_PITCH } from '../core/roofShape.js';

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

// ---- multi-level (storey) edits — the Pro-seam "multi-level" feature -------------
// The model has always carried Levels[] (S1); the scene builder already stacks every
// level by its elevation. These commands let a Pro user add / remove / rename storeys
// and set storey heights, keeping the stack contiguous (each floor sits on the one
// below via stackElevations). All are lossless: they capture the prior elevations of
// every level and restore them on undo, so an edit→undo round-trip is byte-identical.

// Add a storey on top of the stack. `level` must already be a model level (from
// createLevel, with id). Appending at the top leaves every existing level's elevation
// unchanged; stackElevations only sets the new top level's floor onto the one beneath.
export function addLevel(level) {
  return {
    name: 'Add level',
    do(project) {
      project.levels.push(level);
      stackElevations(project.levels);
    },
    undo(project) {
      project.levels = project.levels.filter(l => l.id !== level.id);
    },
  };
}

// Remove a storey. Refuses to remove the last remaining level (a home needs a floor).
// Removing a lower storey shifts everything above it down; undo restores the removed
// level at its original index AND every level's captured elevation, so it's lossless.
export function removeLevel(levelId) {
  let removed = null, idx = -1, prevElev = null;
  return {
    name: 'Remove level',
    do(project) {
      if (project.levels.length <= 1) throw new Error('removeLevel: cannot remove the last level');
      idx = project.levels.findIndex(l => l.id === levelId);
      if (idx < 0) throw new Error(`removeLevel: missing level ${levelId}`);
      prevElev = project.levels.map(l => ({ id: l.id, elevation: l.elevation }));
      removed = project.levels[idx];
      project.levels.splice(idx, 1);
      stackElevations(project.levels);
    },
    undo(project) {
      project.levels.splice(idx, 0, removed);
      for (const { id, elevation } of prevElev) { const l = project.levels.find(x => x.id === id); if (l) l.elevation = elevation; }
    },
  };
}

// Set (or clear) a storey's roof. Used when stacking/unstacking storeys so the roof always
// caps the TOP level: adding a storey moves the roof up, removing the top moves it back down.
// `roof` may be a roof object (from createRoof) or null. Prior roof captured for lossless undo.
export function setLevelRoof(levelId, roof) {
  let prev;
  return {
    name: roof ? 'Add roof' : 'Remove roof',
    do(project) {
      const l = findLevel(project, levelId);
      if (!l) throw new Error(`setLevelRoof: missing level ${levelId}`);
      prev = l.roof;
      l.roof = roof;
    },
    undo(project) {
      const l = findLevel(project, levelId);
      if (l) l.roof = prev;
    },
  };
}

// Change a storey roof's shape (flat / gable / hip) and/or pitch. The prior roof
// is captured whole for a byte-lossless undo (the Phase 1 guarantee). Only the
// roof's `type`/`pitch` fields change — thickness, overhang and material carry
// through untouched. Missing pitch is backfilled to the default so a roof that
// pre-dates the pitch field renders a sane slope once switched to gable/hip.
export function setRoofType(levelId, { type, pitch } = {}) {
  let prev;
  return {
    name: 'Set roof type',
    do(project) {
      const l = findLevel(project, levelId);
      if (!l) throw new Error(`setRoofType: missing level ${levelId}`);
      if (!l.roof) throw new Error(`setRoofType: level ${levelId} has no roof`);
      prev = { ...l.roof };
      if (type !== undefined) l.roof.type = type;
      if (pitch !== undefined) l.roof.pitch = pitch;
      if (l.roof.pitch === undefined) l.roof.pitch = DEFAULT_ROOF_PITCH;
    },
    undo(project) {
      const l = findLevel(project, levelId);
      if (l) l.roof = prev;
    },
  };
}

// Rename a storey (a label only — no geometry, trivially lossless).
export function renameLevel(levelId, name) {
  let prev;
  return {
    name: 'Rename level',
    do(project) {
      const l = findLevel(project, levelId);
      if (!l) throw new Error(`renameLevel: missing level ${levelId}`);
      prev = l.name;
      l.name = name;
    },
    undo(project) {
      const l = findLevel(project, levelId);
      if (l) l.name = prev;
    },
  };
}

// Set a storey's floor-to-floor height. Raising a lower storey pushes every storey above
// it up (via stackElevations); the prior height and all elevations are captured for a
// byte-lossless undo. The caller re-validates (height must be > 0) and rolls back on fail.
export function setLevelHeight(levelId, height) {
  let prevH, prevElev;
  return {
    name: 'Set level height',
    do(project) {
      const l = findLevel(project, levelId);
      if (!l) throw new Error(`setLevelHeight: missing level ${levelId}`);
      prevH = l.height;
      prevElev = project.levels.map(x => ({ id: x.id, elevation: x.elevation }));
      l.height = height;
      stackElevations(project.levels);
    },
    undo(project) {
      const l = findLevel(project, levelId);
      if (l) l.height = prevH;
      for (const { id, elevation } of prevElev) { const x = project.levels.find(y => y.id === id); if (x) x.elevation = elevation; }
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
