// Per-parameter OpenAPI documentation for /api/v1, keyed by the registry path.
//
// Every entry describes what the router in functions/api/v1/[[route]].js
// actually does. Malformed values are a 400 `invalid_parameter` naming the
// parameter; the only deliberate leniencies are case-insensitive `order` and a
// `limit` above 500 clamping to 500.
//
// Shape per parameter:
//   type      'string' | 'integer' | 'number' | 'boolean'
//   description  one-line semantics
//   enum     allowed values, when the router checks a closed set
//   enumFrom 'use_case' | 'priority' — derive the enum from the shared
//            preset tables so the spec cannot drift from the router
//   minimum/maximum/pattern/default  numeric and format constraints
//   nullable  true when the JSON Schema type is `['x', 'null']`

const PAGINATION = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 500,
    default: 100,
    description: 'Page size, a positive integer. Values above 500 are clamped to 500 and the response `limit` reports the applied value; 0, negative, fractional or non-numeric values are a 400.',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Zero-based index of the first row, a non-negative integer; anything else is a 400. An offset past the end returns an empty page with an honest `total`.',
  },
};

const TEXT_SORT = {
  type: 'string',
  enum: ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'],
  default: 'id',
  description: 'Sort key. Prices are USD per million tokens; `context`, `max_output` and `uptime` are offering metrics; `intelligence`, `coding` and `agentic` are benchmark indices. Null values sort last in both directions. An unknown key is a 400 listing the valid keys.',
};

const ORDER = {
  type: 'string',
  enum: ['asc', 'desc'],
  default: 'asc',
  description: 'Sort direction, case-insensitive (`DESC` works). Any other value is a 400.',
};

/**
 * JSON indentation. Every data route returns compact JSON by default and
 * accepts `pretty=1`/`pretty=true` to indent it, so one definition is reused
 * instead of restated per route.
 */
const PRETTY = {
  type: 'string',
  enum: ['1', '0', 'true', 'false'],
  default: '0',
  description: 'When `1` or `true`, indent the JSON. Every data route returns compact JSON by default and honours this flag; indenting inflates the payload, so it is meant for reading, not for clients.',
};

const TEXT_FILTERS = {
  org: {
    type: 'string',
    description: 'Exact organization slug, matched case-insensitively against `model.org`.',
  },
  provider: {
    type: 'string',
    description: 'Exact provider slug, matched case-insensitively against `model.provider`.',
  },
  min_context: {
    type: 'integer',
    minimum: 0,
    description: 'Keep offerings whose context window is at least this many tokens. Offerings with an unknown context window are excluded.',
  },
  min_output: {
    type: 'integer',
    minimum: 0,
    description: 'Keep offerings whose maximum completion tokens are at least this value. Unknown maximums are excluded.',
  },
  min_intelligence: {
    type: 'number',
    minimum: 0,
    description: 'Keep offerings whose benchmark `intelligence_index` is at least this value (decimals allowed, e.g. `45.5`). Unbenchmarked offerings are excluded; `0` disables the filter. Negative or non-numeric values are a 400.',
  },
  quantization: {
    type: 'string',
    description: 'Exact quantization label such as `fp8`, `fp4`, `nvfp4`, `bf16` or `unknown`, matched case-insensitively.',
  },
  open_weights: {
    type: 'boolean',
    description: 'Keep offerings with a resolved open-weight status of `true` or `false`. Unknown statuses are excluded from both, and `null` matches neither.',
  },
  cache_read: {
    type: 'boolean',
    description: 'When `true`, keep only offerings that publish a cache-read tariff.',
  },
  cache_write: {
    type: 'boolean',
    description: 'When `true`, keep only offerings that publish a cache-write tariff.',
  },
  promo: {
    type: 'boolean',
    description: 'When `true`, keep only promotional offerings (`discount > 0`). A structural price has `discount: 0`.',
  },
  zdr: {
    type: 'boolean',
    description: 'When `true`, keep only offerings from a provider marked zero data retention.',
  },
  sub: {
    type: 'boolean',
    description: 'When `true`, keep only offerings available through a subscription plan.',
  },
  benchmarked: {
    type: 'boolean',
    description: 'When `true`, keep only offerings carrying a benchmark sidecar.',
  },
  search: {
    type: 'string',
    description: 'Case-insensitive substring match across model id, display name, org and provider.',
  },
};

const RECOMMENDATION_COMMON = {
  use_case: {
    type: 'string',
    required: true,
    // Filled from USE_CASES by the generator so the enum cannot drift from the
    // presets the router actually accepts.
    enumFrom: 'use_case',
    description: 'Workload preset id. See `/api/v1/use-cases` for each preset\'s assumed mix, weights, requirements and quality floor.',
  },
  priority: {
    type: 'string',
    enumFrom: 'priority',
    default: 'balanced',
    description: 'Provider-ranking weights. `balanced` uses the use case defaults; the others re-weight price, time-to-first-token, throughput and uptime.',
  },
  zdr: {
    type: 'boolean',
    description: 'When `true`, only providers marked zero data retention are eligible.',
  },
  exclude_hq: {
    type: 'string',
    pattern: '^[A-Za-z]{2}(,[A-Za-z]{2})*$',
    description: 'Comma-separated ISO 3166-1 alpha-2 headquarters country codes to exclude. Providers with unknown headquarters are kept, not excluded. A code that is not a real country code is a 400.',
  },
  include_proprietary: {
    type: 'boolean',
    default: false,
    description: 'When `true`, also consider models not confirmed open-weight. Defaults to open-weight models only.',
  },
  detail: {
    type: 'string',
    enum: ['compact', 'full'],
    default: 'compact',
    description: '`compact` returns summary rows with total counts; `full` adds explanations and per-provider detail to every returned row, which enlarges the payload by orders of magnitude.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 10,
    description: 'Maximum rows per recommendation group (1–100), or at most 25 with `detail=full`. An out-of-range value is a 400 rather than a clamp.',
  },
  pretty: {
    type: 'string',
    enum: ['1', '0', 'true', 'false'],
    default: '0',
    description: 'When `1` or `true`, indent the JSON. Every data route returns compact JSON by default and honours this flag.',
  },
};

const MEDIA_FILTERS = {
  org: { type: 'string', description: 'Exact organization slug, matched case-insensitively.' },
  provider: { type: 'string', description: 'Exact provider slug, matched case-insensitively.' },
  search: { type: 'string', description: 'Case-insensitive substring match across id, name, org and provider.' },
};

const MEDIA_SORT = {
  type: 'string',
  enum: ['id', 'org', 'provider'],
  default: 'id',
  description: 'Sort key, compared case-insensitively. An unknown key is a 400 listing the valid keys.',
};

/** Parameter docs keyed by the exact `API_ENDPOINTS[].path` they belong to. */
const COST_QUERY = {
  tokens: {
    type: 'number',
    minimum: 0,
    required: true,
    description: 'Raw token count to price (for example 1000000 for one million). Must be positive.',
  },
  mix: {
    type: 'string',
    pattern: '^\\d+(\\.\\d+)?(,\\d+(\\.\\d+)?){2}$',
    description: 'Fresh input, cached input and output percentages summing to 100. Required unless `use_case` is given; the two are mutually exclusive.',
  },
  use_case: {
    type: 'string',
    enumFrom: 'use_case',
    description: 'Take the mix from this workload preset instead of `mix`. The response marks the mix `assumed: true`.',
  },
};

export const PARAMETER_DOCS = {
  '/api/v1/': { pretty: PRETTY },
  '/api/v1/use-cases': { pretty: PRETTY },
  '/api/v1/stats': { pretty: PRETTY },
  '/api/v1/orgs': { pretty: PRETTY },
  '/api/v1/providers': {
    zdr: {
      type: 'boolean',
      description: 'When `true`, keep only providers whose metadata says `retains_prompts: false`.',
    },
    pretty: PRETTY,
  },
  '/api/v1/recommend': {
    use_case: RECOMMENDATION_COMMON.use_case,
    priority: RECOMMENDATION_COMMON.priority,
    zdr: RECOMMENDATION_COMMON.zdr,
    exclude_hq: RECOMMENDATION_COMMON.exclude_hq,
    include_proprietary: RECOMMENDATION_COMMON.include_proprietary,
    detail: RECOMMENDATION_COMMON.detail,
    limit: RECOMMENDATION_COMMON.limit,
    pretty: RECOMMENDATION_COMMON.pretty,
  },
  '/api/v1/recommend/providers': {
    use_case: RECOMMENDATION_COMMON.use_case,
    model: {
      type: 'string',
      required: true,
      description: 'Canonical model id from the catalog. Org prefixes, case and version suffixes are normalized, so `openai/gpt-5` and `gpt-5` resolve alike. An unknown id returns 404.',
    },
    priority: RECOMMENDATION_COMMON.priority,
    zdr: RECOMMENDATION_COMMON.zdr,
    exclude_hq: RECOMMENDATION_COMMON.exclude_hq,
    include_proprietary: {
      ...RECOMMENDATION_COMMON.include_proprietary,
      description: 'When `true`, also rank providers of models not confirmed open-weight. Without it a closed model ranks no providers and returns an explanatory `message`.',
    },
    detail: RECOMMENDATION_COMMON.detail,
    limit: RECOMMENDATION_COMMON.limit,
    pretty: RECOMMENDATION_COMMON.pretty,
  },
  '/api/v1/models': {
    ...TEXT_FILTERS,
    sort: TEXT_SORT,
    order: ORDER,
    limit: PAGINATION.limit,
    offset: PAGINATION.offset,
    pretty: PRETTY,
  },
  '/api/v1/models/:canonicalId/providers': {
    tokens: {
      type: 'number',
      minimum: 0,
      description: 'Positive token count. It scales the cost figure only and never changes the order; zero, negative or non-numeric values are a 400.',
    },
    mix: {
      type: 'string',
      description: 'Comma-separated input, cached-input, output percentages used to blend each offering\'s rates. Must sum to 100, validated like `/history`. When present, offerings sort by the blended rate at this mix with unpriceable offerings last; `tokens` is not required. Without it, offerings sort by `input + output`, unpriced offerings last.',
    },
    pretty: PRETTY,
  },
  '/api/v1/models/:canonicalId/history': {
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 90,
      default: 90,
      description: 'Window length in days, today inclusive. Values outside 1-90 or non-numeric return 400.',
    },
    mix: {
      type: 'string',
      pattern: '^\\d+(\\.\\d+)?(,\\d+(\\.\\d+)?){2}$',
      description: 'Three percentages (fresh input, cached input, output) summing to 100 ±0.5, blended at read time against the stored raw tariffs. Malformed mixes return 400. Defaults to the agentic mix 2.5, 97, 0.5.',
    },
    pretty: PRETTY,
  },
  '/api/v1/estimate': {
    model: {
      type: 'string',
      required: true,
      description: 'Canonical or org/model id.',
    },
    ...COST_QUERY,
    pretty: PRETTY,
  },
  '/api/v1/compare': {
    models: {
      type: 'string',
      required: true,
      description: 'Comma-separated canonical or org/model ids, at most 20 after de-duplication. Unknown ids are reported in `not_found` rather than failing the request.',
    },
    ...COST_QUERY,
    pretty: PRETTY,
  },
  '/api/v1/images': {
    ...MEDIA_FILTERS,
    sort: MEDIA_SORT,
    order: ORDER,
    limit: PAGINATION.limit,
    offset: PAGINATION.offset,
    pretty: PRETTY,
  },
  '/api/v1/images/:id': {},
  '/api/v1/videos': {
    ...MEDIA_FILTERS,
    sort: MEDIA_SORT,
    order: ORDER,
    limit: PAGINATION.limit,
    offset: PAGINATION.offset,
    pretty: PRETTY,
  },
  '/api/v1/videos/:id': {},
};

/** Path parameter docs for the templated routes. */
export const PATH_PARAMETER_DOCS = {
  canonicalId: {
    type: 'string',
    description: 'Canonical model id. Slashes (`org/model`), colons (`:batch`, `:flex`, `:priority`) and mixed case are accepted, and `%2F` percent-encoding works because the id may itself contain slashes.',
  },
  id: {
    type: 'string',
    description: 'Model id. Slashes (`org/model`) and `%2F` percent-encoding are accepted; matching is on the normalized id.',
  },
};

/**
 * Component schema name for each endpoint's 200 response body, plus a short
 * description of that body. Keyed by the exact registry path; the generator
 * falls back to a bare object for an unregistered path rather than throwing,
 * so a route added by another change still generates a valid document.
 */
export const RESPONSE_DOCS = {
  '/api/v1/': {
    schema: 'ApiIndexResponse',
    description: 'Catalog counts and the rendered endpoint directory.',
  },
  '/api/v1/use-cases': {
    schema: 'UseCasesResponse',
    description: 'The nine workload presets with their assumed mixes, benchmark and provider weights, hard requirements, quantization policy and quality floors.',
  },
  '/api/v1/stats': {
    schema: 'StatsResponse',
    description: 'Catalog, provider, organization, privacy, cache and quantization counts. Each bucket map sums to `model_count`.',
  },
  '/api/v1/orgs': {
    schema: 'OrgsResponse',
    description: 'Organizations with offering counts, sorted by count descending.',
  },
  '/api/v1/providers': {
    schema: 'ProvidersResponse',
    description: 'Provider privacy, policy, headquarters and retention metadata. A null policy value means unknown, never false.',
  },
  '/api/v1/recommend': {
    schema: 'RecommendResponse',
    description: 'Workload shortlist: three headline picks, the four candidate groups, and an Arena `preference` for chat and creative writing.',
  },
  '/api/v1/recommend/providers': {
    schema: 'RecommendProvidersResponse',
    description: 'Providers ranked for one model at the use-case mix, plus a separate unverified group and an optional explanatory `message`.',
  },
  '/api/v1/models': {
    schema: 'PaginatedModels',
    description: 'One page of text offerings with the pre-pagination match count.',
  },
  '/api/v1/models/:canonicalId/providers': {
    schema: 'ModelProvidersResponse',
    description: 'Every provider selling one canonical model, cheapest first by input plus output, or by blended cost when `tokens` and `mix` are supplied.',
  },
  '/api/v1/models/:canonicalId/history': {
    schema: 'HistoryResponse',
    description: 'At most 90 chronological daily cheapest-provider points, with every priceable offering per day in `series`. Days nothing can be priced are omitted, never zero.',
  },
  '/api/v1/estimate': {
    schema: 'EstimateResponse',
    description: 'Every offering of one canonical model with its blended rate and cost, cheapest first. Unpriceable offerings are last with null cost and a reason.',
  },
  '/api/v1/compare': {
    schema: 'CompareResponse',
    description: 'Cheapest provider, most expensive provider, spread and savings per requested model. Unknown ids are listed in `not_found`.',
  },
  '/api/v1/images': {
    schema: 'PaginatedImageModels',
    description: 'One page of image models with per-unit pricing variants.',
  },
  '/api/v1/images/:id': {
    schema: 'ImageModelResponse',
    description: 'One image model with all its pricing variants.',
  },
  '/api/v1/videos': {
    schema: 'PaginatedVideoModels',
    description: 'One page of video models with per-second pricing per resolution.',
  },
  '/api/v1/videos/:id': {
    schema: 'VideoModelResponse',
    description: 'One video model with all its pricing variants.',
  },
};
