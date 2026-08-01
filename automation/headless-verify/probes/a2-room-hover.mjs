// A2 slice probe — hover-highlight the room under the plan cursor (pure view state).
// Drives window.__planHover at a room centroid and asserts the highlight resolves the right
// room AND stays view-only: no command (undo depth unchanged), selection untouched, and the
// save is byte-identical across the hover sweep. Leaves a room warm for the screenshot.
export async function run(page) {
  const info = await page.evaluate(() => {
    window.__setTool && window.__setTool('select');           // hover is SELECT-gated
    const lvl = window.__project().levels[0];
    const r = (lvl.rooms || [])[0];
    if (!r) return { rooms: 0 };
    const c = r.points.reduce((a, p) => ({ x: a.x + p.x / r.points.length, z: a.z + p.z / r.points.length }), { x: 0, z: 0 });
    return { rooms: (lvl.rooms || []).length, roomId: r.id, name: r.name || null, cx: c.x, cz: c.z, tool: window.__state.activeTool };
  });

  const before = await page.evaluate(() => ({ undo: window.__history.undoStack.length, lossless: window.__selftest().lossless }));
  const hover = await page.evaluate(({ cx, cz }) => window.__planHover(cx, cz), info);
  const cleared = await page.evaluate(() => window.__planHoverClear());
  await page.evaluate(({ cx, cz }) => window.__planHover(cx, cz), info); // re-warm for the shot
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => ({ undo: window.__history.undoStack.length, lossless: window.__selftest().lossless }));

  return {
    log: { roomId: info.roomId, name: info.name, tool: info.tool, hover: hover.hover },
    checks: [
      ['A2: app booted with rooms', info.rooms > 0],
      ['A2: SELECT tool active (hover gate)', info.tool === 'select'],
      ['A2: hover resolves the room under the centroid', hover.hover === info.roomId],
      ['A2: hover issues NO command (undo depth unchanged)', hover.undo === before.undo && after.undo === before.undo],
      ['A2: hover leaves selection untouched', hover.selection == null],
      ['A2: __planHoverClear clears the highlight', cleared === null],
      ['A2: save byte-identical across the hover sweep', before.lossless === true && after.lossless === true],
    ],
  };
}
