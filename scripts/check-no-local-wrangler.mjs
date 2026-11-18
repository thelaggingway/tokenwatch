#!/usr/bin/env node
/**
 * scripts/check-no-local-wrangler.mjs — fail fast when a root Wrangler config
 * could be auto-discovered by a Pages deploy.
 *
 * `wrangler pages deploy` treats a root `wrangler.toml` / `wrangler.json` /
 * `wrangler.jsonc` as the source of truth for Pages bindings. The documented
 * local D1 workflow asks developers to copy `wrangler.d1.toml` to `wrangler.toml`,
 * which declares a placeholder `PRICE_HISTORY` database that does not exist.
 * Deploying with that file present either fails or binds a broken database to
 * production, so every deploy path must refuse to start.
 *
 * This is deliberately a *file presence* check, not a content check: a real
 * dashboard-managed deployment needs no root config at all, so an accidentally
 * committed local copy is never legitimate.
 *
 * Usage:
 *   node scripts/check-no-local-wrangler.mjs      # exits 1 with guidance
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Filenames Wrangler auto-discovers in the project root. */
export const AUTO_DISCOVERED_CONFIGS = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

/**
 * Names of auto-discovered Wrangler configs present in `cwd`, or [] when clear.
 * Sorted for stable messages and assertions.
 */
export function findLocalWranglerConfigs(cwd = ROOT) {
  let entries;
  try {
    entries = new Set(readdirSync(cwd));
  } catch {
    // A missing directory cannot contain a deploy-breaking config.
    return [];
  }
  return AUTO_DISCOVERED_CONFIGS.filter((name) => entries.has(name));
}

/**
 * Return an operator-facing error message when a local config is present,
 * or null when the deploy may proceed. Split out from the CLI so deploy paths
 * can gate on it without shelling out.
 */
export function localWranglerConfigError(cwd = ROOT) {
  const found = findLocalWranglerConfigs(cwd);
  if (!found.length) return null;
  return [
    `Refusing to deploy: found a local Wrangler config (${found.join(', ')}) in ${cwd}.`,
    'Wrangler auto-discovers this file and would use it as the source of truth for',
    'Pages bindings, binding the placeholder PRICE_HISTORY database to production.',
    'Remove it first (`rm wrangler.toml`) and re-run the deploy. It exists only for',
    'local D1 development; see migrations/README.md.',
  ].join('\n');
}

/**
 * Assert the deploy may proceed. Throws with the operator message when a local
 * config is present so callers surface one clear, actionable failure.
 */
export function assertNoLocalWranglerConfig(cwd = ROOT) {
  const error = localWranglerConfigError(cwd);
  if (error) throw new Error(error);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    // Check the directory Wrangler runs in, not the script's location.
    assertNoLocalWranglerConfig(process.cwd());
    console.log('check-no-local-wrangler: no auto-discovered Wrangler config; deploy may proceed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
