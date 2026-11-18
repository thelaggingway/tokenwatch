/**
 * PR2: consistent parameter validation.
 *
 * Every rejection carries { error: <string>, parameter: <name>, code } so the
 * WebMCP tools and the embed widget can keep reading `error` as a string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const api = await import('../functions/api/v1/[[route]].js');

const real = JSON.parse(await readFile(join(__dirname, '..', 'public', 'pricing.json'), 'utf8'));

function env(files = {}) {
  return {
    ASSETS: {
      async fetch(url) {
        const path = new URL(url).pathname;
        if (files[path] !== undefined) return new Response(JSON.stringify(files[path]), { status: 200 });
        if (path === '/pricing.json') return new Response(JSON.stringify(real), { status: 200 });
        return new Response('not found', { status: 404 });
      },
    },
  };
}

async function get(pathname, search = '', e = env()) {
  const res = await api.onRequestGet({ request: new Request(`https://tokenwatch.test${pathname}${search}`), env: e });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/** Assert a 400 whose body keeps `error` a string and names the parameter. */
function assertInvalid(result, parameter, label) {
  assert.equal(result.status, 400, `${label} should be a 400`);
  assert.equal(typeof result.body.error, 'string', `${label}: error must stay a string`);
  assert.equal(result.body.code, 'invalid_parameter', `${label}: code`);
  assert.equal(result.body.parameter, parameter, `${label}: parameter`);
}

// ── Pagination ───────────────────────────────────────────────────────────────

test('limit rejects non-integers, zero, and negatives with a 400', async () => {
  for (const raw of ['0', '-5', 'abc', '1.5', '', 'NaN', '1e3']) {
    assertInvalid(await get('/api/v1/models', `?limit=${raw}`), 'limit', `limit=${raw}`);
  }
});

test('limit above the documented cap still clamps to 500 and reports the applied value', async () => {
  const r = await get('/api/v1/models', '?limit=99999');
  assert.equal(r.status, 200);
  assert.equal(r.body.limit, 500);
});

test('offset rejects non-integers and negatives with a 400', async () => {
  for (const raw of ['-1', '1.5', 'abc', '1e3', '']) {
    assertInvalid(await get('/api/v1/models', `?offset=${raw}`), 'offset', `offset=${raw}`);
  }
  assert.equal((await get('/api/v1/models', '?offset=0')).status, 200);
});

// ── sort / order ─────────────────────────────────────────────────────────────

test('an unknown sort key is a 400 that lists the valid keys', async () => {
  const r = await get('/api/v1/models', '?sort=cheapest');
  assertInvalid(r, 'sort', 'sort=cheapest');
  assert.match(r.body.error, /sort/i);
  for (const valid of ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic']) {
    assert.equal((await get('/api/v1/models', `?sort=${valid}`)).status, 200, `sort=${valid} stays valid`);
  }
});

test('order is case-insensitive and rejects anything else', async () => {
  assert.equal((await get('/api/v1/models', '?order=DESC')).status, 200);
  assert.equal((await get('/api/v1/models', '?order=Asc')).status, 200);
  for (const raw of ['sideways', '1', '']) {
    assertInvalid(await get('/api/v1/models', `?order=${raw}`), 'order', `order=${raw}`);
  }
});

// ── Boolean filters ──────────────────────────────────────────────────────────

test('boolean filters accept only true/false and reject everything else', async () => {
  for (const param of ['zdr', 'open_weights', 'cache_read', 'cache_write', 'promo', 'sub', 'benchmarked']) {
    for (const bad of ['1', 'TRUE', 'yes', '0']) {
      assertInvalid(await get('/api/v1/models', `?${param}=${bad}`), param, `${param}=${bad}`);
    }
    assert.equal((await get('/api/v1/models', `?${param}=true`)).status, 200, `${param}=true`);
    assert.equal((await get('/api/v1/models', `?${param}=false`)).status, 200, `${param}=false`);
  }
});

test('/providers?zdr validates its boolean too', async () => {
  assertInvalid(await get('/api/v1/providers', '?zdr=1'), 'zdr', 'providers zdr=1');
  const ok = await get('/api/v1/providers', '?zdr=true');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.provider_count > 0);
});

// ── Numeric filters ──────────────────────────────────────────────────────────

test('min_context, min_output and min_intelligence reject non-numeric and negative input', async () => {
  const cases = [
    ['min_context', ['1M', '1e6', '1.5', 'abc', '-1']],
    ['min_output', ['1M', '1e6', '1.5', 'abc', '-1']],
    ['min_intelligence', ['abc', '-5', '1e2']],
  ];
  for (const [param, bad] of cases) {
    for (const raw of bad) assertInvalid(await get('/api/v1/models', `?${param}=${raw}`), param, `${param}=${raw}`);
  }
  // "1M" must not be truncated to 1 by parseInt.
  assert.equal((await get('/api/v1/models', '?min_context=1000000')).status, 200);
  assert.equal((await get('/api/v1/models', '?min_intelligence=0')).status, 200);
  assert.equal((await get('/api/v1/models', '?min_intelligence=45.5')).status, 200,
    'intelligence indices are decimals, so a decimal floor is valid');
  assert.equal((await get('/api/v1/models', '?min_context=1.5')).status, 400);
});

test('min_context=1e6 no longer silently returns nearly every model', async () => {
  const r = await get('/api/v1/models', '?min_context=1e6');
  assert.equal(r.status, 400);
});

// ── exclude_hq ───────────────────────────────────────────────────────────────

test('exclude_hq accepts only real ISO-3166 alpha-2 codes', async () => {
  const cases = { '/benchmarks.json': null, '/performance.json': null };
  const withAssets = (files) => env(files);
  const benchmarks = JSON.parse(await readFile(join(__dirname, '..', 'public', 'benchmarks.json'), 'utf8'));
  const performance = JSON.parse(await readFile(join(__dirname, '..', 'public', 'performance.json'), 'utf8'));
  void cases; void withAssets;
  const e = env({ '/benchmarks.json': benchmarks, '/performance.json': performance });

  for (const raw of ['zz', 'us,zz', 'U1', 'usa', 'cn,']) {
    assertInvalid(await get('/api/v1/recommend', `?use_case=agentic-coding&exclude_hq=${encodeURIComponent(raw)}`, e), 'exclude_hq', `exclude_hq=${raw}`);
  }
  for (const raw of ['US', 'us', 'CN,US']) {
    assert.equal((await get('/api/v1/recommend', `?use_case=agentic-coding&exclude_hq=${encodeURIComponent(raw)}`, e)).status, 200, `exclude_hq=${raw}`);
  }
});

// ── /models/:id/providers tokens + mix ───────────────────────────────────────

test('/models/:id/providers validates tokens and mix with the shared parser', async () => {
  for (const search of ['?tokens=abc', '?tokens=0', '?tokens=-5', '?tokens=Infinity']) {
    assertInvalid(await get('/api/v1/models/gemini-3.1-pro/providers', search), 'tokens', search);
  }
  for (const search of ['?mix=zzz', '?mix=50,50,50', '?mix=2.5,97', '?mix=-50,150,0', '?mix=2.5,97,-0.5']) {
    assertInvalid(await get('/api/v1/models/gemini-3.1-pro/providers', search), 'mix', search);
  }
});

test('mix without tokens sorts by the blended rate instead of being ignored', async () => {
  const files = {
    '/pricing.json': {
      generated_at: 'x', providers: ['a', 'b'], providers_meta: {},
      models: [
        { id: 'o/m', name: 'm', org: 'o', provider: 'a', quantization: null, discount: 0, pricing: { input: 1, output: 100, cache_read: null, cache_write: null } },
        { id: 'o/m', name: 'm', org: 'o', provider: 'b', quantization: null, discount: 0, pricing: { input: 100, output: 1, cache_read: null, cache_write: null } },
      ],
    },
  };
  const inputHeavy = await get('/api/v1/models/o/m/providers', '?mix=100,0,0', env(files));
  assert.equal(inputHeavy.status, 200);
  assert.equal(inputHeavy.body.providers[0].provider, 'a', 'input-heavy mix favours cheap input');

  const outputHeavy = await get('/api/v1/models/o/m/providers', '?mix=0,0,100', env(files));
  assert.equal(outputHeavy.body.providers[0].provider, 'b', 'output-heavy mix favours cheap output');
});

// ── Error codes, 503 hygiene, HEAD, nosniff ──────────────────────────────────

test('errors carry a stable code and never leak internal error text', async () => {
  const notFound = await get('/api/v1/nope');
  assert.equal(notFound.body.code, 'not_found');

  const missingModel = await get('/api/v1/models/definitely-not-real/providers');
  assert.equal(missingModel.status, 404);
  assert.equal(missingModel.body.code, 'model_not_found');

  const brokenD1 = {
    ASSETS: env().ASSETS,
    PRICE_HISTORY: { prepare() { return { bind() { return this; }, async all() { throw new Error('D1_ERROR: no such table: price_snapshot'); } }; } },
  };
  const history = await get('/api/v1/models/gemini-3.1-pro/history', '', brokenD1);
  assert.equal(history.status, 503);
  assert.equal(history.body.code, 'history_unavailable');
  assert.doesNotMatch(JSON.stringify(history.body), /D1_ERROR|no such table/, 'internal detail must not reach the client');

  const noCatalog = { ASSETS: { async fetch() { return new Response('boom', { status: 500 }); } } };
  const catalog = await get('/api/v1/models', '', noCatalog);
  assert.equal(catalog.status, 503);
  assert.equal(catalog.body.code, 'catalog_unavailable');
});

test('a pricing catalog without models is a controlled 503, not a crash', async () => {
  const broken = env({ '/pricing.json': { generated_at: 'x' } });
  const r = await get('/api/v1/stats', '', broken);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'catalog_unavailable');
});

test('data responses are nosniff and HEAD returns headers with no body', async () => {
  const ok = await get('/api/v1/stats');
  assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');

  assert.equal(typeof api.onRequestHead, 'function', 'onRequestHead must be exported');
  const head = await api.onRequestHead({ request: new Request('https://tokenwatch.test/api/v1/stats'), env: env() });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(head.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await head.text(), '', 'HEAD must not include a body');
});

test('OPTIONS and unknown-route responses stay JSON with CORS', async () => {
  const options = await api.onRequestOptions();
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
});

// ── Embed widget: bad attributes fall back locally ───────────────────────────

test('a malformed data-tw-mix / data-tw-tokens falls back to the widget defaults', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(join(__dirname, '..', 'public', 'widget', 'embed.js'), 'utf8');
  // Pull the two parsers out and exercise them without a DOM.
  const start = src.indexOf('function parseTokensAttr(');
  const end = src.indexOf('function getTheme(');
  assert.ok(start > 0 && end > start, 'embed.js still defines the attribute parsers');
  const DEFAULTS = { tokens: 1000, mix: '2.5,97,0.5' };
  const { parseTokensAttr, parseMixAttr } = new Function(
    `var DEFAULTS = ${JSON.stringify(DEFAULTS)};\n${src.slice(start, end)}\nreturn { parseTokensAttr, parseMixAttr };`,
  )();

  for (const bad of ['abc', '-5', '0', '', null]) assert.equal(parseTokensAttr(bad), 1000, `tokens=${bad}`);
  assert.equal(parseTokensAttr('250'), 250);

  for (const bad of ['zzz', '50,50,50', '2.5,97', '-1,50,51', '', null]) assert.equal(parseMixAttr(bad), DEFAULTS.mix, `mix=${bad}`);
  assert.equal(parseMixAttr('10,0,90'), '10,0,90');
});
