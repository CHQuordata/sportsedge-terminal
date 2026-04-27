import { describe, test, expect } from 'vitest';
import { gradePickFromScore } from '../index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeGame({ homeTeam, awayTeam, homeScore, awayScore }) {
  return {
    home_team: homeTeam,
    away_team: awayTeam,
    completed: true,
    scores: [
      { name: homeTeam, score: String(homeScore) },
      { name: awayTeam, score: String(awayScore) },
    ],
  };
}

function pick(pickStr, matchup) {
  return { pick: pickStr, matchup };
}

const CELTICS_HEAT = makeGame({
  homeTeam: 'Boston Celtics',
  awayTeam: 'Miami Heat',
  homeScore: 115,
  awayScore: 108,
});

const CHIEFS_EAGLES = makeGame({
  homeTeam: 'Kansas City Chiefs',
  awayTeam: 'Philadelphia Eagles',
  homeScore: 27,
  awayScore: 17,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('gradePickFromScore', () => {

  // ── Game matching ────────────────────────────────────────────────────────────

  describe('game matching', () => {
    test('returns null when no game matches the matchup tokens', () => {
      expect(gradePickFromScore(
        pick('OVER 200 (-110)', 'Lakers vs Clippers'),
        [CELTICS_HEAT]
      )).toBe(null);
    });

    test('returns null when games array is empty', () => {
      expect(gradePickFromScore(
        pick('OVER 200 (-110)', 'Celtics vs Heat'),
        []
      )).toBe(null);
    });

    test('returns null when matched game has no scores property', () => {
      const game = { home_team: 'Boston Celtics', away_team: 'Miami Heat', completed: true };
      expect(gradePickFromScore(pick('OVER 200 (-110)', 'Celtics vs Heat'), [game])).toBe(null);
    });

    test('returns null when matched game has an empty scores array', () => {
      const game = { home_team: 'Boston Celtics', away_team: 'Miami Heat', completed: true, scores: [] };
      expect(gradePickFromScore(pick('OVER 200 (-110)', 'Celtics vs Heat'), [game])).toBe(null);
    });

    test('returns null when home score is not parseable as a number', () => {
      const game = {
        home_team: 'Boston Celtics', away_team: 'Miami Heat', completed: true,
        scores: [
          { name: 'Boston Celtics', score: 'TBD' },
          { name: 'Miami Heat', score: '108' },
        ],
      };
      expect(gradePickFromScore(pick('OVER 200 (-110)', 'Celtics vs Heat'), [game])).toBe(null);
    });

    test('returns null when away score is not parseable as a number', () => {
      const game = {
        home_team: 'Boston Celtics', away_team: 'Miami Heat', completed: true,
        scores: [
          { name: 'Boston Celtics', score: '115' },
          { name: 'Miami Heat', score: 'N/A' },
        ],
      };
      expect(gradePickFromScore(pick('OVER 200 (-110)', 'Celtics vs Heat'), [game])).toBe(null);
    });

    test('returns null when matchup is empty — no tokens to match on', () => {
      expect(gradePickFromScore(pick('OVER 200 (-110)', ''), [CELTICS_HEAT])).toBe(null);
    });

    test('matches using a single partial team name token', () => {
      // 'Celtics' alone should match 'Boston Celtics'
      expect(gradePickFromScore(
        pick('OVER 220 (-110)', 'Celtics vs Heat'),
        [CELTICS_HEAT]
      )).toBe('W'); // 115 + 108 = 223 > 220
    });

    test('matching is case-insensitive', () => {
      expect(gradePickFromScore(
        pick('OVER 220 (-110)', 'CELTICS VS HEAT'),
        [CELTICS_HEAT]
      )).toBe('W');
    });

    test('picks the first game from multiple that matches a token', () => {
      const earlyGame = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Chicago Bulls', homeScore: 90, awayScore: 88 });
      const lateGame  = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat',   homeScore: 115, awayScore: 108 });
      // Both contain 'Celtics'; the first one in the array is used
      expect(gradePickFromScore(
        pick('OVER 200 (-110)', 'Celtics vs Bulls'),
        [earlyGame, lateGame]
      )).toBe('L'); // 90 + 88 = 178 < 200
    });
  });

  // ── Totals (OVER / UNDER) ─────────────────────────────────────────────────────

  describe('totals', () => {
    const game223 = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', homeScore: 115, awayScore: 108 });
    const game198 = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', homeScore: 100, awayScore: 98  });
    const game220 = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', homeScore: 110, awayScore: 110 });

    test('OVER wins when combined score exceeds the line', () => {
      expect(gradePickFromScore(pick('OVER 220 (-110)', 'Celtics vs Heat'), [game223])).toBe('W');
    });

    test('OVER loses when combined score is below the line', () => {
      expect(gradePickFromScore(pick('OVER 220 (-110)', 'Celtics vs Heat'), [game198])).toBe('L');
    });

    test('OVER pushes when combined score equals the line exactly', () => {
      expect(gradePickFromScore(pick('OVER 220 (-110)', 'Celtics vs Heat'), [game220])).toBe('P');
    });

    test('UNDER wins when combined score is below the line', () => {
      expect(gradePickFromScore(pick('UNDER 220 (-110)', 'Celtics vs Heat'), [game198])).toBe('W');
    });

    test('UNDER loses when combined score exceeds the line', () => {
      expect(gradePickFromScore(pick('UNDER 220 (-110)', 'Celtics vs Heat'), [game223])).toBe('L');
    });

    test('UNDER pushes when combined score equals the line exactly', () => {
      expect(gradePickFromScore(pick('UNDER 220 (-110)', 'Celtics vs Heat'), [game220])).toBe('P');
    });

    test('half-point total — OVER wins, push is impossible', () => {
      const game = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', homeScore: 110, awayScore: 111 });
      expect(gradePickFromScore(pick('OVER 220.5 (-110)', 'Celtics vs Heat'), [game])).toBe('W'); // 221 > 220.5
    });

    test('half-point total — UNDER wins when combined lands below it', () => {
      expect(gradePickFromScore(pick('UNDER 220.5 (-110)', 'Celtics vs Heat'), [game220])).toBe('W'); // 220 < 220.5
    });

    test('keyword matching is case-insensitive', () => {
      expect(gradePickFromScore(pick('over 220 (-110)', 'Celtics vs Heat'), [game223])).toBe('W');
      expect(gradePickFromScore(pick('Under 220 (-110)', 'Celtics vs Heat'), [game198])).toBe('W');
    });

    test('handles integer totals with no decimal (e.g. MLB run total 8)', () => {
      const game = makeGame({ homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', homeScore: 5, awayScore: 4 });
      expect(gradePickFromScore(pick('OVER 8 (-115)', 'Yankees vs Red Sox'), [game])).toBe('W'); // 9 > 8
    });
  });

  // ── Spreads ────────────────────────────────────────────────────────────────

  describe('spread picks', () => {
    // Chiefs 27, Eagles 17 → home margin = +10

    test('home favorite covers — W', () => {
      // Chiefs -3.5: (27 - 17) + (-3.5) = +6.5 → W
      expect(gradePickFromScore(
        pick('Kansas City Chiefs -3.5 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('W');
    });

    test('home favorite fails to cover — L', () => {
      // Chiefs -13.5: (27 - 17) + (-13.5) = -3.5 → L
      expect(gradePickFromScore(
        pick('Kansas City Chiefs -13.5 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('L');
    });

    test('home team spread pushes when margin equals spread exactly', () => {
      // Chiefs -10: (27 - 17) + (-10) = 0 → P
      expect(gradePickFromScore(
        pick('Kansas City Chiefs -10 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('P');
    });

    test('away underdog covers with plus-spread — W', () => {
      // Eagles +13.5: (17 - 27) + 13.5 = +3.5 → W
      expect(gradePickFromScore(
        pick('Philadelphia Eagles +13.5 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('W');
    });

    test('away underdog fails to cover — L', () => {
      // Eagles +3.5: (17 - 27) + 3.5 = -6.5 → L
      expect(gradePickFromScore(
        pick('Philadelphia Eagles +3.5 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('L');
    });

    test('away team spread pushes when margin equals spread exactly', () => {
      // Eagles +10: (17 - 27) + 10 = 0 → P
      expect(gradePickFromScore(
        pick('Philadelphia Eagles +10 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('P');
    });

    test('returns null when spread team does not match either team', () => {
      expect(gradePickFromScore(
        pick('Dallas Cowboys -3.5 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe(null);
    });

    test('spread matching works with partial team name token', () => {
      // "Chiefs" alone should resolve to home team Kansas City Chiefs
      expect(gradePickFromScore(
        pick('Chiefs -3.5 (-110)', 'Chiefs vs Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('W');
    });

    test('spread matching works with full team name', () => {
      expect(gradePickFromScore(
        pick('Kansas City Chiefs -3.5 (-110)', 'Kansas City Chiefs vs Philadelphia Eagles'),
        [CHIEFS_EAGLES]
      )).toBe('W');
    });
  });

  // ── Moneyline ─────────────────────────────────────────────────────────────────

  describe('moneyline picks', () => {
    const heatWin = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', homeScore: 100, awayScore: 108 });
    const tie     = makeGame({ homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat', homeScore: 108, awayScore: 108 });

    test('home team ML wins — W', () => {
      expect(gradePickFromScore(
        pick('Boston Celtics ML (-150)', 'Celtics vs Heat'),
        [CELTICS_HEAT]
      )).toBe('W');
    });

    test('home team ML loses — L', () => {
      expect(gradePickFromScore(
        pick('Boston Celtics ML (-150)', 'Celtics vs Heat'),
        [heatWin]
      )).toBe('L');
    });

    test('away team ML wins — W', () => {
      expect(gradePickFromScore(
        pick('Miami Heat ML (+120)', 'Celtics vs Heat'),
        [heatWin]
      )).toBe('W');
    });

    test('away team ML loses — L', () => {
      expect(gradePickFromScore(
        pick('Miami Heat ML (+120)', 'Celtics vs Heat'),
        [CELTICS_HEAT]
      )).toBe('L');
    });

    test('ML grades as P on an exact tied score', () => {
      expect(gradePickFromScore(
        pick('Boston Celtics ML (-150)', 'Celtics vs Heat'),
        [tie]
      )).toBe('P');
    });

    test('accepts format without ML keyword — "Team (-150)"', () => {
      expect(gradePickFromScore(
        pick('Boston Celtics (-150)', 'Celtics vs Heat'),
        [CELTICS_HEAT]
      )).toBe('W');
    });

    test('accepts format with positive odds and no parens — "Team +120"', () => {
      expect(gradePickFromScore(
        pick('Miami Heat +120', 'Celtics vs Heat'),
        [heatWin]
      )).toBe('W');
    });

    test('returns null when ML team does not match either team', () => {
      expect(gradePickFromScore(
        pick('Los Angeles Lakers ML (-200)', 'Celtics vs Heat'),
        [CELTICS_HEAT]
      )).toBe(null);
    });
  });

  // ── Unrecognized / malformed picks ────────────────────────────────────────────

  describe('unrecognized pick formats', () => {
    test('returns null for empty pick string', () => {
      expect(gradePickFromScore(pick('', 'Celtics vs Heat'), [CELTICS_HEAT])).toBe(null);
    });

    test('returns null for plain text that matches no pattern', () => {
      expect(gradePickFromScore(pick('some random text', 'Celtics vs Heat'), [CELTICS_HEAT])).toBe(null);
    });

    test('returns null when pick has no odds digits — unrecognized market', () => {
      expect(gradePickFromScore(pick('Boston Celtics first half', 'Celtics vs Heat'), [CELTICS_HEAT])).toBe(null);
    });
  });
});
