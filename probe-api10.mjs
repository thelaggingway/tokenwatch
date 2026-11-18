import { buildHistorySeries, parseMixParam } from './shared/price-history.mjs';
import { blendedRate } from './shared/cost.mjs';

console.log('A) blendedRate with every price null:');
for (const mix of [{ inputPct: 0, cacheReadPct: 100, outputPct: 0 }, { inputPct: 0, cacheReadPct: 0, outputPct: 0 }]) {
  console.log('   ', JSON.stringify(mix), '->', blendedRate({ input: null, output: null, cache_read: null, cache_write: null }, mix), '(0 means "free")');
}
console.log('B) history day where the only row is fully unpriced, mix=0,100,0:');
const rows = [{ utc_day: '2026-01-03', offering_key: 'k', provider: 'p', model_id: 'o/m', quantization: '', input_price: null, output_price: null, cache_read: null, cache_write: null, input_billing: null, discount: 0 }];
console.log('   ', JSON.stringify(buildHistorySeries(rows, { inputPct: 0, cacheReadPct: 100, outputPct: 0 }).map((d) => d.point)));
console.log('C) parseMixParam("0,0,0") ->', JSON.stringify(parseMixParam('0,0,0')), '(a 0/0/0 mix is accepted)');

// Comparator inconsistency proof: nulls interleaved with values
const rowsSort = [
  { id: 'a', v: 5 }, { id: 'b', v: null }, { id: 'c', v: 1 }, { id: 'd', v: null }, { id: 'e', v: 9 },
];
const cmp = (a, b) => {
  if (a.v === null || a.v === undefined) return 1;
  if (b.v === null || b.v === undefined) return -1;
  return a.v - b.v;
};
for (let i = 0; i < 3; i += 1) {
  console.log('D) run', i, [...rowsSort].sort(cmp).map((r) => `${r.id}:${r.v}`).join(' '));
}
console.log('   cmp(null,null)=', cmp(rowsSort[1], rowsSort[3]), 'cmp(null,value)=', cmp(rowsSort[1], rowsSort[0]), '(1 and 1: not antisymmetric)');
