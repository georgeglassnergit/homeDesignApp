// Units — display formatting + user-input parsing (engine-independent verification).
// Run: node src/test/units.test.mjs
//
// Storage is ALWAYS metres; core/units.js only formats for display and parses what a
// novice types back into metres. That parser is the entry point for every dimension a
// user enters — the inspector's dimension edit (app/inspector.js buildDimensionEdit),
// the polar wall-length entry (main.js), measure tooltips — so a misparse or an
// unhandled form is a real novice-facing papercut. This suite locks the accepted
// grammar (metric + imperial, and decimals / fractions / mixed numbers a person types
// on a tape measure), the format output, and the parse→format round-trip. It has no
// Three.js import — running under plain Node is itself the model/view separation guard.
// Own file (pick-protocol §5) so it never collides with in-flight test work.
import { UNIT, formatLength, parseLength, formatArea } from '../core/units.js';

let pass = 0, fail = 0; const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  FAIL: ' + msg); } }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const IN = 0.0254;

// ---- 1) formatLength — metric --------------------------------------------------------------
{
  ok(formatLength(3.2, UNIT.METRIC) === '3.20 m', '1a 3.2 m -> "3.20 m"');
  ok(formatLength(1, UNIT.METRIC) === '1.00 m', '1b exactly 1 m formats in metres (>= 1 boundary)');
  ok(formatLength(0.42, UNIT.METRIC) === '42 cm', '1c under 1 m falls back to whole cm');
  ok(formatLength(0.005, UNIT.METRIC) === '1 cm', '1d 0.5 cm rounds to 1 cm');
  ok(formatLength(0, UNIT.METRIC) === '0 cm', '1e zero -> "0 cm"');
  ok(formatLength(Infinity) === '—' && formatLength(NaN) === '—', '1f non-finite -> em dash');
}

// ---- 2) formatLength — imperial ------------------------------------------------------------
{
  ok(formatLength(3.048, UNIT.IMPERIAL) === '10′ 0″', '2a 3.048 m -> 10′ 0″');
  ok(formatLength(1.6764, UNIT.IMPERIAL) === '5′ 6″', '2b 1.6764 m -> 5′ 6″');
  // 11.98" rounds to 12" and must carry into the next foot, never print "0′ 12″".
  ok(formatLength(11.98 * IN, UNIT.IMPERIAL) === '1′ 0″', '2c inch rounding carries into feet (no 12″)');
  ok(formatLength(0.0254, UNIT.IMPERIAL) === '0′ 1″', '2d 1 inch -> 0′ 1″');
}

// ---- 3) parseLength — metric forms ---------------------------------------------------------
{
  ok(near(parseLength('3.2'), 3.2), '3a bare number (metric) = metres');
  ok(near(parseLength('3.2m'), 3.2), '3b "3.2m"');
  ok(near(parseLength('3.2 m'), 3.2), '3c "3.2 m" (space)');
  ok(near(parseLength('250cm'), 2.5), '3d "250cm"');
  ok(near(parseLength('250 cm'), 2.5), '3e "250 cm" (space)');
  ok(near(parseLength('45mm'), 0.045), '3f "45mm"');
  ok(near(parseLength('45 mm'), 0.045), '3g "45 mm" (space)');
  ok(near(parseLength('1/2'), 0.5), '3h bare fraction (metric) = half a metre');
  ok(near(parseLength('2 1/2 m'), 2.5), '3i mixed number with metre suffix');
}

// ---- 4) parseLength — imperial forms -------------------------------------------------------
{
  ok(near(parseLength("10'6\"", UNIT.IMPERIAL), (120 + 6) * IN), "4a 10'6\" -> feet+inches");
  ok(near(parseLength("10' 6\"", UNIT.IMPERIAL), (120 + 6) * IN), "4b 10' 6\" (space)");
  ok(near(parseLength("5'6", UNIT.IMPERIAL), (60 + 6) * IN), "4c 5'6 (no inch mark)");
  ok(near(parseLength('10 ft', UNIT.IMPERIAL), 120 * IN), '4d "10 ft"');
  ok(near(parseLength('10 feet', UNIT.IMPERIAL), 120 * IN), '4e "10 feet"');
  ok(near(parseLength('6"', UNIT.IMPERIAL), 6 * IN), '4f inches only "6\\""');
  ok(near(parseLength('6 in', UNIT.IMPERIAL), 6 * IN), '4g "6 in"');
  ok(near(parseLength('8', UNIT.IMPERIAL), 8 * 12 * IN), '4h bare number (imperial) = feet');
  // A literal feet/inch mark means imperial regardless of the UI toggle.
  ok(near(parseLength("10'6\"", UNIT.METRIC), (120 + 6) * IN), '4i feet-inch marks parse imperially even in metric mode');
}

// ---- 5) parseLength — fractions & mixed numbers (the new coverage) --------------------------
{
  ok(near(parseLength('6 1/2"', UNIT.IMPERIAL), 6.5 * IN), '5a "6 1/2\"" = 6.5 inches');
  ok(near(parseLength('1/2"', UNIT.IMPERIAL), 0.5 * IN), '5b "1/2\"" = half inch');
  ok(near(parseLength("5' 6 1/2\"", UNIT.IMPERIAL), (60 + 6.5) * IN), '5c feet + fractional inches');
  ok(near(parseLength('10 1/2', UNIT.IMPERIAL), 10.5 * 12 * IN), '5d bare mixed number (imperial) = 10.5 ft');
  ok(near(parseLength('10-1/2', UNIT.IMPERIAL), 10.5 * 12 * IN), '5e hyphenated mixed number "10-1/2"');
  ok(near(parseLength('3/4 in', UNIT.IMPERIAL), 0.75 * IN), '5f "3/4 in"');
}

// ---- 6) parseLength — bad / edge input cleanly rejected (NaN) -------------------------------
{
  ok(Number.isNaN(parseLength('')), '6a empty string -> NaN');
  ok(Number.isNaN(parseLength('   ')), '6b whitespace -> NaN');
  ok(Number.isNaN(parseLength('abc')), '6c non-numeric -> NaN');
  ok(Number.isNaN(parseLength('1/0"', UNIT.IMPERIAL)), '6d zero denominator -> NaN (not Infinity)');
  ok(Number.isNaN(parseLength('10 ish')), '6e trailing junk -> NaN');
  ok(parseLength(3.2) === 3.2, '6f a number passes through unchanged (idempotent)');
  ok(near(parseLength('  3.2m  '), 3.2), '6g surrounding whitespace tolerated');
  ok(near(parseLength('3.2M'), 3.2), '6h uppercase unit tolerated');
}

// ---- 7) formatArea -------------------------------------------------------------------------
{
  ok(formatArea(48, UNIT.METRIC) === '48.0 m²', '7a metric area to one decimal');
  ok(formatArea(48, UNIT.IMPERIAL) === `${Math.round(48 * 10.7639)} sq ft`, '7b imperial area in sq ft');
  ok(formatArea(NaN) === '—' && formatArea(Infinity) === '—', '7c non-finite area -> em dash (matches formatLength)');
}

// ---- 8) parse -> format round-trip ---------------------------------------------------------
{
  // Parsing a formatted metric length and re-formatting is stable.
  const m1 = parseLength(formatLength(3.2, UNIT.METRIC));           // "3.20 m" -> 3.2
  ok(near(m1, 3.2), '8a metric round-trip 3.2 m');
  // Imperial: format rounds to whole inches, so round-trip is exact on a whole-inch value.
  const impStr = formatLength(1.6764, UNIT.IMPERIAL);               // "5′ 6″"
  // formatLength uses the ′ ″ glyphs; parse accepts ' and ", so normalise for the round-trip.
  const m2 = parseLength(impStr.replace('′', "'").replace('″', '"'), UNIT.IMPERIAL);
  ok(near(m2, 1.6764), '8b imperial round-trip 5′ 6″ (whole inches)');
}

// ---- report --------------------------------------------------------------------------------
console.log(`\nunits: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:'); for (const f of fails) console.log('  · ' + f); process.exit(1); }
