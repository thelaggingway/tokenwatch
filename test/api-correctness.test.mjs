/**
 * PR1 correctness guards for the API layer.
 *
 * Every test here encodes a case the committed catalogs cannot express (an
 * unpriced offering, a canonical-id collision) so the assertions stay stable
 * when the generated data refreshes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const api = await import('../functions/api/v1/[[route]].js');

function makeEnv(files) {
  return {
    ASSETS: {
      async fetch(url) {
        const body = files[new URL(url).pathname];
        if (body === undefined) return new Response('Not found', { status: 404 });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
      },
    },
  };
}

async function get(pathname, search = '', files) {
  const res = await api.onRequestGet({
    request: new Request(`https://tokenwatch.test${pathname}${search}`),
    env: makeEnv(files),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const priced = (id, provider, input, output, extra = {}) => ({
  id, name: id, org: 'o', provider, quantization: null,
  pricing: { input, output, cache_read: null, cache_write: null }, discount: 0, ...extra,
});

test('/models/:id/providers ranks an offering with no published price last, never as $0', async () => {
  const files = {
    '/pricing.json': {
      generated_at: 'x', providers: ['a', 'b', 'c'], providers_meta: {},
      models: [priced('o/m', 'a', 5, 5), priced('o/m', 'b', null, null), priced('o/m', 'c', 1, 1)],
    },
  };
  const { body } = await get('/api/v1/models/o/m/providers', '', files);
  assert.deepEqual(body.providers.map((p) => p.provider), ['c', 'a', 'b'],
    'an offering with null input and output must not rank ahead of priced ones');
});

test('/models/:id/providers keeps a half-priced offering after every fully priced one', async () => {
  const files = {
    '/pricing.json': {
      generated_at: 'x', providers: ['a', 'b', 'c'], providers_meta: {},
      models: [priced('o/m', 'a', 9, null), priced('o/m', 'b', 1, 2), priced('o/m', 'c', null, null)],
    },
  };
  const { body } = await get('/api/v1/models/o/m/providers', '', files);
  assert.equal(body.providers[0].provider, 'b', 'the only fully priced offering sorts first');
  assert.equal(body.providers.at(-1).provider, 'c', 'the fully unpriced offering sorts last');
});

test('/models?sort=discount reads the top-level discount and honors order', async () => {
  const files = {
    '/pricing.json': {
      generated_at: 'x', providers: ['a'], providers_meta: {},
      models: [
        priced('o/cheap', 'a', 1, 1, { discount: 0 }),
        priced('o/dear', 'a', 10, 10, { discount: 0.5 }),
        priced('o/sale', 'a', 2, 2, { discount: 0.2 }),
      ],
    },
  };
  const asc = await get('/api/v1/models', '?sort=discount', files);
  assert.deepEqual(asc.body.models.map((m) => m.id), ['o/cheap', 'o/sale', 'o/dear']);
  const desc = await get('/api/v1/models', '?sort=discount&order=desc', files);
  assert.deepEqual(desc.body.models.map((m) => m.id), ['o/dear', 'o/sale', 'o/cheap']);
});

test('/models sorting keeps null values last in both directions', async () => {
  const files = {
    '/pricing.json': {
      generated_at: 'x', providers: ['a'], providers_meta: {},
      models: [
        priced('o/a', 'a', null, 1),
        priced('o/b', 'a', null, 1),
        priced('o/c', 'a', 3, 3),
      ],
    },
  };
  for (const order of ['', '&order=desc']) {
    const { body } = await get('/api/v1/models', `?sort=input${order}`, files);
    assert.equal(body.models.at(0).id, 'o/c', `order${order} must put the priced row first`);
    assert.equal(body.models.length, 3, 'the null rows are kept');
  }
});

// Media routes currently load pricing.json too (fixed in the performance PR);
// supply it so these assertions test id resolution only.
const CATALOG_STUB = { generated_at: 'x', providers: [], providers_meta: {}, models: [] };

const IMAGE_COLLISION = {
  generated_at: 'x',
  models: [
    { id: 'fal-org/gemini-3-pro-image-preview', name: 'Fal', org: 'fal-org', provider: 'fal', pricing: [{ unit: 'image', cost_per_unit: 0.15 }] },
    { id: 'google/gemini-3-pro-image', name: 'Google', org: 'google', provider: 'google', pricing: [{ unit: 'token', cost_per_million: 120 }] },
  ],
};

test('/images/:id prefers the exact id over a canonical-id collision', async () => {
  const files = { '/pricing.json': CATALOG_STUB, '/image-pricing.json': IMAGE_COLLISION };
  const exact = await get('/api/v1/images/google/gemini-3-pro-image', '', files);
  assert.equal(exact.status, 200);
  assert.equal(exact.body.model.id, 'google/gemini-3-pro-image',
    'the org-qualified row the caller named must win over the shadowing fal row');

  const fal = await get('/api/v1/images/fal-org/gemini-3-pro-image-preview', '', files);
  assert.equal(fal.body.model.id, 'fal-org/gemini-3-pro-image-preview');
});

test('/images/:id still resolves a bare canonical id when no exact id matches', async () => {
  const files = { '/pricing.json': CATALOG_STUB, '/image-pricing.json': IMAGE_COLLISION };
  const bare = await get('/api/v1/images/gemini-3-pro-image', '', files);
  assert.equal(bare.status, 200, 'the canonical fallback must still work');
  assert.ok(bare.body.model);
});

test('/videos/:id prefers the exact id over a canonical-id collision', async () => {
  const files = {
    '/pricing.json': CATALOG_STUB,
    '/video-pricing.json': {
      generated_at: 'x',
      models: [
        { id: 'kwaivgi/kling-video-o1', name: 'Kling', org: 'kwaivgi', provider: 'kling', pricing: [{ unit: 'second', cost_per_unit: 0.5 }] },
        { id: 'kling-video-o1', name: 'Kling direct', org: 'kuaishou', provider: 'kuaishou', pricing: [{ unit: 'second', cost_per_unit: 1 }] },
      ],
    },
  };
  const r = await get('/api/v1/videos/kwaivgi/kling-video-o1', '', files);
  assert.equal(r.body.model.id, 'kwaivgi/kling-video-o1');
});

test('blendedRate returns null when a leg with a nonzero share has no price', async () => {
  const { blendedRate } = await import('../shared/cost.mjs');
  const unpriced = { input: null, output: null, cache_read: null, cache_write: null };

  assert.equal(blendedRate(unpriced, { inputPct: 0, cacheReadPct: 100, outputPct: 0 }), null,
    'a cache leg with no cache_read and no input cannot be priced as $0');
  assert.equal(blendedRate(unpriced, { inputPct: 0, cacheReadPct: 0, outputPct: 0 }), null,
    'an all-zero mix prices nothing');
  assert.equal(blendedRate(unpriced, { inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 }), null);

  assert.equal(blendedRate({ input: 2, output: null, cache_read: null }, { inputPct: 100, cacheReadPct: 0, outputPct: 0 }), 2,
    'a zero share stays non-disqualifying');
  assert.equal(blendedRate({ input: 0, output: 0, cache_read: 0 }, { inputPct: 50, cacheReadPct: 25, outputPct: 25 }), 0,
    'a genuinely published $0 rate is still 0, not null');
});

test('history drops a day whose only offering has no published price', async () => {
  const { buildHistorySeries } = await import('../shared/price-history.mjs');
  const rows = [{
    utc_day: '2026-01-03', offering_key: 'k', provider: 'p', model_id: 'o/m', quantization: '',
    input_price: null, output_price: null, cache_read: null, cache_write: null, input_billing: null, discount: 0,
  }];
  assert.deepEqual(buildHistorySeries(rows, { inputPct: 0, cacheReadPct: 100, outputPct: 0 }), [],
    'an unpriceable day must stay absent, never $0');
});

test('every use-case preset produces the same /recommend picks as before the cost change', async () => {
  const { USE_CASES } = await import('../shared/use-cases.mjs');
  const { shortlistModels } = await import('../shared/recommend.mjs');
  const read = async (name) => JSON.parse(await readFile(join(ROOT, 'public', name), 'utf8'));
  const [pricing, benchmarks, performance] = await Promise.all([
    read('pricing.json'), read('benchmarks.json'), read('performance.json'),
  ]);
  const expected = JSON.parse(await readFile(join(__dirname, 'fixtures', 'recommend-presets.json'), 'utf8'));

  assert.deepEqual(Object.keys(expected).sort(), Object.keys(USE_CASES).sort(), 'fixture covers every preset');
  const ids = (list) => (list || []).map((item) => item.id);
  for (const useCase of Object.keys(USE_CASES)) {
    const result = shortlistModels(useCase, pricing.models, { benchmarks, performance });
    const actual = {
      bestQuality: result.bestQuality?.id ?? null,
      bestValue: result.bestValue?.id ?? null,
      cheapestAboveFloor: result.cheapestAboveFloor?.id ?? null,
      qualityRanking: ids(result.qualityRanking),
      paretoFrontier: ids(result.paretoFrontier),
      partiallyBenchmarked: ids(result.partiallyBenchmarked),
      unbenchmarked: ids(result.unbenchmarked),
      unverified: ids(result.unverified),
    };
    assert.deepEqual(actual, expected[useCase], `${useCase} picks/order changed`);
  }
});
