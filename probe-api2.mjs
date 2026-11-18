import { readFile } from 'node:fs/promises';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');

const nullPricing = {
  generated_at: '2026-01-01T00:00:00Z',
  providers: ['a'],
  providers_meta: {},
  models: [
    { id: 'o/priced-cheap', name: 'cheap', org: 'o', provider: 'a', pricing: { input: 1, output: 1, cache_read: null, cache_write: null }, discount: 0 },
    { id: 'o/priced-dear', name: 'dear', org: 'o', provider: 'a', pricing: { input: 10, output: 10, cache_read: null, cache_write: null }, discount: 5 },
    { id: 'o/unpriced', name: 'unpriced', org: 'o', provider: 'a', pricing: { input: null, output: null, cache_read: null, cache_write: null }, discount: 0 },
    { id: 'o/input-only', name: 'inputonly', org: 'o', provider: 'a', pricing: { input: 0.5, output: null, cache_read: null, cache_write: null }, discount: 2 },
  ],
};

function assets(pricing) {
  return {
    async fetch(url) {
      const p = new URL(url).pathname;
      if (p === '/pricing.json') return new Response(JSON.stringify(pricing), { status: 200 });
      const file = { '/benchmarks.json': 'public/benchmarks.json', '/performance.json': 'public/performance.json' }[p];
      if (!file) return new Response('nf', { status: 404 });
      return new Response(await readFile(file, 'utf8'), { status: 200 });
    },
  };
}
async function get(path, search = '', pricing = nullPricing) {
  const t = performance.now();
  const res = await api.onRequestGet({ request: new Request(`https://t.test${path}${search}`), env: { ASSETS: assets(pricing) } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), bytes: text.length, ms: performance.now() - t };
}

const prov = await get('/api/v1/models/o/unpriced/providers');
console.log('A) /providers for an unpriced model:', prov.status, JSON.stringify(prov.body.providers?.map((p) => [p.provider, p.pricing])));
const multi = await get('/api/v1/models/input-only/providers');
console.log('   note canonicalId("o/input-only") =>', JSON.stringify(multi.body.canonical_id));

for (const q of ['?sort=input', '?sort=input&order=desc', '?sort=discount', '?sort=discount&order=desc']) {
  const r = await get('/api/v1/models', q);
  console.log('B)', q, '->', r.body.models.map((m) => `${m.name}:${m.pricing.input ?? 'null'}/${m.discount}`).join(' '));
}

const t1 = await get('/api/v1/models', '');
const t2 = await get('/api/v1/models', '?limit=100');
console.log('C) /models default bytes', t1.bytes, 'ms', t1.ms.toFixed(1));
const compact = JSON.stringify(t1.body);
console.log('   minified bytes', compact.length, 'pretty overhead', (((t1.bytes - compact.length) / t1.bytes) * 100).toFixed(1) + '%');

const recFull = await get('/api/v1/recommend', '?use_case=coding&detail=full&limit=100', real);
console.log('D) recommend full/100 status', recFull.status, 'bytes', recFull.bytes, 'ms', recFull.ms.toFixed(1));
const recDef = await get('/api/v1/recommend', '?use_case=coding', real);
console.log('   recommend default bytes', recDef.bytes, 'ms', recDef.ms.toFixed(1));
const stats = await get('/api/v1/stats', '', real);
console.log('   stats bytes', stats.bytes, 'ms', stats.ms.toFixed(1));

console.log('E) providers?zdr=1 ->', (await get('/api/v1/providers', '?zdr=1', real)).body.provider_count, 'vs zdr=true ->', (await get('/api/v1/providers', '?zdr=true', real)).body.provider_count);
console.log('F) min_intelligence=abc ->', (await get('/api/v1/models', '?min_intelligence=abc')).body.total, '(no 400)');
console.log('   min_context=1e6 ->', (await get('/api/v1/models', '?min_context=1e6')).body.total, '(parseInt truncates to 1)');
console.log('   open_weights=TRUE ->', (await get('/api/v1/models', '?open_weights=TRUE', real)).body.total, 'vs =true ->', (await get('/api/v1/models', '?open_weights=true', real)).body.total);

const orgCase = real.models.filter((m) => m.org !== m.org.toLowerCase()).length;
const provCase = real.models.filter((m) => m.provider !== m.provider.toLowerCase()).length;
console.log('G) catalog org with uppercase:', orgCase, '| provider with uppercase:', provCase);

const neg = await get('/api/v1/models/gemini-3.1-pro/providers', '?tokens=1000&mix=-50,150,0', real);
console.log('H) mix=-50,150,0 ->', neg.status, neg.body.providers?.map((p) => p.provider).join(' | '));
