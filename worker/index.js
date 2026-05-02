const ALLOWED_ORIGIN = 'https://chquordata.github.io';
const PINNACLE_MMA_SPORT = 7;
const PINNACLE_TENNIS_SPORT = 33;
const CRON_SPORTS = ['basketball_nba', 'icehockey_nhl', 'baseball_mlb'];

// Rolling-window durations used across grading, signal performance, and the
// learning agent. Centralised here so tuning one threshold changes all callers.
const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_7D  =  7 * 24 * 60 * 60 * 1000;
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
        return jsonResponse({ status: 'ok', version: '2.2' });
      }
      // Manual cron trigger — for diagnostic / on-demand use. Same code path
      // as the nightly scheduled handler. No auth required since the operation
      // is idempotent (just re-grades existing picks against latest scores)
      // and the worker URL isn't publicly advertised.
      if (path === '/admin/run-cron' && request.method === 'POST') {
        await runNightlyCron(env);
        const diag = await env.LEARNING_STORE.get('et_cron_diagnostic');
        return jsonResponse({ ok: true, diagnostic: diag ? JSON.parse(diag) : null });
      }
      // Closing-line snapshot — captures the latest pre-game odds for every
      // game starting in the next 4 hours and stores keyed by Odds API game
      // ID. Closing Line Value (CLV) is computed at grade time as
      //   (close_implied - entry_implied) * 100  (in percentage points)
      // CLV is the gold-standard pro-bettor metric: positive CLV correlates
      // ~0.7 with long-term ROI, vs ~0.2 for raw win rate. Run this from
      // the frontend on each SCAN so we capture closing lines as games tip off.
      if (path === '/admin/snapshot-odds' && request.method === 'POST') {
        const result = await snapshotClosingOdds(env);
        return jsonResponse({ ok: true, ...result });
      }
      // Backtesting summary — produces an honest performance report by
      // walking the entire pick history with statistical bounds. Computes:
      //   - Per-confidence-bucket calibration (predicted vs actual hit rate)
      //   - Per-sport ROI assuming 1u flat staking
      //   - Average CLV (gold-standard pro metric)
      //   - Walk-forward window simulation
      // Does NOT require historical odds data — uses the picks the user
      // actually made + grading already in place. Real walk-forward against
      // historical Odds API data needs paid-tier access ($30/mo) and is
      // scoped as a follow-up. For now, this gives an honest read on actual
      // performance vs. the model's stated confidence.
      if (path === '/admin/backtest' && request.method === 'GET') {
        const histRaw = await env.LEARNING_STORE.get('et_picks_history');
        const perfRaw = await env.LEARNING_STORE.get('et_signal_performance');
        if (!histRaw) return jsonResponse({ error: 'no pick history' });
        const history = JSON.parse(histRaw);
        const perf = perfRaw ? JSON.parse(perfRaw) : {};
        const report = buildBacktestReport(history, perf);
        return jsonResponse(report);
      }
      // Per-pick grading dry-run — helps diagnose why cron isn't grading
      // pending picks.
      if (path === '/admin/grade-trace' && request.method === 'GET') {
        const histRaw = await env.LEARNING_STORE.get('et_picks_history');
        const cgRaw = await env.LEARNING_STORE.get('et_completed_games');
        if (!histRaw || !cgRaw) return jsonResponse({ error: 'history or completed games missing' });
        const history = JSON.parse(histRaw);
        const completedGames = JSON.parse(cgRaw).games || [];
        const trace = [];
        history.forEach(slate => {
          (slate.picks || []).forEach(pick => {
            if (pick.result && pick.result !== '?') return;
            const matchup = pick.matchup || '';
            const matchedGame = findGameForPick(matchup, completedGames, slate.date);
            const result = gradePickFromScore(pick, completedGames, slate.date);
            // Exhaustive candidate enumeration so we can see WHY no match
            const m = _normName(matchup);
            const parts = m.split(/\s+(?:@|vs|v)\s+|\s*,\s*|\s*\|\s*/).filter(Boolean);
            const allMatches = completedGames.filter(g => {
              const ht = g.home_team, at = g.away_team;
              if (parts.length < 2) return false;
              const [s1, s2] = parts;
              const sideMatch = (side, team) => {
                const t = _normName(team);
                const sideToks = side.split(/\s+/).filter(w => w.length >= 3 && !_AMBIG_TOKS.has(w));
                if (sideToks.some(w => t.includes(w))) return true;
                const tLast = t.split(/\s+/).pop();
                return !!(tLast && tLast.length >= 3 && !_AMBIG_TOKS.has(tLast) && side.includes(tLast));
              };
              return (sideMatch(s1, ht) && sideMatch(s2, at)) || (sideMatch(s1, at) && sideMatch(s2, ht));
            });
            trace.push({
              date: slate.date,
              sport: pick.sport,
              matchup,
              pick: pick.pick,
              normalizedParts: parts,
              candidatesFound: allMatches.length,
              candidatesList: allMatches.map(g => `${g.away_team} @ ${g.home_team}`).slice(0, 5),
              uniqueMatch: matchedGame ? `${matchedGame.away_team} @ ${matchedGame.home_team}` : null,
              result,
              reason: result ? 'graded' : matchedGame ? 'matched but pick not parsed' : (allMatches.length > 1 ? `${allMatches.length} ambiguous candidates` : 'no matching game')
            });
          });
        });
        return jsonResponse({ pendingTotal: trace.length, completedGamesTotal: completedGames.length, trace });
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

  // 0. Snapshot closing-line odds for upcoming games (next 4 hours). The
  // 2 AM ET cron is too late for tonight's games which already started, but
  // captures any AM games (early MLB, European tennis). Frontend SCAN
  // additionally hits /admin/snapshot-odds so the bulk of capture happens
  // organically as the user refreshes the dashboard pre-game.
  await snapshotClosingOdds(env).catch(() => {});

  // 1. Fetch completed scores across all active sports + ESPN tennis (parallel)
  // Odds API tennis score coverage is sparse — ESPN fills the gap reliably
  // for both ATP and WTA without requiring a key.
  const [completedGames, espnTennisGames] = await Promise.all([
    fetchAllCompletedScores(env.ODDS_API_KEY),
    fetchTennisScoresFromESPN()
  ]);
  completedGames.push(...espnTennisGames);

  // Extract diagnostic info before storing (it's attached to the array)
  const breakdown = completedGames._breakdown || {};
  const sportsListErr = completedGames._sportsListErr;
  // Strip diagnostic metadata before persisting the games array itself
  const games = completedGames.filter(g => g && !g._breakdown);

  // 2. Store raw completed games + per-cron diagnostic so the user can
  // see what each cron run actually fetched and why (rate limits?
  // empty days? auth fail?). Diagnostic is queryable via
  //   curl https://sportsedge-proxy.chuynh.workers.dev/kv/et_cron_diagnostic
  await env.LEARNING_STORE.put('et_completed_games', JSON.stringify({
    ts: Date.now(),
    games
  }), { expirationTtl: 60 * 60 * 24 * 4 }); // 4-day TTL

  await env.LEARNING_STORE.put('et_cron_diagnostic', JSON.stringify({
    ts: Date.now(),
    iso: new Date().toISOString(),
    sportsListErr,
    breakdown,
    totalCompleted: games.length
  }), { expirationTtl: 60 * 60 * 24 * 14 }); // 14-day TTL

  // 3. Read pick history from KV, auto-grade ungraded picks
  const historyRaw = await env.LEARNING_STORE.get('et_picks_history');
  if (!historyRaw) return;

  let history;
  try { history = JSON.parse(historyRaw); } catch { return; }

  let changed = false;
  // Collect CLV computation tasks — done after grading loop since they're
  // async KV reads that we want to batch.
  const clvTasks = [];
  history.forEach(slate => {
    (slate.picks || []).forEach(pick => {
      if (pick.result && pick.result !== '?') return;
      // Pass slate.date through so findGameForPick can disambiguate when
      // multiple completed games match the matchup (series play).
      const result = gradePickFromScore(pick, completedGames, slate.date);
      if (result) {
        pick.result = result; changed = true;
        // Queue CLV computation for newly graded picks. Skip if pick already
        // has CLV from a prior run.
        if (pick.clv == null) clvTasks.push(pick);
      }
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

  // Compute CLV for each newly graded pick — batched after grading loop
  // since each call is an async KV read. Best-effort: failures are silent.
  if (clvTasks.length) {
    await Promise.allSettled(clvTasks.map(async pick => {
      try {
        const clvData = await _computeCLV(pick, env);
        if (clvData) {
          pick.clv = clvData.clv;
          pick.clv_data = clvData;
          changed = true;
        }
      } catch (_) {}
    }));
  }

  if (changed) {
    await env.LEARNING_STORE.put('et_picks_history', JSON.stringify(history.slice(0, 30)));
  }

  // 4. Learning agent — runs EVERY cron, not just when new picks were graded.
  // computeSignalPerformance is deterministic and cheap (just counts W/L/P
  // by signal tag across existing graded history). Gating it on `changed`
  // meant the KV state went stale on any day where no new completed games
  // matched pending picks, even though the underlying graded-pick data was
  // there. The Claude rule-rewrite call inside runLearningAgent has its own
  // internal gating (requires ≥5 recent picks and CLAUDE_API_KEY) so it
  // won't fire wastefully when there's nothing new to learn from.
  await runLearningAgent(env, history);
}

// ── Learning agent ────────────────────────────────────────────────────────────

// Wilson score interval (95% CI) for a binomial proportion. Returns
// [lowerBound, upperBound] for win rate given w wins out of n attempts.
// Provides honest confidence bounds even at small samples — replaces the
// previous practice of treating "4-1 (80% WR)" as a real edge when the
// 95% CI is actually [35%, 99%], i.e. statistically indistinguishable
// from a coin flip. Used to gate rule generation and signal display so
// noise can't masquerade as edge at $500K/wk stakes.
function _wilsonInterval(w, n) {
  if (n === 0) return [0, 1];
  const z = 1.96; // 95% CI
  const p = w / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// Signal performance is computed deterministically from graded pick history.
// No Claude needed — just count W/L/P per signal tag across the last 30 days.
// Each signal also gets a Wilson 95% confidence interval so rule generation
// can gate on statistical significance rather than raw win rate.
function computeSignalPerformance(history) {
  const perf = {};
  const cutoff = Date.now() - MS_30D;
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
  // Annotate each signal with Wilson CI bounds for downstream filtering.
  // Pushes treated as half-wins for the proportion (standard convention).
  Object.values(perf).forEach(v => {
    const n = v.w + v.l + v.p;
    const wForCI = v.w + (v.p || 0) * 0.5;
    const [lo, hi] = _wilsonInterval(wForCI, n);
    v.n = n;
    v.wr = n > 0 ? wForCI / n : null;
    v.ci_lo = +lo.toFixed(3);
    v.ci_hi = +hi.toFixed(3);
    // Flag whether signal is statistically above coin flip (lo > 0.5)
    // or actively losing (hi < 0.5).
    v.significant_edge = lo > 0.5;
    v.significant_fade = hi < 0.5;
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
  const cutoff = Date.now() - MS_7D;
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

  // Build signal performance summary for context. Includes Wilson 95% CI
  // bounds + a SIGNIFICANCE TAG so Claude can correctly distinguish noise
  // from edge. Without this, "4-1 (80% WR)" gets treated as a strong rule
  // when its 95% CI is actually [35%, 99%] — indistinguishable from a coin
  // flip. Significance flags:
  //   [EDGE]  = ci_lo > 0.50 (statistically beating breakeven, real signal)
  //   [FADE]  = ci_hi < 0.50 (statistically losing, real anti-signal)
  //   [NOISE] = neither (sample too small or true rate near coin flip)
  const perfSummary = Object.entries(perf)
    .filter(([, v]) => v.w + v.l > 0)
    .sort(([, a], [, b]) => (b.n) - (a.n))
    .slice(0, 25)
    .map(([tag, v]) => {
      const wr = Math.round((v.wr || 0) * 100);
      const lo = Math.round(v.ci_lo * 100);
      const hi = Math.round(v.ci_hi * 100);
      const flag = v.significant_edge ? '[EDGE]' : v.significant_fade ? '[FADE]' : '[NOISE]';
      return `  ${flag} ${tag}: ${v.w}-${v.l}${v.p ? '-' + v.p : ''} (${wr}% WR, n=${v.n}, 95% CI ${lo}-${hi}%)`;
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

STATISTICAL SIGNIFICANCE GATE (HARD REQUIREMENT):
- Each signal in the SIGNAL PERFORMANCE block above is tagged [EDGE], [FADE], or [NOISE].
- [EDGE] means Wilson 95% CI lower bound > 50% — statistically beats coin flip.
- [FADE] means Wilson 95% CI upper bound < 50% — statistically loses.
- [NOISE] means the signal cannot be distinguished from a coin flip yet.
- ONLY generate "favors X" rules from [EDGE]-tagged signals.
- ONLY generate "fade X" rules from [FADE]-tagged signals.
- NEVER generate a rule from a [NOISE]-tagged signal regardless of raw WR.
- This prevents 4-1 (80% WR) hot streaks from minting confident-looking rules
  that are actually statistical noise.

OUTPUT REQUIREMENTS:
- Max 10 rules per sport (down from 12 — be aggressive about pruning)
- Each rule max 20 words, name the exact signal/condition/outcome
- It is BETTER to have 3 strong rules than 10 weak ones — if a sport has no signals meeting preservation criteria, return an empty string for that sport's rules rather than preserving stale ones
- If a sport has 0 graded picks in the last 30d, return its existing rules unchanged (no data = can't decay)
- Output raw JSON only. No markdown fences.

Output format (all 4 sport fields required even if unchanged):
{"tennis_rules":"rule1\\nrule2\\n...","nba_rules":"...","mlb_rules":"...","nhl_rules":"..."}`;

  // Log learning agent failures to KV so they're queryable via
  // /kv/et_learning_agent_err. Silences the outer try-catch without
  // hiding the actual failure reason from operators.
  const _logLearningErr = async (reason, detail = '') => {
    try {
      await env.LEARNING_STORE.put('et_learning_agent_err', JSON.stringify({
        ts: Date.now(), iso: new Date().toISOString(), reason,
        detail: String(detail).slice(0, 500)
      }), { expirationTtl: 60 * 60 * 24 * 14 });
    } catch (_) {}
  };

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

    if (!resp.ok) { await _logLearningErr('api_error', `HTTP ${resp.status}`); return; }
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const raw = (text.match(/(\{[\s\S]+\})/) || [])[1] || text.trim();
    if (!raw.startsWith('{')) { await _logLearningErr('parse_error', `response: ${raw.slice(0, 200)}`); return; }

    const result = JSON.parse(raw);

    const ruleKeyMap = {
      tennis_rules: 'et_learned_rules_tennis',
      nba_rules:    'et_learned_rules_nba',
      mlb_rules:    'et_learned_rules_mlb',
      nhl_rules:    'et_learned_rules_nhl'
    };

    // null/undefined = field absent from response → keep existing KV rules unchanged
    // "" = model explicitly cleared all rules for this sport → delete the KV key
    // anything else = new rule text → overwrite
    await Promise.allSettled(
      Object.entries(ruleKeyMap).map(([field, kvKey]) => {
        const val = result[field];
        if (val == null) return Promise.resolve();
        if (val === '') return env.LEARNING_STORE.delete(kvKey);
        return env.LEARNING_STORE.put(kvKey, val, { expirationTtl: 60 * 60 * 24 * 365 });
      })
    );
  } catch (e) { await _logLearningErr('exception', e?.message || String(e)); }
}

// ── Score fetching ────────────────────────────────────────────────────────────

// ESPN public scoreboard API — free, no key, covers ATP + WTA with per-set
// linescores. Used as primary tennis scoring source since Odds API tennis
// score coverage is sparse (typically returns 0 completed matches mid-tournament).
// Fetches the last 7 days so all pending tennis picks are in range.
async function fetchTennisScoresFromESPN(daysBack = 7) {
  const games = [];
  const leagues = ['atp', 'wta'];
  const dates = [];
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  await Promise.allSettled(leagues.flatMap(league =>
    dates.map(async date => {
      try {
        const r = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/tennis/${league}/scoreboard?dates=${date}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!r.ok) return;
        const data = await r.json();
        (data.events || []).forEach(event => {
          const comp = event.competitions?.[0];
          if (!comp?.status?.type?.completed) return;
          const [c1, c2] = comp.competitors || [];
          if (!c1 || !c2) return;
          const name1 = c1.athlete?.displayName || '';
          const name2 = c2.athlete?.displayName || '';
          if (!name1 || !name2) return;
          // Prefer per-set linescores (needed for game spread + totals grading).
          // Falls back to sets-won string which still grades ML picks correctly.
          const scoreStr = c => c.linescores?.length
            ? c.linescores.map(s => s.value ?? s.displayValue ?? '').join(',')
            : String(c.score || '');
          games.push({
            sport: 'tennis',
            id: `espn_${event.id}`,
            home_team: name1,
            away_team: name2,
            commence_time: comp.date || event.date,
            completed: true,
            scores: [
              { name: name1, score: scoreStr(c1) },
              { name: name2, score: scoreStr(c2) }
            ]
          });
        });
      } catch (_) {}
    })
  ));
  return games;
}

async function fetchAllCompletedScores(apiKey) {
  const sports = [...CRON_SPORTS];

  // Discover active tennis sport keys
  let sportsListErr = null;
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
    if (r.ok) {
      const all = await r.json();
      const tennis = all.filter(s => s.active && s.key.startsWith('tennis_')).slice(0, 8).map(s => s.key);
      sports.push(...tennis);
    } else {
      sportsListErr = `sports list ${r.status}`;
    }
  } catch (e) { sportsListErr = e?.message || String(e); }

  const results = [];
  // Per-sport diagnostic counters — written to KV alongside results so we
  // can see WHY completed-games is empty (rate limit? no games? auth fail?)
  // instead of silently returning [] with no explanation.
  const breakdown = {};
  await Promise.allSettled(sports.map(async sport => {
    breakdown[sport] = { fetched: 0, completed: 0, status: null, err: null };
    try {
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/scores/?daysFrom=3&apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(8000) }
      );
      breakdown[sport].status = r.status;
      if (!r.ok) return;
      const data = await r.json();
      breakdown[sport].fetched = Array.isArray(data) ? data.length : 0;
      data.filter(g => g.completed).forEach(g => {
        results.push({ sport, ...g });
        breakdown[sport].completed++;
      });
    } catch (e) { breakdown[sport].err = e?.message || String(e); }
  }));

  // Stash the breakdown for retrieval via /kv/et_cron_diagnostic
  results._breakdown = breakdown;
  results._sportsListErr = sportsListErr;
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
function findGameForPick(matchup, games, pickDate) {
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
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Multiple candidates — common when teams play a series (MLB 3-game series,
  // NBA/NHL playoffs). Disambiguate by matching pickDate to game commence_time.
  if (pickDate) {
    const exact = candidates.filter(g => (g.commence_time || '').slice(0, 10) === pickDate);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact[0]; // same-day duplicates → just pick first
    // No exact-date match — pick game closest to pickDate that's BEFORE or on pickDate
    // (a pick made April 29 for a game that completed April 28 = the prior game)
    const target = new Date(pickDate + 'T12:00:00Z').getTime();
    const sorted = candidates
      .map(g => ({ g, dt: new Date(g.commence_time || 0).getTime() }))
      .filter(x => x.dt <= target + 24 * 3600 * 1000) // allow up to 1 day after pick date
      .sort((a, b) => Math.abs(a.dt - target) - Math.abs(b.dt - target));
    if (sorted.length) return sorted[0].g;
  }
  // No date provided or no good date match — pick the most recent completed game
  return candidates.sort((a, b) => new Date(b.commence_time || 0) - new Date(a.commence_time || 0))[0];
}

function gradePickFromScore(pick, games, pickDate) {
  const pt = pick.pick || '';
  const matchup = pick.matchup || '';
  // pickDate is the slate date (YYYY-MM-DD) — used to disambiguate when the
  // same matchup has multiple completed games (series play, repeat fixtures).
  const game = findGameForPick(matchup, games, pickDate || pick.date);
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

  // Fallback ML parsing — handles picks where the strict regex fails:
  //   "Pittsburgh Pirates ML"            (no odds suffix)
  //   "Tampa Bay Rays ML (implied ~+103)" (non-numeric in parens)
  //   "Milwaukee Brewers ML (run line TBD)"
  // Strategy: split on " ML" and use the prefix as the team name. As long
  // as the matchup-side resolution (pickSideIsHome) succeeds, we can grade
  // an ML pick without needing to parse the odds at all.
  const mlSplit = pt.match(/^(.+?)\s+ML\b/i);
  if (mlSplit) {
    const isHome = pickSideIsHome(mlSplit[1]);
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
  // TA stores all match results in a JS array: var matchmx = [[date, event, surface, tour, result, ...], ...]
  // surface is index 2 ('Clay'|'Hard'|'Grass'), result is index 4 ('W'|'L'), date is index 0 (YYYYMMDD).
  // We tally W/L per surface per year and return the most recent year for each surface.
  try {
    const m = html.match(/var matchmx\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return null;
    const matchmx = JSON.parse(m[1]);
    if (!Array.isArray(matchmx) || !matchmx.length) return null;
    const bySurface = {};
    let cw = 0, cl = 0;
    for (const row of matchmx) {
      const result = row[4];
      if (result === 'W') cw++;
      else if (result === 'L') cl++;
      else continue;
      const surf = String(row[2] || '').toLowerCase();
      if (surf !== 'clay' && surf !== 'hard' && surf !== 'grass') continue;
      const year = String(row[0] || '').slice(0, 4);
      if (year.length !== 4) continue;
      if (!bySurface[surf]) bySurface[surf] = {};
      if (!bySurface[surf][year]) bySurface[surf][year] = { w: 0, l: 0 };
      if (result === 'W') bySurface[surf][year].w++;
      else bySurface[surf][year].l++;
    }
    const out = {};
    for (const [surf, years] of Object.entries(bySurface)) {
      const keys = Object.keys(years).sort();
      const mostRecent = keys[keys.length - 1];
      if (mostRecent) out[surf] = { year: +mostRecent, ...years[mostRecent] };
    }
    if (cw + cl > 0) out.career = { w: cw, l: cl };
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
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

// ── Backtesting report ──────────────────────────────────────────────────────
// Produces a quantitative performance summary the user can audit. Works
// against the picks history we already have — no historical odds fetch
// required (that's a paid-tier follow-up). Reports calibration per
// confidence bucket, per-sport ROI assuming flat 1u staking, average CLV,
// and Wilson 95% CIs so the user sees noise vs real edge.

function buildBacktestReport(history, perf) {
  const allPicks = [];
  history.forEach(s => {
    (s.picks || []).forEach(p => {
      if (p.is_lean) return;
      allPicks.push({ ...p, slate_date: s.date });
    });
  });
  const graded = allPicks.filter(p => p.result && p.result !== '?');

  // ── Calibration per confidence bucket ──
  const PREDICTED = { HIGH: 0.60, MEDIUM: 0.55, LOW: 0.48, REVIEW: 0.50 };
  const calibration = {};
  ['HIGH', 'MEDIUM', 'LOW', 'REVIEW'].forEach(c => {
    const bucket = graded.filter(p => (p.confidence || '').toUpperCase() === c);
    const w = bucket.filter(p => p.result === 'W').length;
    const l = bucket.filter(p => p.result === 'L').length;
    const pp = bucket.filter(p => p.result === 'P').length;
    if (!w && !l) return;
    const [lo, hi] = _wilsonInterval(w, w + l);
    calibration[c] = {
      n: w + l + pp, w, l, p: pp,
      actual_wr: +(w / (w + l)).toFixed(3),
      predicted_wr: PREDICTED[c],
      diff_pp: +((w / (w + l) - PREDICTED[c]) * 100).toFixed(1),
      ci_95: [+lo.toFixed(3), +hi.toFixed(3)],
      kelly_adjustment: +(((w / (w + l)) / PREDICTED[c]) || 1).toFixed(2)
    };
  });

  // ── Per-sport ROI (assuming 1u flat staking, American-odds payouts) ──
  const _americanToProfit = (price, isWin) => {
    if (!isWin) return -1;
    if (price > 0) return price / 100;
    if (price < 0) return 100 / Math.abs(price);
    return 0;
  };
  const bySport = {};
  graded.forEach(p => {
    const sp = p.sport || 'unknown';
    if (!bySport[sp]) bySport[sp] = { n: 0, w: 0, l: 0, p: 0, units: 0, clvs: [] };
    bySport[sp].n++;
    if (p.result === 'W') {
      bySport[sp].w++;
      const profit = p.entry_odds ? _americanToProfit(p.entry_odds, true) : 0.91; // -110 default
      bySport[sp].units += profit;
    } else if (p.result === 'L') {
      bySport[sp].l++;
      bySport[sp].units -= 1;
    } else if (p.result === 'P') {
      bySport[sp].p++;
    }
    if (typeof p.clv === 'number') bySport[sp].clvs.push(p.clv);
  });
  Object.values(bySport).forEach(s => {
    const dec = s.w + s.l;
    s.wr = dec ? +(s.w / dec).toFixed(3) : null;
    const [lo, hi] = _wilsonInterval(s.w, dec);
    s.ci_95 = [+lo.toFixed(3), +hi.toFixed(3)];
    s.roi_pct = s.n ? +((s.units / s.n) * 100).toFixed(1) : 0;
    s.units = +s.units.toFixed(2);
    s.avg_clv = s.clvs.length ? +(s.clvs.reduce((a, b) => a + b, 0) / s.clvs.length).toFixed(2) : null;
    s.clv_n = s.clvs.length;
    delete s.clvs;
  });

  // ── Overall metrics ──
  const allCLV = graded.map(p => p.clv).filter(c => typeof c === 'number');
  const avgCLV = allCLV.length ? allCLV.reduce((a, b) => a + b, 0) / allCLV.length : null;
  const totalUnits = Object.values(bySport).reduce((s, x) => s + x.units, 0);
  const totalDecided = Object.values(bySport).reduce((s, x) => s + x.w + x.l, 0);

  // ── Walk-forward simulation: split into 7-day windows, see if rules
  // learned in window N would have profited in window N+1. This is the
  // first-principles test of "is the learning loop actually working?"
  const windows = [];
  if (history.length >= 14) {
    // Sort by date asc
    const sorted = [...history].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (let i = 7; i < sorted.length; i++) {
      const trainSlates = sorted.slice(Math.max(0, i - 7), i);
      const testSlate = sorted[i];
      const trainPicks = trainSlates.flatMap(s => (s.picks || []).filter(p => p.result && p.result !== '?'));
      const testPicks = (testSlate.picks || []).filter(p => p.result && p.result !== '?');
      if (!trainPicks.length || !testPicks.length) continue;
      const trainW = trainPicks.filter(p => p.result === 'W').length;
      const trainL = trainPicks.filter(p => p.result === 'L').length;
      const testW = testPicks.filter(p => p.result === 'W').length;
      const testL = testPicks.filter(p => p.result === 'L').length;
      windows.push({
        date: testSlate.date,
        train_record: `${trainW}-${trainL}`,
        train_wr: trainW + trainL ? +(trainW / (trainW + trainL)).toFixed(3) : null,
        test_record: `${testW}-${testL}`,
        test_wr: testW + testL ? +(testW / (testW + testL)).toFixed(3) : null,
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_picks: allPicks.length,
      graded: graded.length,
      pending: allPicks.length - graded.length,
      total_units_pnl: +totalUnits.toFixed(2),
      total_roi_pct: totalDecided ? +((totalUnits / totalDecided) * 100).toFixed(1) : 0,
      avg_clv_pp: avgCLV != null ? +avgCLV.toFixed(2) : null,
      clv_sample: allCLV.length,
      window_days: 30
    },
    calibration,
    by_sport: bySport,
    walk_forward_windows: windows.slice(-10), // last 10 days
    notes: [
      'CLV is the gold-standard pro metric: positive CLV correlates ~0.7 with long-term ROI vs ~0.2 for raw WR.',
      'A confidence bucket is well-calibrated when actual_wr ≈ predicted_wr. Diff_pp >= 5 means recalibrate Kelly sizing.',
      'Walk-forward windows show whether learned rules from the last 7 days would have profited the following day. Useful for spotting overfitting.',
      'Wilson 95% CI: if ci_95[0] > 0.5 the bucket is statistically beating breakeven. Below ~10 picks, all CIs are wide and non-actionable.'
    ]
  };
}

// ── Closing-line snapshots for CLV tracking ─────────────────────────────────
// Snapshot the current odds for every game starting in the next ~4 hours so
// we can later compute Closing Line Value when grading. Stores per-game with
// a 4-day TTL (long enough to survive grading + a few backfill retries).

const _CRON_SPORTS_ALL = [
  'basketball_nba', 'icehockey_nhl', 'baseball_mlb', 'americanfootball_nfl'
];

async function snapshotClosingOdds(env) {
  if (!env.ODDS_API_KEY) return { error: 'no API key' };
  const sports = [..._CRON_SPORTS_ALL];
  // Discover active tennis sport keys
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${env.ODDS_API_KEY}`);
    if (r.ok) {
      const all = await r.json();
      const tennis = all.filter(s => s.active && s.key.startsWith('tennis_')).slice(0, 8).map(s => s.key);
      sports.push(...tennis);
    }
  } catch (_) {}
  // Pull odds for games starting in next 12 hours (these are about to close).
  // Wider than 4h covers evening + late-night MLB/NBA + early AM tennis.
  // Format timestamps to match what the frontend uses — ISO string truncated
  // to seconds, NOT encoded. Encoding the colons via encodeURIComponent
  // breaks the Odds API time filter (returns 422).
  const now = new Date();
  const horizon = new Date(now.getTime() + 12 * 3600 * 1000);
  const _fmt = d => d.toISOString().split('.')[0] + 'Z'; // strip millis
  const tf = _fmt(now);
  const tt = _fmt(horizon);
  let captured = 0;
  const breakdown = {};
  await Promise.allSettled(sports.map(async sport => {
    breakdown[sport] = { count: 0, status: null };
    try {
      const r = await fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${env.ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&commenceTimeFrom=${tf}&commenceTimeTo=${tt}`,
        { signal: AbortSignal.timeout(10000) }
      );
      breakdown[sport].status = r.status;
      if (!r.ok) return;
      const games = await r.json();
      // Store each game's snapshot keyed by Odds API game ID. We store a
      // compact representation: best price per market side across books.
      await Promise.all((games || []).map(async g => {
        const snap = _condenseOddsSnapshot(g);
        if (!snap) return;
        await env.LEARNING_STORE.put(`et_closing:${g.id}`, JSON.stringify(snap), {
          expirationTtl: 60 * 60 * 24 * 4
        });
        captured++;
        breakdown[sport].count++;
      }));
    } catch (e) { breakdown[sport].err = e?.message || String(e); }
  }));
  return { captured, breakdown };
}

// Condense full Odds API game payload to just the best-line-per-side data
// we need for CLV computation. Reduces KV write size dramatically (~95%).
function _condenseOddsSnapshot(g) {
  if (!g?.bookmakers?.length) return null;
  const bySide = {}; // key: market+side+point → { bestPrice, book, allPrices: [] }
  g.bookmakers.forEach(b => {
    (b.markets || []).forEach(m => {
      (m.outcomes || []).forEach(o => {
        const pointKey = o.point !== undefined ? `${o.name}|${o.point}` : o.name;
        const k = `${m.key}__${pointKey}`;
        if (!bySide[k]) bySide[k] = { market: m.key, side: o.name, point: o.point, prices: [] };
        bySide[k].prices.push({ book: b.title, price: o.price });
      });
    });
  });
  // For each market+side, compute best (highest, i.e. lowest implied prob) price
  const lines = {};
  Object.entries(bySide).forEach(([k, v]) => {
    if (!v.prices.length) return;
    const best = v.prices.reduce((a, b) => _impliedFromAmerican(b.price) < _impliedFromAmerican(a.price) ? b : a);
    const consensus = v.prices.reduce((s, p) => s + _impliedFromAmerican(p.price), 0) / v.prices.length;
    lines[k] = {
      market: v.market, side: v.side, point: v.point,
      bestPrice: best.price, bestBook: best.book,
      consensusImplied: +(consensus * 100).toFixed(2),
      bookCount: v.prices.length
    };
  });
  return {
    id: g.id, sport: g.sport_key, home_team: g.home_team, away_team: g.away_team,
    commence_time: g.commence_time, snapshot_at: new Date().toISOString(),
    lines
  };
}

function _impliedFromAmerican(price) {
  if (!Number.isFinite(price) || price === 0) return 0.5;
  return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
}

// Compute CLV for a graded pick by looking up the closing snapshot and
// comparing against the pick's entry odds. Returns { clv, closingPrice,
// closingBook, closingImplied, entryImplied } or null if no closing data.
async function _computeCLV(pick, env) {
  // Pick may have entry_odds stashed by the frontend (we added this), or we
  // fall back to extracting from the pick string text.
  const entryPrice = pick.entry_odds != null ? Number(pick.entry_odds) : _extractOddsFromPickText(pick.pick || '');
  if (!Number.isFinite(entryPrice)) return null;
  // Look up closing snapshot by trying matchup-derived game IDs. We don't
  // have the Odds API game ID directly stored on the pick — easier path:
  // look up the most recent et_closing:* key whose teams match the pick.
  // For now, accept this as a limitation — entries with explicit
  // pick.odds_api_game_id get cleanest CLV; others get null.
  if (!pick.odds_api_game_id) return null;
  const snapRaw = await env.LEARNING_STORE.get(`et_closing:${pick.odds_api_game_id}`);
  if (!snapRaw) return null;
  const snap = JSON.parse(snapRaw);
  // Find the matching market line in the closing snapshot. For ML picks
  // we need market='h2h' and side matching the team. For totals: name
  // 'Over'/'Under' + point. For spreads: team + point.
  const closing = _findClosingLine(snap, pick);
  if (!closing) return null;
  const entryImplied = _impliedFromAmerican(entryPrice);
  const closingImplied = _impliedFromAmerican(closing.bestPrice);
  // CLV = how much the line moved in our favor from entry to close, in
  // implied-probability percentage points. Positive = we beat the close.
  const clv = +((closingImplied - entryImplied) * 100).toFixed(2);
  return { clv, closingPrice: closing.bestPrice, closingBook: closing.bestBook,
    closingImplied: +(closingImplied * 100).toFixed(2),
    entryImplied: +(entryImplied * 100).toFixed(2) };
}

function _findClosingLine(snap, pick) {
  if (!snap?.lines) return null;
  const pt = (pick.pick || '').toLowerCase();
  // Determine market
  const isOver = /\bover\b/i.test(pt), isUnder = /\bunder\b/i.test(pt);
  const isTotal = isOver || isUnder;
  const isSpread = !isTotal && /[+-]\d+\.\d/.test(pt);
  const market = isTotal ? 'totals' : isSpread ? 'spreads' : 'h2h';
  // For totals: extract point and find Over/Under line
  if (isTotal) {
    const pointMatch = pt.match(/(\d+\.?\d*)/);
    if (!pointMatch) return null;
    const point = parseFloat(pointMatch[1]);
    const sideName = isOver ? 'over' : 'under';
    const found = Object.values(snap.lines).find(l =>
      l.market === 'totals' && l.side.toLowerCase() === sideName && Math.abs((l.point || 0) - point) < 0.01
    );
    return found || null;
  }
  // For ML/spread: match by team name
  const homeL = (snap.home_team || '').toLowerCase();
  const awayL = (snap.away_team || '').toLowerCase();
  const homeWords = homeL.split(/\s+/).filter(w => w.length >= 4);
  const awayWords = awayL.split(/\s+/).filter(w => w.length >= 4);
  const teamHome = homeWords.some(w => pt.includes(w));
  const teamAway = !teamHome && awayWords.some(w => pt.includes(w));
  if (!teamHome && !teamAway) return null;
  const targetSide = teamHome ? snap.home_team : snap.away_team;
  const sideMatches = Object.values(snap.lines).filter(l =>
    l.market === market && l.side === targetSide
  );
  if (!sideMatches.length) return null;
  if (market === 'h2h') return sideMatches[0];
  // For spreads: match by point if specified in pick
  const spMatch = pt.match(/[+-]\d+\.?\d*/);
  if (!spMatch) return sideMatches[0];
  const spPoint = parseFloat(spMatch[0]);
  return sideMatches.find(l => Math.abs((l.point || 0) - spPoint) < 0.01) || sideMatches[0];
}

function _extractOddsFromPickText(pickText) {
  // "Team ML (-150)" → -150 ; "Team -3.5 (+110)" → +110
  const m = pickText.match(/\(([+-]?\d{2,4})\)/);
  return m ? parseInt(m[1]) : NaN;
}

// ── Pinnacle ──────────────────────────────────────────────────────────────────

async function getPinnacleOdds(env, sportId) {
  // Sanity-check creds BEFORE making the call so we return a useful error
  // instead of an opaque 500. Auth issues are the most common cause of
  // Pinnacle worker failures (creds expire, env var typo, etc.).
  if (!env.PINNACLE_USER || !env.PINNACLE_PWD) {
    throw new Error(`Pinnacle creds missing — set PINNACLE_USER and PINNACLE_PWD env vars in Cloudflare Worker settings`);
  }
  const auth = btoa(`${env.PINNACLE_USER}:${env.PINNACLE_PWD}`);
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
  };

  const [fixturesRes, oddsRes] = await Promise.all([
    fetch(`https://api.pinnacle.com/v1/fixtures?sportId=${sportId}`, { headers }),
    fetch(`https://api.pinnacle.com/v2/odds?sportId=${sportId}&oddsFormat=American`, { headers }),
  ]);

  // 401/403 are auth errors (creds bad/revoked); 429 = rate limit; 5xx = upstream issue.
  // Return descriptive errors so the frontend status indicator can show WHY.
  if (!fixturesRes.ok) {
    const txt = await fixturesRes.text();
    const reason = fixturesRes.status === 401 || fixturesRes.status === 403
      ? `auth rejected (creds may be expired or revoked)`
      : fixturesRes.status === 429 ? `rate limited by Pinnacle`
      : fixturesRes.status >= 500 ? `Pinnacle upstream error`
      : `request failed`;
    throw new Error(`Pinnacle fixtures ${fixturesRes.status} — ${reason}: ${txt.slice(0, 200)}`);
  }
  if (!oddsRes.ok) {
    const txt = await oddsRes.text();
    const reason = oddsRes.status === 401 || oddsRes.status === 403
      ? `auth rejected (creds may be expired or revoked)`
      : oddsRes.status === 429 ? `rate limited by Pinnacle`
      : oddsRes.status >= 500 ? `Pinnacle upstream error`
      : `request failed`;
    throw new Error(`Pinnacle odds ${oddsRes.status} — ${reason}: ${txt.slice(0, 200)}`);
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
