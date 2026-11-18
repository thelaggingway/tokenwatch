import { readFile } from 'node:fs/promises';
import { canonicalId } from './shared/normalize.mjs';

const real = JSON.parse(await readFile('public/pricing.json', 'utf8'));
const api = await import('./functions/api/v1/[[route]].js');

let t = performance.now();
for (let i = 0; i < 10; i += 1) for (const m of real.models) canonicalId(m.id);
console.log('A) canonicalId over the catalog, per request:', ((performance.now() - t) / 10).toFixed(2), 'ms');

const ENV = { ASSETS: { async fetch(url) { const p = new URL(url).pathname; if (p === '/pricing.json') return new Response(await readFile('public/pricing.json', 'utf8')); return new Response('nf', { status: 404 }); } } };
for (const path of ['/api/v1/models/gemini-3.1-pro/providers', '/api/v1/models/gemini-3.1-pro/history', '/api/v1/stats']) {
  const t0 = performance.now();
  await api.onRequestGet({ request: new Request(`https://t.test${path}`), env: ENV });
  console.log('B)', path, (performance.now() - t0).toFixed(1), 'ms');
}

const COLD = { ASSETS: { async fetch(url) { const p = new URL(url).pathname; const raw = await readFile('public/pricing.json', 'utf8'); return new Response(raw); } } };
t = performance.now();
for (let i = 0; i < 5; i += 1) await api.onRequestGet({ request: new Request('https://t.test/api/v1/models?limit=1'), env: COLD });
console.log('C) full pricing.json read+JSON.parse per request:', ((performance.now() - t) / 5).toFixed(1), 'ms');

// Uncaught crash surface: valid JSON, missing `models`
const broken = { ASSETS: { async fetch() { return new Response(JSON.stringify({ generated_at: 'x' })); } } };
try {
  const res = await api.onRequestGet({ request: new Request('https://t.test/api/v1/stats'), env: broken });
  console.log('D) pricing.json without models ->', res.status, JSON.stringify(await res.json()).slice(0, 100));
} catch (e) {
  console.log('D) pricing.json without models -> UNCAUGHT', e.constructor.name + ':', e.message, '(platform would return a non-JSON 500)');
}

// Same for advisor with a non-array messages field
const advisor = await import('./functions/api/advisor.js');
for (const body of ['{"messages":{}}', '{"messages":[null]}', '[1,2,3]', 'null']) {
  try {
    const res = await advisor.onRequestPost({ request: new Request('https://t.test/api/advisor', { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.' + Math.floor(Math.random() * 200), 'Content-Type': 'application/json' }, body }), env: { INFERX_BASE_URL: 'https://x.test', INFERX_API_KEY: 'k', ASSETS: { async fetch() { return new Response('nf', { status: 404 }); } } } });
    console.log('E)', body, '->', res.status);
  } catch (e) {
    console.log('E)', body, '-> UNCAUGHT', e.message);
  }
}
