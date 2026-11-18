/**
 * Tests for the local D1 developer tooling added after the end-to-end API audit:
 *
 *   1. The deploy guard that refuses to publish when a root `wrangler.toml`
 *      copied for local D1 work could be auto-discovered by Wrangler.
 *   2. `--seed-days` / `--vary` on the snapshot writer, which must stay local.
 *
 * The guard is a file-presence check, so these tests use real temporary
 * directories rather than mocks — a mocked `existsSync` would pass even if the
 * filename list were wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTO_DISCOVERED_CONFIGS,
  assertNoLocalWranglerConfig,
  findLocalWranglerConfigs,
  localWranglerConfigError,
} from '../scripts/check-no-local-wrangler.mjs';
import * as writer from '../scripts/snapshot-prices.mjs';
import { shiftUtcDay, utcDay } from '../shared/price-history.mjs';

const GUARD = new URL('../scripts/check-no-local-wrangler.mjs', import.meta.url).pathname;

function tempRepo(configNames = []) {
  const root = mkdtempSync(join(tmpdir(), 'tw-guard-'));
  for (const name of configNames) writeFileSync(join(root, name), 'name = "local"\n');
  return root;
}

// ── Deploy guard ──────────────────────────────────────────────────────────────

test('deploy guard passes when no auto-discovered Wrangler config exists', () => {
  const root = tempRepo();
  try {
    assert.deepEqual(findLocalWranglerConfigs(root), []);
    assert.equal(localWranglerConfigError(root), null);
    assert.doesNotThrow(() => assertNoLocalWranglerConfig(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const name of AUTO_DISCOVERED_CONFIGS) {
  test(`deploy guard blocks a root ${name} and names it in the failure`, () => {
    const root = tempRepo([name]);
    try {
      assert.deepEqual(findLocalWranglerConfigs(root), [name]);
      const message = localWranglerConfigError(root);
      assert.ok(message, 'a present config must produce an error message');
      // The operator needs the filename, the reason, and the remedy.
      assert.match(message, new RegExp(name.replace('.', '\\.')));
      assert.match(message, /Refusing to deploy/);
      assert.match(message, /PRICE_HISTORY/);
      assert.match(message, /rm wrangler\.toml/);
      assert.throws(() => assertNoLocalWranglerConfig(root), /Refusing to deploy/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('deploy guard ignores the committed templates and unrelated files', () => {
  const root = tempRepo(['wrangler.d1.toml', 'wrangler.history.toml', 'README.md']);
  try {
    assert.deepEqual(findLocalWranglerConfigs(root), [],
      'the committed templates are not auto-discovered and must not block deploys');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy guard CLI exits non-zero with guidance when the config is present', () => {
  const blocked = tempRepo(['wrangler.toml']);
  const clear = tempRepo();
  try {
    const failed = spawnSync(process.execPath, [GUARD], { cwd: blocked, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Refusing to deploy/);

    const passed = spawnSync(process.execPath, [GUARD], { cwd: clear, encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /deploy may proceed/);
  } finally {
    rmSync(blocked, { recursive: true, force: true });
    rmSync(clear, { recursive: true, force: true });
  }
});

test('a blocked deploy fails before Wrangler is ever invoked', async () => {
  const { deployPages } = await import('../scripts/deploy-pages.mjs');
  const root = tempRepo(['wrangler.toml']);
  try {
    const calls = [];
    await assert.rejects(
      deployPages({
        root,
        execute: (...args) => { calls.push(args); return { status: 0 }; },
      }),
      /Refusing to deploy/,
    );
    assert.deepEqual(calls, [], 'no deploy attempt may run with a local config present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deploy guard runs inside the repository itself', async () => {
  // Guards the real checkout: a stale local `wrangler.toml` must never be
  // committed, and this fails loudly if one is.
  assert.doesNotThrow(() => assertNoLocalWranglerConfig(),
    'remove the local wrangler.toml (it is for local D1 work only) before committing');
});

// ── Snapshot writer: --seed-days / --vary ────────────────────────────────────

test('--seed-days parses a positive count and requires --local', () => {
  const parsed = writer.parseArgs(['--local', '--seed-days', '7']);
  assert.equal(parsed.seedDays, 7);
  assert.equal(parsed.local, true);
  assert.equal(parsed.remote, false);
  assert.throws(() => writer.parseArgs(['--seed-days', '7']), /exactly one of --local or --remote/);
});

test('--seed-days can never target remote D1', () => {
  assert.throws(() => writer.parseArgs(['--remote', '--seed-days', '7']), /--seed-days requires --local/);
  assert.throws(() => writer.parseArgs(['--seed-days', '7', '--remote']), /--seed-days requires --local/);
});

test('--seed-days rejects malformed and out-of-range counts', () => {
  for (const bad of ['0', '-3', 'abc', '1.5', '']) {
    assert.throws(() => writer.parseArgs(['--local', '--seed-days', bad]), /positive integer/,
      `--seed-days ${JSON.stringify(bad)} must be rejected`);
  }
  assert.throws(
    () => writer.parseArgs(['--local', '--seed-days', String(writer.MAX_SEED_DAYS + 1)]),
    /at most 90/,
  );
  assert.equal(writer.parseArgs(['--local', '--seed-days', String(writer.MAX_SEED_DAYS)]).seedDays,
    writer.MAX_SEED_DAYS);
});

test('--vary is only accepted together with --seed-days', () => {
  assert.throws(() => writer.parseArgs(['--local', '--vary']), /only valid with --seed-days/);
  assert.equal(writer.parseArgs(['--local', '--seed-days', '3', '--vary']).vary, true);
});

test('--seed-days without --local leaves the plain single-day path untouched', () => {
  const plain = writer.parseArgs(['--local']);
  assert.equal(plain.seedDays, null);
  assert.equal(plain.vary, false);
});

test('seedDaysFor produces the count of days ending at the anchor, oldest first', () => {
  const days = writer.seedDaysFor('2026-11-18', 3);
  assert.deepEqual(days, ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.deepEqual(writer.seedDaysFor('2026-11-18', 1), ['2026-11-18']);
  assert.equal(writer.seedDaysFor('2026-11-18', 5)[0], shiftUtcDay('2026-11-18', -4));
  assert.equal(writer.seedDaysFor(utcDay(new Date()), 1).length, 1);
});

test('varyPricingForDay is deterministic but differs between days', () => {
  const base = {
    generated_at: '2026-11-18T00:00:00.000Z',
    models: [
      { id: 'a/model', provider: 'p1', pricing: { input: 1, output: 2, cache_read: 0.5 } },
      { id: 'b/model', provider: 'p2', pricing: { input: 4, output: 8, cache_read: null } },
    ],
  };
  const first = writer.varyPricingForDay(base, '2026-11-14');
  const again = writer.varyPricingForDay(base, '2026-11-14');
  const other = writer.varyPricingForDay(base, '2026-11-15');

  assert.deepEqual(first, again, 'the same day must produce identical rows');
  assert.notDeepEqual(first.models.map(m => m.pricing), other.models.map(m => m.pricing),
    'different days must not be a flat repeat');
  // Non-price fields and the source catalog are never mutated.
  assert.deepEqual(first.models.map(m => m.id), ['a/model', 'b/model']);
  assert.equal(base.models[0].pricing.input, 1, 'the source catalog must not be mutated');
  // Prices stay finite, positive, and near the published rate.
  for (const model of first.models) {
    for (const key of ['input', 'output']) {
      assert.ok(Number.isFinite(model.pricing[key]) && model.pricing[key] > 0);
    }
    assert.equal(model.pricing.cache_read, base.models.find(m => m.id === model.id).pricing.cache_read,
      'cache_read is a published cache rate and is left alone');
  }
});

test('varyPricingForDay tolerates models without pricing', () => {
  const pricing = { models: [{ id: 'x', provider: 'p' }, { id: 'y', provider: 'p', pricing: {} }] };
  assert.doesNotThrow(() => writer.varyPricingForDay(pricing, '2026-11-18'));
});

test('varyPricingForDay moves nearly every offering between adjacent days', () => {
  // A day-seeded hash that barely changes with the day produces a chart that is
  // visually flat and never switches provider. Assert the property directly:
  // adjacent days must disagree on essentially every published price.
  const models = Array.from({ length: 200 }, (_, i) => ({
    id: `org/model-${i}`, provider: `p${i % 7}`, pricing: { input: 1 + i * 0.01, output: 2 + i * 0.02 },
  }));
  const pricing = { models };
  const a = writer.varyPricingForDay(pricing, '2026-11-17').models;
  const b = writer.varyPricingForDay(pricing, '2026-11-18').models;
  const identical = a.filter((model, i) => model.pricing.input === b[i].pricing.input).length;
  assert.ok(identical < models.length * 0.05,
    `only ${identical}/${models.length} prices should repeat across adjacent days`);
});
