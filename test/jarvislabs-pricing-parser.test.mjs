import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getJarvislabsCatalogRows,
  readJarvislabsSnapshot,
  JARVISLABS_SNAPSHOT_PATH,
} from '../scripts/fetch-jarvislabs.mjs';
import {
  jarvislabsNameMatchesId,
  jarvislabsZeroOutput,
  parseJarvislabsPricingHtml,
  validateJarvislabsSnapshot,
  JARVISLABS_MIN_ROWS,
} from '../scripts/lib.mjs';

/** One desktop pricing row, in the shape the live page server-renders. */
function row({ id, name, quant = 'FP8', context = '1M', input = '$0.07', cache = '$0.003', output = '$0.49', vision = true }) {
  const caps = [
    '<li><svg aria-hidden="true"></svg><span aria-hidden="true">Reasoning</span><span class="sr-only">Reasoning</span></li>',
    vision ? '<li><svg aria-hidden="true"></svg><span aria-hidden="true">Vision</span><span class="sr-only">Image input</span></li>' : '',
    '<li><svg aria-hidden="true"></svg><span aria-hidden="true">Tools</span><span class="sr-only">Tool calling</span></li>',
    '<li><svg aria-hidden="true"></svg><span aria-hidden="true">JSON</span><span class="sr-only">JSON output</span></li>',
  ].join('');
  return `<tr class="border-b">
      <th scope="row"><div class="flex"><span><img alt=""/></span><div>
        <p><a href="/products/token-factory/${id}" class="font-semibold">${name}</a>${
    quant ? `<span class="font-mono text-[12px]">${quant}</span>` : ''
  }</p>
        <p><span>Provider</span><span aria-hidden="true">·</span><button type="button" aria-label="Copy model ID ${id}"><span class="break-all">${id}</span><svg aria-hidden="true"></svg></button><span role="status" class="sr-only"></span></p>
        <ul aria-label="Capabilities">${caps}</ul>
      </div></div></th>
      <td class="text-right">${context}</td>
      <td class="text-right">${input}</td>
      <td class="text-right">${cache}</td>
      <td class="text-right">${output}</td>
      <td class="text-right"><a href="/dashboard/models/playground?model=${id}" aria-label="Try ${name} in the playground">Try</a></td>
    </tr>`;
}

const CAPTION = 'USD per 1 million tokens. Context is the window we serve.';

/** A page carrying the desktop table (and, optionally, the mobile card list). */
function page(rows, { cards = true, caption = CAPTION } = {}) {
  const head = `<thead><tr><th>Model</th><th>Context</th><th>Input</th><th>Cached input</th><th>Output</th><th><span class="sr-only">Playground</span></th></tr></thead>`;
  const table = `<table class="w-full"><caption>${caption}</caption>${head}<tbody>${rows.join('')}</tbody></table>`;
  const cardList = cards
    ? `<div class="mt-10 lg:hidden"><ul aria-label="${CAPTION}"><li>${
      rows[0].replace('aria-label="Copy model ID', 'aria-label="Copy card model ID')
    }</li></ul></div>`
    : '';
  return `<html><body><section id="pricing">${cardList}${table}</section></body></html>`;
}

const ROWS = [
  row({ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', context: '1M', input: '$0.07', cache: '$0.003', output: '$0.49' }),
  row({ id: 'deepseek-v4.1-flash-1017-cyber', name: 'DeepSeek V4.1 Flash Cyber', context: '1M', input: '$0.30', cache: '$0.006', output: '$1.00' }),
  row({ id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', quant: 'BF16', context: '256K', input: '$0.11', cache: '$0.05', output: '$0.37' }),
  row({ id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', quant: 'BF16', context: '256K', input: '$0.14', cache: '$0.05', output: '$0.40' }),
  row({ id: 'glm-5.3', name: 'GLM-5.3', context: '230K', input: '$0.70', cache: '$0.13', output: '$2.20', vision: false }),
  row({ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', context: '1M', input: '$0.075', cache: '$0.015', output: '$0.25' }),
  row({ id: 'nemotron-3.5-super-vl-120b-a12b-nvfp4', name: 'Nemotron 3.5 Super VL 120B A12B NVFP4', quant: null, context: '1M', input: '$0.15', cache: '$0.02', output: '$0.50' }),
  row({ id: 'qwen-3.8-27b-fp8', name: 'Qwen 3.8 27B FP8', quant: null, context: '256K', input: '$0.30', cache: '$0.08', output: '$2.35' }),
];

const HTML = page(ROWS);

function htmlFetch(body = HTML, status = 200) {
  return async () => new Response(body, { status });
}

async function tempSnapshotPath() {
  const dir = await mkdtemp(join(tmpdir(), 'tw-jarvislabs-'));
  return { dir, path: join(dir, 'jarvislabs-pricing.json') };
}

// ── parser ────────────────────────────────────────────────────────────────────

test('parseJarvislabsPricingHtml reads every priced row of the desktop table', () => {
  const rows = parseJarvislabsPricingHtml(HTML);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => r.id), [
    'deepseek-v4.1-flash-1017',
    'deepseek-v4.1-flash-1017-cyber',
    'gemma-4-26b-a4b-it',
    'gemma-4-31b-it',
    'glm-5.3',
    'glm-5.3-flash',
    'nemotron-3.5-super-vl-120b-a12b-nvfp4',
    'qwen-3.8-27b-fp8',
  ]);
  const flash = rows.find((r) => r.id === 'glm-5.3-flash');
  assert.deepEqual(flash, {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    input: 0.075,
    output: 0.25,
    cache_read: 0.015,
    context_length: 1_000_000,
    quantization: 'fp8',
    input_modalities: ['text', 'image'],
  });
  // "230K" is the served window, not a rounded 1M.
  assert.equal(rows.find((r) => r.id === 'glm-5.3').context_length, 230_000);
  assert.deepEqual(rows.find((r) => r.id === 'glm-5.3').input_modalities, ['text']);
});

test('the page precision lands in quantization, and the id suffix is the fallback', () => {
  const rows = parseJarvislabsPricingHtml(HTML);
  // No precision label beside the name: the id suffix still carries it.
  assert.equal(rows.find((r) => r.id === 'qwen-3.8-27b-fp8').quantization, 'fp8');
  assert.equal(rows.find((r) => r.id === 'nemotron-3.5-super-vl-120b-a12b-nvfp4').quantization, 'nvfp4');
  // BF16 is stated beside the name even though no id suffix says so.
  assert.equal(rows.find((r) => r.id === 'gemma-4-31b-it').quantization, 'bf16');
});

test('the mobile card list is ignored — only the captioned table is read', () => {
  const withoutTable = page(ROWS, { cards: true }).replace(/<table[\s\S]*<\/table>/, '');
  assert.deepEqual(parseJarvislabsPricingHtml(withoutTable), []);
  const withoutCards = page(ROWS, { cards: false });
  assert.equal(parseJarvislabsPricingHtml(withoutCards).length, 8);
});

test('a table without the USD-per-1M caption yields no rows', () => {
  assert.deepEqual(parseJarvislabsPricingHtml(page(ROWS, { caption: 'Per-image pricing' })), []);
  assert.deepEqual(parseJarvislabsPricingHtml(''), []);
  assert.deepEqual(parseJarvislabsPricingHtml(null), []);
});

test('a row with no positive output tariff is dropped, not published as free', () => {
  const html = page([
    row({ id: 'glm-5.3', name: 'GLM-5.3', input: '$0.70', output: '$0.00' }),
    ...ROWS.slice(0, 4),
  ]);
  const rows = parseJarvislabsPricingHtml(html);
  assert.equal(rows.length, 4);
  assert.ok(!rows.some((r) => r.id === 'glm-5.3'));
  assert.deepEqual(jarvislabsZeroOutput(html), ['glm-5.3']);
});

test('a row with a missing or unreadable price cell is dropped', () => {
  const html = page([
    row({ id: 'glm-5.3', name: 'GLM-5.3', input: 'Sign in', output: '$2.20' }),
    ...ROWS.slice(0, 4),
  ]);
  assert.equal(parseJarvislabsPricingHtml(html).length, 4);
});

test('a duplicate id is parsed once', () => {
  const html = page([ROWS[0], ROWS[0], ...ROWS.slice(1, 5)]);
  assert.equal(parseJarvislabsPricingHtml(html).length, 5);
});

test('jarvislabsNameMatchesId pairs a marketing name with its id', () => {
  assert.equal(jarvislabsNameMatchesId('DeepSeek V4.1 Flash', 'deepseek-v4.1-flash-1017'), true);
  assert.equal(jarvislabsNameMatchesId('Gemma 4 26B A4B IT', 'gemma-4-26b-a4b-it'), true);
  assert.equal(jarvislabsNameMatchesId('GLM-5.3', 'glm-5.3'), true);
  assert.equal(jarvislabsNameMatchesId('GLM-5.3', 'qwen-3.8-27b-fp8'), false);
});

// ── validation ────────────────────────────────────────────────────────────────

test('validateJarvislabsSnapshot accepts a complete parse', () => {
  assert.equal(validateJarvislabsSnapshot({ models: parseJarvislabsPricingHtml(HTML) }), true);
});

test('validateJarvislabsSnapshot rejects partial, duplicated or mispriced rows', () => {
  const rows = parseJarvislabsPricingHtml(HTML);
  assert.throws(
    () => validateJarvislabsSnapshot({ models: rows.slice(0, JARVISLABS_MIN_ROWS - 1) }),
    /minimum floor/,
  );
  assert.throws(
    () => validateJarvislabsSnapshot({ models: [...rows.slice(0, 4), { ...rows[0] }] }),
    /duplicate model id/,
  );
  assert.throws(
    () => validateJarvislabsSnapshot({ models: rows.map((r) => (r.id === 'glm-5.3' ? { ...r, output: 0 } : r)) }),
    /non-positive output/,
  );
  assert.throws(
    () => validateJarvislabsSnapshot({ models: rows.map((r) => (r.id === 'glm-5.3' ? { ...r, name: 'Qwen 3.8 27B' } : r)) }),
    /does not match id/,
  );
  assert.throws(() => validateJarvislabsSnapshot({ models: 'nope' }), /must be an array/);
});

test('validateJarvislabsSnapshot rejects a large drop against last-good', () => {
  const rows = parseJarvislabsPricingHtml(HTML);
  assert.throws(() => validateJarvislabsSnapshot({ models: rows.slice(0, 5) }, { previous: { models: rows } }), /row count dropped/);
  // Six of eight is inside the 25% ceiling.
  assert.equal(validateJarvislabsSnapshot({ models: rows.slice(0, 6) }, { previous: { models: rows } }), true);
});

// ── loader ────────────────────────────────────────────────────────────────────

test('getJarvislabsCatalogRows returns live rows and writes the snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { rows, source } = await getJarvislabsCatalogRows({ fetchImpl: htmlFetch(), snapshotPath: path, log: () => {} });
    assert.equal(source, 'fresh');
    assert.equal(rows.length, 8);
    assert.ok(rows.every((m) => m.provider === 'jarvislabs'));
    assert.equal(rows[0].pricing.cache_write, null);
    const snapshot = await readJarvislabsSnapshot(path);
    assert.ok(snapshot, 'snapshot written');
    assert.equal(snapshot.source_url, 'https://jarvislabs.ai/products/token-factory');
    assert.equal(snapshot.models.length, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getJarvislabsCatalogRows reuses a snapshot younger than 24h without fetching', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await getJarvislabsCatalogRows({ fetchImpl: htmlFetch(), snapshotPath: path, log: () => {} });
    let calls = 0;
    const counting = async () => { calls += 1; return new Response('{}', { status: 200 }); };
    const { source, rows } = await getJarvislabsCatalogRows({ fetchImpl: counting, snapshotPath: path, log: () => {} });
    assert.equal(calls, 0);
    assert.equal(source, 'snapshot');
    assert.equal(rows.length, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an HTTP failure falls back to the last-good snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await getJarvislabsCatalogRows({ fetchImpl: htmlFetch(), snapshotPath: path, log: () => {} });
    const { source, rows } = await getJarvislabsCatalogRows({
      fetchImpl: htmlFetch('', 503), snapshotPath: path, force: true, log: () => {},
    });
    assert.equal(source, 'snapshot');
    assert.equal(rows.length, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejected fresh parse falls back to the last-good snapshot', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    await getJarvislabsCatalogRows({ fetchImpl: htmlFetch(), snapshotPath: path, log: () => {} });
    const thin = page(ROWS.slice(0, 2));
    const { source, rows, reason } = await getJarvislabsCatalogRows({
      fetchImpl: htmlFetch(thin), snapshotPath: path, force: true, log: () => {},
    });
    assert.equal(source, 'snapshot');
    assert.equal(rows.length, 8);
    assert.match(reason, /minimum floor/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a zero-output row is skipped and named in the log', async () => {
  const { dir, path } = await tempSnapshotPath();
  const lines = [];
  try {
    const html = page([
      row({ id: 'glm-5.3', name: 'GLM-5.3', input: '$0.70', output: '$0.00' }),
      ...ROWS.filter((r) => !r.includes('token-factory/glm-5.3"')),
    ]);
    const { rows } = await getJarvislabsCatalogRows({
      fetchImpl: htmlFetch(html), snapshotPath: path, log: (line) => lines.push(line),
    });
    assert.equal(rows.length, 7);
    assert.ok(!rows.some((r) => r.id === 'glm-5.3'));
    assert.ok(lines.some((l) => /skipped glm-5\.3 — no output tariff published/.test(l)), lines.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fetch failure with no snapshot yields no rows and a reason', async () => {
  const { dir, path } = await tempSnapshotPath();
  try {
    const { source, rows, reason } = await getJarvislabsCatalogRows({
      fetchImpl: htmlFetch('', 500), snapshotPath: path, log: () => {},
    });
    assert.equal(source, 'none');
    assert.deepEqual(rows, []);
    assert.match(reason, /HTTP 500/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the committed snapshot is readable and valid', async () => {
  const snapshot = await readJarvislabsSnapshot(JARVISLABS_SNAPSHOT_PATH);
  assert.ok(snapshot, 'data/jarvislabs-pricing.json is committed and valid');
  assert.equal(snapshot.models.length, 8);
});

// ── registry + reviewed metadata ──────────────────────────────────────────────

test('JarvisLabs is wired into main() as a Tier-1 source with a snapshot fallback', async () => {
  const src = await readFile('scripts/fetch-pricing.mjs', 'utf8');
  assert.match(src, /import \{ getJarvislabsCatalogRows \} from '\.\/fetch-jarvislabs\.mjs'/);
  assert.match(src, /const jarvislabs = await getJarvislabsCatalogRows\(\)/);
  assert.match(src, /status: `ok \(\$\{jarvislabs\.source\}\)`/);
  assert.match(src, /stampSource\(jarvislabs\.rows, 'direct'\)/);
});

test('the JarvisLabs metadata block carries the reviewed policy URLs and retention stance', async () => {
  const src = await readFile('scripts/fetch-pricing.mjs', 'utf8');
  const metadata = src.match(/  jarvislabs: \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(metadata, 'MANUAL_PROVIDER_META has a jarvislabs entry');
  assert.match(metadata, /privacy_policy_url: 'https:\/\/jarvislabs\.ai\/termsandservice'/);
  assert.match(metadata, /terms_of_service_url: 'https:\/\/jarvislabs\.ai\/termsandservice'/);
  assert.match(metadata, /status_page_url: null/);
  assert.match(metadata, /headquarters: 'IN'/);
  assert.match(metadata, /may_train: false/);
  // Product-page copy, not a reviewed policy verdict: the ToS reserves indefinite
  // retention of "all information provided".
  assert.ok(!/retains_prompts:/.test(metadata), 'retains_prompts stays unset');
  assert.match(metadata, /retention_days: null/);
});

test('both refresh workflows commit the JarvisLabs snapshot', async () => {
  for (const workflow of ['.github/workflows/refresh-pricing.yml', '.github/workflows/refresh-aa.yml']) {
    assert.match(await readFile(workflow, 'utf8'), /git add [^\n]*data\/jarvislabs-pricing\.json/);
  }
});
