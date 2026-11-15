#!/usr/bin/env node
/**
 * fetch-inco.mjs
 *
 * Public Inco Tier-1 catalog ingestion.
 *
 * Source: https://api.inco.ai/v1/models (public, no key). The catalog is an
 * OpenAI-shaped `{object:"list", data:[…]}` whose `pricing` block is already in
 * USD per 1M tokens; `parseInco()` in scripts/lib.mjs drops every row without a
 * positive output tariff — a $0 output is a missing price, not a free one.
 *
 * Durability model (same shape as fetch-zro.mjs, so an Inco outage cannot break
 * the refresh workflow):
 *   - data/inco-pricing.json is the committed LAST-GOOD source snapshot.
 *   - A snapshot younger than 24h is reused without a network call, so the
 *     2-hourly refresh only hits the live catalog once per day.
 *   - On fetch/parse/validation failure, the last-good snapshot is used and the
 *     provider reports `ok (fallback)` instead of `ok`.
 *   - `validateIncoSnapshot()` is fail-closed: a partial parse, duplicate ids,
 *     non-positive prices, a sub-floor row count, a mis-paired display name, or
 *     a >34% row-count drop versus last-good all reject the fresh data.
 */

import { readFile } from 'node:fs/promises';
import {
  incoRowsFromSnapshot,
  incoSnapshotFresh,
  incoZeroOutput,
  INCO_MODELS_URL,
  parseInco,
  validateIncoSnapshot,
  writeJsonAtomic,
} from './lib.mjs';

export const INCO_SNAPSHOT_PATH = 'data/inco-pricing.json';

/** Read the committed last-good snapshot, or null when absent/invalid. */
export async function readIncoSnapshot(path = INCO_SNAPSHOT_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    validateIncoSnapshot(parsed, { previous: null });
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a validated snapshot (fetch timestamp recorded for the TTL). */
export async function writeIncoSnapshot(snapshot, path = INCO_SNAPSHOT_PATH) {
  validateIncoSnapshot(snapshot, { previous: null });
  await writeJsonAtomic(path, snapshot);
}

/**
 * Fetch + validate the live Inco catalog.
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date }} [options]
 * @returns {Promise<{ok: true, snapshot: object, zeroOutput: string[]} | {ok: false, reason: string}>}
 */
export async function fetchIncoSnapshot({ fetchImpl = fetch, now = () => new Date() } = {}) {
  let data;
  try {
    const resp = await fetchImpl(INCO_MODELS_URL, { redirect: 'follow', signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    data = await resp.json();
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const zeroOutput = incoZeroOutput(data);
  const models = parseInco(data).map((m) => ({
    id: m.id,
    name: m.name,
    context_length: m.context_length,
    input_modalities: m.input_modalities,
    input: m.pricing.input,
    output: m.pricing.output,
    cache_read: m.pricing.cache_read,
  }));
  const snapshot = {
    source_url: INCO_MODELS_URL,
    fetched_at: now().toISOString(),
    models,
  };
  try {
    validateIncoSnapshot(snapshot, { previous: null });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, snapshot, zeroOutput };
}

/**
 * Resolve Inco catalog rows for a refresh run.
 *
 * Freshly validated rows when the live fetch lands, otherwise last-good
 * snapshot rows. Always returns ordinary catalog records (provider: "inco").
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date, snapshotPath?: string,
 *   force?: boolean, log?: (msg: string) => void }} [options]
 * @returns {Promise<{rows: Array<object>, source: 'fresh'|'snapshot'|'none', zeroOutput?: string[], reason?: string}>}
 */
export async function getIncoCatalogRows({
  fetchImpl = fetch,
  now = () => new Date(),
  snapshotPath = INCO_SNAPSHOT_PATH,
  force = false,
  log = console.log,
} = {}) {
  const previous = await readIncoSnapshot(snapshotPath);
  const nowMs = now().getTime();

  // Reuse a fresh snapshot without touching the network (daily ingestion on a
  // 2-hourly refresh cadence).
  if (!force && previous && incoSnapshotFresh(previous, nowMs)) {
    log(`  Inco: reusing last-good snapshot (fetched ${previous.fetched_at})`);
    return { rows: incoRowsFromSnapshot(previous), source: 'snapshot' };
  }

  const fetched = await fetchIncoSnapshot({ fetchImpl, now });
  if (fetched.ok) {
    if (fetched.zeroOutput.length) {
      log(`  ⚠ Inco: $0 output price (skipped, not free): ${fetched.zeroOutput.join(', ')}`);
    }
    try {
      validateIncoSnapshot(fetched.snapshot, { previous });
    } catch (err) {
      log(`  ⚠ Inco: fresh snapshot rejected (${err.message}) — using last-good`);
      if (previous) return { rows: incoRowsFromSnapshot(previous), source: 'snapshot', reason: err.message };
      return { rows: [], source: 'none', reason: err.message };
    }
    try {
      await writeIncoSnapshot(fetched.snapshot, snapshotPath);
      log(`  ✓ Inco: fetched ${fetched.snapshot.models.length} priced offerings`);
    } catch (err) {
      log(`  ⚠ Inco: could not persist snapshot (${err.message}) — using fresh rows anyway`);
    }
    return { rows: incoRowsFromSnapshot(fetched.snapshot), source: 'fresh' };
  }

  log(`  ⚠ Inco: fetch/parse failed (${fetched.reason}) — using last-good snapshot`);
  if (previous) return { rows: incoRowsFromSnapshot(previous), source: 'snapshot', reason: fetched.reason };
  return { rows: [], source: 'none', reason: fetched.reason };
}
