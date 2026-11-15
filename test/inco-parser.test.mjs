import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getIncoCatalogRows,
  readIncoSnapshot,
  INCO_SNAPSHOT_PATH,
} from '../scripts/fetch-inco.mjs';
import {
  incoNameMatchesId,
  incoZeroOutput,
  parseInco,
  validateIncoSnapshot,
  INCO_MIN_ROWS,
} from '../scripts/lib.mjs';

const model = (over = {}) => ({
  object: 'model',
  owned_by: 'inco',
  mode: 'standard',
  context_length: 1048576,
  modalities: { input: ['text'], output: ['text'] },
  pricing: { input: 0.15, cached_input: 0.03, output: 0.5 },
  ...over,
});

const RESPONSE = {
  object: 'list',
  data: [
    model({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', modalities: { input: ['text', 'image', 'video'], output: ['text'] } }),
    model({ id: 'glm-5.3-flash:fast', name: 'GLM 5.3 Flash (Fast)', mode: 'fast', pricing: { input: 0.3, cached_input: 0.06, output: 1 } }),
    model({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', pricing: { input: 0.3, cached_input: 0.006, output: 1.2 } }),
    model({ id: 'deepseek-v4.1-flash:fast', name: 'DeepSeek V4.1 Flash (Fast)', mode: 'fast', pricing: { input: 0.6, cached_input: 0.012, output: 2.4 } }),
    model({ id: 'kimi-k3.1-pro:standard', name: 'Kimi K3.1 Pro', pricing: { input: 3, cached_input: 0.3, output: 15 } }),
    model({ id: 'kimi-k3.1-pro:fast', name: 'Kimi K3.1 Pro (Fast)', mode: 'fast', pricing: { input: 6, cached_input: 0.6, output: 30 } }),
  ],
};

function jsonFetch(body = RESPONSE, status = 200) {
  return async () => new Response(JSON.stringify(body), { status });
}

async function tempSnapshotPath() {
  const dir = await mkdtemp(join(tmpdir(), 'tw-inco-'));
  return { dir, path: join(dir, 'inco-pricing.json') };
}

// ── parser ────────────────────────────────────────────────────────────────────

test('parseInco keeps the catalog tariff, cache price and org for every row', () => {
  const rows = parseInco(RESPONSE);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((m) => m.provider === 'inco'));
  assert.deepEqual(rows.map((m) => m.id), [
    'glm-5.3-flash',
    'glm-5.3-flash:fast',
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash:fast',
    'kimi-k3.1-pro',
    'kimi-k3.1-pro:fast',
  ]);
  const fast = rows.find((m) => m.id === 'glm-5.3-flash:fast');
  assert.deepEqual(fast.pricing, { input: 0.3, output: 1, cache_read: 0.06, cache_write: null });
  assert.equal(fast.org, 'z-ai');
  assert.equal(fast.discount, 0);
  assert.equal(fast.context_length, 1048576);
  assert.deepEqual(rows.find((m) => m.id === 'glm-5.3-flash').input_modalities, ['text', 'image', 'video']);
});

test('parseInco collapses a :standard id onto the base id', () => {
  const rows = parseInco({ data: [model({ id: 'kimi-k3.1-pro:standard', name: 'Kimi K3.1 Pro' })] });
  assert.deepEqual(rows.map((m) => m.id), ['kimi-k3.1-pro']);
});

test('a $0 output price is skipped and reported, never published as free', () => {
  const data = { data: [model({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', pricing: { input: 0.15, output: 0 } })] };
  assert.deepEqual(parseInco(data), []);
  assert.deepEqual(incoZeroOutput(data), ['glm-5.3-flash']);
  assert.deepEqual(incoZeroOutput(RESPONSE), []);
});

test('rows without a positive input price are skipped', () => {
  const rows = parseInco({ data: [model({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', pricing: { input: 0, output: 0.5 } })] });
  assert.deepEqual(rows, []);
});

test('non-text output models are dropped', () => {
  const rows = parseInco({ data: [model({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', modalities: { input: ['text'], output: ['image'] } })] });
  assert.deepEqual(rows, []);
});

test('a missing cached_input price stays null rather than falling back to input', () => {
  const rows = parseInco({ data: [model({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', pricing: { input: 0.15, output: 0.5 } })] });
  assert.equal(rows[0].pricing.cache_read, null);
});

test('incoNameMatchesId pairs fast variants and rejects a mis-paired name', () => {
  assert.equal(incoNameMatchesId('GLM 5.3 Flash (Fast)', 'glm-5.3-flash:fast'), true);
  assert.equal(incoNameMatchesId('Kimi K3.1 Pro', 'kimi-k3.1-pro:standard'), true);
  assert.equal(incoNameMatchesId('GLM 5.3 Flash', 'deepseek-v4.1-flash'), false);
  assert.equal(incoNameMatchesId('GLM 5.3 Flash (Fast)', 'glm-5.3-flash'), false);
});

// ── snapshot validation ───────────────────────────────────────────────────────

const snapshotRows = () => parseInco(RESPONSE).map((m) => ({
  id: m.id, name: m.name, input: m.pricing.input, output: m.pricing.output,
}));

test('validateIncoSnapshot accepts a full catalog', () => {
  assert.equal(validateIncoSnapshot({ models: snapshotRows() }), true);
});

test('validateIncoSnapshot rejects a sub-floor, duplicate or non-positive catalog', () => {
  assert.throws(() => validateIncoSnapshot({ models: snapshotRows().slice(0, INCO_MIN_ROWS - 1) }), /minimum floor/);
  const dup = snapshotRows();
  dup[1].id = dup[0].id;
  assert.throws(() => validateIncoSnapshot({ models: dup }), /duplicate model id/);
  const zero = snapshotRows();
  zero[0].output = 0;
  assert.throws(() => validateIncoSnapshot({ models: zero }), /non-positive output/);
  const mispaired = snapshotRows();
  mispaired[0].name = 'DeepSeek V4.1 Flash';
  assert.throws(() => validateIncoSnapshot({ models: mispaired }), /does not match id/);
});

test('validateIncoSnapshot rejects a large drop against last-good', () => {
  const previous = { models: [...snapshotRows(), ...snapshotRows().map((r) => ({ ...r, id: `${r.id}-x`, name: r.name }))] };
  assert.throws(() => validateIncoSnapshot({ models: snapshotRows() }, { previous }), /row count dropped/);
});

// ── loader ────────────────────────────────────────────────────────────────────

test('getIncoCatalogRows returns live rows and writes the snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { rows, source } = await getIncoCatalogRows({ fetchImpl: jsonFetch(), snapshotPath: path, log: () => {} });
    assert.equal(source, 'fresh');
    assert.equal(rows.length, 6);
    const snapshot = await readIncoSnapshot(path);
    assert.ok(snapshot, 'snapshot written');
    assert.equal(snapshot.source_url, 'https://api.inco.ai/v1/models');
    assert.equal(snapshot.models.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getIncoCatalogRows reuses a snapshot younger than 24h without fetching', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await getIncoCatalogRows({ fetchImpl: jsonFetch(), snapshotPath: path, log: () => {} });
    let calls = 0;
    const counting = async () => { calls += 1; return new Response('{}', { status: 200 }); };
    const { source, rows } = await getIncoCatalogRows({ fetchImpl: counting, snapshotPath: path, log: () => {} });
    assert.equal(calls, 0);
    assert.equal(source, 'snapshot');
    assert.equal(rows.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an HTTP failure falls back to the last-good snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await getIncoCatalogRows({ fetchImpl: jsonFetch(), snapshotPath: path, log: () => {} });
    const { source, rows } = await getIncoCatalogRows({
      fetchImpl: jsonFetch({}, 503), snapshotPath: path, force: true, log: () => {},
    });
    assert.equal(source, 'snapshot');
    assert.equal(rows.length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejected fresh parse falls back to the last-good snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await getIncoCatalogRows({ fetchImpl: jsonFetch(), snapshotPath: path, log: () => {} });
    const thin = { data: RESPONSE.data.slice(0, 2) };
    const { source, rows, reason } = await getIncoCatalogRows({
      fetchImpl: jsonFetch(thin), snapshotPath: path, force: true, log: () => {},
    });
    assert.equal(source, 'snapshot');
    assert.equal(rows.length, 6);
    assert.match(reason, /minimum floor/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fetch failure with no snapshot yields no rows and a reason', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { source, rows, reason } = await getIncoCatalogRows({
      fetchImpl: jsonFetch({}, 500), snapshotPath: path, log: () => {},
    });
    assert.equal(source, 'none');
    assert.deepEqual(rows, []);
    assert.match(reason, /HTTP 500/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the committed snapshot is readable and valid', async () => {
  const snapshot = await readIncoSnapshot(INCO_SNAPSHOT_PATH);
  assert.ok(snapshot, 'data/inco-pricing.json is committed and valid');
});

// ── registry + reviewed metadata ──────────────────────────────────────────────

test('Inco is wired into main() as a keyless Tier-1 source with a snapshot fallback', async () => {
  const src = await readFile('scripts/fetch-pricing.mjs', 'utf8');
  assert.match(src, /import \{ getIncoCatalogRows \} from '\.\/fetch-inco\.mjs'/);
  assert.match(src, /const inco = await getIncoCatalogRows\(\)/);
  assert.match(src, /status: `ok \(\$\{inco\.source\}\)`/);
  assert.match(src, /stampSource\(inco\.rows, 'direct'\)/);
});

test('the Inco metadata block carries the reviewed policy URLs and retention stance', async () => {
  const src = await readFile('scripts/fetch-pricing.mjs', 'utf8');
  const metadata = src.match(/  inco: \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(metadata, 'MANUAL_PROVIDER_META has an inco entry');
  assert.match(metadata, /privacy_policy_url: 'https:\/\/inco\.ai\/legal\/privacy\/'/);
  assert.match(metadata, /terms_of_service_url: 'https:\/\/inco\.ai\/legal\/terms\/'/);
  assert.match(metadata, /status_page_url: null/);
  assert.match(metadata, /headquarters: 'US'/);
  assert.match(metadata, /retains_prompts: true/);
  assert.match(metadata, /may_train: false/);
  assert.match(metadata, /retention_days: 30/);
  assert.match(metadata, /retention_note: '[^']*relayed[^']*'/);
});

test('both refresh workflows commit the Inco snapshot', async () => {
  for (const workflow of ['.github/workflows/refresh-pricing.yml', '.github/workflows/refresh-aa.yml']) {
    assert.match(await readFile(workflow, 'utf8'), /git add [^\n]*data\/inco-pricing\.json/);
  }
});
