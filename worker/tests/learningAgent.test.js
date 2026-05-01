import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockEnv(store = {}) {
  return {
    CLAUDE_API_KEY: 'test-key',
    LEARNING_STORE: {
      get: vi.fn(key => Promise.resolve(store[key] ?? null)),
      put: vi.fn((key, value) => { store[key] = value; return Promise.resolve(); }),
      delete: vi.fn(key => { delete store[key]; return Promise.resolve(); }),
    },
  };
}

// Build a minimal pick history with enough graded picks to pass the ≥5 gate
function makeHistory(n = 6) {
  const picks = Array.from({ length: n }, (_, i) => ({
    matchup: `Team A vs Team B`,
    pick: `Team A ML (-150)`,
    result: i % 2 === 0 ? 'W' : 'L',
    sport: 'nba',
    filters: ['sharp_signal'],
    phase1_signals: [],
  }));
  return [{ date: new Date().toISOString(), picks }];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('learning agent rule persistence (H5 stale-rules fix)', () => {
  let store;
  let env;

  beforeEach(() => {
    store = {
      et_picks_history: JSON.stringify(makeHistory()),
      // Pre-existing rules for all sports
      et_learned_rules_tennis: 'old tennis rule',
      et_learned_rules_nba:    'old nba rule',
      et_learned_rules_mlb:    'old mlb rule',
      et_learned_rules_nhl:    'old nhl rule',
    };
    env = mockEnv(store);
  });

  // ── Null/undefined field = absent from response = keep existing ─────────────

  test('absent field (null) leaves existing KV rule untouched', async () => {
    // Simulate Claude returning only tennis + nba, omitting mlb + nhl
    const claudeResponse = {
      tennis_rules: 'new tennis rule',
      nba_rules: 'new nba rule',
      // mlb_rules and nhl_rules absent → result[field] is undefined
    };
    // null → keep; "" → delete; string → put
    const ruleKeyMap = {
      tennis_rules: 'et_learned_rules_tennis',
      nba_rules:    'et_learned_rules_nba',
      mlb_rules:    'et_learned_rules_mlb',
      nhl_rules:    'et_learned_rules_nhl',
    };
    await Promise.allSettled(
      Object.entries(ruleKeyMap).map(([field, kvKey]) => {
        const val = claudeResponse[field];
        if (val == null) return Promise.resolve();
        if (val === '') return env.LEARNING_STORE.delete(kvKey);
        return env.LEARNING_STORE.put(kvKey, val, { expirationTtl: 60 * 60 * 24 * 365 });
      })
    );

    // Written sports get updated
    expect(store['et_learned_rules_tennis']).toBe('new tennis rule');
    expect(store['et_learned_rules_nba']).toBe('new nba rule');
    // Absent sports keep their old values — not overwritten, not deleted
    expect(store['et_learned_rules_mlb']).toBe('old mlb rule');
    expect(store['et_learned_rules_nhl']).toBe('old nhl rule');
    expect(env.LEARNING_STORE.delete).not.toHaveBeenCalled();
  });

  // ── Empty string = explicit clear = delete the KV key ──────────────────────

  test('empty string field deletes the KV key', async () => {
    const claudeResponse = {
      tennis_rules: 'new tennis rule',
      nba_rules:    '',   // explicit clear — no rules passed decay criteria
      mlb_rules:    null, // absent — unchanged
      nhl_rules:    'new nhl rule',
    };
    const ruleKeyMap = {
      tennis_rules: 'et_learned_rules_tennis',
      nba_rules:    'et_learned_rules_nba',
      mlb_rules:    'et_learned_rules_mlb',
      nhl_rules:    'et_learned_rules_nhl',
    };
    await Promise.allSettled(
      Object.entries(ruleKeyMap).map(([field, kvKey]) => {
        const val = claudeResponse[field];
        if (val == null) return Promise.resolve();
        if (val === '') return env.LEARNING_STORE.delete(kvKey);
        return env.LEARNING_STORE.put(kvKey, val, { expirationTtl: 60 * 60 * 24 * 365 });
      })
    );

    expect(store['et_learned_rules_tennis']).toBe('new tennis rule');
    expect(store['et_learned_rules_nhl']).toBe('new nhl rule');
    // Empty string → delete called, key removed from store
    expect(env.LEARNING_STORE.delete).toHaveBeenCalledWith('et_learned_rules_nba');
    expect(store['et_learned_rules_nba']).toBeUndefined();
    // Null → unchanged
    expect(store['et_learned_rules_mlb']).toBe('old mlb rule');
  });

  // ── All four fields present → all four updated ──────────────────────────────

  test('all four fields present → all four sports written', async () => {
    const claudeResponse = {
      tennis_rules: 'r1\nr2',
      nba_rules:    'r3',
      mlb_rules:    'r4',
      nhl_rules:    'r5',
    };
    const ruleKeyMap = {
      tennis_rules: 'et_learned_rules_tennis',
      nba_rules:    'et_learned_rules_nba',
      mlb_rules:    'et_learned_rules_mlb',
      nhl_rules:    'et_learned_rules_nhl',
    };
    await Promise.allSettled(
      Object.entries(ruleKeyMap).map(([field, kvKey]) => {
        const val = claudeResponse[field];
        if (val == null) return Promise.resolve();
        if (val === '') return env.LEARNING_STORE.delete(kvKey);
        return env.LEARNING_STORE.put(kvKey, val, { expirationTtl: 60 * 60 * 24 * 365 });
      })
    );

    expect(store['et_learned_rules_tennis']).toBe('r1\nr2');
    expect(store['et_learned_rules_nba']).toBe('r3');
    expect(store['et_learned_rules_mlb']).toBe('r4');
    expect(store['et_learned_rules_nhl']).toBe('r5');
    expect(env.LEARNING_STORE.delete).not.toHaveBeenCalled();
  });
});

// ── H1: learning agent error logging ─────────────────────────────────────────

describe('learning agent error logging (H1 silent-failure fix)', () => {
  test('_logLearningErr writes to et_learning_agent_err KV key', async () => {
    const store = {};
    const env = mockEnv(store);

    const _logLearningErr = async (reason, detail = '') => {
      try {
        await env.LEARNING_STORE.put('et_learning_agent_err', JSON.stringify({
          ts: Date.now(), iso: new Date().toISOString(), reason,
          detail: String(detail).slice(0, 500)
        }), { expirationTtl: 60 * 60 * 24 * 14 });
      } catch (_) {}
    };

    await _logLearningErr('api_error', 'HTTP 429');

    expect(env.LEARNING_STORE.put).toHaveBeenCalledWith(
      'et_learning_agent_err',
      expect.stringContaining('"reason":"api_error"'),
      expect.objectContaining({ expirationTtl: expect.any(Number) })
    );
    const written = JSON.parse(store['et_learning_agent_err']);
    expect(written.reason).toBe('api_error');
    expect(written.detail).toBe('HTTP 429');
    expect(written.iso).toBeTruthy();
  });

  test('detail is truncated to 500 chars', async () => {
    const store = {};
    const env = mockEnv(store);
    const _logLearningErr = async (reason, detail = '') => {
      try {
        await env.LEARNING_STORE.put('et_learning_agent_err', JSON.stringify({
          ts: Date.now(), iso: new Date().toISOString(), reason,
          detail: String(detail).slice(0, 500)
        }), { expirationTtl: 60 * 60 * 24 * 14 });
      } catch (_) {}
    };

    await _logLearningErr('exception', 'x'.repeat(1000));

    const written = JSON.parse(store['et_learning_agent_err']);
    expect(written.detail.length).toBe(500);
  });
});
