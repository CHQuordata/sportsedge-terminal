# CLAUDE.md — SPORTSEDGE TERMINAL

## PROJECT OVERVIEW

Single-file Bloomberg Terminal-style sports betting dashboard. All logic lives in `index.html` (~3,200 lines). Zero dependencies, no build step. Deployed on GitHub Pages at `https://chquordata.github.io/sportsedge-terminal/`.

- **Worker proxy:** `worker/index.js` — Cloudflare Worker for Pinnacle API (Tennis #33) to bypass CORS
- **Dev server:** `npx serve -p 3000 .` (configured in `.claude/launch.json`)

---

## CODE WORKFLOW

**Always: edit → `git add` → `git commit` → `git push origin main`**

Never stop at commit. The live site only updates on push (GitHub Pages).

---

## SPORTS COVERAGE

| Sport | Key | Markets |
|-------|-----|---------|
| Tennis (ATP) | `tennis_atp` | h2h, spreads, totals |
| Tennis (WTA) | `tennis_wta` | h2h, spreads, totals |

---

## KEY CONSTANTS (index.html)

```js
SHARP_BOOKS  = ['Pinnacle', 'Circa Sports', 'BetOnline.ag', 'Bookmaker', 'BookiePro']
LOWVIG_BOOKS = ['LowVig.ag', 'PropSwap', 'Unibet']
SQUARE_BOOKS = ['FanDuel', 'DraftKings', 'BetMGM', 'Caesars', ...rest]

EDGE_THRESHOLDS = { HIGH: 8, MEDIUM: 5, LOW: 3 }  // % deviation from consensus

// Implied probability
aimp(odds) => odds > 0 ? 100/(odds+100) : |odds|/(|odds|+100)
```

---

## ANALYSIS RULES

These rules govern all manual analysis I perform in conversation.

### 1. MANDATORY LIVE LINE PULL

Before any analysis, pull confirmed current prices. Never assume or estimate lines.

**Primary source:** DraftKings
- Search: `[Team A] vs [Team B] DraftKings odds [current date]`
- Tennis: `[Player A] vs [Player B] DraftKings odds [current date]`

**Fallback chain (never leave a line as N/A):**
1. BetMGM — `[matchup] BetMGM odds`
2. FanDuel — `[matchup] FanDuel odds`
3. European decimal odds (Flashscore, SportGambler)

**Decimal → American conversion:**
- Favorite: `(decimal - 1) × 100` → e.g. 1.41 → -244
- Underdog: `-100 / (decimal - 1)` → e.g. 2.90 → +190

If the user provides lines directly, use those — no re-pull needed.

---

### 2. ALT LINE COMPARISON (TENNIS HEAVY FAVORITES)

When a tennis ML is **-200 or worse**, always pull and compare all three vehicles:

| Market | When it's right |
|--------|----------------|
| ML | Only if price gap to -1.5g is under 2% |
| -1.5 games | **Default** — same outcome as ML in 99% of wins (only fails triple tiebreak) |
| -2.5 games | H2H suggests dominant straight sets; verify expected margin first |

Always state implied probability for each option and explain the tradeoff explicitly.

---

### 3. TENNIS GAME SPREAD MATH

Game spread = sum of **all games won across the entire match**. Never calculate set by set.

**Example:** 4-6, 6-3, 6-3
- Winner: 4+6+6 = **16 games**
- Loser: 6+3+3 = **12 games**
- Net margin: **+4** (covers -2.5 and -3.5, does NOT cover -4.5)

Same logic applies to set spreads and total games O/U.

---

### 4. SLATE REVIEWS — POLYMARKET & KALSHI CROSS-CHECK

On multi-game slate requests only (not single-match deep dives):

**Polymarket:** `site:polymarket.com [Team A] [Team B]` — win probability (¢ = %) + total $ volume  
**Kalshi:** `[Team A] [Team B] Kalshi` — note: limited WTA/ATP and international sports coverage

**Volume-adjusted signal thresholds:**

| Volume | Signal |
|--------|--------|
| $10K+ | Actionable — treat gap seriously |
| $1K–$10K | Soft lean — flag thin liquidity |
| Under $1K | Noise — disregard gap entirely |

**Gap interpretation (at $10K+ volume):**
- 5%+ gap → actionable signal
- 3–5% gap → mild lean
- DK higher than prediction market → book may be stale/inflated on favorite
- Prediction market higher than DK → book lagging sharp money

**Output format for slate table:**

| Match | DK (implied) | Source | Polymarket | PM Vol | Gap | Flag |
|-------|-------------|--------|-----------|--------|-----|------|
| Rybakina vs Zheng | -441 (81.5%) | DK | 80¢ (80%) | $1.6K | 1.5% | Noise |

---

### 5. TENNIS SURFACE RESET RULE

Do not overprice historical H2H when the matchup moves to a new surface. H2H built on hard/grass carries minimal predictive weight on clay and vice versa.

Before backing any favorite based on H2H, check: **on which surfaces were those meetings played?**

If the dog has a concrete structural edge on the current surface (better surface record, more recent clay matches, opponent on first clay event of season), lean dog or pass. Never back the favorite on ranking or narrative alone when the surface is new to the matchup.

---

### 6. SPORT-SPECIFIC STAT POLICIES

**Tennis:**
- TRUE SIGNALS (priority order): RetWon% ≥42%, BPconv% gap ≥10pp, 2ndWon% <50%, 1stIn% gap ≥8pp, Surface win% current season, Rest days gap ≥2, BPsave% gap ≥10pp
- H2H is strong only when: 3+ meetings on **today's specific surface**, or dominant 5-0 / 4-0 overall pattern
- World ranking gap ≥20 = structural edge **only** when higher-ranked player also has positive recent form on current surface
- Never cite ranking tier ("top 10"), seed number, or season W-L record as a pick reason
- LIMITED DATA tag: use ranking + market price ONLY — never invent surface records or playing style

**Injury policy:**
- Injury is background context — already priced into the market line
- Never downgrade confidence or skip a pick solely because of an injury listing
- If a match is on the slate, both players are healthy enough to compete. Never cite injury as a reason to skip or downgrade a tennis pick

---

### 7. SESSION MEMORY RULES

- Save every analysis session as `.md` to the `outputs/` directory (create if it doesn't exist)
- Filename convention: `YYYY-MM-DD_TeamA_vs_TeamB.md` or `YYYY-MM-DD_BettingSlate.md`
- Always present the saved file path to the user after saving

---

## DATA SOURCES

| Source | Purpose |
|--------|---------|
| The Odds API | Live odds, 10+ sportsbooks (500 req/mo free) |
| Pinnacle API (CF Worker) | Sharp money reference — Tennis |
| Tennis News API (TheSportsDB) | Player profiles, H2H records, ATP/WTA rankings |
| GitHub / Jeff Sackmann | ATP/WTA historical match data 2021–2024 (surface stats) |
