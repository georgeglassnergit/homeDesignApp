// edit/history.js — model-level undo/redo stack of commands. Not scene-level.

export class History {
  constructor(project, opts = {}) {
    this.project = project;
    this.limit = opts.limit ?? 100;
    this.undoStack = [];
    this.redoStack = [];
  }
  execute(cmd) {
    cmd.do(this.project);
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return cmd;
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() {
    if (!this.canUndo()) return null;
    const cmd = this.undoStack.pop();
    cmd.undo(this.project);
    this.redoStack.push(cmd);
    return cmd;
  }
  redo() {
    if (!this.canRedo()) return null;
    const cmd = this.redoStack.pop();
    cmd.do(this.project);
    this.undoStack.push(cmd);
    return cmd;
  }
  labels() { return this.undoStack.map(c => c.name); }
}
