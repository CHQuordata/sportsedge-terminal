// Odds math utilities — canonical source used by both index.html (via window assignment) and tests.

export function aimp(p) {
  return p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
}

export function kellyPct(conf, pickStr, evData) {
  const m = (pickStr || '').match(/\(([+-]\d+)\)/);
  const amer = m ? parseInt(m[1]) : (conf === 'HIGH' ? -115 : -110);
  const dec = amer > 0 ? amer / 100 + 1 : 100 / Math.abs(amer) + 1;
  const p = evData?.tp
    ? Math.min(Math.max(parseFloat(evData.tp) / 100, 0.45), 0.75)
    : conf === 'HIGH' ? 0.58 : conf === 'MEDIUM' ? 0.53 : 0.50;
  const k = (p * (dec - 1) - (1 - p)) / (dec - 1);
  return Math.max(0, k * 100);
}
