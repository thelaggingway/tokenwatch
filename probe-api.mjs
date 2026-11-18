import { readFile } from 'node:fs/promises';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');

let assetCalls = [];
function assets(pricing = real) {
  return {
    async fetch(url) {
      const p = new URL(url).pathname;
      assetCalls.push(p);
      if (p === '/pricing.json') return new Response(JSON.stringify(pricing), { status: 200 });
      const file = { '/image-pricing.json': 'public/image-pricing.json', '/video-pricing.json': 'public/video-pricing.json' }[p];
      if (!file) return new Response('nf', { status: 404 });
      return new Response(await readFile(file, 'utf8'), { status: 200 });
    },
  };
}

async function get(path, search = '', pricing) {
  const ctx = { request: new Request(`https://t.test${path}${search}`), env: { ASSETS: assets(pricing) } };
  const res = await api.onRequestGet(ctx);
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), body: JSON.parse(text), bytes: text.length };
}

const d = await get('/api/v1/models', '?sort=discount&limit=500');
const discs = d.body.models.map((m) => m.discount);
console.log('1) sort=discount first 12:', discs.slice(0, 12).join(','));
let inv = 0;
for (let i = 1; i < discs.length; i++) if (discs[i] < discs[i - 1]) inv++;
console.log('   inversions:', inv, '/', discs.length);

const desc = await get('/api/v1/models', '?sort=input&order=desc&limit=500');
const inputs = desc.body.models.map((m) => m.pricing.input);
console.log('2) sort=input&desc first 6:', inputs.slice(0, 6).join(','));
console.log('   nulls in first 6:', inputs.slice(0, 6).filter((v) => v == null).length);
console.log('   overall nulls:', inputs.filter((v) => v == null).length);

for (const q of ['?tokens=abc&mix=2.5,97,0.5', '?tokens=1000&mix=zzz', '?tokens=1000&mix=50,50,50', '?tokens=1000&mix=0,100,0']) {
  const r = await get('/api/v1/models/gemini-3.1-pro/providers', q);
  console.log('3)', q, '->', r.status, r.body.providers?.map((p) => p.provider).join(' | '));
}

const info = await get('/api/v1/stats');
console.log('4) Cache-Control:', JSON.stringify(info.headers['cache-control']), 'ETag:', JSON.stringify(info.headers['etag']));

const m500 = await get('/api/v1/models', '?limit=500');
console.log('5) /models?limit=500 bytes:', m500.bytes, 'items', m500.body.models.length);
console.log('   /models default bytes:', (await get('/api/v1/models')).bytes);

assetCalls = [];
await get('/api/v1/images', '?limit=1');
console.log('6) assets fetched for /images:', assetCalls.join(','));

for (const n of [10, 1000, 100000]) {
  const s = 'z'.repeat(n);
  const t = performance.now();
  await get('/api/v1/models', `?search=${s}`);
  console.log(`7) search len ${n}: ${(performance.now() - t).toFixed(1)}ms`);
}

console.log('8) limit=1.9 ->', (await get('/api/v1/models', '?limit=1.9')).body.limit, '| offset=1e3 ->', (await get('/api/v1/models', '?offset=1e3')).body.offset);
console.log('   limit=99999 ->', (await get('/api/v1/models', '?limit=99999')).body.limit);
