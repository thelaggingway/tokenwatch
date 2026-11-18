import { readFile } from 'node:fs/promises';
import { buildHistorySeries } from './shared/price-history.mjs';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');

console.log('A) models with context_length:', real.models.filter((m) => m.context_length != null).length, '/', real.models.length);

function assets(map) {
  return { async fetch(url) { const p = new URL(url).pathname; return map[p] ?? new Response('nf', { status: 404 }); } };
}
async function get(path, search, env) {
  const res = await api.onRequestGet({ request: new Request(`https://t.test${path}${search}`), env });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

const pricingRes = () => new Response(JSON.stringify(real));
const ok = await get('/api/v1/models', '?min_context=1e6', { ASSETS: assets({ '/pricing.json': pricingRes() }) });
console.log('B) min_context=1e6 total:', ok.body.total, '| min_context=1000 total:', (await get('/api/v1/models', '?min_context=1000', { ASSETS: assets({ '/pricing.json': pricingRes() }) })).body.total);

const brokenPricing = { ASSETS: assets({ '/pricing.json': new Response('boom', { status: 500 }), '/image-pricing.json': new Response(await readFile('public/image-pricing.json', 'utf8')) }) };
const img = await get('/api/v1/images', '?limit=1', brokenPricing);
console.log('C) /images with pricing.json down ->', img.status, img.body.error);

const twoNulls = {
  generated_at: 'x', providers: ['a'], providers_meta: {},
  models: [
    { id: 'o/a', name: 'a', org: 'o', provider: 'a', pricing: { input: null, output: 1 }, discount: 0 },
    { id: 'o/b', name: 'b', org: 'o', provider: 'a', pricing: { input: null, output: 2 }, discount: 0 },
    { id: 'o/c', name: 'c', org: 'o', provider: 'a', pricing: { input: 3, output: 3 }, discount: 0 },
  ],
};
for (const q of ['?sort=input', '?sort=input&order=desc']) {
  const r = await get('/api/v1/models', q, { ASSETS: assets({ '/pricing.json': new Response(JSON.stringify(twoNulls)) }) });
  console.log('D)', q, '->', r.body.models.map((m) => `${m.name}:${m.pricing.input}`).join(' '));
}

const rows = [{ utc_day: '2026-01-01', offering_key: 'k', provider: 'p', model_id: 'o/m', quantization: '', input_price: null, output_price: null, cache_read: null, cache_write: 3, input_billing: null, discount: 0 }];
console.log('E) history from a cache-write-only row:', JSON.stringify(buildHistorySeries(rows).map((d) => d.point)));

const rowsMix0 = [
  { utc_day: '2026-01-02', offering_key: 'k1', provider: 'unpriced', model_id: 'o/m', quantization: '', input_price: null, output_price: null, cache_read: null, cache_write: 1, input_billing: null, discount: 0 },
  { utc_day: '2026-01-02', offering_key: 'k2', provider: 'priced', model_id: 'o/m', quantization: '', input_price: 4, output_price: 8, cache_read: 1, cache_write: null, input_billing: null, discount: 0 },
];
console.log('F) cheapest with an unpriced row present:', JSON.stringify(buildHistorySeries(rowsMix0).map((d) => [d.point.provider, d.point.blended])));

console.log('G) history is model-known-gated; retired ids 404. canonical parity check:');
const { canonicalId } = await import('./shared/normalize.mjs');
console.log('   canonicalId("zai-org/GLM-5.2") =', canonicalId('zai-org/GLM-5.2'), '| canonicalId("GLM-5.2") =', canonicalId('GLM-5.2'));

// providers route includes delivery variants?
const v = real.models.filter((m) => /:flex$/.test(m.id))[0];
if (v) {
  const r = await get(`/api/v1/models/${encodeURIComponent(v.id.replace(/:flex$/, ''))}/providers`, '', { ASSETS: assets({ '/pricing.json': pricingRes() }) });
  const flex = r.body.providers.filter((p) => /:flex$/.test(p.provider) || true);
  console.log('H) base id', v.id.replace(/:flex$/, ''), '-> providers', r.body.providers.map((p) => `${p.provider}${p.quantization ? '/' + p.quantization : ''}`).join(', '));
}
