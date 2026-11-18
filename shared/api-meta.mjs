// Worker-safe API metadata shared by the Pages Function and static documentation generator.

export const API_ENDPOINTS = [
  {
    path: '/api/v1/',
    summary: 'API metadata and endpoint directory',
    params: ['pretty'],
    sort: [],
  },
  {
    path: '/api/v1/use-cases',
    summary: 'List workload recommendation presets and their assumed mixes, weights, requirements, and quality floors',
    description: 'Returns the nine use-case presets used by /choose/ and the recommend endpoints. Every mix is flagged assumed: true; weights and floors are documented judgments, not measurements.',
    params: ['pretty'],
    sort: [],
  },
  {
    path: '/api/v1/recommend',
    summary: 'Recommend models for a workload; chat and creative-writing also return an Arena preference favorite with source metadata',
    description: 'Open-weight model shortlist for one use case: picks.bestQuality, picks.bestValue (quality/price Pareto frontier) and picks.cheapestAboveFloor, each with a recommended provider, explanation, and confidence (stable, moderately_stable, close_call). Also returns alsoConsidered, partiallyBenchmarked, unbenchmarked, and unverified groups. Arena ratings in preference are from the LMArena leaderboard dataset (CC BY 4.0); display the attribution in preference.source.',
    errorNote: 'Invalid parameters return 400 with { error, parameter, code: "invalid_parameter" }.',
    params: ['use_case', 'priority', 'zdr', 'exclude_hq', 'include_proprietary', 'detail', 'limit', 'pretty'],
    requiredParams: ['use_case'],
    parameterLimits: { limit: 100 },
    parameterFormats: { exclude_hq: 'comma-separated ISO-3166-1 alpha-2 codes' },
    sort: [],
  },
  {
    path: '/api/v1/recommend/providers',
    summary: 'Rank providers for one model with full explanations for the top three and compact remaining rows',
    description: 'Ranks eligible providers for one canonical model at the use case assumed mix on blended price, TTFT p50, throughput p50, and uptime, weighted by priority. Providers missing required capability or context metadata are returned in unverified, never ranked.',
    params: ['use_case', 'model', 'priority', 'zdr', 'exclude_hq', 'include_proprietary', 'detail', 'limit', 'pretty'],
    requiredParams: ['use_case', 'model'],
    parameterLimits: { limit: 100 },
    sort: [],
  },
  {
    path: '/api/v1/models',
    summary: 'List text-generation model offerings',
    params: ['org', 'provider', 'min_context', 'min_output', 'min_intelligence', 'quantization', 'open_weights', 'cache_read', 'cache_write', 'promo', 'zdr', 'sub', 'benchmarked', 'search', 'sort', 'order', 'limit', 'offset', 'pretty'],
    errorNote: 'Invalid parameters return 400 with { error, parameter, code: "invalid_parameter" }. Booleans accept only true or false; minimums are non-negative integers.',
    parameterLimits: { limit: 500 },
    parameterFormats: { order: 'asc or desc (case-insensitive); default asc' },
    sort: ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'],
  },
  {
    path: '/api/v1/models/:canonicalId/providers',
    summary: 'List providers for one canonical model, ordered by cost',
    params: ['tokens', 'mix', 'pretty'],
    errorNote: 'Invalid mix or non-positive tokens return 400. Supplying mix without tokens sorts by the blended rate at that mix.',
    parameterFormats: { mix: 'inputPct,cacheReadPct,outputPct summing to 100' },
    sort: [],
  },
  {
    path: '/api/v1/models/:canonicalId/history',
    summary: 'Daily cheapest-provider price history, blended at read time',
    params: ['days', 'mix', 'pretty'],
    sort: [],
  },
  {
    path: '/api/v1/estimate',
    summary: 'Per-provider cost for a model at a token count and mix, cheapest first',
    description: 'Returns { provider, provider_display, quantization, rate_per_mtok, cost_usd } for every offering of one canonical model, sorted cheapest first. Offerings that cannot be priced at the requested mix return cost_usd: null with an unpriceable_reason and are listed last — never $0. Supply either mix=inputPct,cacheReadPct,outputPct or use_case=<preset id>.',
    params: ['model', 'tokens', 'mix', 'use_case', 'pretty'],
    requiredParams: ['model', 'tokens'],
    errorNote: 'Invalid parameters return 400 with { error, parameter, code: "invalid_parameter" }; an unknown model returns 404 with code "model_not_found".',
    parameterFormats: { mix: 'inputPct,cacheReadPct,outputPct summing to 100; mutually exclusive with use_case' },
    sort: [],
  },
  {
    path: '/api/v1/compare',
    summary: 'Compare cheapest per-provider cost across up to 20 models',
    description: 'Returns per model the cheapest provider and cost, the most expensive provider cost, the spread, and the savings versus the most expensive option. Unknown ids are reported in a not_found array instead of failing the whole request.',
    params: ['models', 'tokens', 'mix', 'use_case', 'pretty'],
    requiredParams: ['models', 'tokens'],
    parameterLimits: { models: 20 },
    errorNote: 'Invalid parameters return 400 with { error, parameter, code: "invalid_parameter" }. More than 20 model ids is a 400.',
    parameterFormats: { models: 'comma-separated canonical or org/model ids, max 20' },
    sort: [],
  },
  {
    path: '/api/v1/stats',
    summary: 'Return catalog, provider, organization, privacy, cache, and quantization counts',
    params: ['pretty'],
    sort: [],
  },
  {
    path: '/api/v1/orgs',
    summary: 'List model organizations with offering counts',
    params: ['pretty'],
    sort: [],
  },
  {
    path: '/api/v1/providers',
    summary: 'List provider metadata and policy fields',
    params: ['zdr', 'pretty'],
    sort: [],
  },
  {
    path: '/api/v1/images',
    summary: 'List image-generation models',
    params: ['org', 'provider', 'search', 'sort', 'order', 'limit', 'offset', 'pretty'],
    sort: ['id', 'org', 'provider'],
  },
  {
    path: '/api/v1/images/:id',
    summary: 'Return one image model with its pricing variants',
    params: ['pretty'],
    sort: [],
  },
  {
    path: '/api/v1/videos',
    summary: 'List video-generation models',
    params: ['org', 'provider', 'search', 'sort', 'order', 'limit', 'offset', 'pretty'],
    sort: ['id', 'org', 'provider'],
  },
  {
    path: '/api/v1/videos/:id',
    summary: 'Return one video model with its pricing variants',
    params: ['pretty'],
    sort: [],
  },
];

export function endpointDirectory() {
  return API_ENDPOINTS
    .filter((endpoint) => endpoint.path !== '/api/v1/')
    .map((endpoint) => {
      const params = endpoint.params.length ? ` (params: ${endpoint.params.join(', ')})` : '';
      return `${endpoint.path} — ${endpoint.summary}${params}`;
    });
}
