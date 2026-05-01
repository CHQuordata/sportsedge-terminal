# 2026-05-01 — Self-Learning System Review & Bug Fixes

## Session Type
Code review and bug fix session. No picks generated.

---

## Context

Reviewed the self-learning pipeline end-to-end: nightly cron grading, signal performance tracking, Claude Haiku rule extraction, and how learned rules feed back into daily pick generation.

---

## Gap Noted: April 28–30

No `outputs/` files exist for April 28, 29, or 30. CLAUDE.md session memory rule requires saving every analysis session to `outputs/`. These sessions were either not run or not saved. No retroactive recovery possible — pick history for those dates exists only in KV/localStorage.

**Going forward:** every analysis session, including single-match deep dives, must be saved here before the session ends.

---

## Bugs Fixed (committed to `claude/review-self-learning-grading-8v2MU`)

### Fix 1 — Frontend series grading date disambiguation
**File:** `index.html` — `_findGameFE`, `gradePickFromScore`, `autoGradeFromScores`

**Problem:** `_findGameFE` returned `null` for any matchup with multiple completed game candidates (NBA/NHL playoff series, MLB 3-game series). The worker's `findGameForPick` correctly disambiguated these using `pickDate`; the frontend did not.

**Effect:** Playoff picks showed `?` indefinitely in the browser session. The nightly cron graded them correctly, but the client never resolved them between cron runs.

**Fix:** Ported the worker's date disambiguation logic into `_findGameFE(matchup, games, pickDate)`. `autoGradeFromScores` now passes `slate.date` through the call chain.

---

### Fix 2 — Sport-specific learned rules not reaching Phase 2
**File:** `index.html` — `generatePicks`

**Problem:** Phase 2 (main picks call) used `et_learned_rules` (legacy monolithic key) or `DEFAULT_LEARNED_RULES`. Sport-specific rules extracted by the learning agent (`et_learned_rules_tennis`, `et_learned_rules_nba`, etc.) only reached Phase 2 indirectly through Phase 1's analysis output.

**Fix:** After loading the legacy rules string, sport-specific rules for all 4 sports are appended inline before `buildSystemPrompt` is called. Each block is labeled with the sport and marked highest priority.

---

### Fix 3 — Wilson CI significance flags missing from Phase 1 signal context
**File:** `index.html` — `_mkRules` inline function in `generatePicks`

**Problem:** Signal track record injected into Phase 1 showed raw W-L-P counts without `[EDGE]/[FADE]/[NOISE]` significance tags. Phase 1 had no way to distinguish statistically real edges from small-sample noise.

**Fix:** Added `flag = v.significant_edge ? '[EDGE]' : v.significant_fade ? '[FADE]' : '[NOISE]'` to each signal line. Updated the header to explain the tags.

---

## Self-Learning System Status

Architecture is sound. The three-layer pipeline (grading → signal tracking → rule extraction) works correctly in the worker. All fixes above bring the frontend's client-side grading and prompt injection into parity with the worker's behavior.
