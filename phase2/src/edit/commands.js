// edit/commands.js — every user edit is a command with do()/undo() on the PLAIN model.
// This is what gives undo/redo for free and keeps the model the single source of truth.
// Scene rebuild is a pure function of the model after each command (done by the view layer).

import { findLevel, findWall } from '../core/model.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

// Add a wall to a level. `wall` must already be a model wall (with id).
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

// Move one endpoint ('a'|'b') of a wall to a new {x,z}. Coalesce drags -> commit one command on pointer-up.
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

// Remove a wall and any openings that reference it (captured for undo).
export function removeWall(levelId, wallId) {
  let removedWall = null, removedOpenings = [], wallIndex = -1;
  return {
    name: 'Remove wall',
    do(project) {
      const lvl = findLevel(project, levelId);
      wallIndex = lvl.walls.findIndex(w => w.id === wallId);
      if (wallIndex < 0) throw new Error(`removeWall: missing wall ${wallId}`);
      removedWall = lvl.walls[wallIndex];
      lvl.walls.splice(wallIndex, 1);
      removedOpenings = lvl.openings.filter(o => o.wallId === wallId);
      lvl.openings = lvl.openings.filter(o => o.wallId !== wallId);
    },
    undo(project) {
      const lvl = findLevel(project, levelId);
      lvl.walls.splice(wallIndex, 0, removedWall);
      lvl.openings.push(...removedOpenings);
    },
  };
}

// Add an opening (door/window). `opening` must already be a model opening (with id + wallId).
export function addOpening(levelId, opening) {
  return {
    name: `Add ${opening.kind}`,
    do(project) {
      const lvl = findLevel(project, levelId);
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

// Replace the whole project contents with a template/starter (mutates in place; container identity kept).
const PROJECT_KEYS = ['schemaVersion', 'name', 'units', 'site', 'materials', 'levels', 'furniture'];
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
