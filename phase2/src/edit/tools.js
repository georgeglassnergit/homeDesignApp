// edit/tools.js — STUB (UNVERIFIED: needs Three.js + the Phase 0/1 environment).
// See VIEW-LAYER-CONTRACT.md §3. Translates pointer gestures into model commands.
import { isAvailable } from '../app/state.js';
import * as cmds from './commands.js';

export class ToolController {
  constructor({ state, history, project, planView, picking, rebuild }) {
    Object.assign(this, { state, history, project, planView, picking, rebuild });
    this._draft = null; // in-flight gesture (e.g. wall being drawn / vertex being dragged)
  }

  setTool(name) {
    if (!isAvailable(name, this.state.mode)) return false; // Simple/Pro seam gate
    this.state.activeTool = name;
    this._draft = null;
    return true;
  }

  // The three handlers below build a command from `cmds`, commit via
  // history.execute(cmd), then call this.rebuild(this.project, scene).
  // Continuous drags MUST coalesce into a single moveWallVertex committed on pointerUp.
  onPointerDown(/* event */) { throw new Error('tools.onPointerDown: not implemented (view layer)'); }
  onPointerMove(/* event */) { throw new Error('tools.onPointerMove: not implemented (view layer)'); }
  onPointerUp(/* event */)   { throw new Error('tools.onPointerUp: not implemented (view layer)'); }
}

// Referenced so the intended command wiring is explicit for the next session:
export const COMMAND_MAP = {
  drawWall:    cmds.addWall,
  moveVertex:  cmds.moveWallVertex,
  removeWall:  cmds.removeWall,
  placeDoor:   cmds.addOpening,
  placeWindow: cmds.addOpening,
  template:    cmds.loadTemplate,
};
