import { readFile } from 'node:fs/promises';
import { canonicalId, deliveryVariant } from './shared/normalize.mjs';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');
const assets = (body) => ({ async fetch() { return new Response(JSON.stringify(body), { status: 200 }); } });
async function get(path, search, pricing = real) {
  const res = await api.onRequestGet({ request: new Request(`https://t.test${path}${search}`), env: { ASSETS: assets(pricing) } });
  return { status: res.status, body: await res.json() };
}

const byKey = new Map();
for (const m of real.models) {
  const key = `${canonicalId(m.id)}|${m.provider}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(m);
}
const collisions = [...byKey.entries()].filter(([, rows]) => rows.length > 1);
console.log('A) canonicalId+provider groups with >1 row:', collisions.length);
const variantCollision = collisions.filter(([, rows]) => rows.some((r) => deliveryVariant(r.id)));
console.log('   of which involve a delivery variant:', variantCollision.length);
const example = variantCollision[0];
if (example) {
  console.log('   example:', example[1].map((r) => `${r.id} (${r.provider}) in=${r.pricing.input}`).join(' | '));
  const target = example[0].split('|')[0];
  const r = await get(`/api/v1/models/${target}/providers`, '');
  console.log('   /providers rows:', JSON.stringify(r.body.providers.map((p) => ({ provider: p.provider, q: p.quantization, input: p.pricing.input, id: p.id }))));
  console.log('   response exposes offering id?', 'id' in r.body.providers[0]);
}

const im = JSON.parse(await readFile('public/image-pricing.json', 'utf8'));
const vd = JSON.parse(await readFile('public/video-pricing.json', 'utf8'));
const multi = (arr) => arr.filter((m) => String(m.id).split('/').length > 2);
console.log('B) multi-segment image ids:', multi(im.models).length, multi(im.models).slice(0, 4).map((m) => m.id));
console.log('   multi-segment video ids:', multi(vd.models).length, multi(vd.models).slice(0, 4).map((m) => m.id));
const dupes = (arr) => {
  const seen = new Map();
  for (const m of arr) { const k = canonicalId(m.id); seen.set(k, (seen.get(k) || []).concat(m.id)); }
  return [...seen.entries()].filter(([, ids]) => ids.length > 1);
};
console.log('   image canonical collisions:', JSON.stringify(dupes(im.models).slice(0, 3)));
console.log('   video canonical collisions:', JSON.stringify(dupes(vd.models).slice(0, 3)));

const seg = im.models.find((m) => String(m.id).split('/').length > 2);
if (seg) {
  const r = await get(`/api/v1/images/${seg.id}`, '');
  console.log('C) /images/<multi-segment id>', seg.id, '->', r.status, r.body.model?.id ?? r.body.error);
  const r2 = await get(`/api/v1/images/${encodeURIComponent(seg.id)}`, '');
  console.log('   encoded ->', r2.status, r2.body.model?.id ?? r2.body.error);
}
