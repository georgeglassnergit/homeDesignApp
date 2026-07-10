// core/units.js — display formatting/parsing only. Storage is ALWAYS meters.
const FT_TO_M = 0.3048, IN_TO_M = 0.0254;

export function parseLength(input, mode = 'metric') {
  if (typeof input === 'number') return input;
  const s = String(input).trim().toLowerCase();
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meter|meters)?$/);
  if (m && (m[2] || mode === 'metric')) return parseFloat(m[1]);
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*cm$/); if (m) return parseFloat(m[1]) / 100;
  m = s.match(/^(-?\d+(?:\.\d+)?)\s*mm$/); if (m) return parseFloat(m[1]) / 1000;
  m = s.match(/^(?:(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet))?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches))?$/);
  if (m && (m[1] || m[2])) {
    const ft = m[1] ? parseFloat(m[1]) : 0, inch = m[2] ? parseFloat(m[2]) : 0;
    return ft * FT_TO_M + inch * IN_TO_M;
  }
  m = s.match(/^(-?\d+(?:\.\d+)?)$/);
  if (m) return mode === 'imperial' ? parseFloat(m[1]) * IN_TO_M : parseFloat(m[1]);
  return NaN;
}

export function formatLength(meters, mode = 'metric') {
  if (mode === 'imperial') {
    const totalIn = meters / IN_TO_M;
    const ft = Math.floor(totalIn / 12);
    const inch = Math.round((totalIn - ft * 12) * 10) / 10;
    if (ft && inch) return `${ft}'${inch}"`;
    if (ft) return `${ft}'`;
    return `${inch}"`;
  }
  return `${Math.round(meters * 1000) / 1000}m`;
}

export function formatArea(sqm, mode = 'metric') {
  if (mode === 'imperial') return `${Math.round(sqm / (FT_TO_M * FT_TO_M))} ft2`;
  return `${Math.round(sqm * 100) / 100} m2`;
}
