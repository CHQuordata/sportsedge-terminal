const ALLOWED_ORIGIN = 'https://chquordata.github.io';
const PINNACLE_MMA_SPORT = 7;
const PINNACLE_TENNIS_SPORT = 33;
const CRON_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];
const PINNACLE_SPORT_IDS = {
  basketball_nba: 4,
  icehockey_nhl: 19,
  baseball_mlb: 3,
  american_football_nfl: 15,
  tennis: 33,
  mma: 7,
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/pinnacle/mma') {
        const data = await getPinnacleOdds(env, PINNACLE_MMA_SPORT);
        return jsonResponse(data);
      }
      if (path === '/pinnacle/tennis') {
        const data = await getPinnacleOdds(env, PINNACLE_TENNIS_SPORT);
        return jsonResponse(data);
      }
      if (path === '/pinnacle/odds') {
        const sp = url.searchParams.get('sport');
        const key = sp?.startsWith('tennis_') ? 'tennis' : sp;
        const sportId = PINNACLE_SPORT_IDS[key];
        if (!sportId) return jsonResponse({ error: 'Unknown sport' }, 400);
        const data = await getPinnacleOdds(env, sportId);
        return jsonResponse(data);
      }
      if (path === '/health') {
        return jsonResponse({ status: 'ok', version: '2.1' });
      }
      // Tennis Abstract player stats — third-tier fallback when matchstat and
      // Sackmann are both blank. Returns parsed surface W-L when available,
      // null on parse failure. KV-cached 24h to be polite to TA.
      if (path === '/tennis/ta' && request.method === 'GET') {
        const name = url.searchParams.get('name');
        if (!name) return jsonResponse({ error: 'Missing name' }, 400);
        return handleTennisAbstract(name, env);
      }
      // KV read: GET /kv/:key
      if (path.startsWith('/kv/') && request.method === 'GET') {
        return handleKvGet(path.slice(4), env);
      }
      // KV write: POST /kv/:key  body: { value: "<string>" }
      if (path.startsWith('/kv/') && request.method === 'POST') {
        return handleKvPost(path.slice(4), request, env);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyCron(env));
  }
};

// ── KV handlers ──────────────────────────────────────────────────────────────

async function handleKvGet(key, env) {
  if (!env.LEARNING_STORE) return jsonResponse({ error: 'KV not configured' }, 503);
  const val = await env.LEARNING_STORE.get(key);
  if (val === null) return jsonResponse({ value: null });
  return jsonResponse({ value: val });
}

async function handleKvPost(key, request, env) {
  if (!env.LEARNING_STORE) return jsonResponse({ error: 'KV not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  if (body.value === undefined) return jsonResponse({ error: 'Missing value' }, 400);
  const strVal = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
  await env.LEARNING_STORE.put(key, strVal, { expirationTtl: 60 * 60 * 24 * 90 }); // 90-day TTL
  return jsonResponse({ ok: true });
}

// ── Nightly cron ─────────────────────────────────────────────────────────────

async function runNightlyCron(env) {
  if (!env.ODDS_API_KEY || !env.LEARNING_STORE) return;

  // 1. Fetch completed scores across all active sports
  const completedGames = await fetchAllCompletedScores(env.ODDS_API_KEY);

  // 2. Store raw completed games for the frontend to pull as training data
  await env.LEARNING_STORE.put('et_completed_games', JSON.stringify({
    ts: Date.now(),
    games: completedGames
  }), { expirationTtl: 60 * 60 * 24 * 4 }); // 4-day TTL

  // 3. Read pick history from KV, auto-grade ungraded picks
  const historyRaw = await env.LEARNING_STORE.get('et_picks_history');
  if (!historyRaw) return;

  let history;
  try { history = JSON.parse(historyRaw); } catch { return; }

  let changed = false;
  history.forEach(slate => {
    (slate.picks || []).forEach(pick => {
      if (pick.result && pick.result !== '?') return;
      const result = gradePickFromScore(pick, completedGames);
      if (result) { pick.result = result; changed = true; }
    });
    // Also update grading array if present
    if (slate.grading) {
      slate.grading.forEach(g => {
        if (g.result && g.result !== '?') return;
        const matched = (slate.picks || []).find(p =>
          p.pick === g.pick ||
          (p.matchup && g.matchup && p.matchup.toLowerCase() === g.matchup.toLowerCase())
        );
        if (matched?.result) { g.result = matched.result; changed = true; }
      });
    }
  });

  if (changed) {
    await env.LEARNING_STORE.put('et_picks_history', JSON.stringify(history.slice(0, 30)));
  }

  // 4. Learning agent — runs whenever new picks were graded
  if (changed) {
    await runLearningAgent(env, history);
  }
}

// ── Learning agent ────────────────────────────────────────────────────────────

// Signal performance is computed deterministically from graded pick history.
// No Claude needed — just count W/L/P per signal tag across the last 30 days.
function computeSignalPerformance(history) {
  const perf = {};
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  history.forEach(slate => {
    if (new Date(slate.date).getTime() < cutoff) return;
    (slate.picks || []).forEach(pick => {
      if (!pick.result || pick.result === '?') return;
      // Merge Phase 2 filter tags + Phase 1 signal names — deduplicated via Set
      const tags = new Set([
        ...(pick.filters || []).map(t => t.toLowerCase().replace(/\s+/g, '_')),
        ...(pick.phase1_signals || [])
      ]);
      tags.forEach(tag => {
        if (!tag) return;
        if (!perf[tag]) perf[tag] = { w: 0, l: 0, p: 0 };
        if (pick.result === 'W') perf[tag].w++;
        else if (pick.result === 'L') perf[tag].l++;
        else if (pick.result === 'P') perf[tag].p++;
      });
    });
  });
  return perf;
}

async function runLearningAgent(env, history) {
  // Always recompute signal performance — deterministic, cheap, always accurate
  const perf = computeSignalPerformance(history);
  await env.LEARNING_STORE.put(
    'et_signal_performance',
    JSON.stringify(perf),
    { expirationTtl: 60 * 60 * 24 * 365 }
  );

  // Claude call for narrative rule extraction — requires CLAUDE_API_KEY secret
  if (!env.CLAUDE_API_KEY) return;

  // Collect picks from the last 7 days with confirmed results
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentBySport = { tennis: [], nba: [], mlb: [], nhl: [] };
  history.forEach(slate => {
    if (new Date(slate.date).getTime() < cutoff) return;
    (slate.picks || []).forEach(pick => {
      if (!pick.result || pick.result === '?') return;
      const sport = (pick.sport || '').toLowerCase();
      if (recentBySport[sport]) recentBySport[sport].push(pick);
    });
  });

  const totalRecent = Object.values(recentBySport).reduce((s, a) => s + a.length, 0);
  if (totalRecent < 5) return; // not enough data for meaningful lessons

  // Read existing sport-specific rules
  const sports = ['tennis', 'nba', 'mlb', 'nhl'];
  const existingRules = await Promise.all(
    sports.map(s => env.LEARNING_STORE.get(`et_learned_rules_${s}`))
  );
  const rulesMap = Object.fromEntries(sports.map((s, i) => [s, existingRules[i] || '']));

  // Build picks block grouped by sport
  let picksBlock = '';
  for (const [sport, picks] of Object.entries(recentBySport)) {
    if (!picks.length) continue;
    picksBlock += `\n${sport.toUpperCase()} (${picks.length} picks, last 7d):\n`;
    picks.forEach(p => {
      const tags = (p.filters || []).join(', ') || 'no signal tags';
      const conf = p.confidence || '?';
      picksBlock += `  ${p.result} | ${conf} | ${p.matchup || ''} | ${p.pick || ''} | signals: ${tags}\n`;
    });
  }

  // Build signal performance summary for context
  const perfSummary = Object.entries(perf)
    .filter(([, v]) => v.w + v.l > 0)
    .sort(([, a], [, b]) => (b.w + b.l) - (a.w + a.l))
    .slice(0, 20)
    .map(([tag, v]) => {
      const total = v.w + v.l + v.p;
      const wr = total > 0 ? Math.round(v.w / (v.w + v.l) * 100) : 0;
      return `  ${tag}: ${v.w}-${v.l}${v.p ? '-' + v.p : ''} (${wr}% WR, ${total} picks)`;
    })
    .join('\n');

  const existingRulesBlock = Object.entries(rulesMap)
    .filter(([, r]) => r)
    .map(([s, r]) => `${s.toUpperCase()} RULES:\n${r}`)
    .join('\n\n');

  const userMsg =
`GRADED PICKS — last 7 days:
${picksBlock}

SIGNAL PERFORMANCE — last 30 days (all graded picks):
${perfSummary || '(insufficient data yet)'}

EXISTING LEARNED RULES:
${existingRulesBlock || '(none yet)'}

Instructions:
- Analyze the pick results above by sport.
- For each sport that has graded picks: identify what's working and what isn't.

DECAY POLICY — apply to EVERY existing rule before considering preservation:
- DROP any rule whose referenced signal has FEWER THAN 3 picks in the last 30 days. Stale signals that don't appear in recent data must not persist — they were either learned from a different season, a tournament that's no longer running, or a pattern the system has stopped triggering on. A rule with no current evidence is noise.
- DROP any rule whose referenced signal has win rate ≤40% with sample ≥10 in the last 30 days. The signal is actively losing money; preserving the rule is worse than having no rule.
- DROP any rule that depends on a player, team, or tournament-specific name that doesn't appear in any pick from the last 14 days. Roster moves, retirements, and tournament substitutions invalidate name-specific rules quickly.
- DOWN-PROMOTE (rewrite as softer "context only" guidance, max 15 words) any rule whose signal has 41-49% WR with sample ≥10. It's not a clear edge, just a weak lean.

PRESERVATION CRITERIA — a rule survives only if ALL hold:
- Referenced signal has ≥3 picks in last 30d
- Referenced signal has ≥50% WR (or strict policy rule from CLAUDE.md that does not depend on win rate, e.g. "never use SH%")
- Rule is still consistent with the pick reasoning patterns in the last 7 days

ADDITION CRITERIA — only add new rules when:
- Sample ≥5 picks for the new pattern in last 30d
- Win rate ≥55% on that pattern
- The pattern is reproducible (not just one hot streak with the same pick)

OUTPUT REQUIREMENTS:
- Max 10 rules per sport (down from 12 — be aggressive about pruning)
- Each rule max 20 words, name the exact signal/condition/outcome
- It is BETTER to have 3 strong rules than 10 weak ones — if a sport has no signals meeting preservation criteria, return an empty string for that sport's rules rather than preserving stale ones
- If a sport has 0 graded picks in the last 30d, return its existing rules unchanged (no data = can't decay)
- Output raw JSON only. No markdown fences.

Output format (all 4 sport fields required even if unchanged):
{"tennis_rules":"rule1\\nrule2\\n...","nba_rules":"...","mlb_rules":"...","nhl_rules":"..."}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'You are a sports betting signal analyst. Extract learned rules from graded pick results. Output raw JSON only — start with { immediately, no markdown.',
        messages: [{ role: 'user', content: userMsg }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) return;
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const raw = (text.match(/(\{[\s\S]+\})/) || [])[1] || text.trim();
    if (!raw.startsWith('{')) return;

    const result = JSON.parse(raw);

    const ruleKeyMap = {
      tennis_rules: 'et_learned_rules_tennis',
      nba_rules:    'et_learned_rules_nba',
      mlb_rules:    'et_learned_rules_mlb',
      nhl_rules:    'et_learned_rules_nhl'
    };

    await Promise.allSettled(
      Object.entries(ruleKeyMap).map(([field, kvKey]) => {
        if (!result[field]) return Promise.resolve();
        return env.LEARNING_STORE.put(kvKey, result[field], { expirationTtl: 60 * 60 * 24 * 365 });
      })
    );
  } catch (_) {}
}

// ── Score fetching ────────────────────────────────────────────────────────────

async function fetchAllCompletedScores(apiKey) {
  const sports = [...CRON_SPORTS];

  // Discover active tennis sport keys
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
    if (r.ok) {
      const all = await r.json();
      const tennis = all.filter(s => s.active && s.key.startsWith('tennis_')).slice(0, 8).map(s => s.key);
      sports.push(...tennis);
    }
  } catch (_) {}

  const results = [];
  await Promise.allSettled(sports.map(async sport => {
    try {
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/?daysFrom=3&apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) return;
      const data = await r.json();
      data.filter(g => g.completed).forEach(g => results.push({ sport, ...g }));
    } catch (_) {}
  }));

  return results;
}

// ── Pick grading ──────────────────────────────────────────────────────────────
// Matches a stored pick against completed game scores and returns W / L / P / null

// Normalize a team / player name for matching. Lowercase, strip punctuation,
// collapse whitespace, drop common league/sport suffixes.
function _normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find the unique game matching a pick's matchup string. Returns the game
// object only when BOTH sides of the matchup map to the same game (one to
// home, one to away). Returns null on no match OR ambiguous match (more than
// one game contains a side). This eliminates the substring-matching false
// positives that the old code had — e.g. "LA" matching both Lakers and
// Clippers, or short tokens hitting multiple teams.
//
// AMBIGUOUS_TOKENS is a blacklist of city codes / shared prefixes that, on
// their own, do not uniquely identify a team. Tokens NOT in this list are
// accepted at any length (so "Sox", "Mets", "Cubs" still work) — only the
// short ambiguous ones are filtered.
const _AMBIG_TOKS = new Set([
  'la','ny','sf','st','nj','tb','nb','ne','sd','gs','was','wsh','nyc','los',
  'new','san','the','los angeles','new york'
]);
function findGameForPick(matchup, games) {
  const m = _normName(matchup);
  if (!m) return null;
  // Split matchup into two sides on common separators
  const parts = m.split(/\s+(?:@|vs|v)\s+|\s*,\s*|\s*\|\s*/).filter(Boolean);
  if (parts.length < 2) {
    // Fall back: try splitting on " at " (some MLB/NFL formats)
    const alt = m.split(/\s+at\s+/);
    if (alt.length === 2) parts.push(...alt);
  }
  if (parts.length < 2) return null;
  const [side1, side2] = parts;
  const _toks = s => s.split(/\s+/).filter(w => w.length >= 3 && !_AMBIG_TOKS.has(w));
  const sideMatches = (side, team) => {
    const t = _normName(team);
    const sideToks = _toks(side);
    if (sideToks.some(w => t.includes(w))) return true;
    // Try team's last word back-referenced into side text
    const tLast = t.split(/\s+/).pop();
    if (tLast && tLast.length >= 3 && !_AMBIG_TOKS.has(tLast) && side.includes(tLast)) return true;
    return false;
  };
  const candidates = games.filter(g => {
    const ht = g.home_team, at = g.away_team;
    return (sideMatches(side1, ht) && sideMatches(side2, at)) ||
           (sideMatches(side1, at) && sideMatches(side2, ht));
  });
  // Strict: only return if exactly ONE game matches. Ambiguous → null →
  // pick stays ungraded rather than getting a wrong result.
  return candidates.length === 1 ? candidates[0] : null;
}

function gradePickFromScore(pick, games) {
  const pt = pick.pick || '';
  const matchup = pick.matchup || '';
  const game = findGameForPick(matchup, games);
  if (!game?.scores?.length) return null;

  // Tennis routes through a dedicated grader regardless of score format —
  // numeric-sets-won responses would otherwise fall through to team-sport
  // logic and grade incorrectly (a 2-0 sets win is not a 2-0 ML in points).
  if ((pick.sport || '').toLowerCase() === 'tennis') {
    return gradeTennisPick(pick, game);
  }

  const homeS = parseFloat(game.scores.find(s => s.name === game.home_team)?.score ?? 'NaN');
  const awayS = parseFloat(game.scores.find(s => s.name === game.away_team)?.score ?? 'NaN');
  if (isNaN(homeS) || isNaN(awayS)) return null;

  const ptL = pt.toLowerCase();

  // Resolve which side (home/away) of the game a pick references. Uses the
  // same 4+ char word-matching as findGameForPick so cross-team collisions
  // (e.g. "LA" hitting both Lakers and Clippers) cannot happen here either.
  const pickSideIsHome = (pickStr) => {
    const ht = _normName(game.home_team), at = _normName(game.away_team);
    const p = _normName(pickStr);
    const words = p.split(/\s+/).filter(w => w.length >= 3 && !_AMBIG_TOKS.has(w));
    const inH = words.some(w => ht.includes(w));
    const inA = words.some(w => at.includes(w));
    if (inH && !inA) return true;
    if (inA && !inH) return false;
    // Fallback: check if either team's last word (3+ chars, not ambig) appears in pick
    const hLast = ht.split(/\s+/).pop(), aLast = at.split(/\s+/).pop();
    if (hLast && hLast.length >= 3 && !_AMBIG_TOKS.has(hLast) && p.includes(hLast)) return true;
    if (aLast && aLast.length >= 3 && !_AMBIG_TOKS.has(aLast) && p.includes(aLast)) return false;
    return null; // ambiguous — caller should treat as ungraded
  };

  // Total (Over/Under) — does not need home/away resolution
  if (ptL.includes('over') || ptL.includes('under')) {
    const n = parseFloat((pt.match(/(\d+\.?\d*)/) || [])[1] || 'NaN');
    if (isNaN(n)) return null;
    const combined = homeS + awayS;
    if (Math.abs(combined - n) < 0.01) return 'P';
    return (ptL.includes('over') ? combined > n : combined < n) ? 'W' : 'L';
  }

  // Spread: "Team -3.5 (-110)" or "Team +3.5 (-110)" or "Team +0 (-110)"
  // Widened from old regex to also accept decimal-only spreads (e.g. ".5")
  // and bare integers (e.g. "+0" without trailing decimal).
  const spM = pt.match(/^(.+?)\s+([+-]?\d*\.?\d+)\s*\(/);
  if (spM) {
    const spread = parseFloat(spM[2]);
    if (isNaN(spread)) return null;
    const isHome = pickSideIsHome(spM[1]);
    if (isHome === null) return null;
    const margin = (isHome ? homeS - awayS : awayS - homeS) + spread;
    if (Math.abs(margin) < 0.01) return 'P';
    return margin > 0 ? 'W' : 'L';
  }

  // ML: "Team ML (-150)" or "Team (-150)" with 3-digit odds
  const mlM = pt.match(/^(.+?)\s+(?:ML\s*)?\(?[+-]?(\d{3,})/i);
  if (mlM) {
    const isHome = pickSideIsHome(mlM[1]);
    if (isHome === null) return null;
    const pS = isHome ? homeS : awayS, oS = isHome ? awayS : homeS;
    if (pS === oS) return 'P';
    return pS > oS ? 'W' : 'L';
  }

  return null;
}

// ── Tennis grading ────────────────────────────────────────────────────────────
// Tennis pick formats:
//   "Player Last ML (+144)"            → moneyline
//   "Player Last -2.5 games (-110)"    → game spread (sum games across all sets)
//   "UNDER 22.5 total games (-110)"    → total games O/U
//   "Player Last -1.5 sets (+150)"     → set spread (rare)
//
// Odds API tennis scores come in two formats depending on event:
//   (a) Numeric sets won:    [{name:"Carlos Alcaraz", score:"2"}, ...]
//   (b) Per-set game counts: [{name:"Alcaraz", score:"6,4,6"}, {name:"X", score:"3,6,4"}]
// We grade ML reliably from either format; spread/total grading requires
// per-set game data and returns null if only set counts are available.

function _parseTennisScores(game) {
  const s1 = game.scores?.find(s => s.name === game.home_team);
  const s2 = game.scores?.find(s => s.name === game.away_team);
  if (!s1 || !s2) return null;
  const raw1 = String(s1.score || '').trim(), raw2 = String(s2.score || '').trim();
  // Per-set format requires EXPLICIT multi-set separator (space, comma, or
  // semicolon) — never hyphen alone, since "2-1" is ambiguous (could be
  // one-set games or a sets-won shorthand). When in doubt, fall back to the
  // numeric sets-won path which is safer.
  const isPerSet = /[,\s;]/.test(raw1) || /[,\s;]/.test(raw2);
  if (isPerSet) {
    const parseSets = s => s.split(/[,\s;]+/).filter(Boolean).map(g => {
      // Strip any non-digit characters (e.g. tiebreak parens "7(5)" → "75",
      // but we only need the leading game count for set-win comparison)
      const lead = String(g).match(/^\d+/);
      return lead ? parseInt(lead[0], 10) : null;
    }).filter(n => n !== null && !isNaN(n));
    const homeGames = parseSets(raw1), awayGames = parseSets(raw2);
    if (!homeGames.length || !awayGames.length) return null;
    const homeTotal = homeGames.reduce((a, b) => a + b, 0);
    const awayTotal = awayGames.reduce((a, b) => a + b, 0);
    // Sets won = sets where that side has more games (a 7-6 tiebreak set
    // still counts as one won — leading-digit parse handles "7(5)" form)
    const len = Math.min(homeGames.length, awayGames.length);
    let homeSets = 0, awaySets = 0;
    for (let i = 0; i < len; i++) {
      if (homeGames[i] > awayGames[i]) homeSets++;
      else if (awayGames[i] > homeGames[i]) awaySets++;
    }
    return { hasGameDetail: true, homeGames: homeTotal, awayGames: awayTotal, homeSets, awaySets };
  }
  // Numeric sets-won format. parseInt with leading-digit fallback handles
  // edge cases like "2.0" or "  2 " gracefully.
  const lead1 = raw1.match(/^\d+/), lead2 = raw2.match(/^\d+/);
  if (!lead1 || !lead2) return null;
  const n1 = parseInt(lead1[0], 10), n2 = parseInt(lead2[0], 10);
  if (isNaN(n1) || isNaN(n2)) return null;
  return { hasGameDetail: false, homeSets: n1, awaySets: n2 };
}

function gradeTennisPick(pick, game) {
  const pt = pick.pick || '';
  const ptL = pt.toLowerCase();
  const ts = _parseTennisScores(game);
  if (!ts) return null;
  const homeWon = ts.homeSets > ts.awaySets;
  const awayWon = ts.awaySets > ts.homeSets;
  if (!homeWon && !awayWon) return null; // tied — bad data

  // Total games O/U — requires per-set detail
  if (ptL.includes('over') || ptL.includes('under')) {
    if (!ts.hasGameDetail) return null;
    const n = parseFloat((pt.match(/(\d+\.?\d*)/) || [])[1] || 'NaN');
    if (isNaN(n)) return null;
    const combined = ts.homeGames + ts.awayGames;
    if (Math.abs(combined - n) < 0.01) return 'P';
    return (ptL.includes('over') ? combined > n : combined < n) ? 'W' : 'L';
  }

  const pickSideIsHome = (pickStr) => {
    const ht = _normName(game.home_team), at = _normName(game.away_team);
    const p = _normName(pickStr);
    const words = p.split(/\s+/).filter(w => w.length >= 4);
    const inH = words.some(w => ht.includes(w));
    const inA = words.some(w => at.includes(w));
    if (inH && !inA) return true;
    if (inA && !inH) return false;
    return null;
  };

  // Game spread: "Player -2.5 games (-110)" — requires per-set detail
  const spGames = pt.match(/^(.+?)\s+([+-]?\d*\.?\d+)\s+games?\s*\(/i);
  if (spGames) {
    if (!ts.hasGameDetail) return null;
    const spread = parseFloat(spGames[2]);
    if (isNaN(spread)) return null;
    const isHome = pickSideIsHome(spGames[1]);
    if (isHome === null) return null;
    const margin = (isHome ? ts.homeGames - ts.awayGames : ts.awayGames - ts.homeGames) + spread;
    if (Math.abs(margin) < 0.01) return 'P';
    return margin > 0 ? 'W' : 'L';
  }

  // Set spread: "Player -1.5 sets (+150)" — works with sets-only data
  const spSets = pt.match(/^(.+?)\s+([+-]?\d*\.?\d+)\s+sets?\s*\(/i);
  if (spSets) {
    const spread = parseFloat(spSets[2]);
    if (isNaN(spread)) return null;
    const isHome = pickSideIsHome(spSets[1]);
    if (isHome === null) return null;
    const margin = (isHome ? ts.homeSets - ts.awaySets : ts.awaySets - ts.homeSets) + spread;
    if (Math.abs(margin) < 0.01) return 'P';
    return margin > 0 ? 'W' : 'L';
  }

  // Tennis ML: works with any score format. "Player ML (+144)" or "Player (+144)"
  const mlM = pt.match(/^(.+?)\s+(?:ML\s*)?\(?[+-]?(\d{3,})/i);
  if (mlM) {
    const isHome = pickSideIsHome(mlM[1]);
    if (isHome === null) return null;
    return (isHome ? homeWon : awayWon) ? 'W' : 'L';
  }

  return null;
}

// ── Tennis Abstract scraper ───────────────────────────────────────────────────
// Best-effort parser. TA's HTML can change without notice — parser is
// conservative (returns null on failure) and never throws. Successful parses
// include surface W-L (current year) extracted from the "Match Results" view.

function taSlug(name) {
  // TA URL convention: First + Last (capitalized), no spaces, no diacritics.
  // Compound surnames concatenated. e.g. "Carlos Alcaraz" -> "CarlosAlcaraz".
  return (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z\s-]/g, '')
    .split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function parseTAHtml(html) {
  // Extract surface W-L from inline JS variables. TA stores recent stats in
  // patterns like: var clayHist = "2024: 12-3 ..."; or in tables. This parser
  // tries a few known patterns and returns whatever it finds. Anything missing
  // stays undefined — caller treats as "no data".
  const out = {};
  const yearRow = (label, key) => {
    const re = new RegExp(label + '[\\s\\S]{0,400}?(\\d{4})[^\\d]+(\\d+)\\s*-\\s*(\\d+)', 'i');
    const m = html.match(re);
    if (m) out[key] = { year: +m[1], w: +m[2], l: +m[3] };
  };
  yearRow('Clay', 'clay');
  yearRow('Hard', 'hard');
  yearRow('Grass', 'grass');
  // Career W-L summary near top of page
  const careerM = html.match(/Career[\s\S]{0,200}?(\d+)\s*-\s*(\d+)/i);
  if (careerM) out.career = { w: +careerM[1], l: +careerM[2] };
  return Object.keys(out).length ? out : null;
}

async function handleTennisAbstract(name, env) {
  const slug = taSlug(name);
  if (!slug) return jsonResponse({ error: 'Bad name' }, 400);
  const cacheKey = `ta:${slug}`;
  // KV cache — 24h. TA stats only update once daily.
  if (env.LEARNING_STORE) {
    try {
      const cached = await env.LEARNING_STORE.get(cacheKey);
      if (cached) return jsonResponse({ name: slug, cached: true, ...JSON.parse(cached) });
    } catch (_) {}
  }
  try {
    const r = await fetch(`https://www.tennisabstract.com/cgi-bin/player-classic.cgi?p=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (sportsedge-terminal)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return jsonResponse({ name: slug, stats: null, reason: `TA ${r.status}` });
    const html = await r.text();
    if (!html || html.length < 500) return jsonResponse({ name: slug, stats: null, reason: 'empty' });
    const stats = parseTAHtml(html);
    const payload = { name: slug, stats };
    if (env.LEARNING_STORE && stats) {
      try { await env.LEARNING_STORE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 86400 }); } catch (_) {}
    }
    return jsonResponse(payload);
  } catch (e) {
    return jsonResponse({ name: slug, stats: null, reason: e.message || 'fetch failed' });
  }
}

// ── Pinnacle ──────────────────────────────────────────────────────────────────

async function getPinnacleOdds(env, sportId) {
  const auth = btoa(`${env.PINNACLE_USER}:${env.PINNACLE_PWD}`);
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
  };

  const [fixturesRes, oddsRes] = await Promise.all([
    fetch(`https://api.pinnacle.com/v1/fixtures?sportId=${sportId}`, { headers }),
    fetch(`https://api.pinnacle.com/v2/odds?sportId=${sportId}&oddsFormat=American`, { headers }),
  ]);

  if (!fixturesRes.ok) {
    const txt = await fixturesRes.text();
    throw new Error(`Pinnacle fixtures ${fixturesRes.status}: ${txt.slice(0, 200)}`);
  }
  if (!oddsRes.ok) {
    const txt = await oddsRes.text();
    throw new Error(`Pinnacle odds ${oddsRes.status}: ${txt.slice(0, 200)}`);
  }

  const [fixtures, odds] = await Promise.all([fixturesRes.json(), oddsRes.json()]);

  const eventMap = new Map();
  fixtures.league?.forEach(league => {
    league.events?.forEach(ev => {
      if (ev.status === 'O') {
        eventMap.set(ev.id, { home: ev.home, away: ev.away, starts: ev.starts });
      }
    });
  });

  const result = [];
  odds.leagues?.forEach(league => {
    league.events?.forEach(ev => {
      const fix = eventMap.get(ev.id);
      if (!fix) return;
      const period = ev.periods?.find(p => p.number === 0);
      if (!period) return;
      const ml = period.moneyline;
      const spread = period.spreads?.[0];
      const total = period.totals?.[0];
      const markets = [];
      if (ml?.home && ml?.away) {
        markets.push({ key: 'h2h', outcomes: [{ name: fix.home, price: ml.home }, { name: fix.away, price: ml.away }] });
      }
      if (spread?.hdp !== undefined && spread.home && spread.away) {
        markets.push({ key: 'spreads', outcomes: [{ name: fix.home, price: spread.home, point: -spread.hdp }, { name: fix.away, price: spread.away, point: spread.hdp }] });
      }
      if (total?.points !== undefined && total.over && total.under) {
        markets.push({ key: 'totals', outcomes: [{ name: 'Over', price: total.over, point: total.points }, { name: 'Under', price: total.under, point: total.points }] });
      }
      if (!markets.length) return;
      result.push({
        id: `pinnacle_${ev.id}`,
        home_team: fix.home,
        away_team: fix.away,
        commence_time: fix.starts,
        bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', markets }]
      });
    });
  });

  return result;
}

// Named exports for unit testing
export { gradePickFromScore, computeSignalPerformance };

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsPreflightResponse() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    }
  });
}
