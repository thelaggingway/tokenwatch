/**
 * PR3: caching, compact payloads, ETag/304, and the detail=full cap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const api = await import('../functions/api/v1/[[route]].js');

const pricing = await readFile(join(ROOT, 'public', 'pricing.json'), 'utf8');
const imagePricing = await readFile(join(ROOT, 'public', 'image-pricing.json'), 'utf8');
const videoPricing = await readFile(join(ROOT, 'public', 'video-pricing.json'), 'utf8');
const benchmarks = await readFile(join(ROOT, 'public', 'benchmarks.json'), 'utf8');
const performance = await readFile(join(ROOT, 'public', 'performance.json'), 'utf8');

/** Records which assets each request touches. */
function makeEnv({ etag = true, reads = [] } = {}) {
  const files = {
    '/pricing.json': pricing,
    '/image-pricing.json': imagePricing,
    '/video-pricing.json': videoPricing,
    '/benchmarks.json': benchmarks,
    '/performance.json': performance,
  };
  return {
    reads,
    ASSETS: {
      async fetch(url) {
        const path = new URL(url).pathname;
        reads.push(path);
        const body = files[path];
        if (!body) return new Response('not found', { status: 404 });
        return new Response(body, { status: 200, headers: etag ? { ETag: `"${path}-v1"` } : {} });
      },
    },
  };
}

async function get(pathname, search = '', { env = makeEnv(), method = 'GET', headers = {} } = {}) {
  const fn = method === 'HEAD' ? api.onRequestHead : api.onRequestGet;
  const res = await fn({ request: new Request(`https://tokenwatch.test${pathname}${search}`, { method, headers }), env });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test('/images and /videos never read pricing.json', async () => {
  for (const path of ['/api/v1/images', '/api/v1/videos']) {
    const env = makeEnv();
    await get(path, '?limit=5', { env });
    assert.ok(!env.reads.includes('/pricing.json'), `${path} must not load the text catalog`);
  }
});

test('the parsed catalog is reused while the asset ETag is unchanged', async () => {
  const env = makeEnv();
  const first = await get('/api/v1/models', '?limit=1', { env });
  const body = JSON.parse(first.text);
  assert.ok(body.total > 0);
  const before = env.reads.length;
  await get('/api/v1/models', '?limit=1', { env });
  // The asset is re-checked (cheap) but the parse is reused, so the request
  // still succeeds and the payload is identical.
  assert.equal(env.reads.length, before + 1, 'one conditional re-check per request');
});

test('a changed ETag invalidates the cached catalog', async () => {
  const files = {
    '/pricing.json': JSON.stringify({
      generated_at: '2026-01-01T00:00:00Z', providers: ['a'], providers_meta: {},
      models: [{ id: 'o/one', name: 'one', org: 'o', provider: 'a', discount: 0, pricing: { input: 1, output: 1, cache_read: null, cache_write: null } }],
    }),
  };
  let version = 1;
  const env = {
    ASSETS: {
      async fetch(url) {
        const body = new Response(files[new URL(url).pathname], { status: 200, headers: { ETag: `"v${version}"` } });
        return body;
      },
    },
  };
  assert.equal(JSON.parse((await get('/api/v1/models', '', { env })).text).total, 1);

  files['/pricing.json'] = JSON.stringify({
    generated_at: '2026-02-02T00:00:00Z', providers: ['a'], providers_meta: {},
    models: [
      { id: 'o/one', name: 'one', org: 'o', provider: 'a', discount: 0, pricing: { input: 1, output: 1, cache_read: null, cache_write: null } },
      { id: 'o/two', name: 'two', org: 'o', provider: 'a', discount: 0, pricing: { input: 2, output: 2, cache_read: null, cache_write: null } },
    ],
  });
  version = 2;
  assert.equal(JSON.parse((await get('/api/v1/models', '', { env })).text).total, 2, 'a refreshed catalog is picked up on the next request');
});

test('responses are compact JSON unless pretty=1 is requested', async () => {
  const compact = await get('/api/v1/stats');
  assert.doesNotMatch(compact.text, /\n\s+"generated_at"/, 'compact output must not be indented');
  const pretty = await get('/api/v1/stats', '?pretty=1');
  assert.match(pretty.text, /\n {2}"generated_at"/);
  assert.ok(pretty.text.length > compact.text.length, 'pretty is the opt-in, larger form');
});

test('200 GET responses carry a short shared-cache policy, errors do not', async () => {
  const ok = await get('/api/v1/stats');
  assert.equal(ok.headers.get('Cache-Control'), 'public, max-age=300, stale-while-revalidate=600');
  const notFound = await get('/api/v1/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get('Cache-Control'), 'no-store');
});

test('a strong ETag is stable for identical bytes and enables 304', async () => {
  const first = await get('/api/v1/stats');
  const etag = first.headers.get('ETag');
  assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
  const second = await get('/api/v1/stats');
  assert.equal(second.headers.get('ETag'), etag, 'same body → same ETag');

  const conditional = await get('/api/v1/stats', '', { headers: { 'If-None-Match': etag } });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.text, '', '304 has no body');
  assert.equal(conditional.headers.get('ETag'), etag);
});

test('HEAD returns the GET headers with no body', async () => {
  const head = await get('/api/v1/stats', '', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers.get('Cache-Control'), 'public, max-age=300, stale-while-revalidate=600');
  assert.equal(head.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('detail=full is capped at limit 25 with a clear 400', async () => {
  const over = await get('/api/v1/recommend', '?use_case=agentic-coding&detail=full&limit=100');
  assert.equal(over.status, 400);
  assert.equal(over.body?.code ?? JSON.parse(over.text).code, 'invalid_parameter');
  assert.match(JSON.parse(over.text).error, /detail=full/);

  assert.equal((await get('/api/v1/recommend', '?use_case=agentic-coding&detail=full&limit=25')).status, 200);
  assert.equal((await get('/api/v1/recommend', '?use_case=agentic-coding&detail=compact&limit=100')).status, 200);
});

test('the default /models payload stays a fraction of the old pretty-printed form', async () => {
  const compact = await get('/api/v1/models');
  const pretty = await get('/api/v1/models', '?pretty=1');
  assert.ok(compact.text.length < pretty.text.length * 0.8,
    `compact ${compact.text.length} should be well under pretty ${pretty.text.length}`);
});
