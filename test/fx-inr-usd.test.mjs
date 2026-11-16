import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getInrUsdRate, readInrUsdSnapshot, inrPricingNote, INR_USD_SNAPSHOT_PATH } from '../scripts/fetch-fx.mjs';

const SNAPSHOT = {
  base: 'INR', quote: 'USD', rate: 0.0106, rate_date: '2026-11-13',
  fetched_at: '2026-11-13T16:00:00.000Z', source: 'ECB reference rate via frankfurter.dev',
};
// Live Frankfurter response shape (2026-11-16).
const LIVE = { amount: 1.0, base: 'INR', date: '2026-11-16', rates: { USD: 0.010647 } };

const quiet = () => {};
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const failFetch = async () => { throw new Error('network down'); };
async function seeded(snapshot) {
  const path = join(await mkdtemp(join(tmpdir(), 'fx-')), 'fx.json');
  if (snapshot) await writeFile(path, JSON.stringify(snapshot));
  return path;
}

test('the committed INR→USD snapshot is valid', async () => {
  assert.ok(await readInrUsdSnapshot(INR_USD_SNAPSHOT_PATH));
});

test('a rate younger than 7 days is reused without a network call', async () => {
  const snapshotPath = await seeded(SNAPSHOT);
  const fx = await getInrUsdRate({
    snapshotPath, log: quiet,
    now: () => new Date('2026-11-19T00:00:00Z'),
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(fx.rate, 0.0106);
  assert.equal(fx.source, 'snapshot');
});

test('a week-old rate is refreshed and persisted', async () => {
  const snapshotPath = await seeded(SNAPSHOT);
  const fx = await getInrUsdRate({ snapshotPath, log: quiet, now: () => new Date('2026-11-21T00:00:00Z'), fetchImpl: okFetch(LIVE) });
  assert.equal(fx.source, 'fresh');
  assert.equal(fx.rate, 0.010647);
  const saved = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.equal(saved.rate_date, '2026-11-16');
  assert.equal(saved.fetched_at, '2026-11-21T00:00:00.000Z');
});

test('fetch failures and implausible rates fall back to the last-good rate', async () => {
  const now = () => new Date('2026-12-30T00:00:00Z');
  for (const fetchImpl of [failFetch, okFetch({ ...LIVE, rates: { USD: 83.2 } })]) {
    const snapshotPath = await seeded(SNAPSHOT);
    const fx = await getInrUsdRate({ snapshotPath, log: quiet, now, fetchImpl });
    assert.equal(fx.source, 'stale');
    assert.equal(fx.rate, 0.0106);
    assert.deepEqual(JSON.parse(await readFile(snapshotPath, 'utf8')), SNAPSHOT);
  }
});

test('no snapshot and no live rate is an error', async () => {
  const snapshotPath = await seeded(null);
  await assert.rejects(getInrUsdRate({ snapshotPath, log: quiet, fetchImpl: failFetch }), /no INR→USD rate/);
});

test('the pricing note names the rate, its date, and the weekly cadence', () => {
  assert.equal(
    inrPricingNote(SNAPSHOT),
    'Billed in INR. USD prices are converted at ₹1 = $0.0106 (ECB reference rate of 2026-11-13), refreshed weekly; your actual charge follows the rupee rate when you pay.',
  );
});
