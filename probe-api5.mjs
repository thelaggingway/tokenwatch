import { readFile } from 'node:fs/promises';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');
const assets = (body) => ({ async fetch() { return new Response(JSON.stringify(body), { status: 200 }); } });

async function get(path, search, pricing = real) {
  const res = await api.onRequestGet({ request: new Request(`https://t.test${path}${search}`), env: { ASSETS: assets(pricing) } });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), bytes: text.length };
}

for (const q of ['?sort=intelligence', '?sort=intelligence&order=desc', '?sort=uptime&order=desc', '?sort=cache_read&order=desc']) {
  const r = await get('/api/v1/models', q + '&limit=500');
  const vals = r.body.models.map((m) => (q.startsWith('?sort=intelligence') ? m.benchmarks?.intelligence_index : q.startsWith('?sort=uptime') ? m.uptime_30m : m.pricing.cache_read));
  const nullIdx = vals.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
  console.log(`${q}: first 6 = ${vals.slice(0, 6).join(',')} | nulls ${nullIdx.length}, first at ${nullIdx[0] ?? 'none'}, last at ${nullIdx[nullIdx.length - 1] ?? 'none'}`);
}

const bothNull = {
  generated_at: 'x', providers: ['a'], providers_meta: {},
  models: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ id: `o/${n}`, name: n, org: 'o', provider: 'a', pricing: { input: null, output: 1 }, discount: 0 })),
};
const runs = [];
for (let i = 0; i < 3; i++) runs.push((await get('/api/v1/models', '?sort=output&order=desc', bothNull)).body.models.map((m) => m.name).join(''));
console.log('both-null comparator, 3 runs:', runs.join(' / '), '| count preserved:', (await get('/api/v1/models', '?sort=output', bothNull)).body.total);

const sizeOf = (obj) => JSON.stringify(obj).length;
const sample = real.models.reduce((acc, m) => ({ base: acc.base + sizeOf({ ...m, modelsdev: undefined }), dev: acc.dev + sizeOf(m.modelsdev || {}) }), { base: 0, dev: 0 });
console.log('modelsdev share of catalog bytes:', ((sample.dev / (sample.base + sample.dev)) * 100).toFixed(1) + '%');

const variants = real.models.filter((m) => /:(batch|flex|priority|fast|ultrafast|turbo|highspeed|off-peak)$/i.test(m.id));
const listed = (await get('/api/v1/models', '?limit=1')).body.total;
console.log('/models total includes delivery variants:', variants.length, 'of', listed);

const rec = await get('/api/v1/recommend', '?use_case=agentic-coding&detail=full&limit=100');
console.log('recommend full/100 bytes:', rec.bytes);

const noPricing = { ASSETS: { async fetch(url) { const p = new URL(url).pathname; return p === '/pricing.json' ? new Response(JSON.stringify(real)) : new Response('nope', { status: 404 }); } } };
const rec503 = await api.onRequestGet({ request: new Request('https://t.test/api/v1/recommend?use_case=agentic-coding'), env: noPricing });
console.log('recommend 503 body:', JSON.stringify(await rec503.json()).slice(0, 160));

const d1 = { ASSETS: assets(real), PRICE_HISTORY: { prepare() { return { bind() { return this; }, async all() { throw new Error('D1_ERROR: no such table: price_snapshot at line 12'); } }; } } };
const hist = await api.onRequestGet({ request: new Request('https://t.test/api/v1/models/gemini-3.1-pro/history'), env: d1 });
console.log('history 503 body:', JSON.stringify(await hist.json()).slice(0, 200));
