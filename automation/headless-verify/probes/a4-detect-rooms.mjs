// A4 slice probe — surface + add auto-detected rooms on the plan (the UI wiring over the pure
// detectNewRooms engine). Drives the REAL app: draws two detached square rooms with the draw-wall
// tool, runs "Find rooms" (window.__findRooms), and adds one candidate (window.__addDetectedRoom)
// the same way a plan click does. Asserts the pure engine surfaces exactly the enclosed spaces
// that AREN'T already saved rooms, that a candidate click commits an UNDOABLE addRoom command
// (undo depth +1, undo removes it, redo restores it), that the added room is byte-lossless, and
// that the overlay is otherwise pure view state. Leaves one added room (amber) + one remaining
// candidate (teal "+ Add room") on the plan for the screenshot.
export async function run(page) {
  // Draw two detached 4×4 squares below the existing home (z 6..10), each a closed wall loop.
  const before = await page.evaluate(() => {
    window.__controller.finishChain();
    window.__setTool('draw-wall');
    const squareA = [[-2, 6], [2, 6], [2, 10], [-2, 10], [-2, 6]];   // closes back to the first corner
    const squareB = [[3, 6], [7, 6], [7, 10], [3, 10], [3, 6]];
    for (const [x, z] of squareA) window.__planClick(x, z);
    window.__controller.finishChain();
    for (const [x, z] of squareB) window.__planClick(x, z);
    window.__controller.finishChain();
    window.__setTool('select');                 // candidate-click is SELECT-gated
    window.__plan.frameModel();                 // fit house + the two new squares into view
    const lvl = window.__project().levels[0];
    return {
      walls: lvl.walls.length,
      rooms: (lvl.rooms || []).length,
      undo: window.__history.undoStack.length,
      lossless: window.__selftest().lossless,
      tool: window.__state.activeTool,
    };
  });

  // Find rooms — the two new squares are enclosed but NOT saved, so both are offered; the two
  // ORIGINAL rooms are already saved and must NOT reappear as candidates.
  const find = await page.evaluate(() => {
    const undoBefore = window.__history.undoStack.length;
    const r = window.__findRooms();
    return { count: r.count, seamVisible: r.seamVisible, undoAfter: window.__history.undoStack.length, undoBefore, areas: r.candidates.map((c) => Math.round(polyArea(c.points))) };
    function polyArea(pts) { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p.x * q.z - q.x * p.z; } return Math.abs(s) / 2; }
  });

  // Add the first candidate the way a plan click does.
  const add = await page.evaluate(() => window.__addDetectedRoom(0));

  // Prove it's an undoable command: undo removes the room, redo restores it. (Refresh clears the
  // overlay on each, so we re-run Find rooms afterward to re-show the still-unsaved twin.)
  const undoRedo = await page.evaluate(() => {
    const roomsAfterAdd = window.__project().levels[0].rooms.length;
    window.__controller.undo();
    const roomsAfterUndo = window.__project().levels[0].rooms.length;
    window.__controller.redo();
    const roomsAfterRedo = window.__project().levels[0].rooms.length;
    window.__findRooms();                        // re-show the one remaining candidate for the shot
    return { roomsAfterAdd, roomsAfterUndo, roomsAfterRedo, remaining: window.__plan.getCandidates().length, lossless: window.__selftest().lossless };
  });

  await page.waitForTimeout(120);

  const origRooms = before.rooms;               // 2 (Living + Bedroom)
  return {
    log: { before, find, add, undoRedo },
    checks: [
      ['A4: app booted with the sample rooms', origRooms === 2],
      ['A4: two 4×4 squares drawn (8 new walls)', before.walls === 5 + 8],
      ['A4: SELECT tool active (add gate)', before.tool === 'select'],
      ['A4: Find rooms detects the 2 unsaved enclosed spaces', find.count === 2],
      ['A4: detected candidates are the 4×4 squares (16 m²)', find.areas.filter((a) => a === 16).length === 2],
      ['A4: existing saved rooms are NOT re-offered', find.count === 2 /* not 4 */],
      ['A4: Find rooms issues NO command (view state)', find.undoAfter === find.undoBefore],
      ['A4: adding a candidate creates exactly one room', add && add.added_count === 1],
      ['A4: add is an undoable command (undo depth +1)', add && add.undo === before.undo + 1],
      ['A4: the new room is selected after add', add && add.selection && add.selection.kind === 'room' && add.selection.id === add.added],
      ['A4: one candidate remains after adding one', add && add.remaining === 1],
      ['A4: undo removes the added room', undoRedo.roomsAfterUndo === undoRedo.roomsAfterAdd - 1],
      ['A4: redo restores it', undoRedo.roomsAfterRedo === undoRedo.roomsAfterAdd],
      ['A4: overlay re-shows the still-unsaved twin', undoRedo.remaining === 1],
      ['A4: save stays lossless across the sequence', before.lossless === true && undoRedo.lossless === true],
      ['A4: room-detect seam is visible (un-tiered)', find.seamVisible === true],
    ],
  };
}
