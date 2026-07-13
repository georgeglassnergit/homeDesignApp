// edit/commands.js — every user edit is a command with do()/undo() on the PLAIN model.
// This is what gives undo/redo for free and keeps the model the single source of truth.
// Scene rebuild is a pure function of the model after each command (done by the view layer).
// Model/view separation: ZERO Three.js in here — commands only touch the plain Project.

import { findLevel, findWall } from '../core/model.js';

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
