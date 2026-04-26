# 2026-04-26 — Terminal Development: Phase 1 Architecture Session

## Session Type
Code development + one live analysis re-run (Rybakina vehicle correction)

---

## Analysis: Rybakina -1.5 Sets Re-Assessment

**Context:** User asked whether Rybakina straight sets (-1.5 sets) was still viable after discovering she dropped a set vs Ruse in R2 at Madrid.

**Conclusion:** Vehicle downgraded from -1.5 sets → -1.5 games.

- Dimension votes unchanged: Rybakina 5 — Zheng 1 (side correct)
- Vehicle override fires: ⚠️ dropped a set vs Ruse (R2, same tournament, same surface)
- -1.5 sets requires straight sets; Ruse R2 3-setter means real 3-setter risk vs Zheng
- -1.5 games survives a 3-setter as long as she wins by 2+ total games

**Rule reinforced:** Never take -1.5 sets on a player who went 3 sets in the same draw, regardless of their dominance level. The vehicle is wrong even when the side is right.

---

## Development Work Completed

### 1. Line Movement into Phase 1 (all 4 sports)

- `buildGamesContext`: extended lineMove block to also output total line movement (was spread-only before)
- Tennis Phase 1: signal #10 — spread move ≥1.5 votes for player line moved toward
- MLB Phase 1: signal #12 — spread/total movement votes
- NHL Phase 1: signal #9 — spread/total movement votes
- NBA Phase 1 playoffs: signal #7 added (regular season already had it)

### 2. Tennis In-Tournament Form (set scores)

- `tennisForm` already stored `score` field (ESPN linescores). Was not being displayed.
- `buildGamesContext` L5 form: now shows score + `(3S)` flag for 3-setters
- New "this tournament" breakdown per player: all results with scores, flags ⚠️ has dropped a set
- Phase 1 VEHICLE OVERRIDE: caps -1.5 sets → -1.5 games when ⚠️ present; caps to ML if dropped a set vs today's opponent

### 3. Tennis Alt Lines Block

- Phase 1 now evaluates game spread viability (-3.5/-4.5/-5.5+) using BPconv, 1stIn, surface form
- Phase 1 now evaluates first set winner independently using SERVE dimension signals + rest gap
- JSON schema: `alt_lines.game_spread` and `alt_lines.first_set` fields

### 4. Unit Sizing + Parlay Tier (all 4 sports)

- All Phase 1 analysts now output `units` (2/1/0.5) and `parlay_tier` (leg/standalone/avoid)
- Derived mechanically from confidence tier — Phase 2 uses these for parlay construction

### 5. Sport-Specific Learned Rules

- `syncFromKV` / `syncToKV` now include 4 sport-specific rule keys:
  `et_learned_rules_tennis`, `_nba`, `_mlb`, `_nhl`
- Phase 1 call block injects sport-specific rules at top of each analyst's context as highest-priority overrides
- Helper `_mkRules(key, sport)` prepends "LEARNED RULES (sport — apply these first)" if rules exist

### 6. Tennis Phase 1: 5-Dimension Architecture

**The big structural change.** Replaced flat 11-signal vote list with 5 independent dimensions.

**Problem fixed:** Signal cannibalization. RetWon% + BPconv% were both firing as separate votes for the same return-dominance edge. Market implied% + line movement were double-counting the same consensus. A player could get a 9-0 "score" from 2 underlying advantages.

**New architecture:**

| Dimension | Signals that feed it |
|-----------|---------------------|
| SERVE | 1stIn%, BPsave% |
| RETURN | RetWon%, BPconv%, 2ndWon% |
| FORM | Surface win%, H2H on surface, in-tournament results |
| PHYSICAL | Rest days, match load |
| MARKET | Implied% + line movement (combined — ONE vote) |

Max possible: 5-0 instead of inflated 9-0. Each dimension evaluates its sub-signals internally and produces exactly one vote.

**Vehicle mapping unchanged:** 4-5 dim votes → -1.5 sets, 3 → -1.5 games, 2-1 → ML, ≤2 → PASS.

**JSON schema updated:** `dimensions` object replaces flat `signals` array. Each dimension shows winner + sub-signal details.

### 7. Tennis-Specific Gaps (4 items)

**a) Tiebreak detection**
- `tennisForm` push now stores `ret: st !== 'STATUS_FINAL'`
- Tournament form display detects 7-6 sets → flags `⚠️ tiebreak in draw`
- Phase 1 VEHICLE OVERRIDE: tiebreak reduces game spread ceiling by one step (-4.5 → -3.5 max)

**b) Left-handed advantage on clay**
- Clay surface context note updated: "LH players: cross-court forehand to RH backhand is structural on slow courts"
- Phase 1 FORM dimension: LH clay advantage counts as additional sub-signal (training knowledge used for handedness)

**c) Opponent quality weighting**
- Phase 1 FORM dimension: if L5 opponents appear to be qualifiers/ranked >50, surface win% flagged as "vs lower competition" — requires 2 other sub-signals to assign FORM vote

**d) Retirement/walkover flag**
- `tennisForm` entries now store `ret: true` for STATUS_RETIRED/WALKOVER/FORFEIT
- Shows as `(ret/WO)` inline in tournament and L5 form strings
- Phase 1: last match ended ret/WO weakens in-tournament sub-signal ("match sharpness unknown")

---

## State of Parlay (from prior session — still live)

| Leg | Status |
|-----|--------|
| Sinner -5.5 games | WIN |
| Gauff ML -115 (live bet) | WIN |
| Rybakina straight sets | Downgraded to -1.5 games (not placed at -1.5 sets) |
| Cavs -2.5 | TBD (tonight) |
| Fonseca +1.5 first set games (-150) | TBD (night session) |

---

## Key Architectural Decisions

1. **Dimensional grouping > flat vote list** — correlated signals must be grouped and produce one vote per dimension. Adding a new signal to tennis now means placing it in the right dimension, not adding a new vote.

2. **Sport-specific learned rules** — lessons from NBA parlays should never influence tennis analysis. Four separate rule stores prevent cross-sport contamination.

3. **Phase 1 is structural, Phase 2 is narrative** — Phase 1 derives the pick mechanically from data. Phase 2 receives locked conclusions and writes the explanation. They cannot contradict each other.

4. **Vehicle is doubly constrained** — by dimension vote count AND in-tournament form. Both must clear for -1.5 sets. One veto (dropped a set, tiebreak) downgrades the vehicle even if the vote count is 5-0.
