// ESPN response parsers — canonical source used by both index.html and tests.

export function extractPitchers(d) {
  const comp = d?.header?.competitions?.[0];
  if (!comp) return null;
  const res = {};
  (comp.competitors || []).forEach(c => {
    const p = c.probables?.[0];
    if (!p?.athlete) return;
    const cats = p.statistics?.splits?.categories || [];
    const sv = n => cats.find(x => x.name === n);
    const fi = sv('fullInnings')?.value || 0, pi = sv('partInnings')?.value || 0;
    const ip = fi + pi / 3;
    const k = sv('strikeouts')?.value || 0;
    const bb = sv('baseOnBalls')?.value || sv('walks')?.value || 0;
    const hr = sv('homeRunsAllowed')?.value || sv('homeRuns')?.value || 0;
    res[c.homeAway] = {
      name: p.athlete.shortName || p.athlete.fullName,
      hand: p.athlete.throws?.abbreviation || '?',
      era: sv('ERA')?.displayValue || '--',
      whip: sv('WHIP')?.displayValue || '--',
      ip: ip.toFixed(1),
      k9: ip > 1 ? (k / ip * 9).toFixed(1) : '--',
      bb9: ip > 1 ? (bb / ip * 9).toFixed(1) : '--',
      hr9: ip > 1 ? (hr / ip * 9).toFixed(1) : '--',
      w: sv('wins')?.value || 0,
      l: sv('losses')?.value || 0,
    };
  });
  return Object.keys(res).length ? res : null;
}

export function extractNBAStats(d) {
  if (!d) return null;
  const all = [];
  // ESPN returns stats under several different response shapes depending on endpoint
  const cats = d.results?.stats?.categories
    || d.results?.splits?.categories
    || d.splits?.categories
    || d.statistics?.splits?.categories
    || d.categories
    || [];
  (Array.isArray(cats) ? cats : []).forEach(c => (c.stats || []).forEach(s => all.push(s)));
  const dv = (...names) => { for (const n of names) { const s = all.find(x => x.name === n); if (s?.displayValue) return s.displayValue; } return null; };
  const nv = (...names) => { for (const n of names) { const s = all.find(x => x.name === n); if (s?.value != null) return s.value; } return null; };
  const ppg = dv('avgPoints', 'avgPointsPerGame', 'points');
  // ESPN core API uses avgPointsAllowed on site endpoint; core v2 may use avgOpponentPoints or avgDefPoints
  const oppPpg = dv('avgPointsAllowed', 'avgOpponentPoints', 'avgDefPoints', 'opponentAvgPoints', 'avgPointsAgainst');
  const netPts = (ppg && oppPpg) ? (parseFloat(ppg) - parseFloat(oppPpg)).toFixed(1) : null;
  const paceVal = nv('pace', 'avgPossessions', 'possessionsPerGame', 'avgPace');
  const pace = paceVal != null ? parseFloat(paceVal.toFixed ? paceVal.toFixed(1) : paceVal) : null;
  return {
    ppg, fgPct: dv('fieldGoalPct', 'fieldGoalPercentage'), tpPct: dv('threePointPct', 'threePointPercentage'), ftPct: dv('freeThrowPct', 'freeThrowPercentage'),
    scEff: dv('scoringEfficiency'), shEff: dv('shootingEfficiency'),
    ast: dv('avgAssists'), reb: dv('avgRebounds'), blk: dv('avgBlocks'), stl: dv('avgSteals'),
    oppPpg, netPts, toPg: dv('avgTurnovers'), pace,
  };
}

export function extractNHLStats(d) {
  if (!d) return null;
  const all = [];
  const cats = d.splits?.categories || d.results?.stats?.categories || [];
  (Array.isArray(cats) ? cats : []).forEach(c => (c.stats || []).forEach(s => all.push(s)));
  const dv = n => { const s = all.find(x => x.name === n); return s?.displayValue || null; };
  const v = n => { const s = all.find(x => x.name === n); return s?.value ?? null; };
  const gp = v('games') || 1;
  const goals = v('goals'), goalsAg = v('goalsAgainst');
  const ppPct = v('powerPlayPct') != null ? v('powerPlayPct').toFixed(1) : dv('powerPlayPct') || null;
  const pkPct = v('penaltyKillPct') != null ? v('penaltyKillPct').toFixed(1) : dv('penaltyKillPct') || null;
  const net = goals != null && goalsAg != null ? ((goals - goalsAg) / gp).toFixed(2) : null;
  return {
    gaa: v('avgGoalsAgainst') != null ? v('avgGoalsAgainst').toFixed(2) : dv('avgGoalsAgainst'),
    savePct: v('savePct') != null ? v('savePct').toFixed(3) : dv('savePct'),
    gpg: goals != null ? (goals / gp).toFixed(2) : null,
    shotsPg: v('shotsTotal') != null ? (v('shotsTotal') / gp).toFixed(1) : null,
    shootPct: v('shootingPct') != null ? v('shootingPct').toFixed(1) : dv('shootingPct'),
    foPct: v('faceoffPercent') != null ? v('faceoffPercent').toFixed(1) : dv('faceoffPercent'),
    ppg: v('powerPlayGoals'), ppPct, pkPct, net,
  };
}
