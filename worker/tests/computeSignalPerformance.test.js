import { describe, test, expect } from 'vitest';
import { computeSignalPerformance } from '../index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const today = new Date().toISOString();
const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function makeSlate(date, picks) {
  return { date, picks };
}

function makePick(result, filters = [], phase1_signals = []) {
  return { result, filters, phase1_signals };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeSignalPerformance', () => {

  // ── Basic counting ────────────────────────────────────────────────────────

  describe('basic counting', () => {
    test('returns empty object for empty history', () => {
      expect(computeSignalPerformance([])).toEqual({});
    });

    test('counts a W for a pick with a filter tag', () => {
      const history = [makeSlate(today, [makePick('W', ['high_ev'])])];
      expect(computeSignalPerformance(history)).toEqual({
        high_ev: { w: 1, l: 0, p: 0 },
      });
    });

    test('counts an L', () => {
      const history = [makeSlate(today, [makePick('L', ['sharp_signal'])])];
      expect(computeSignalPerformance(history)).toEqual({
        sharp_signal: { w: 0, l: 1, p: 0 },
      });
    });

    test('counts a P (push)', () => {
      const history = [makeSlate(today, [makePick('P', ['b2b_fade'])])];
      expect(computeSignalPerformance(history)).toEqual({
        b2b_fade: { w: 0, l: 0, p: 1 },
      });
    });

    test('accumulates W/L/P across multiple picks in the same slate', () => {
      const history = [makeSlate(today, [
        makePick('W', ['tag_a']),
        makePick('L', ['tag_a']),
        makePick('P', ['tag_a']),
      ])];
      expect(computeSignalPerformance(history)).toEqual({
        tag_a: { w: 1, l: 1, p: 1 },
      });
    });

    test('accumulates across multiple slates', () => {
      const history = [
        makeSlate(today, [makePick('W', ['tag_a'])]),
        makeSlate(today, [makePick('W', ['tag_a'])]),
        makeSlate(today, [makePick('L', ['tag_a'])]),
      ];
      expect(computeSignalPerformance(history)).toEqual({
        tag_a: { w: 2, l: 1, p: 0 },
      });
    });

    test('tracks multiple different tags independently', () => {
      const history = [makeSlate(today, [
        makePick('W', ['tag_a']),
        makePick('L', ['tag_b']),
      ])];
      expect(computeSignalPerformance(history)).toEqual({
        tag_a: { w: 1, l: 0, p: 0 },
        tag_b: { w: 0, l: 1, p: 0 },
      });
    });

    test('one pick with multiple tags increments each tag separately', () => {
      const history = [makeSlate(today, [makePick('W', ['tag_a', 'tag_b'])])];
      expect(computeSignalPerformance(history)).toEqual({
        tag_a: { w: 1, l: 0, p: 0 },
        tag_b: { w: 1, l: 0, p: 0 },
      });
    });
  });

  // ── Result filtering ────────────────────────────────────────────────────────

  describe('result filtering', () => {
    test('ignores picks with result === "?"', () => {
      const history = [makeSlate(today, [makePick('?', ['pending_signal'])])];
      expect(computeSignalPerformance(history)).toEqual({});
    });

    test('ignores picks with null result', () => {
      const history = [makeSlate(today, [makePick(null, ['some_signal'])])];
      expect(computeSignalPerformance(history)).toEqual({});
    });

    test('ignores picks with no result field', () => {
      const history = [makeSlate(today, [{ filters: ['tag'], phase1_signals: [] }])];
      expect(computeSignalPerformance(history)).toEqual({});
    });
  });

  // ── Date cutoff ────────────────────────────────────────────────────────────

  describe('30-day date cutoff', () => {
    test('excludes slates older than 30 days', () => {
      const history = [makeSlate(daysAgo(31), [makePick('W', ['old_signal'])])];
      expect(computeSignalPerformance(history)).toEqual({});
    });

    test('includes slates from 29 days ago', () => {
      const history = [makeSlate(daysAgo(29), [makePick('W', ['recent_signal'])])];
      expect(computeSignalPerformance(history)).toEqual({
        recent_signal: { w: 1, l: 0, p: 0 },
      });
    });

    test('mixes old and recent slates, only counts recent', () => {
      const history = [
        makeSlate(daysAgo(31), [makePick('W', ['signal'])]),
        makeSlate(daysAgo(1),  [makePick('L', ['signal'])]),
      ];
      expect(computeSignalPerformance(history)).toEqual({
        signal: { w: 0, l: 1, p: 0 },
      });
    });
  });

  // ── Tag merging (filters + phase1_signals) ──────────────────────────────────

  describe('tag merging', () => {
    test('merges filters and phase1_signals, no double-counting when tag appears in both', () => {
      const history = [makeSlate(today, [
        makePick('W', ['shared_tag'], ['shared_tag']),
      ])];
      expect(computeSignalPerformance(history)).toEqual({
        shared_tag: { w: 1, l: 0, p: 0 },
      });
    });

    test('counts tags from phase1_signals only', () => {
      const history = [makeSlate(today, [
        makePick('W', [], ['phase1_only']),
      ])];
      expect(computeSignalPerformance(history)).toEqual({
        phase1_only: { w: 1, l: 0, p: 0 },
      });
    });

    test('normalizes filter tag whitespace to underscores and lowercases', () => {
      const history = [makeSlate(today, [makePick('W', ['Sharp Signal'])])];
      expect(computeSignalPerformance(history)).toEqual({
        sharp_signal: { w: 1, l: 0, p: 0 },
      });
    });

    test('skips blank/empty tags', () => {
      const history = [makeSlate(today, [makePick('W', ['', 'valid_tag'], [])])];
      expect(computeSignalPerformance(history)).toEqual({
        valid_tag: { w: 1, l: 0, p: 0 },
      });
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('handles slate with no picks array', () => {
      const history = [{ date: today }];
      expect(computeSignalPerformance(history)).toEqual({});
    });

    test('handles slate with empty picks array', () => {
      const history = [makeSlate(today, [])];
      expect(computeSignalPerformance(history)).toEqual({});
    });

    test('handles pick with no filters or signals', () => {
      const history = [makeSlate(today, [makePick('W', [], [])])];
      expect(computeSignalPerformance(history)).toEqual({});
    });
  });
});
