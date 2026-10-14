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

// Parse ONE numeric token that may be a plain decimal ("10.5", "-3.2"), a bare
// fraction ("1/2"), or a mixed number ("10 1/2" / "10-1/2" — the form people
// actually type on an imperial tape). Returns NaN for anything else, and for a
// zero denominator, so a malformed entry is cleanly rejected rather than parsed
// into a bogus length. Kept local: it only makes sense inside parseLength.
function parseNumericToken(tok) {
  const t = tok.trim();
  let m;
  // mixed number: whole + fraction, e.g. "10 1/2" or "10-1/2"
  if ((m = t.match(/^(-?\d+)[\s-]+(\d+)\/(\d+)$/))) {
    const den = parseInt(m[3], 10);
    if (den === 0) return NaN;
    const whole = parseInt(m[1], 10);
    const frac = parseInt(m[2], 10) / den;
    return whole < 0 ? whole - frac : whole + frac;
  }
  // pure fraction, e.g. "1/2" or "-3/4"
  if ((m = t.match(/^(-?\d+)\/(\d+)$/))) {
    const den = parseInt(m[2], 10);
    if (den === 0) return NaN;
    return parseInt(m[1], 10) / den;
  }
  // plain decimal
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
  return NaN;
}

// best-effort parse of user input -> meters. Accepts (metric or imperial, and
// each numeric part may be a decimal, fraction, or mixed number):
//   3.2 · 3.2m · 320cm · 45mm · 10'6" · 10' 6 1/2" · 5'6 · 10 ft · 6" · 6 1/2" ·
//   1/2" · and a bare number/fraction (feet in imperial, metres in metric).
// Returns NaN when nothing matches, so the caller can surface "couldn't read".
export function parseLength(str, system = UNIT.METRIC) {
  if (typeof str === 'number') return str;
  const s = String(str).trim().toLowerCase();
  if (!s) return NaN;
  let m;
  // feet(-and-inches): "<ft>' <in>" — feet is a plain decimal; the optional
  // inch part may be a decimal, fraction, or mixed number, with or without a mark.
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(.*?)\s*(?:"|in|inch|inches)?$/))) {
    const ft = parseFloat(m[1]);
    const inchTok = m[2].trim();
    const inch = inchTok ? parseNumericToken(inchTok) : 0;
    if (isFinite(ft) && isFinite(inch)) return (ft * 12 + inch) * M_PER_IN;
  }
  // inches only: "6"", "6 1/2 in", "1/2 inch"
  if ((m = s.match(/^(.*?)\s*(?:"|in|inch|inches)$/))) {
    const v = parseNumericToken(m[1]);
    if (isFinite(v)) return v * M_PER_IN;
  }
  if ((m = s.match(/^(.*?)\s*cm$/))) { const v = parseNumericToken(m[1]); if (isFinite(v)) return v / 100; }
  if ((m = s.match(/^(.*?)\s*mm$/))) { const v = parseNumericToken(m[1]); if (isFinite(v)) return v / 1000; }
  if ((m = s.match(/^(.*?)\s*m$/)))  { const v = parseNumericToken(m[1]); if (isFinite(v)) return v; }
  // bare number/fraction: feet in imperial, metres in metric
  const v = parseNumericToken(s);
  if (isFinite(v)) return system === UNIT.IMPERIAL ? v * M_PER_IN * 12 : v;
  return NaN;
}

export function formatArea(sqm, system = UNIT.METRIC) {
  if (!isFinite(sqm)) return '—';
  if (system === UNIT.IMPERIAL) return `${Math.round(sqm * 10.7639)} sq ft`;
  return `${sqm.toFixed(1)} m²`;
}
