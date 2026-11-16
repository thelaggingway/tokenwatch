import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSarvam, dedupKey, normalizeProvider } from '../scripts/lib.mjs';

// JSON-LD blocks of https://www.sarvam.ai/api-pricing (2026-11-16).
const HTML = await readFile(new URL('./fixtures/sarvam-api-pricing.html', import.meta.url), 'utf8');
// Live keyless https://api.sarvam.ai/v2/models (2026-11-16).
const CATALOG = JSON.parse(
  await readFile(new URL('./fixtures/sarvam-v2-models.json', import.meta.url), 'utf8')
);
// Round rate so INR prices read straight across (₹13.50 -> $0.135).
const usdPerInr = 0.01;

test('parseSarvam converts the INR LLM offers to USD per 1M', () => {
  const rows = parseSarvam({ html: HTML, catalog: CATALOG, usdPerInr });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((m) => m.provider === 'sarvam'));
  const flash = rows.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(flash.org, 'z-ai');
  assert.equal(flash.name, 'GLM 5.3 Flash');
  assert.deepEqual(flash.pricing, { input: 0.135, output: 0.45, cache_read: 0.025, cache_write: null });
  assert.equal(flash.context_length, 1048576);
  assert.deepEqual(flash.input_modalities, ['text', 'image']);
  const sarvam = rows.find((m) => m.id === 'sarvam-105b');
  assert.equal(sarvam.org, 'sarvam');
  assert.deepEqual(sarvam.pricing, { input: 0.1, output: 0.25, cache_read: 0.0025, cache_write: null });
  assert.deepEqual(sarvam.input_modalities, ['text']);
});

test('parseSarvam maps Sarvam ids onto existing canonical rows', () => {
  const keys = parseSarvam({ html: HTML, catalog: CATALOG, usdPerInr }).map(dedupKey).sort();
  assert.deepEqual(keys, [
    'deepseek-v4.1-flash-1017|sarvam',
    'gemma-4-31b-it|sarvam',
    'glm-5.3-flash|sarvam',
    'glm-5.3|sarvam',
    'sarvam-105b|sarvam',
  ]);
  // "Gemma 4" on the pricing page joins "Gemma 4 31B" in the catalog.
  const gemma = parseSarvam({ html: HTML, catalog: CATALOG, usdPerInr }).find((m) => m.id === 'gemma-4-31b-it');
  assert.equal(gemma.org, 'google');
  assert.equal(gemma.context_length, 262144);
  assert.equal(normalizeProvider('Sarvam AI'), 'sarvam');
});

test('parseSarvam does not price the unlisted Interactive variant or provisioned models', () => {
  const ids = parseSarvam({ html: HTML, catalog: CATALOG, usdPerInr }).map((m) => m.id);
  assert.ok(!ids.some((id) => /interactive|kimi|qwen|mimo|deepseek-?v4-pro/i.test(id)));
});

test('parseSarvam throws when the page, catalog, or rate changes shape', () => {
  assert.throws(() => parseSarvam({ html: '<html></html>', catalog: CATALOG, usdPerInr }), /JSON-LD/);
  assert.throws(() => parseSarvam({ html: HTML, catalog: { error: 'x' }, usdPerInr }), /catalog/);
  assert.throws(() => parseSarvam({ html: HTML, catalog: CATALOG }), /INR/);
  const usd = HTML.replaceAll('"priceCurrency":"INR"', '"priceCurrency":"USD"');
  assert.throws(() => parseSarvam({ html: usd, catalog: CATALOG, usdPerInr }), /unexpected unit/);
});
