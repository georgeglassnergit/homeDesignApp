// ============================================================================
// E2 · Advisory checks — engine-independent, computed on read (no Three.js).
// Activates the `code-checks` Pro seam.
//
// ── READ THIS FIRST (constraint #6 in docs/PHASE-3-PLAN.md) ──────────────────
// This is a DESIGN / VISUALISATION tool, NOT a code-compliance certifier. Every
// finding here is an APPROXIMATE, ADVISORY nudge against common residential
// rules of thumb — it is NEVER a statement that a design does or does not meet
// any building code, and it is NEVER engineer-certified. The numbers below are
// approachable real-world defaults (metric), documented with the rough real
// rule they echo, and are all overridable. Anything user-facing built on top of
// this MUST surface `ADVISORY_DISCLAIMER`.
//
// Purity / save contract: this module only READS the model (walls, openings,
// rooms, level heights) and returns plain data. It stores nothing, mutates
// nothing, issues no command, and adds no save field — so it cannot touch the
// Phase 1 lossless save (proven in src/test/advisory-checks.test.mjs). It imports
// only pure model helpers; there is no Three.js here.
// ============================================================================

import { polygonArea, wallLength } from './model.js';

// The label every consumer must show near these findings. Not a legal notice —
// a plain-language reminder that this is guidance, not certification.
export const ADVISORY_DISCLAIMER =
  'Advisory only — approximate real-world guidance, not a code-compliance check ' +
  'or engineer-certified. Always confirm against your local building code.';

// Approximate residential rules of thumb, all in metres / m². Each echoes a
// common real-world figure (noted alongside) but is deliberately conservative
// and fully overridable via runAdvisoryChecks(project, { thresholds }).
export const DEFAULT_THRESHOLDS = Object.freeze({
  minCeilingHeight:    2.3,   // habitable-room ceiling ≈ 2.3–2.4 m in many codes
  minRoomArea:         6.5,   // habitable room ≈ 70 sq ft ≈ 6.5 m² (IRC-ish)
  minDoorWidth:        0.76,  // ~30" leaf; accessible clear width wants ~0.81 m
  minDoorHeight:       2.0,   // standard door head ≈ 2.0–2.1 m
  minEgressWindowArea: 0.5,   // emergency-egress opening ≈ 5.7 sq ft ≈ 0.53 m²
  maxEgressSill:       1.1,   // egress window sill ≈ ≤ 1.1 m off the floor
});

// A single finding is plain, serializable data. `severity` is 'advisory' (a
// threshold rule of thumb isn't met) or 'info' (a neutral observation). `ref`
// lets a future UI select/zoom the offending element without re-deriving it.
function finding(code, severity, ref, message, measured, threshold, unit) {
  return { code, severity, ref, message, measured, threshold, unit };
}

const round2 = (n) => Math.round(n * 100) / 100;
const isRoom = (r) => r && Array.isArray(r.points) && r.points.length >= 3;

// The human name of a level, tolerant of a bare/partial level object.
function levelName(level, index) {
  return (level && level.name) || `Level ${index + 1}`;
}

// ── individual checks — each pure, each returns an array of findings ──────────

// A. Ceiling height: the storey's floor-to-ceiling height (level.height) below
//    the habitable minimum. One finding per low storey.
export function checkCeilingHeights(project, t) {
  const out = [];
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  levels.forEach((lvl, i) => {
    const h = lvl && Number(lvl.height);
    if (!(h > 0)) return;                       // invalid heights are validateProject's job
    if (h < t.minCeilingHeight - 1e-9) {
      out.push(finding(
        'ceiling-height', 'advisory',
        { levelId: lvl.id, kind: 'level', id: lvl.id, where: levelName(lvl, i) },
        `${levelName(lvl, i)} ceiling is about ${round2(h)} m — lower than the ~${t.minCeilingHeight} m typical for a habitable room.`,
        round2(h), t.minCeilingHeight, 'm',
      ));
    }
  });
  return out;
}

// B. Room area: a room smaller than a typical habitable room. Worded so it does
//    not read as a defect — a closet/bath is legitimately small.
export function checkRoomAreas(project, t) {
  const out = [];
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  levels.forEach((lvl, i) => {
    const rooms = (lvl && Array.isArray(lvl.rooms)) ? lvl.rooms : [];
    for (const r of rooms) {
      if (!isRoom(r)) continue;
      const area = polygonArea(r.points);
      if (area > 0 && area < t.minRoomArea - 1e-9) {
        out.push(finding(
          'room-area', 'advisory',
          { levelId: lvl.id, kind: 'room', id: r.id, where: `${levelName(lvl, i)} · ${r.name || 'Room'}` },
          `"${r.name || 'Room'}" is about ${round2(area)} m² — smaller than the ~${t.minRoomArea} m² typical for a habitable room (fine for a closet or bath).`,
          round2(area), t.minRoomArea, 'm2',
        ));
      }
    }
  });
  return out;
}

// C. Openings: doors below an accessible/typical clear width or height; windows
//    whose opening is too small, or whose sill is too high, to serve as an
//    emergency egress if the room is a bedroom.
export function checkOpenings(project, t) {
  const out = [];
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  levels.forEach((lvl, i) => {
    const openings = (lvl && Array.isArray(lvl.openings)) ? lvl.openings : [];
    for (const o of openings) {
      if (!o) continue;
      const where = levelName(lvl, i);
      if (o.kind === 'door') {
        if (o.width > 0 && o.width < t.minDoorWidth - 1e-9) {
          out.push(finding(
            'door-width', 'advisory',
            { levelId: lvl.id, kind: 'opening', id: o.id, where },
            `A door is about ${round2(o.width)} m wide — narrower than the ~${t.minDoorWidth} m accessible clear width.`,
            round2(o.width), t.minDoorWidth, 'm',
          ));
        }
        if (o.height > 0 && o.height < t.minDoorHeight - 1e-9) {
          out.push(finding(
            'door-height', 'advisory',
            { levelId: lvl.id, kind: 'opening', id: o.id, where },
            `A door is about ${round2(o.height)} m tall — lower than the ~${t.minDoorHeight} m typical head height.`,
            round2(o.height), t.minDoorHeight, 'm',
          ));
        }
      } else if (o.kind === 'window') {
        const area = (o.width > 0 && o.height > 0) ? o.width * o.height : 0;
        if (area > 0 && area < t.minEgressWindowArea - 1e-9) {
          out.push(finding(
            'window-egress-area', 'advisory',
            { levelId: lvl.id, kind: 'opening', id: o.id, where },
            `A window's opening is about ${round2(area)} m² — below the ~${t.minEgressWindowArea} m² an emergency-egress window needs (matters if this room is a bedroom).`,
            round2(area), t.minEgressWindowArea, 'm2',
          ));
        }
        if (o.sill != null && o.sill > t.maxEgressSill + 1e-9) {
          out.push(finding(
            'window-egress-sill', 'advisory',
            { levelId: lvl.id, kind: 'opening', id: o.id, where },
            `A window sill sits about ${round2(o.sill)} m off the floor — higher than the ~${t.maxEgressSill} m an egress window allows (matters if this room is a bedroom).`,
            round2(o.sill), t.maxEgressSill, 'm',
          ));
        }
      }
    }
  });
  return out;
}

// D. Storey habitability: a storey that has rooms but no window at all (natural
//    light / ventilation), or rooms but no door at all (access). Whole-storey
//    scope keeps this robust without associating each opening to a room.
export function checkStoreyHabitability(project) {
  const out = [];
  const levels = (project && Array.isArray(project.levels)) ? project.levels : [];
  levels.forEach((lvl, i) => {
    const rooms = (lvl && Array.isArray(lvl.rooms)) ? lvl.rooms : [];
    const roomCount = rooms.filter(isRoom).length;
    if (roomCount === 0) return;                // nothing enclosed yet — nothing to advise
    const openings = (lvl && Array.isArray(lvl.openings)) ? lvl.openings : [];
    const windows = openings.filter((o) => o && o.kind === 'window').length;
    const doors = openings.filter((o) => o && o.kind === 'door').length;
    const where = levelName(lvl, i);
    if (windows === 0) {
      out.push(finding(
        'storey-natural-light', 'advisory',
        { levelId: lvl.id, kind: 'level', id: lvl.id, where },
        `${where} has ${roomCount} room${roomCount === 1 ? '' : 's'} but no windows — natural light and ventilation may be inadequate.`,
        0, 1, 'count',
      ));
    }
    if (doors === 0) {
      out.push(finding(
        'storey-access', 'advisory',
        { levelId: lvl.id, kind: 'level', id: lvl.id, where },
        `${where} has ${roomCount} room${roomCount === 1 ? '' : 's'} but no doorways — rooms may be inaccessible.`,
        0, 1, 'count',
      ));
    }
  });
  return out;
}

// ── the entry point ──────────────────────────────────────────────────────────
// Run every advisory check over a project and return a flat, ordered result:
//   { findings: [...], counts: {advisory, info, total}, byCode: {code: n},
//     disclaimer, thresholds }
// Deterministic order (checks in A→D order, elements in model order) so a UI
// list and the tests are stable. Never throws on a malformed/partial project —
// each check is defensive — so an in-progress design can be checked live.
export function runAdvisoryChecks(project, opts = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const findings = [
    ...checkCeilingHeights(project, t),
    ...checkRoomAreas(project, t),
    ...checkOpenings(project, t),
    ...checkStoreyHabitability(project),
  ];
  const counts = { advisory: 0, info: 0, total: findings.length };
  const byCode = {};
  for (const f of findings) {
    if (f.severity === 'info') counts.info++; else counts.advisory++;
    byCode[f.code] = (byCode[f.code] || 0) + 1;
  }
  return { findings, counts, byCode, disclaimer: ADVISORY_DISCLAIMER, thresholds: t };
}

// A one-line headline for a toolbar/badge, e.g. "3 advisories" / "All clear".
// Purely derived from a runAdvisoryChecks result; carries no compliance claim.
export function advisorySummary(result) {
  const n = (result && result.counts && result.counts.advisory) || 0;
  if (n === 0) return 'No advisories';
  return `${n} ${n === 1 ? 'advisory' : 'advisories'}`;
}
