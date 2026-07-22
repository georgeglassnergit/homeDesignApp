// edit/measure.js — the measure tool's pure math (the Pro-seam "measure-tool").
// Engine-independent: no Three.js, no DOM. A measurement is two plan points; the
// tool holds them as VIEW state (never the model — measuring changes nothing), and
// this module turns them into a distance + a units-formatted label + a midpoint for
// the plan renderer to place the label. Importing it under Node is itself the
// model/view-separation guard.
import { formatLength, UNIT } from '../core/units.js';

// Straight-line plan distance between two {x,z} points, in metres.
export function measureDistance(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

// Midpoint of the measurement — where the plan view anchors the distance label.
export function measureMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

// Describe a (possibly incomplete) measurement for display. Returns null until both
// endpoints exist. `to` may be a live preview point (mouse position) or the committed
// second click — the caller decides via `complete`.
export function describeMeasure(measure, system = UNIT.METRIC) {
  if (!measure || !measure.from || !measure.to) return null;
  const meters = measureDistance(measure.from, measure.to);
  return {
    meters,
    label: formatLength(meters, system),
    mid: measureMidpoint(measure.from, measure.to),
    complete: !!measure.complete,
  };
}
