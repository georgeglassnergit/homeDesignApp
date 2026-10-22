// Furniture commands + validation — engine-independent verification against the
// AUTHORITATIVE src/ model. Plain Node, no Three.js, no network, no browser.
// Run: node src/test/furniture-commands.test.mjs
//
// Covers the missing link between the Phase-4 image→3D "furnish" pipeline and the undoable
// model: addFurniture/removeFurniture (edit/commands.js) commit a furniture record — the one
// toFurniture/createFurniture produces — into the top-level project.furniture[] array, with
// lossless undo (index-captured remove) that preserves the Phase 1 save round-trip. Also locks
// the new validateProject furniture guard, which previously ignored furniture entirely.
//
// No Three.js import here — running under plain Node is itself the model/view separation guard
// (Node has no `three`; a stray import in the edit/core layer would fail to load this suite).
import {
  createProject, createLevel, createFurniture, validateProject,
  serialize, deserialize, findFurniture, projectCounts, _resetIds,
} from '../core/model.js';
import { addFurniture, removeFurniture } from '../edit/commands.js';
import { History } from '../edit/history.js';
import { toFurniture } from '../core/furnishPipeline.js';
import { sampleHome } from '../templates/sampleHome.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }

const clone = (v) => JSON.parse(JSON.stringify(v));

function main() {
  _resetIds();

  // A minimal project with one level to host furniture referencing a real levelId.
  function freshProject() {
    const level = createLevel({ name: 'Ground' });
    return createProject({ name: 'Furnish test', levels: [level] });
  }

  // ---- 1) addFurniture command --------------------------------------------------------------
  {
    const p = freshProject();
    const lvlId = p.levels[0].id;
    const furn = createFurniture('/chair.glb', { name: 'Chair', levelId: lvlId, position: { x: 1, z: 2 } });
    const cmd = addFurniture(furn);
    ok(cmd.name === 'Add furniture', '1a command name is "Add furniture"');
    ok(p.furniture.length === 0, '1b project starts with no furniture');
    cmd.do(p);
    ok(p.furniture.length === 1 && p.furniture[0].id === furn.id, '1c do() appends the record');
    ok(findFurniture(p, furn.id) === furn, '1d findFurniture locates it');
    ok(projectCounts(p).furniture === 1, '1e projectCounts reflects the add');
    cmd.undo(p);
    ok(p.furniture.length === 0, '1f undo() removes exactly the added record');
    ok(findFurniture(p, furn.id) === null, '1g findFurniture returns null after undo');
  }

  // addFurniture initializes a missing furniture array defensively (old/partial projects).
  {
    const p = freshProject();
    delete p.furniture;
    const furn = createFurniture('/x.glb');
    addFurniture(furn).do(p);
    ok(Array.isArray(p.furniture) && p.furniture.length === 1, '1h do() creates the array when absent');
  }

  // addFurniture rejects a record with no id (a createFurniture record always has one).
  {
    const p = freshProject();
    let threw = false;
    try { addFurniture({ src: '/no-id.glb' }).do(p); } catch { threw = true; }
    ok(threw, '1i addFurniture without an id throws');
  }

  // ---- 2) removeFurniture command (index-captured lossless undo) ----------------------------
  {
    const p = freshProject();
    const a = createFurniture('/a.glb', { name: 'A' });
    const b = createFurniture('/b.glb', { name: 'B' });
    const c = createFurniture('/c.glb', { name: 'C' });
    p.furniture.push(a, b, c);
    const cmd = removeFurniture(b.id);
    ok(cmd.name === 'Remove furniture', '2a command name is "Remove furniture"');
    cmd.do(p);
    ok(p.furniture.length === 2 && !findFurniture(p, b.id), '2b do() removes the middle record');
    ok(p.furniture[0].id === a.id && p.furniture[1].id === c.id, '2c remaining order preserved');
    cmd.undo(p);
    ok(p.furniture.length === 3, '2d undo() restores the record');
    ok(p.furniture[0].id === a.id && p.furniture[1].id === b.id && p.furniture[2].id === c.id,
      '2e undo() re-inserts at the ORIGINAL index (order byte-identical)');
  }

  // removeFurniture throws on a missing id and on a project with no furniture array.
  {
    const p = freshProject();
    p.furniture.push(createFurniture('/a.glb'));
    let threw = false;
    try { removeFurniture('nope').do(p); } catch { threw = true; }
    ok(threw, '2f removeFurniture with an unknown id throws');
    const p2 = freshProject(); delete p2.furniture;
    let threw2 = false;
    try { removeFurniture('x').do(p2); } catch { threw2 = true; }
    ok(threw2, '2g removeFurniture on a project with no furniture throws');
  }

  // ---- 3) History integration (undo/redo) ---------------------------------------------------
  {
    const p = freshProject();
    const h = new History(p);
    const furn = createFurniture('/lamp.glb', { name: 'Lamp' });
    h.execute(addFurniture(furn));
    ok(p.furniture.length === 1, '3a execute(addFurniture) adds');
    h.undo();
    ok(p.furniture.length === 0, '3b undo removes');
    h.redo();
    ok(p.furniture.length === 1 && findFurniture(p, furn.id), '3c redo re-adds the same record');
  }

  // ---- 4) Phase 1 lossless save round-trip survives furniture edits -------------------------
  {
    const p = freshProject();
    const before = serialize(p);
    const furn = createFurniture('/sofa.glb', { name: 'Sofa', levelId: p.levels[0].id, position: { x: 3, z: -1 } });
    const add = addFurniture(furn);
    add.do(p);
    // add → deserialize(serialize) is stable
    const roundTripped = deserialize(serialize(p));
    ok(serialize(roundTripped) === serialize(p), '4a serialize→deserialize→serialize is byte-identical with furniture present');
    add.undo(p);
    ok(serialize(p) === before, '4b add→undo restores the save byte-for-byte');

    // remove → undo on a populated project is also lossless (index + content restored)
    p.furniture.push(createFurniture('/x.glb', { name: 'X' }), furn, createFurniture('/z.glb', { name: 'Z' }));
    const snapshot = serialize(p);
    const rm = removeFurniture(furn.id);
    rm.do(p);
    rm.undo(p);
    ok(serialize(p) === snapshot, '4c remove→undo restores the save byte-for-byte');
  }

  // ---- 5) toFurniture bridge → addFurniture commits the pipeline output ----------------------
  {
    const p = freshProject();
    // a synthetic successful runFurnishJob result (what the pipeline resolves to)
    const result = { jobId: 'job-1', name: 'Generated chair', src: 'https://proxy.local/furnish/job-1.glb', polls: 3 };
    const furn = toFurniture(result, { levelId: p.levels[0].id, position: { x: 0.5, z: 0.5 } });
    ok(furn.src === result.src && furn.name === 'Generated chair', '5a toFurniture carries src + name from the job');
    const h = new History(p);
    h.execute(addFurniture(furn));
    ok(p.furniture.length === 1 && validateProject(p).ok, '5b the pipeline output commits as a valid furniture record');
    h.undo();
    ok(p.furniture.length === 0, '5c and the commit is undoable');
  }

  // ---- 6) validateProject furniture guard (previously ignored furniture entirely) -----------
  {
    // positive controls first: the sample home (which ships furniture with a real levelId) and
    // a null-levelId record ("not tied to a storey") both validate.
    ok(validateProject(sampleHome()).ok, '6a sampleHome (ships furniture) still validates');
    const base = freshProject();
    base.furniture.push(createFurniture('/ok.glb', { name: 'Untied', levelId: null }));
    ok(validateProject(base).ok, '6b a well-formed record with null levelId validates');

    const hasErr = (p, needle) => validateProject(p).errors.some(e => e.includes(needle));

    // empty / non-string src
    { const p = freshProject(); p.furniture.push(createFurniture('', { name: 'NoSrc' }));
      ok(!validateProject(p).ok && hasErr(p, 'src must be a non-empty string'), '6c empty src rejected'); }
    { const p = freshProject(); const f = createFurniture('/a.glb'); f.src = 42; p.furniture.push(f);
      ok(hasErr(p, 'src must be a non-empty string'), '6d non-string src rejected'); }

    // non-finite position
    { const p = freshProject(); const f = createFurniture('/a.glb'); f.position = { x: NaN, z: 0 }; p.furniture.push(f);
      ok(hasErr(p, 'position coordinates must be finite'), '6e NaN position rejected'); }
    { const p = freshProject(); const f = createFurniture('/a.glb'); f.position = { x: 0, z: Infinity }; p.furniture.push(f);
      ok(hasErr(p, 'position coordinates must be finite'), '6f infinite position rejected'); }

    // non-finite scale / rotationY
    { const p = freshProject(); const f = createFurniture('/a.glb'); f.scale = NaN; p.furniture.push(f);
      ok(hasErr(p, 'scale must be a finite number'), '6g NaN scale rejected'); }
    { const p = freshProject(); const f = createFurniture('/a.glb'); f.rotationY = Infinity; p.furniture.push(f);
      ok(hasErr(p, 'rotationY must be a finite number'), '6h infinite rotationY rejected'); }

    // unknown non-null levelId (referential integrity)
    { const p = freshProject(); p.furniture.push(createFurniture('/a.glb', { levelId: 'level-does-not-exist' }));
      ok(hasErr(p, 'unknown levelId level-does-not-exist'), '6i non-null unknown levelId rejected'); }

    // furniture present but not an array
    { const p = freshProject(); p.furniture = { not: 'an array' };
      ok(hasErr(p, 'furniture must be an array'), '6j non-array furniture rejected'); }

    // absent furniture is fine (old/partial saves): no furniture errors
    { const p = freshProject(); delete p.furniture;
      ok(validateProject(p).ok, '6k absent furniture does not trip the guard'); }
  }

  // ---- report ------------------------------------------------------------------------------
  console.log(`\nfurniture-commands: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILED:'); for (const f of fails) console.log('  · ' + f); process.exit(1); }
}

main();
