/**
 * PR4: /api/v1/estimate and /api/v1/compare.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const api = await import('../functions/api/v1/[[route]].js');

const CATALOG = {
  generated_at: '2026-01-01T00:00:00Z',
  providers: ['a', 'b', 'c'],
  providers_meta: {},
  models: [
    // Same model at three providers: cheap, dear, and unpriceable.
    { id: 'o/model', name: 'Model', org: 'o', provider: 'a', quantization: 'fp8', discount: 0, pricing: { input: 1, output: 2, cache_read: 0.5, cache_write: null } },
    { id: 'o/model', name: 'Model', org: 'o', provider: 'b', quantization: null, discount: 0, pricing: { input: 4, output: 8, cache_read: 1, cache_write: null } },
    { id: 'o/model', name: 'Model', org: 'o', provider: 'c', quantization: null, discount: 0, pricing: { input: null, output: null, cache_read: null, cache_write: null } },
    // Second model, one provider.
    { id: 'o/other', name: 'Other', org: 'o', provider: 'a', quantization: null, discount: 0, pricing: { input: 10, output: 20, cache_read: null, cache_write: null } },
  ],
};

function env(catalog = CATALOG) {
  return {
    ASSETS: {
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === '/pricing.json') return new Response(JSON.stringify(catalog), { status: 200 });
        return new Response('not found', { status: 404 });
      },
    },
  };
}

async function get(pathname, search = '') {
  const res = await api.onRequestGet({ request: new Request(`https://tokenwatch.test${pathname}${search}`), env: env() });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

// ── /estimate ────────────────────────────────────────────────────────────────

test('estimate returns per-provider rates and costs sorted cheapest first', async () => {
  // 100% input at $1/M for 2M tokens = $2; provider b = $8.
  const { status, body } = await get('/api/v1/estimate', '?model=o/model&tokens=2&mix=100,0,0');
  assert.equal(status, 200);
  assert.equal(body.model, 'model', 'reports the canonical id');
  assert.equal(body.tokens, 2);
  assert.deepEqual(body.mix, { inputPct: 100, cacheReadPct: 0, outputPct: 0 });

  const priced = body.providers.filter((p) => p.cost_usd !== null);
  assert.deepEqual(priced.map((p) => p.provider), ['a', 'b'], 'cheapest first');
  assert.equal(priced[0].rate_per_mtok, 1);
  assert.equal(priced[0].cost_usd, 2);
  assert.equal(priced[1].cost_usd, 8);
  assert.equal(priced[0].quantization, 'fp8');
});

test('estimate lists unpriceable offerings last with a reason and a null cost, never $0', async () => {
  const { body } = await get('/api/v1/estimate', '?model=o/model&tokens=2&mix=100,0,0');
  const unpriced = body.providers.at(-1);
  assert.equal(unpriced.provider, 'c');
  assert.equal(unpriced.cost_usd, null);
  assert.equal(unpriced.rate_per_mtok, null);
  assert.equal(typeof unpriced.unpriceable_reason, 'string');
  assert.ok(unpriced.unpriceable_reason.length > 0);
  assert.ok(!body.providers.some((p) => p.cost_usd === 0), 'no offering is reported as free');
});

test('estimate accepts a use_case preset for the mix', async () => {
  const { status, body } = await get('/api/v1/estimate', '?model=o/model&tokens=1&use_case=agentic-coding');
  assert.equal(status, 200);
  // A preset mix is flagged assumed, matching /recommend's convention.
  assert.deepEqual(body.mix, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5, assumed: true });
  assert.equal(body.use_case, 'agentic-coding');
  assert.ok(body.providers.length >= 2);
});

test('estimate validates its parameters', async () => {
  for (const [search, parameter] of [
    ['', 'model'],
    ['?model=o/model', 'tokens'],
    ['?model=o/model&tokens=0', 'tokens'],
    ['?model=o/model&tokens=abc', 'tokens'],
    ['?model=o/model&tokens=1&mix=50,50,50', 'mix'],
    ['?model=o/model&tokens=1&use_case=nope', 'use_case'],
    ['?model=o/model&tokens=1&mix=100,0,0&use_case=agentic-coding', 'mix'],
  ]) {
    const { status, body } = await get('/api/v1/estimate', search);
    assert.equal(status, 400, search || 'missing model');
    assert.equal(body.code, 'invalid_parameter');
    assert.equal(body.parameter, parameter, search);
    assert.equal(typeof body.error, 'string');
  }
  const missing = await get('/api/v1/estimate', '?model=does-not-exist&tokens=1&mix=100,0,0');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'model_not_found');
});

// ── /compare ─────────────────────────────────────────────────────────────────

test('compare reports cheapest, max, spread and savings per model', async () => {
  const { status, body } = await get('/api/v1/compare', '?models=o/model,o/other&tokens=1&mix=100,0,0');
  assert.equal(status, 200);
  const model = body.models.find((m) => m.model === 'model');
  // provider a: $1/M, provider b: $4/M, provider c unpriceable
  assert.equal(model.cheapest.provider, 'a');
  assert.equal(model.cheapest.cost_usd, 1);
  assert.equal(model.max_cost_usd, 4);
  assert.equal(model.spread_usd, 3);
  assert.equal(model.savings_vs_most_expensive_usd, 3);
  assert.equal(model.unpriceable_count, 1);

  const other = body.models.find((m) => m.model === 'other');
  assert.equal(other.cheapest.cost_usd, 10);
  assert.equal(other.spread_usd, 0);
});

test('compare reports unknown ids in not_found instead of failing the request', async () => {
  const { status, body } = await get('/api/v1/compare', '?models=o/model,ghost,o/other&tokens=1&mix=100,0,0');
  assert.equal(status, 200);
  assert.deepEqual(body.not_found, ['ghost']);
  assert.equal(body.models.length, 2);
});

test('compare caps the model list at 20 and rejects malformed input', async () => {
  const many = Array.from({ length: 21 }, (_, i) => `o/m${i}`).join(',');
  const over = await get('/api/v1/compare', `?models=${many}&tokens=1&mix=100,0,0`);
  assert.equal(over.status, 400);
  assert.equal(over.body.parameter, 'models');
  assert.match(over.body.error, /20/);

  for (const [search, parameter] of [
    ['', 'models'],
    ['?models=&tokens=1&mix=100,0,0', 'models'],
    ['?models=o/model', 'tokens'],
    ['?models=o/model&tokens=1', 'mix'],
    ['?models=o/model&tokens=1&mix=50,50,50', 'mix'],
  ]) {
    const { status, body } = await get('/api/v1/compare', search);
    assert.equal(status, 400, search || 'missing models');
    assert.equal(body.parameter, parameter, search);
  }
});

test('compare deduplicates repeated ids', async () => {
  const { body } = await get('/api/v1/compare', '?models=o/model,o/model&tokens=1&mix=100,0,0');
  assert.equal(body.models.length, 1);
});

// ── Registration ─────────────────────────────────────────────────────────────

test('both endpoints are registered in the API directory', async () => {
  const { body } = await get('/api/v1/');
  const joined = body.endpoints.join('\n');
  assert.match(joined, /\/api\/v1\/estimate/);
  assert.match(joined, /\/api\/v1\/compare/);
});
