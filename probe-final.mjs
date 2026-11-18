import { buildHistorySeries } from './shared/price-history.mjs';

const cacheWriteOnly = (day, key, provider) => ({
  utc_day: day, offering_key: key, provider, model_id: 'o/m', quantization: '',
  input_price: null, output_price: null, cache_read: null, cache_write: 2, input_billing: null, discount: 0,
});
const priced = (day, key, provider, rate) => ({
  utc_day: day, offering_key: key, provider, model_id: 'o/m', quantization: '',
  input_price: rate, output_price: rate, cache_read: rate, cache_write: null, input_billing: null, discount: 0,
});

console.log('A) cache-write-only row, mix=0,100,0 ->', JSON.stringify(buildHistorySeries([cacheWriteOnly('2026-01-03', 'k', 'p')], { inputPct: 0, cacheReadPct: 100, outputPct: 0 }).map((d) => d.point)));
console.log('   same row, default agentic mix ->', JSON.stringify(buildHistorySeries([cacheWriteOnly('2026-01-03', 'k', 'p')]).map((d) => d.point)));

// tie-break creates a spurious provider switch
const ties = [
  priced('2026-01-01', 'k1', 'zeta', 1),
  priced('2026-01-01', 'k2', 'alpha', 1),
  priced('2026-01-02', 'k1', 'zeta', 1),
  priced('2026-01-02', 'k2', 'alpha', 1),
];
const pts = buildHistorySeries(ties);
console.log('B) identical prices, two providers:', pts.map((d) => `${d.day}:${d.point.provider}`).join(' '), '| switch count:', pts.slice(1).filter((d, i) => d.point.provider !== pts[i].point.provider).length);
