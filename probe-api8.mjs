import { readFile } from 'node:fs/promises';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');
const ENV = {
  ASSETS: {
    async fetch(url) {
      const p = new URL(url).pathname;
      if (p === '/pricing.json') return new Response(await readFile('public/pricing.json', 'utf8'));
      return new Response('nf', { status: 404 });
    },
  },
};
async function get(path, search = '') {
  const res = await api.onRequestGet({ request: new Request(`https://t.test${path}${search}`), env: ENV });
  return { status: res.status, body: await res.json() };
}

const unknownZdr = real.models.filter((m) => m.zdr === undefined);
console.log('A) offerings with unknown zdr:', unknownZdr.length);
const target = unknownZdr[0];
const r = await get(`/api/v1/models/${encodeURIComponent(target.id)}/providers`);
const row = r.body.providers.find((p) => p.provider === target.provider);
console.log('   catalog zdr:', JSON.stringify(target.zdr), '-> API row zdr:', JSON.stringify(row.zdr), '(AGENTS.md: unknown is not false)');
console.log('   same row open_weights:', JSON.stringify(row.open_weights), '(preserved as null)');
const sub = real.models.filter((m) => m.subscription === undefined).length;
console.log('   offerings with unknown subscription:', sub);

console.log('B) provider_count meanings:');
console.log('   /api/v1/ ->', (await get('/api/v1/')).body.provider_count, '(distinct model.provider)');
console.log('   /providers ->', (await get('/api/v1/providers')).body.provider_count, '(providers_meta keys)');
console.log('   /api/v1/ source_count ->', (await get('/api/v1/')).body.source_count, '(pricing.providers length)');

console.log('C) 404 body reflects the request path:', JSON.stringify((await get('/api/v1/<script>alert(1)</script>')).body));
const bad = await get('/api/v1/images/<img src=x onerror=alert(1)>');
console.log('   images 404:', JSON.stringify(bad.body).slice(0, 120));

const big = await get('/api/v1/models', '?limit=500');
const one = big.body.models[0];
console.log('D) a single /models row byte size:', JSON.stringify(one).length, '| has modelsdev:', 'modelsdev' in one);
