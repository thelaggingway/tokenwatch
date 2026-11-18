import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { assertNoLocalWranglerConfig } from './check-no-local-wrangler.mjs';

// Retry only publication of the already-built public/ tree, never the refresh
// or history writes. Keep the version previously used by wrangler-action@v3.
//
// The guard runs before the first attempt: a root `wrangler.toml` copied for
// local D1 work is auto-discovered by `wrangler pages deploy` and would bind
// the placeholder PRICE_HISTORY database to production. Retrying that is
// pointless, so it fails fast with operator guidance instead.
export async function deployPages({
  execute = spawnSync, wait = delay, log = console.log, root,
  checkConfig = assertNoLocalWranglerConfig,
} = {}) {
  checkConfig(root);
  const args = ['--yes', 'wrangler@3.90.0', 'pages', 'deploy', 'public',
    '--project-name', 'payg-inference-calculator', '--branch', 'main'];
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Pages deploy attempt ${attempt}/3`);
    const result = execute('npx', args, { stdio: 'inherit' });
    if (!result.error && result.status === 0) return;
    const reason = result.error?.message || `exit ${result.status}, signal ${result.signal ?? 'none'}`;
    if (attempt === 3) throw new Error(`Pages deploy failed after 3 attempts (${reason})`);
    const backoff = 10000 * attempt;
    log(`Pages deploy failed (${reason}); retrying in ${backoff / 1000}s`);
    await wait(backoff);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  deployPages().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
