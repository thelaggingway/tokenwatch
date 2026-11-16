#!/usr/bin/env node
/**
 * fetch-fx.mjs
 *
 * INR→USD rate for providers that bill in rupees (Sarvam AI).
 *
 * Source: Frankfurter (keyless), which republishes the ECB reference rate once
 * per TARGET business day. Weekly precision is enough for list prices, so:
 *   - data/fx-inr-usd.json is the committed LAST-GOOD rate.
 *   - A rate fetched less than 7 days ago is reused without a network call.
 *   - On fetch/validation failure the last-good rate is used, however old, so a
 *     rate-service outage cannot drop Sarvam from the catalog.
 *   - Only with no usable snapshot AND no fresh rate does the caller get an
 *     error (Sarvam then reports a fetch failure for that run).
 */

import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './lib.mjs';

export const INR_USD_URL = 'https://api.frankfurter.dev/v1/latest?base=INR&symbols=USD';
export const INR_USD_SNAPSHOT_PATH = 'data/fx-inr-usd.json';
export const INR_USD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Throws unless `s` is a plausible INR→USD snapshot. */
export function validateInrUsdSnapshot(s) {
  if (!s || s.base !== 'INR' || s.quote !== 'USD') throw new Error('not an INR→USD snapshot');
  // ₹1 has been ~$0.011–0.013 for years; outside this band the source is garbled.
  if (!(typeof s.rate === 'number' && s.rate > 0.005 && s.rate < 0.05)) throw new Error(`implausible INR→USD rate ${s.rate}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.rate_date || ''))) throw new Error(`bad rate_date ${s.rate_date}`);
  if (!Number.isFinite(Date.parse(s.fetched_at))) throw new Error(`bad fetched_at ${s.fetched_at}`);
  return s;
}

/** Committed last-good rate, or null when absent/invalid. */
export async function readInrUsdSnapshot(path = INR_USD_SNAPSHOT_PATH) {
  try {
    return validateInrUsdSnapshot(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return null;
  }
}

/** Fetch + validate the live rate. Never throws. */
export async function fetchInrUsdSnapshot({ fetchImpl = fetch, now = () => new Date() } = {}) {
  try {
    const res = await fetchImpl(INR_USD_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${INR_USD_URL}`);
    const body = await res.json();
    const snapshot = validateInrUsdSnapshot({
      base: 'INR',
      quote: 'USD',
      rate: Number(body?.rates?.USD),
      rate_date: body?.date,
      fetched_at: now().toISOString(),
      source: 'ECB reference rate via frankfurter.dev',
    });
    return { ok: true, snapshot };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Current INR→USD rate: the committed snapshot while younger than 7 days,
 * else a fresh fetch (persisted), else the stale snapshot.
 * @returns {Promise<{rate: number, rate_date: string, fetched_at: string, source: 'snapshot'|'fresh'|'stale'}>}
 */
export async function getInrUsdRate({
  fetchImpl = fetch,
  now = () => new Date(),
  snapshotPath = INR_USD_SNAPSHOT_PATH,
  force = false,
  log = console.log,
} = {}) {
  const previous = await readInrUsdSnapshot(snapshotPath);
  if (!force && previous && now().getTime() - Date.parse(previous.fetched_at) < INR_USD_MAX_AGE_MS) {
    return { ...previous, source: 'snapshot' };
  }
  const fetched = await fetchInrUsdSnapshot({ fetchImpl, now });
  if (fetched.ok) {
    try {
      await writeJsonAtomic(snapshotPath, fetched.snapshot);
    } catch (err) {
      log(`  ⚠ FX: could not persist INR→USD snapshot (${err.message}) — using fresh rate anyway`);
    }
    log(`  ✓ FX: INR→USD ${fetched.snapshot.rate} (ECB ${fetched.snapshot.rate_date})`);
    return { ...fetched.snapshot, source: 'fresh' };
  }
  if (previous) {
    log(`  ⚠ FX: INR→USD fetch failed (${fetched.reason}) — using last-good rate from ${previous.rate_date}`);
    return { ...previous, source: 'stale' };
  }
  throw new Error(`no INR→USD rate: ${fetched.reason}`);
}

/** Visitor-facing disclaimer stored as providers_meta[provider].pricing_note. */
export function inrPricingNote(fx) {
  return `Billed in INR. USD prices are converted at ₹1 = $${fx.rate} (ECB reference rate of ${fx.rate_date}), refreshed weekly; your actual charge follows the rupee rate when you pay.`;
}
