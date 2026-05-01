import { aimp } from './odds.js';

// Default classification — represents the consensus on which books take sharp
// money. THIS LIST IS A SNAPSHOT and will go stale as books get acquired,
// change ownership, or new sharp shops emerge. Do not edit this list to
// "patch" a single book — instead set localStorage overrides at runtime so
// the user can adjust without redeploying:
//
//   localStorage.setItem('et_sharp_books_add',    JSON.stringify(['NewSharp']))
//   localStorage.setItem('et_sharp_books_remove', JSON.stringify(['Pinnacle']))
//   localStorage.setItem('et_lowvig_books_add',   JSON.stringify(['NewLowVig']))
//   localStorage.setItem('et_lowvig_books_remove',JSON.stringify(['Unibet']))
//
// Reload page to apply. This protects against the "Pinnacle gets acquired by
// a square operator and we keep stamping its lines as sharp money" failure
// mode without requiring a code deploy.
export const SHARP_BOOKS = ['Pinnacle', 'Circa Sports', 'BetOnline.ag', 'Bookmaker', 'BookiePro'];
export const LOWVIG_BOOKS = ['LowVig.ag', 'PropSwap', 'Unibet'];

function _readOverride(key) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
  } catch (_) { return []; }
}

export function getEffectiveSharpBooks() {
  const add = _readOverride('et_sharp_books_add');
  const remove = new Set(_readOverride('et_sharp_books_remove'));
  return [...SHARP_BOOKS, ...add].filter(b => !remove.has(b));
}

export function getEffectiveLowvigBooks() {
  const add = _readOverride('et_lowvig_books_add');
  const remove = new Set(_readOverride('et_lowvig_books_remove'));
  return [...LOWVIG_BOOKS, ...add].filter(b => !remove.has(b));
}

export function getBookTier(b) {
  const sharp = getEffectiveSharpBooks();
  const lowvig = getEffectiveLowvigBooks();
  return sharp.some(s => b.includes(s)) ? 'sharp'
    : lowvig.some(s => b.includes(s)) ? 'lowvig'
    : 'square';
}

export function detectEdges(games) {
  const edges = [];
  games.forEach(g => {
    if (!g.odds?.bookmakers) return;
    const M = {};
    g.odds.bookmakers.forEach(b => {
      b.markets.forEach(m => {
        if (!M[m.key]) M[m.key] = [];
        m.outcomes.forEach(o => { M[m.key].push({ bk: b.title, nm: o.name, pr: o.price, pt: o.point }); });
      });
    });
    Object.keys(M).forEach(mk => {
      const S = {};
      M[mk].forEach(o => {
        const k = o.pt !== undefined ? `${o.nm} ${o.pt}` : o.nm;
        if (!S[k]) S[k] = [];
        S[k].push(o);
      });
      Object.keys(S).forEach(sk => {
        const of2 = S[sk];
        if (of2.length < 2) return;
        const P = of2.map(o => ({ ...o, ip: aimp(o.pr) }));
        const con = P.reduce((s, p) => s + p.ip, 0) / P.length;
        const best = P.reduce((b, p) => p.ip < b.ip ? p : b, P[0]);
        const edge = ((con - best.ip) / con) * 100;
        if (edge > 3) {
          const bt = getBookTier(best.bk);
          edges.push({
            g, mk,
            ml: mk === 'h2h' ? 'ML' : mk === 'spreads' ? 'SPREAD' : 'TOTAL',
            side: sk, bb: best.bk, bp: best.pr, bi: best.ip, con, ep: edge,
            nb: of2.length,
            tier: edge >= 8 ? 'high' : edge >= 5 ? 'med' : 'low',
            bookTier: bt, sharp: bt === 'sharp', lowvig: bt === 'lowvig',
          });
        }
      });
    });
  });
  return edges.sort((a, b) => {
    const ta = a.sharp ? 0 : a.lowvig ? 2 : 1;
    const tb = b.sharp ? 0 : b.lowvig ? 2 : 1;
    return ta !== tb ? ta - tb : b.ep - a.ep;
  });
}

export function calcEV(g, market, pickName) {
  if (!g.odds?.bookmakers?.length) return null;
  const pp = [], op = [];
  g.odds.bookmakers.forEach(b => {
    const m = b.markets.find(x => x.key === market);
    if (!m) return;
    m.outcomes.forEach(o => {
      const key = o.point !== undefined ? `${o.name} ${o.point}` : o.name;
      if (key.includes(pickName) || o.name.includes(pickName.split(' ')[0]))
        pp.push({ pr: o.price, bk: b.title });
      else
        op.push({ pr: o.price, bk: b.title });
    });
  });
  if (!pp.length || !op.length) return null;
  // Filter out invalid prices (NaN from bad odds, undefined, zero) BEFORE
  // averaging — a single bad price corrupts the whole calculation. aimp(0)
  // returns NaN, NaN propagates through reduce, ev becomes NaN, downstream
  // UI displays "NaN%" or hides the data silently.
  const validPP = pp.filter(p => Number.isFinite(p.pr) && p.pr !== 0 && Number.isFinite(aimp(p.pr)));
  const validOP = op.filter(p => Number.isFinite(p.pr) && p.pr !== 0 && Number.isFinite(aimp(p.pr)));
  if (!validPP.length || !validOP.length) return null;
  const pIP = validPP.reduce((s, p) => s + aimp(p.pr), 0) / validPP.length;
  const oIP = validOP.reduce((s, p) => s + aimp(p.pr), 0) / validOP.length;
  const tot = pIP + oIP;
  // Guard against degenerate cases:
  //  - tot === 0: both sides at infinity-american-odds (impossible in real
  //    markets but data corruption can produce it)
  //  - tot is not finite: NaN propagation upstream
  //  - trueP outside [0.01, 0.99]: implied probability of < 1% or > 99%
  //    means corrupted data — refusing to publish a number prevents a 99%
  //    "true probability" from minting a confident-looking pick
  if (!Number.isFinite(tot) || tot <= 0) return null;
  const trueP = pIP / tot;
  if (!Number.isFinite(trueP) || trueP < 0.01 || trueP > 0.99) return null;
  const best = validPP.reduce((b, p) => aimp(p.pr) < aimp(b.pr) ? p : b, validPP[0]);
  const dec = best.pr > 0 ? (best.pr / 100) + 1 : (100 / Math.abs(best.pr)) + 1;
  if (!Number.isFinite(dec) || dec <= 1) return null;
  const ev = (trueP * dec - 1) * 100;
  if (!Number.isFinite(ev)) return null;
  return { ev: +ev.toFixed(1), bp: best.pr, bk: best.bk, tp: (trueP * 100).toFixed(0) };
}

export function getLineRange(g, market) {
  if (!g.odds?.bookmakers?.length) return null;
  const altMkt = market === 'spreads' ? 'alternate_spreads'
    : market === 'totals' ? 'alternate_totals' : null;
  const pts = new Map();
  g.odds.bookmakers.forEach(b => {
    [market, altMkt].filter(Boolean).forEach(mk => {
      const m = b.markets.find(x => x.key === mk);
      if (!m) return;
      m.outcomes.forEach(o => {
        if (o.point === undefined) return;
        if (!pts.has(o.name)) pts.set(o.name, []);
        pts.get(o.name).push(o.point);
      });
    });
  });
  if (!pts.size) return null;
  let txt = '';
  pts.forEach((vals, nm) => {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const label = nm.split(' ').pop() || nm;
    const mnStr = mn < 0 ? mn : '+' + mn;
    const mxStr = mx < 0 ? mx : '+' + mx;
    txt += (txt ? '  ' : '') + label + ' ' + (mn !== mx ? mnStr + ' to ' + mxStr : mnStr);
  });
  return txt || null;
}

export function getSharp(edges) {
  if (!edges.length) return { r: 0, n: 'No data', bars: '' };
  const e = edges.find(e => e.sharp) || edges[0];
  const r = e.ep >= 10 ? 5 : e.ep >= 7 ? 4 : e.ep >= 5 ? 3 : e.ep >= 3 ? 2 : 1;
  const suffix = e.sharp ? ' ⚡' : e.lowvig ? ' ◎' : '';
  return {
    r,
    n: `${e.ep.toFixed(1)}% @ ${e.bb}${suffix}`,
    bars: Array(5).fill(0).map((_, i) => `<div class="sb${i < r ? ' on' : ''}"></div>`).join(''),
  };
}
