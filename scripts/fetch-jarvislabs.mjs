#!/usr/bin/env node
/**
 * fetch-jarvislabs.mjs
 *
 * Daily public JarvisLabs Token Factory Tier-1 API-pricing ingestion.
 *
 * Source: https://jarvislabs.ai/products/token-factory (public, no key). The
 * OpenAI-compatible catalog at https://models.jarvislabs.net/v1 requires a
 * bearer token, so the product page is the only public price source.
 * `parseJarvislabsPricingHtml()` in scripts/lib.mjs reads the desktop pricing
 * <table> the page server-renders.
 *
 * Durability model:
 *   - data/jarvislabs-pricing.json is the committed LAST-GOOD source snapshot.
 *   - A snapshot younger than 24h is reused without a network call, so the
 *     2-hourly refresh workflow only hits the live page once per day.
 *   - On fetch/parse/validation failure, the last-good snapshot is used.
 *   - `validateJarvislabsSnapshot()` is fail-closed: a partial parse, duplicate
 *     ids, non-positive prices, a sub-floor row count, or a >25% row-count drop
 *     versus last-good all reject the fresh data.
 *
 * `getJarvislabsCatalogRows()` always returns either newly validated rows or
 * validated fallback rows, mapped to ordinary TokenWatch catalog records
 * (provider: "jarvislabs"). It never returns a partial slice and never
 * publishes a zero-priced model as free.
 */

import { readFile } from 'node:fs/promises';
import {
  parseJarvislabsPricingHtml,
  validateJarvislabsSnapshot,
  jarvislabsSnapshotFresh,
  jarvislabsRowsFromSnapshot,
  jarvislabsZeroOutput,
  JARVISLABS_PRICING_URL,
  writeJsonAtomic,
} from './lib.mjs';

export const JARVISLABS_SNAPSHOT_PATH = 'data/jarvislabs-pricing.json';

/**
 * Read the committed last-good snapshot, or null when absent/invalid.
 *
 * The on-disk copy is validated with the same fail-closed rules as a fresh
 * fetch, so a corrupted or hand-truncated `data/jarvislabs-pricing.json` can
 * never be reused via the TTL path or published as fallback rows — the "never
 * partial" invariant applies to the last-good copy too.
 */
export async function readJarvislabsSnapshot(path = JARVISLABS_SNAPSHOT_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    validateJarvislabsSnapshot(parsed, { previous: null });
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a validated snapshot (fetch timestamp recorded for the TTL).
 * Fails fast rather than writing a snapshot that `readJarvislabsSnapshot()`
 * would reject — keeps the committed last-good copy always consumable.
 */
export async function writeJarvislabsSnapshot(snapshot, path = JARVISLABS_SNAPSHOT_PATH) {
  validateJarvislabsSnapshot(snapshot, { previous: null });
  await writeJsonAtomic(path, snapshot);
}

/**
 * Fetch + validate the live Token Factory pricing page.
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date }} [options]
 * @returns {Promise<{ok: true, snapshot: object, skipped: string[]} | {ok: false, reason: string}>}
 */
export async function fetchJarvislabsSnapshot({ fetchImpl = fetch, now = () => new Date() } = {}) {
  let html;
  try {
    const resp = await fetchImpl(JARVISLABS_PRICING_URL, { redirect: 'follow' });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    html = await resp.text();
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const rows = parseJarvislabsPricingHtml(html);
  const skipped = jarvislabsZeroOutput(html);
  const snapshot = {
    source_url: JARVISLABS_PRICING_URL,
    fetched_at: now().toISOString(),
    models: rows,
  };
  try {
    validateJarvislabsSnapshot(snapshot, { previous: null });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, snapshot, skipped };
}

/**
 * Resolve JarvisLabs catalog rows for a refresh run.
 *
 * Returns newly validated rows when the live fetch succeeds and validates;
 * otherwise returns rows from the last-good snapshot. Always returns ordinary
 * catalog records (provider: "jarvislabs") — never null, never partial.
 *
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date, snapshotPath?: string,
 *   force?: boolean, log?: (msg: string) => void }} [options]
 * @returns {Promise<{rows: Array<object>, source: 'fresh'|'snapshot'|'none', reason?: string}>}
 */
export async function getJarvislabsCatalogRows({
  fetchImpl = fetch,
  now = () => new Date(),
  snapshotPath = JARVISLABS_SNAPSHOT_PATH,
  force = false,
  log = console.log,
} = {}) {
  const previous = await readJarvislabsSnapshot(snapshotPath);
  const nowMs = now().getTime();

  // Reuse a fresh snapshot without touching the network (daily ingestion on a
  // 2-hourly refresh cadence).
  if (!force && previous && jarvislabsSnapshotFresh(previous, nowMs)) {
    log(`  JarvisLabs: reusing last-good snapshot (fetched ${previous.fetched_at})`);
    return { rows: jarvislabsRowsFromSnapshot(previous), source: 'snapshot' };
  }

  const fetched = await fetchJarvislabsSnapshot({ fetchImpl, now });
  if (fetched.ok) {
    // A $0 output tariff is a missing price, not a free one: name the ids we
    // dropped so a page change is visible in the refresh log.
    for (const id of fetched.skipped) {
      log(`  ⚠ JarvisLabs: skipped ${id} — no output tariff published`);
    }
    // Guard against a large row-count regression before accepting fresh data.
    try {
      validateJarvislabsSnapshot(fetched.snapshot, { previous });
    } catch (err) {
      log(`  ⚠ JarvisLabs: fresh snapshot rejected (${err.message}) — using last-good`);
      if (previous) return { rows: jarvislabsRowsFromSnapshot(previous), source: 'snapshot', reason: err.message };
      return { rows: [], source: 'none', reason: err.message };
    }
    try {
      await writeJarvislabsSnapshot(fetched.snapshot, snapshotPath);
      log(`  ✓ JarvisLabs: fetched ${fetched.snapshot.models.length} API offerings`);
    } catch (err) {
      log(`  ⚠ JarvisLabs: could not persist snapshot (${err.message}) — using fresh rows anyway`);
    }
    return { rows: jarvislabsRowsFromSnapshot(fetched.snapshot), source: 'fresh' };
  }

  log(`  ⚠ JarvisLabs: fetch/parse failed (${fetched.reason}) — using last-good snapshot`);
  if (previous) return { rows: jarvislabsRowsFromSnapshot(previous), source: 'snapshot', reason: fetched.reason };
  return { rows: [], source: 'none', reason: fetched.reason };
}
