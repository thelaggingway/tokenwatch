/**
 * One-off capture of /recommend output for every use-case preset, used as a
 * golden fixture so a cost-formula change can be proven not to move any pick.
 * Run: node scripts/capture-recommend-presets.mjs > test/fixtures/recommend-presets.json
 */
import { readFile } from 'node:fs/promises';
import { USE_CASES } from '../shared/use-cases.mjs';
import { shortlistModels } from '../shared/recommend.mjs';

const pricing = JSON.parse(await readFile(new URL('../public/pricing.json', import.meta.url), 'utf8'));
const benchmarks = JSON.parse(await readFile(new URL('../public/benchmarks.json', import.meta.url), 'utf8'));
const performance = JSON.parse(await readFile(new URL('../public/performance.json', import.meta.url), 'utf8'));

const ids = (list) => (list || []).map((item) => item.id);
const out = {};
for (const useCase of Object.keys(USE_CASES)) {
  const result = shortlistModels(useCase, pricing.models, { benchmarks, performance });
  out[useCase] = {
    bestQuality: result.bestQuality?.id ?? null,
    bestValue: result.bestValue?.id ?? null,
    cheapestAboveFloor: result.cheapestAboveFloor?.id ?? null,
    qualityRanking: ids(result.qualityRanking),
    paretoFrontier: ids(result.paretoFrontier),
    partiallyBenchmarked: ids(result.partiallyBenchmarked),
    unbenchmarked: ids(result.unbenchmarked),
    unverified: ids(result.unverified),
  };
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
