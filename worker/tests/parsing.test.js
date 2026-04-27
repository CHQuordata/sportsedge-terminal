import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractPitchers, extractNBAStats, extractNHLStats } from '../../lib/parsing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

// ── extractPitchers ───────────────────────────────────────────────────────────

describe('extractPitchers', () => {
  const data = fixture('espn-mlb-pitchers.json');

  test('returns null when data has no competitions', () => {
    expect(extractPitchers(null)).toBeNull();
    expect(extractPitchers({})).toBeNull();
    expect(extractPitchers({ header: {} })).toBeNull();
  });

  test('returns null when competitions array is empty', () => {
    expect(extractPitchers({ header: { competitions: [] } })).toBeNull();
  });

  test('returns null when no competitors have probables', () => {
    const d = { header: { competitions: [{ competitors: [{ homeAway: 'home' }] }] } };
    expect(extractPitchers(d)).toBeNull();
  });

  test('parses home pitcher name', () => {
    const result = extractPitchers(data);
    expect(result.home.name).toBe('G. Cole');
  });

  test('parses away pitcher name', () => {
    const result = extractPitchers(data);
    expect(result.away.name).toBe('C. Burnes');
  });

  test('parses throwing hand', () => {
    expect(extractPitchers(data).home.hand).toBe('R');
    expect(extractPitchers(data).away.hand).toBe('R');
  });

  test('parses ERA and WHIP as display strings', () => {
    const { home, away } = extractPitchers(data);
    expect(home.era).toBe('3.20');
    expect(home.whip).toBe('1.08');
    expect(away.era).toBe('2.94');
    expect(away.whip).toBe('0.99');
  });

  test('calculates K/9 from strikeouts and IP', () => {
    // Cole: 208 K / 180 IP × 9 = 10.4
    expect(parseFloat(extractPitchers(data).home.k9)).toBeCloseTo(10.4, 1);
  });

  test('calculates BB/9', () => {
    // Cole: 45 BB / 180 IP × 9 = 2.25 ≈ 2.2
    expect(parseFloat(extractPitchers(data).home.bb9)).toBeCloseTo(2.25, 1);
  });

  test('calculates HR/9', () => {
    // Cole: 22 HR / 180 IP × 9 = 1.1
    expect(parseFloat(extractPitchers(data).home.hr9)).toBeCloseTo(1.1, 1);
  });

  test('parses partial innings correctly — 2 partial innings = 0.667 IP added', () => {
    // Burnes: 195 full + 2 partial = 195.667 IP
    const ip = parseFloat(extractPitchers(data).away.ip);
    expect(ip).toBeCloseTo(195.667, 1);
  });

  test('parses win/loss record', () => {
    const { home, away } = extractPitchers(data);
    expect(home.w).toBe(14);
    expect(home.l).toBe(6);
    expect(away.w).toBe(16);
    expect(away.l).toBe(5);
  });

  test('returns -- for k9/bb9/hr9 when IP is 1 or less', () => {
    const d = { header: { competitions: [{ competitors: [{
      homeAway: 'home',
      probables: [{ athlete: { shortName: 'Opener', throws: {} }, statistics: { splits: { categories: [
        { name: 'fullInnings', value: 1 },
        { name: 'partInnings', value: 0 },
        { name: 'strikeouts', value: 2 },
      ] } } }]
    }] }] } };
    expect(extractPitchers(d).home.k9).toBe('--');
  });
});

// ── extractNBAStats ────────────────────────────────────────────────────────────

describe('extractNBAStats', () => {
  const data = fixture('espn-nba-stats.json');

  test('returns null for null input', () => {
    expect(extractNBAStats(null)).toBeNull();
  });

  test('parses points per game', () => {
    expect(extractNBAStats(data).ppg).toBe('116.4');
  });

  test('parses opponent points per game', () => {
    expect(extractNBAStats(data).oppPpg).toBe('109.8');
  });

  test('computes net points differential', () => {
    // 116.4 − 109.8 = 6.6
    expect(extractNBAStats(data).netPts).toBe('6.6');
  });

  test('parses pace', () => {
    expect(extractNBAStats(data).pace).toBe(101.2);
  });

  test('parses shooting percentages', () => {
    const stats = extractNBAStats(data);
    expect(stats.fgPct).toBe('47.8');
    expect(stats.tpPct).toBe('36.2');
    expect(stats.ftPct).toBe('78.5');
  });

  test('parses per-game counting stats', () => {
    const stats = extractNBAStats(data);
    expect(stats.ast).toBe('27.2');
    expect(stats.reb).toBe('44.1');
    expect(stats.blk).toBe('5.2');
    expect(stats.stl).toBe('8.1');
    expect(stats.toPg).toBe('13.5');
  });

  test('handles response using splits.categories path', () => {
    const altData = { splits: { categories: data.results.stats.categories } };
    const result = extractNBAStats(altData);
    expect(result.ppg).toBe('116.4');
  });

  test('handles response using results.splits.categories path', () => {
    const altData = { results: { splits: { categories: data.results.stats.categories } } };
    const result = extractNBAStats(altData);
    expect(result.ppg).toBe('116.4');
  });
});

// ── extractNHLStats ────────────────────────────────────────────────────────────

describe('extractNHLStats', () => {
  const data = fixture('espn-nhl-stats.json');

  test('returns null for null input', () => {
    expect(extractNHLStats(null)).toBeNull();
  });

  test('parses goals-against average', () => {
    // value is 2.659, toFixed(2) = "2.66"
    expect(extractNHLStats(data).gaa).toBe('2.66');
  });

  test('parses save percentage to 3 decimal places', () => {
    expect(extractNHLStats(data).savePct).toBe('0.912');
  });

  test('computes goals per game', () => {
    // 262 goals / 82 games = 3.195... → "3.20"
    expect(extractNHLStats(data).gpg).toBe('3.20');
  });

  test('computes shots per game', () => {
    // 2706 / 82 = 32.97... → "33.0"
    expect(extractNHLStats(data).shotsPg).toBe('33.0');
  });

  test('parses power play percentage', () => {
    expect(extractNHLStats(data).ppPct).toBe('21.3');
  });

  test('parses penalty kill percentage', () => {
    expect(extractNHLStats(data).pkPct).toBe('82.1');
  });

  test('parses shooting percentage', () => {
    expect(extractNHLStats(data).shootPct).toBe('9.7');
  });

  test('parses faceoff percentage', () => {
    expect(extractNHLStats(data).foPct).toBe('51.2');
  });

  test('parses power play goals as raw value', () => {
    expect(extractNHLStats(data).ppg).toBe(52);
  });
});
