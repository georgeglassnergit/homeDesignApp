// Units: storage is ALWAYS meters. This module only formats/parses for display,
// so novices can work in feet-and-inches while the model stays metric+precise.

export const UNIT = Object.freeze({ METRIC: 'metric', IMPERIAL: 'imperial' });
const M_PER_IN = 0.0254;

export function formatLength(meters, system = UNIT.METRIC) {
  if (!isFinite(meters)) return '—';
  if (system === UNIT.IMPERIAL) {
    const totalIn = meters / M_PER_IN;
    let ft = Math.floor(totalIn / 12);
    let inch = Math.round(totalIn - ft * 12);
    if (inch === 12) { ft += 1; inch = 0; }
    return `${ft}′ ${inch}″`;
  }
  return meters >= 1 ? `${meters.toFixed(2)} m` : `${Math.round(meters * 100)} cm`;
}

// best-effort parse of user input -> meters. Accepts: 3.2, 3.2m, 320cm, 10'6", 10 ft
export function parseLength(str, system = UNIT.METRIC) {
  if (typeof str === 'number') return str;
  const s = String(str).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)?\s*(?:"|in|inch|inches)?$/))) {
    const ft = parseFloat(m[1]); const inch = m[2] ? parseFloat(m[2]) : 0;
    return (ft * 12 + inch) * M_PER_IN;
  }
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/))) return parseFloat(m[1]) * M_PER_IN;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*cm$/))) return parseFloat(m[1]) / 100;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*mm$/))) return parseFloat(m[1]) / 1000;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*m?$/))) {
    const v = parseFloat(m[1]);
    return system === UNIT.IMPERIAL && !s.endsWith('m') ? v * M_PER_IN * 12 : v; // bare number in imperial = feet
  }
  return NaN;
}

export function formatArea(sqm, system = UNIT.METRIC) {
  if (system === UNIT.IMPERIAL) return `${Math.round(sqm * 10.7639)} sq ft`;
  return `${sqm.toFixed(1)} m²`;
}
