import { describe, test, expect, vi } from 'vitest';
import worker from '../index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockEnv(store = {}) {
  return {
    LEARNING_STORE: {
      get: vi.fn(key => Promise.resolve(store[key] ?? null)),
      put: vi.fn((key, value) => { store[key] = value; return Promise.resolve(); }),
      delete: vi.fn(key => { delete store[key]; return Promise.resolve(); }),
    },
  };
}

function req(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  return new Request(`https://worker.example.com${path}`, opts);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Worker fetch handler', () => {

  // ── CORS preflight ────────────────────────────────────────────────────────

  describe('OPTIONS (CORS preflight)', () => {
    test('returns CORS allow-methods header', async () => {
      const res = await worker.fetch(req('OPTIONS', '/health'), mockEnv());
      expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    });

    test('returns CORS allow-origin header', async () => {
      const res = await worker.fetch(req('OPTIONS', '/health'), mockEnv());
      expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
    });
  });

  // ── Health check ──────────────────────────────────────────────────────────

  describe('GET /health', () => {
    test('returns 200 with status ok', async () => {
      const res = await worker.fetch(req('GET', '/health'), mockEnv());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
    });

    test('includes version field', async () => {
      const res = await worker.fetch(req('GET', '/health'), mockEnv());
      const data = await res.json();
      expect(data.version).toBe('2.2');
    });
  });

  // ── KV read ───────────────────────────────────────────────────────────────

  describe('GET /kv/:key', () => {
    test('returns { value: null } when key does not exist', async () => {
      const res = await worker.fetch(req('GET', '/kv/missing'), mockEnv());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.value).toBeNull();
    });

    test('returns stored string value when key exists', async () => {
      const env = mockEnv({ 'my_key': '{"hello":"world"}' });
      const res = await worker.fetch(req('GET', '/kv/my_key'), env);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.value).toBe('{"hello":"world"}');
    });

    test('returns 503 when LEARNING_STORE is not configured', async () => {
      const res = await worker.fetch(req('GET', '/kv/key'), {});
      expect(res.status).toBe(503);
    });

    test('response includes CORS header', async () => {
      const res = await worker.fetch(req('GET', '/kv/any'), mockEnv());
      expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
    });
  });

  // ── KV write ─────────────────────────────────────────────────────────────

  describe('POST /kv/:key', () => {
    test('stores string value and returns { ok: true }', async () => {
      const env = mockEnv();
      const res = await worker.fetch(req('POST', '/kv/my_key', { value: 'hello' }), env);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(env.LEARNING_STORE.put).toHaveBeenCalledWith(
        'my_key', 'hello', expect.objectContaining({ expirationTtl: expect.any(Number) })
      );
    });

    test('serializes non-string values to JSON before storing', async () => {
      const env = mockEnv();
      await worker.fetch(req('POST', '/kv/my_key', { value: { nested: true } }), env);
      expect(env.LEARNING_STORE.put).toHaveBeenCalledWith(
        'my_key', '{"nested":true}', expect.anything()
      );
    });

    test('returns 400 when value field is missing', async () => {
      const res = await worker.fetch(req('POST', '/kv/my_key', { other: 'data' }), mockEnv());
      expect(res.status).toBe(400);
    });

    test('returns 400 for a malformed JSON body', async () => {
      const badReq = new Request('https://worker.example.com/kv/my_key', {
        method: 'POST',
        body: 'not json at all',
        headers: { 'Content-Type': 'text/plain' },
      });
      const res = await worker.fetch(badReq, mockEnv());
      expect(res.status).toBe(400);
    });

    test('returns 503 when LEARNING_STORE is not configured', async () => {
      const res = await worker.fetch(req('POST', '/kv/key', { value: 'x' }), {});
      expect(res.status).toBe(503);
    });
  });

  // ── Unknown routes ────────────────────────────────────────────────────────

  describe('unknown routes', () => {
    test('GET to an unmapped path returns 404', async () => {
      const res = await worker.fetch(req('GET', '/unknown/path'), mockEnv());
      expect(res.status).toBe(404);
    });

    test('404 response body contains error field', async () => {
      const res = await worker.fetch(req('GET', '/nope'), mockEnv());
      const data = await res.json();
      expect(data).toHaveProperty('error');
    });
  });
});
