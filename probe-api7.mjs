import { readFile } from 'node:fs/promises';

const api = await import('./functions/api/v1/[[route]].js');
const assets = (map) => ({ async fetch(url) { const p = new URL(url).pathname; const v = map[p]; return v ? v() : new Response('nf', { status: 404 }); } });
const im = await readFile('public/image-pricing.json', 'utf8');
const vd = await readFile('public/video-pricing.json', 'utf8');
const pr = await readFile('public/pricing.json', 'utf8');
const ENV = { ASSETS: assets({
  '/pricing.json': () => new Response(pr),
  '/image-pricing.json': () => new Response(im),
  '/video-pricing.json': () => new Response(vd),
}) };
async function get(path) {
  const res = await api.onRequestGet({ request: new Request(`https://t.test${path}`), env: ENV });
  return { status: res.status, body: await res.json() };
}

const catalog = JSON.parse(im);
const pair = catalog.models.filter((m) => /^(google\/)?gemini-3-pro-image(-preview)?$/.test(m.id));
console.log('rows:', pair.map((m) => `${m.id} org=${m.org} provider=${m.provider} pricing=${JSON.stringify(m.pricing)}`).join('\n      '));
for (const id of ['gemini-3-pro-image', 'gemini-3-pro-image-preview', 'google/gemini-3-pro-image', 'google/gemini-3-pro-image-preview']) {
  const r = await get(`/api/v1/images/${id}`);
  console.log(`GET /images/${id} -> ${r.status} ${r.body.model ? r.body.model.id : r.body.error}`);
}
const list = await get('/api/v1/images');
console.log('/images list total:', list.body.total, '| both rows listed?', ['gemini-3-pro-image', 'gemini-3-pro-image-preview', 'google/gemini-3-pro-image'].map((id) => list.body.models.some((m) => m.id === id)));
