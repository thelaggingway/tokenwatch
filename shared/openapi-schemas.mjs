// OpenAPI 3.1 component schemas and per-parameter documentation for the public
// /api/v1 contract. Kept dependency-free (ADR 0001) and separate from the
// endpoint registry so router changes and registry edits rebase cleanly.
//
// Null semantics everywhere: a null price or timestamp means "unknown", never
// zero and never free. Optional keys are omitted rather than nulled where the
// router does not emit them (e.g. `reasoning_options` is always present, while
// `context_price_tiers` is `null` when no tier applies).

/** Nullable-number helper — prices are `number | null`, never `0` for unknown. */
const nullableNumber = (description) => ({
  type: ['number', 'null'],
  ...(description ? { description } : {}),
});

const nullableInteger = (description) => ({
  type: ['integer', 'null'],
  ...(description ? { description } : {}),
});

const nullableString = (description) => ({
  type: ['string', 'null'],
  ...(description ? { description } : {}),
});

const nullableBoolean = (description) => ({
  type: ['boolean', 'null'],
  ...(description ? { description } : {}),
});

/** UTC day stamp emitted by every catalog response. */
const generatedAt = {
  type: 'string',
  format: 'date-time',
  description: 'Generation timestamp of the source catalog this response was served from.',
};

const day = {
  type: 'string',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'UTC calendar day (YYYY-MM-DD).',
};

/** `{ input, output, cache_read, cache_write, ... }` in USD per million tokens. */
export const PRICING_SCHEMA = {
  type: 'object',
  description: 'Published tariffs in USD per million tokens. A null value is unknown, not free.',
  properties: {
    input: nullableNumber('Uncached input price per million tokens.'),
    output: nullableNumber('Output (completion) price per million tokens.'),
    cache_read: nullableNumber('Cached-input read price per million tokens; null when unpublished.'),
    cache_write: nullableNumber('Cache-write price per million tokens; null when unpublished.'),
    cache_write_addon: nullableNumber('Extra cache-storage charge when the provider bills one.'),
    input_billing: {
      type: ['string', 'null'],
      enum: ['cache_write', null],
      description: 'When "cache_write", fresh input is billed at the write tariff.',
    },
  },
  required: ['input', 'output', 'cache_read', 'cache_write'],
};

export const CONTEXT_PRICE_TIER_SCHEMA = {
  type: 'object',
  description: 'Long-context tariff applying to a single request above `above_tokens`. The base `pricing` still governs the default calculator estimate.',
  properties: {
    above_tokens: { type: 'integer', minimum: 0 },
    input: nullableNumber(),
    output: nullableNumber(),
    cache_read: nullableNumber(),
    cache_write: nullableNumber(),
  },
  required: ['above_tokens', 'input', 'output', 'cache_read', 'cache_write'],
};

export const SUPPORTED_PARAMETER_VALUE_SCHEMA = {
  type: ['object', 'boolean', 'null'],
  description: 'Acceptable values for one request parameter: `{type:"boolean"}`, `{type:"enum",values:[…]}` or `{type:"range",min,max}`; `true`/`false` for plain flags.',
};

const MODELSDEV_CAPABILITIES_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'boolean' },
    tool_call: { type: 'boolean' },
    structured_output: { type: 'boolean' },
    attachment: { type: 'boolean' },
    temperature: { type: 'boolean' },
  },
};

const MODELSDEV_MODALITIES_SCHEMA = {
  type: 'object',
  properties: {
    input: { type: 'array', items: { type: 'string' } },
    output: { type: 'array', items: { type: 'string' } },
  },
};

const REASONING_OPTION_SCHEMA = {
  type: 'object',
  description: 'One reasoning control models.dev reports for the model. An empty array means none are listed.',
  properties: {
    type: { type: 'string', description: 'Control kind, e.g. `toggle` or `effort`.' },
    values: { type: 'array', items: { type: 'string' } },
  },
  required: ['type'],
};

/** models.dev sidecar block attached to a text offering. */
export const MODELSDEV_SCHEMA = {
  type: ['object', 'null'],
  description: 'models.dev enrichment for this (provider, model) pair. Null when no match was found. Enrichment fills gaps; it never overwrites a source price.',
  properties: {
    source: { type: 'string' },
    model_id: { type: 'string' },
    base_url: nullableString(),
    doc_url: nullableString(),
    confidence: { type: 'string', enum: ['high', 'medium'], description: 'Exact match (`high`) or bounded fuzzy match (`medium`).' },
    release_date: nullableString(),
    knowledge_cutoff: nullableString(),
    description: nullableString(),
    capabilities: MODELSDEV_CAPABILITIES_SCHEMA,
    modalities: MODELSDEV_MODALITIES_SCHEMA,
    open_weights: nullableBoolean(),
    license: nullableString(),
    reasoning_options: { type: 'array', items: REASONING_OPTION_SCHEMA },
    interleaved_reasoning: nullableBoolean(),
  },
};

export const MODELSDEV_MODEL_SCHEMA = {
  type: ['object', 'null'],
  description: 'Model-level models.dev fallback, used only when no provider-specific block matched.',
  properties: {
    source: { type: 'string' },
    release_date: nullableString(),
    knowledge_cutoff: nullableString(),
    description: nullableString(),
    capabilities: MODELSDEV_CAPABILITIES_SCHEMA,
    modalities: MODELSDEV_MODALITIES_SCHEMA,
    open_weights: nullableBoolean(),
    license: nullableString(),
    doc_url: nullableString(),
    reasoning_options: { type: 'array', items: REASONING_OPTION_SCHEMA },
    interleaved_reasoning: nullableBoolean(),
  },
};

export const BENCHMARKS_SCHEMA = {
  type: ['object', 'null'],
  description: 'Benchmark sidecar. Any individual score is null when that benchmark did not cover the model.',
  properties: {
    intelligence_index: nullableNumber('Composite intelligence index (0-100 scale).'),
    coding_index: nullableNumber('Coding index (0-100 scale).'),
    agentic_index: nullableNumber('Agentic index (0-100 scale).'),
    design_arena_best: nullableNumber(),
    arena_text: nullableNumber(),
    arena_text_rank: nullableInteger(),
    arena_text_rating_lower: nullableNumber(),
    arena_text_rating_upper: nullableNumber(),
    arena_text_vote_count: nullableInteger(),
    arena_text_date: nullableString(),
    arena_creative_writing: nullableNumber(),
    arena_creative_writing_rank: nullableInteger(),
    arena_creative_writing_rating_lower: nullableNumber(),
    arena_creative_writing_rating_upper: nullableNumber(),
    arena_creative_writing_vote_count: nullableInteger(),
    arena_creative_writing_date: nullableString(),
  },
};

/**
 * `/api/v1/models` row. The list route emits a subset of the detail route's
 * fields, so every property here is optional and the two share this schema.
 */
export const MODEL_SCHEMA = {
  type: 'object',
  description: 'One text-generation offering: a model sold by one provider.',
  properties: {
    id: { type: 'string', description: 'Model identifier as published by the source. May contain `/`, `:` (delivery variant) or mixed case.' },
    name: { type: 'string' },
    org: { type: 'string', description: 'Lowercase organization slug owning the model.' },
    provider: { type: 'string', description: 'Lowercase provider slug.' },
    provider_display: nullableString('Human-readable provider name.'),
    quantization: nullableString('Published quantization, e.g. `fp8`, `fp4`, `nvfp4`, `bf16`; `unknown` when unpublished.'),
    discount: { type: 'number', minimum: 0, maximum: 1, description: 'Promotional fraction off the provider list price. 0 means a structural price, not a promo.' },
    pricing: { $ref: '#/components/schemas/Pricing' },
    context_length: nullableInteger('Maximum context window in tokens.'),
    max_completion_tokens: nullableInteger('Maximum output tokens per request.'),
    max_prompt_tokens: nullableInteger('Maximum prompt tokens per request.'),
    uptime_30m: nullableNumber('Reported 30-minute uptime percentage.'),
    uptime_1d: nullableNumber('Reported 1-day uptime percentage.'),
    zdr: nullableBoolean('True when the provider is marked zero data retention.'),
    subscription: nullableBoolean('True when the offering is sold through a subscription plan.'),
    open_weights: nullableBoolean('Resolved weight availability. Null means unknown, never "closed".'),
    open_weights_source: nullableString('`override`, `modelsdev`, `org_prior`, or null when unresolved.'),
    license: nullableString('Source-cited license when reviewed, otherwise the models.dev or provider-catalog license.'),
    supported_parameters: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'Request parameters the endpoint accepts.',
    },
    supports_tool_choice: nullableBoolean('True when at least one tool_choice value is supported.'),
    supports_implicit_caching: nullableBoolean('True when the provider caches prompts implicitly.'),
    lifecycle_status: {
      type: ['string', 'null'],
      enum: ['deprecated', 'beta', 'alpha', null],
      description: 'models.dev lifecycle status. Deprecated offerings are never recommended.',
    },
    context_price_tiers: {
      type: ['array', 'null'],
      items: { $ref: '#/components/schemas/ContextPriceTier' },
      description: 'Long-context tiers, ascending by `above_tokens`; null when the base tariff applies to every context length.',
    },
    benchmarks: { $ref: '#/components/schemas/Benchmarks' },
    modelsdev: { $ref: '#/components/schemas/ModelsDev' },
    modelsdev_model: { $ref: '#/components/schemas/ModelsDevModel' },
  },
  required: ['id', 'name', 'org', 'provider', 'pricing'],
};

/** `/api/v1/models/:canonicalId/providers` row. */
export const PROVIDER_OFFERING_SCHEMA = {
  type: 'object',
  description: 'One provider selling one canonical model, with the capability and cost fields the recommender consumes.',
  properties: {
    provider: { type: 'string' },
    provider_display: nullableString(),
    quantization: nullableString(),
    discount: { type: 'number', minimum: 0, maximum: 1 },
    zdr: { type: 'boolean', description: 'Always a boolean here; false when not confirmed.' },
    subscription: { type: 'boolean' },
    context_length: nullableInteger(),
    max_completion_tokens: nullableInteger(),
    max_prompt_tokens: nullableInteger(),
    uptime_30m: nullableNumber(),
    uptime_1d: nullableNumber(),
    open_weights: nullableBoolean(),
    open_weights_source: nullableString(),
    license: nullableString(),
    supported_parameters: { type: ['array', 'null'], items: { type: 'string' } },
    supports_tool_choice: nullableBoolean(),
    supports_implicit_caching: nullableBoolean(),
    lifecycle_status: {
      type: ['string', 'null'],
      enum: ['deprecated', 'beta', 'alpha', null],
    },
    context_price_tiers: {
      type: ['array', 'null'],
      items: { $ref: '#/components/schemas/ContextPriceTier' },
    },
    pricing: { $ref: '#/components/schemas/Pricing' },
  },
  required: ['provider', 'pricing', 'zdr', 'subscription'],
};

export const HISTORY_POINT_SCHEMA = {
  type: 'object',
  description: 'Cheapest priceable offering for one UTC day at the requested mix. Days nothing can be priced are omitted, never emitted as zero.',
  properties: {
    day,
    provider: { type: 'string' },
    model_id: { type: 'string', description: 'Model id as stored in the snapshot, which can differ in case from the request.' },
    quantization: nullableString(),
    blended: { type: 'number', description: 'Blended USD per million tokens at the requested mix.' },
    input: nullableNumber(),
    output: nullableNumber(),
    cache_read: nullableNumber(),
    discount: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['day', 'provider', 'model_id', 'blended', 'input', 'output'],
};

export const HISTORY_OFFERING_SCHEMA = {
  type: 'object',
  description: 'Every priceable offering for that day, so a chart can show a provider switch without a second request.',
  properties: {
    provider: { type: 'string' },
    model_id: { type: 'string' },
    quantization: nullableString(),
    blended: { type: 'number' },
  },
  required: ['provider', 'model_id', 'blended'],
};

export const HISTORY_DAY_SCHEMA = {
  type: 'object',
  properties: {
    day,
    offerings: { type: 'array', items: { $ref: '#/components/schemas/HistoryOffering' } },
  },
  required: ['day', 'offerings'],
};

export const HISTORY_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'At most 90 chronological daily points (oldest → newest). `points[i]` is the cheapest entry of `series[i].offerings`.',
  properties: {
    canonical_id: { type: 'string', description: 'Normalized model id actually looked up, which strips the org prefix and version suffixes.' },
    days: { type: 'integer', minimum: 1, maximum: 90, description: 'Requested window length; echoed from `days` (default 90).' },
    from: { ...day, description: 'First day of the requested window (inclusive).' },
    to: { ...day, description: 'Last day of the requested window, always today in UTC.' },
    mix: {
      type: 'object',
      description: 'Mix used to blend the stored raw tariffs.',
      properties: {
        input: { type: 'number' },
        cache_read: { type: 'number' },
        output: { type: 'number' },
      },
      required: ['input', 'cache_read', 'output'],
    },
    point_count: { type: 'integer', minimum: 0, maximum: 90, description: 'Number of returned days; fewer than `days` when snapshots are missing.' },
    provider_switches: { type: 'integer', minimum: 0, description: 'Times the cheapest provider changed between consecutive points.' },
    points: { type: 'array', items: { $ref: '#/components/schemas/HistoryPoint' } },
    series: { type: 'array', items: { $ref: '#/components/schemas/HistoryDay' } },
  },
  required: ['canonical_id', 'days', 'from', 'to', 'mix', 'point_count', 'provider_switches', 'points', 'series'],
};

const MIX_SCHEMA = {
  type: 'object',
  description: 'Assumed workload mix in percent. These are documented defaults, not measurements of your traffic.',
  properties: {
    inputPct: { type: 'number', minimum: 0, maximum: 100 },
    cacheReadPct: { type: 'number', minimum: 0, maximum: 100 },
    outputPct: { type: 'number', minimum: 0, maximum: 100 },
    assumed: { type: 'boolean' },
  },
  required: ['inputPct', 'cacheReadPct', 'outputPct', 'assumed'],
};

const CONFIDENCE_SCHEMA = {
  type: 'object',
  description: 'How stable a pick is against the runner-up. `uncompared` means there was no comparable alternative.',
  properties: {
    level: { type: 'string', enum: ['stable', 'moderately_stable', 'close_call', 'uncompared'] },
    method: { type: 'string', description: '`provider_score_margin` when scores were compared.' },
    scoreMargin: nullableNumber('Gap to the runner-up score.'),
    runnerUpId: nullableString(),
    runnerUpScore: nullableNumber(),
  },
  required: ['level'],
};

const OFFERING_SUMMARY_SCHEMA = {
  type: ['object', 'null'],
  description: 'Compact offering attached to a recommendation pick.',
  properties: {
    id: { type: 'string' },
    provider: { type: 'string' },
    name: nullableString(),
    pricing: { $ref: '#/components/schemas/Pricing' },
    context_length: nullableInteger(),
    max_prompt_tokens: nullableInteger(),
    max_completion_tokens: nullableInteger(),
    quantization: nullableString(),
    zdr: { type: 'boolean' },
    subscription: { type: 'boolean' },
  },
};

export const RECOMMEND_PROVIDER_SCHEMA = {
  type: ['object', 'null'],
  description: 'A ranked provider for one model at the use case mix.',
  properties: {
    provider: { type: 'string' },
    offering: { $ref: '#/components/schemas/OfferingSummary' },
    score: nullableNumber('Composite provider score (0-100) at the priority weights.'),
    blendedRate: nullableNumber('USD per million tokens at the use case mix.'),
    ttftP50: nullableNumber('Median time to first token in seconds.'),
    throughputP50: nullableNumber('Median output tokens per second.'),
    uptime: nullableNumber('Uptime percentage used for ranking.'),
    uptimeWindow: nullableString('Window the uptime figure covers, e.g. `30m`.'),
    quantization: nullableString(),
    license: nullableString(),
    canonicalId: { type: 'string' },
    confidence: { $ref: '#/components/schemas/Confidence' },
    reasons: { type: 'array', items: { type: 'string' }, description: 'Why this provider ranked where it did.' },
    unknowns: { type: 'array', items: { type: 'string' }, description: 'Missing signals that weakened the score.' },
    explanation: { type: 'string', description: 'Present on the top three and on `detail=full` rows only.' },
  },
  required: ['provider'],
};

export const UNVERIFIED_PROVIDER_SCHEMA = {
  type: 'object',
  description: 'A provider missing required capability or context metadata. Never ranked.',
  properties: {
    provider: { type: 'string' },
    offeringId: nullableString(),
    blendedRate: nullableNumber(),
    reason: nullableString(),
  },
  required: ['provider'],
};

export const RECOMMENDATION_SCHEMA = {
  type: 'object',
  description: 'One model pick. Compact rows carry scores, rates and a single reason; `detail=full` adds explanations.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    org: { type: 'string' },
    provider: { type: 'string' },
    quantization: nullableString(),
    openWeights: nullableBoolean(),
    openWeightsSource: nullableString(),
    license: nullableString(),
    qualityScore: nullableNumber('Use-case-weighted benchmark score (0-100) after shrinking uncovered weights toward the cohort median.'),
    qualityCoverage: nullableNumber('Fraction (0-1) of the use-case benchmark weight actually covered.'),
    blendedRate: nullableNumber('Cheapest blended rate across eligible providers.'),
    recommendedBlendedRate: nullableNumber('Blended rate of the recommended provider.'),
    recommendedProvider: { $ref: '#/components/schemas/RecommendProvider' },
    cheapestProvider: { $ref: '#/components/schemas/RecommendProvider' },
    offering: { $ref: '#/components/schemas/OfferingSummary' },
    cheapestOffering: { $ref: '#/components/schemas/OfferingSummary' },
    providers: { type: 'array', items: { $ref: '#/components/schemas/RecommendProvider' } },
    unverifiedProviders: { type: 'array', items: { $ref: '#/components/schemas/UnverifiedProvider' } },
    reasons: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } },
    confidence: { $ref: '#/components/schemas/Confidence' },
    explanation: { type: 'string' },
  },
  required: ['id', 'name'],
};

export const RECOMMENDATION_ROW_SCHEMA = {
  type: 'object',
  description: 'Compact row used by the alsoConsidered / partiallyBenchmarked / unbenchmarked / unverified groups.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    score: nullableNumber(),
    coverage: nullableNumber(),
    blendedRate: nullableNumber(),
    reason: nullableString(),
  },
  required: ['id', 'name'],
};

export const GROUP_SCHEMA = {
  type: 'object',
  description: 'A candidate group. `totalCount` counts every member; `items` is capped at `limit`.',
  properties: {
    totalCount: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: { $ref: '#/components/schemas/RecommendationRow' } },
  },
  required: ['totalCount', 'items'],
};

export const PROVIDER_GROUP_SCHEMA = {
  type: 'object',
  description: 'Ranked provider group. `totalCount` counts every ranked provider; `items` is capped at `limit`, with full explanations on the top three or on every row for `detail=full`.',
  properties: {
    totalCount: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: { $ref: '#/components/schemas/RecommendProvider' } },
  },
  required: ['totalCount', 'items'],
};

export const UNVERIFIED_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    totalCount: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: { $ref: '#/components/schemas/UnverifiedProvider' } },
  },
  required: ['totalCount', 'items'],
};

const PREFERENCE_SOURCE_SCHEMA = {
  type: 'object',
  description: 'Dataset metadata for the Arena ratings. Consumers must display this attribution: it is licensed CC BY 4.0.',
  properties: {
    name: { type: 'string' },
    leaderboard: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    data_url: { type: 'string', format: 'uri' },
    rating_date: nullableString('Date the ratings were published.'),
    scale: nullableString(),
    license: { type: 'string' },
    license_url: { type: 'string', format: 'uri' },
    attribution: { type: 'string' },
  },
  required: ['name', 'leaderboard', 'license'],
};

export const PREFERENCE_SCHEMA = {
  type: ['object', 'null'],
  description: 'Arena favorite shown separately from the capability-ranked picks. Returned for `chat-assistant` and `creative-writing`; null for other use cases.',
  properties: {
    field: { type: 'string', description: 'Benchmark field the favorite comes from, e.g. `arena_text`.' },
    label: { type: 'string' },
    board: { type: 'string', description: 'Leaderboard name, e.g. `Text overall`.' },
    source: { $ref: '#/components/schemas/PreferenceSource' },
    favorite: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        rank: nullableInteger(),
        rating: nullableNumber(),
        providers: { type: 'array', items: { $ref: '#/components/schemas/RecommendationRow' } },
      },
    },
    ranking: nullableString(),
  },
};

export const RECOMMEND_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'Workload-aware shortlist. Picks are open-weight by default; `include_proprietary=true` also admits models not confirmed open-weight. Groups are compact unless `detail=full`.',
  properties: {
    generated_at: generatedAt,
    benchmarks_generated_at: nullableString('Generation timestamp of the benchmark sidecar.'),
    performance_generated_at: nullableString('Generation timestamp of the performance sidecar.'),
    useCase: { type: 'string' },
    priority: { type: 'string', enum: ['balanced', 'cheapest', 'fastest', 'most-reliable'] },
    mix: { $ref: '#/components/schemas/Mix' },
    qualityFloor: { $ref: '#/components/schemas/QualityFloor' },
    preference: { $ref: '#/components/schemas/Preference' },
    picks: {
      type: 'object',
      description: 'The three headline picks. Any of them can be null when no model clears the floor under the constraints.',
      properties: {
        bestQuality: { $ref: '#/components/schemas/Recommendation' },
        bestValue: { $ref: '#/components/schemas/Recommendation' },
        cheapestAboveFloor: { $ref: '#/components/schemas/Recommendation' },
      },
      required: ['bestQuality', 'bestValue', 'cheapestAboveFloor'],
    },
    alsoConsidered: { $ref: '#/components/schemas/Group' },
    partiallyBenchmarked: { $ref: '#/components/schemas/Group' },
    unbenchmarked: { $ref: '#/components/schemas/Group' },
    unverified: { $ref: '#/components/schemas/Group' },
  },
  required: ['generated_at', 'useCase', 'priority', 'mix', 'picks', 'alsoConsidered', 'partiallyBenchmarked', 'unbenchmarked', 'unverified'],
};

export const RECOMMEND_PROVIDERS_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'Provider ranking for one canonical model. Providers missing required metadata land in `unverified`, never in `ranked`.',
  properties: {
    generated_at: generatedAt,
    benchmarks_generated_at: nullableString(),
    performance_generated_at: nullableString(),
    useCase: { type: 'string' },
    priority: { type: 'string', enum: ['balanced', 'cheapest', 'fastest', 'most-reliable'] },
    mix: { $ref: '#/components/schemas/Mix' },
    canonical_id: { type: 'string' },
    ranked: { $ref: '#/components/schemas/ProviderGroup' },
    unverified: { $ref: '#/components/schemas/UnverifiedGroup' },
    message: nullableString('Present when no provider qualifies.'),
  },
  required: ['generated_at', 'useCase', 'priority', 'mix', 'canonical_id', 'ranked', 'unverified'],
};

export const ERROR_SCHEMA = {
  type: 'object',
  description: 'Error envelope. `error` is always a human-readable string; `code` is a stable machine-readable value; `parameter` names the rejected query parameter on validation failures.',
  properties: {
    error: { type: 'string', description: 'Human-readable message.' },
    parameter: { type: 'string', description: 'Query parameter that failed validation.' },
    code: {
      type: 'string',
      enum: ['invalid_parameter', 'model_not_found', 'not_found', 'catalog_unavailable', 'history_unavailable', 'recommendation_data_unavailable'],
      description: 'Stable machine-readable error code.',
    },
    detail: { type: 'string', description: 'Fixed configuration hint on some 503 responses. Never contains internal error text.' },
    canonical_id: { type: 'string', description: 'Looked-up id echoed on model 404 responses.' },
    id: { type: 'string', description: 'Looked-up id echoed on image/video 404 responses.' },
  },
  required: ['error', 'code'],
};

export const PAGINATED_MODELS_SCHEMA = {
  type: 'object',
  description: 'One page of text offerings. `total` counts matches before paging.',
  properties: {
    generated_at: generatedAt,
    total: { type: 'integer', minimum: 0 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
  },
  required: ['generated_at', 'total', 'offset', 'limit', 'models'],
};

export const MODEL_PROVIDERS_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'Every provider selling one canonical model, cheapest first.',
  properties: {
    canonical_id: { type: 'string' },
    model_count: { type: 'integer', minimum: 1 },
    providers: { type: 'array', items: { $ref: '#/components/schemas/ProviderOffering' } },
  },
  required: ['canonical_id', 'model_count', 'providers'],
};

export const API_INDEX_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    model_count: { type: 'integer', minimum: 0 },
    provider_count: { type: 'integer', minimum: 0, description: 'Distinct providers that actually list an offering.' },
    source_count: { type: 'integer', minimum: 0, description: 'Number of pricing sources in the catalog (larger than provider_count).' },
    endpoints: { type: 'array', items: { type: 'string' }, description: 'Rendered endpoint directory lines.' },
  },
  required: ['generated_at', 'model_count', 'provider_count', 'source_count', 'endpoints'],
};

export const STATS_RESPONSE_SCHEMA = {
  type: 'object',
  description: 'Catalog counts. Each bucket map sums to `model_count`.',
  properties: {
    generated_at: generatedAt,
    model_count: { type: 'integer', minimum: 0 },
    provider_count: { type: 'integer', minimum: 0 },
    org_count: { type: 'integer', minimum: 0 },
    zdr_count: { type: 'integer', minimum: 0 },
    subscription_count: { type: 'integer', minimum: 0 },
    cache_read_count: { type: 'integer', minimum: 0 },
    cache_write_count: { type: 'integer', minimum: 0 },
    providers: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    orgs: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    quantizations: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
    source_providers: { type: 'array', items: { type: 'string' } },
  },
  required: ['generated_at', 'model_count', 'provider_count', 'org_count', 'providers', 'orgs', 'quantizations'],
};

export const ORGS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    org_count: { type: 'integer', minimum: 0 },
    orgs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          org: { type: 'string' },
          model_count: { type: 'integer', minimum: 0 },
        },
        required: ['org', 'model_count'],
      },
    },
  },
  required: ['generated_at', 'org_count', 'orgs'],
};

export const PROVIDERS_META_SCHEMA = {
  type: 'object',
  description: 'Privacy, policy and headquarters metadata per provider. Unknown policy values stay null; unknown is not false.',
  properties: {
    privacy_policy_url: nullableString(),
    terms_of_service_url: nullableString(),
    status_page_url: nullableString(),
    headquarters: nullableString('Two-letter country code; null when unreported.'),
    datacenters: { type: ['array', 'null'], items: { type: 'string' } },
    retains_prompts: nullableBoolean('False means prompts are not retained (zero data retention).'),
    may_train: nullableBoolean(),
    retention_days: nullableInteger(),
    retention_note: nullableString(),
    pricing_note: nullableString(),
    source: nullableString('`manual` when a hand-reviewed entry outranks OpenRouter metadata.'),
    setup_env: { type: ['array', 'null'], items: { type: 'string' } },
    ai_sdk_package: nullableString(),
  },
};

export const PROVIDERS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    provider_count: { type: 'integer', minimum: 0 },
    providers_meta: { type: 'object', additionalProperties: { $ref: '#/components/schemas/ProvidersMeta' } },
  },
  required: ['generated_at', 'provider_count', 'providers_meta'],
};

export const QUALITY_FLOOR_SCHEMA = {
  type: ['object', 'null'],
  description: 'Absolute quality floor a model must clear to be ranked at all.',
  properties: {
    field: { type: 'string', description: 'Benchmark field the floor applies to, e.g. `coding_index`.' },
    min: { type: 'number' },
  },
  required: ['field', 'min'],
};

export const USE_CASES_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    use_cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          mix: { $ref: '#/components/schemas/Mix' },
          weights: {
            type: 'object',
            properties: {
              benchmark: { type: 'object', additionalProperties: { type: 'number' } },
              provider: { type: 'object', additionalProperties: { type: 'number' } },
            },
          },
          requirements: {
            type: 'object',
            properties: {
              needsToolCalling: { type: 'boolean' },
              needsStructuredOutput: { type: 'boolean' },
              minContext: { type: 'integer', minimum: 0 },
            },
          },
          quantizationPolicy: {
            type: 'object',
            properties: {
              reject: { type: 'array', items: { type: 'string' } },
              fallbackWhenNoAlternative: { type: 'boolean' },
            },
          },
          floors: { $ref: '#/components/schemas/QualityFloor' },
        },
        required: ['id', 'label', 'mix', 'weights', 'requirements', 'quantizationPolicy', 'floors'],
      },
    },
  },
  required: ['generated_at', 'use_cases'],
};

export const IMAGE_MODEL_SCHEMA = {
  type: 'object',
  description: 'One image-generation model. `pricing` is a list of per-unit variants, not a per-million-token tariff.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    org: { type: 'string' },
    provider: { type: 'string' },
    output_modalities: { type: 'array', items: { type: 'string' } },
    supported_parameters: {
      type: ['object', 'null'],
      additionalProperties: { $ref: '#/components/schemas/SupportedParameterValue' },
      description: 'Accepted request parameters keyed by name; null when the provider publishes none.',
    },
    pricing: {
      type: 'array',
      items: {
        type: 'object',
        description: 'One priced variant. `unit` distinguishes flat per-image, per-megapixel, per-request and per-token billing.',
        properties: {
          unit: { type: 'string', enum: ['image', 'megapixel', 'request', 'token'] },
          variant: nullableString('Resolution or quality label this variant applies to.'),
          cost_per_unit: { type: 'number', description: 'USD per `unit`.' },
          cost_per_million: nullableNumber('USD per million tokens for token-billed models; null for non-token units.'),
        },
        required: ['unit', 'cost_per_unit'],
      },
    },
  },
  required: ['id', 'name', 'org', 'provider', 'pricing'],
};

export const VIDEO_MODEL_SCHEMA = {
  type: 'object',
  description: 'One video-generation model with per-second prices per resolution.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    org: { type: 'string' },
    provider: { type: 'string' },
    supported_durations: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Allowed clip lengths in seconds.' },
    supported_resolutions: { type: 'array', items: { type: 'string' } },
    pricing: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          resolution: nullableString('Resolution this rate applies to; null when not resolution-dependent.'),
          audio: nullableBoolean('Whether the rate includes audio; null when the provider does not say.'),
          cost_per_second: { type: 'number', description: 'USD per second of generated video.' },
        },
        required: ['cost_per_second'],
      },
    },
  },
  required: ['id', 'name', 'org', 'provider', 'pricing'],
};

export const PAGINATED_IMAGE_MODELS_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    total: { type: 'integer', minimum: 0 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    models: { type: 'array', items: { $ref: '#/components/schemas/ImageModel' } },
  },
  required: ['generated_at', 'total', 'offset', 'limit', 'models'],
};

export const PAGINATED_VIDEO_MODELS_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    total: { type: 'integer', minimum: 0 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    models: { type: 'array', items: { $ref: '#/components/schemas/VideoModel' } },
  },
  required: ['generated_at', 'total', 'offset', 'limit', 'models'],
};

export const IMAGE_MODEL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    model: { $ref: '#/components/schemas/ImageModel' },
  },
  required: ['generated_at', 'model'],
};

export const VIDEO_MODEL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    generated_at: generatedAt,
    model: { $ref: '#/components/schemas/VideoModel' },
  },
  required: ['generated_at', 'model'],
};

/** Every component schema, keyed by the name `$ref` uses. */
export const COMPONENT_SCHEMAS = {
  Pricing: PRICING_SCHEMA,
  ContextPriceTier: CONTEXT_PRICE_TIER_SCHEMA,
  SupportedParameterValue: SUPPORTED_PARAMETER_VALUE_SCHEMA,
  ModelsDev: MODELSDEV_SCHEMA,
  ModelsDevModel: MODELSDEV_MODEL_SCHEMA,
  Benchmarks: BENCHMARKS_SCHEMA,
  Model: MODEL_SCHEMA,
  ProviderOffering: PROVIDER_OFFERING_SCHEMA,
  HistoryPoint: HISTORY_POINT_SCHEMA,
  HistoryOffering: HISTORY_OFFERING_SCHEMA,
  HistoryDay: HISTORY_DAY_SCHEMA,
  HistoryResponse: HISTORY_RESPONSE_SCHEMA,
  Mix: MIX_SCHEMA,
  Confidence: CONFIDENCE_SCHEMA,
  QualityFloor: QUALITY_FLOOR_SCHEMA,
  OfferingSummary: OFFERING_SUMMARY_SCHEMA,
  RecommendProvider: RECOMMEND_PROVIDER_SCHEMA,
  UnverifiedProvider: UNVERIFIED_PROVIDER_SCHEMA,
  Recommendation: RECOMMENDATION_SCHEMA,
  RecommendationRow: RECOMMENDATION_ROW_SCHEMA,
  Group: GROUP_SCHEMA,
  ProviderGroup: PROVIDER_GROUP_SCHEMA,
  UnverifiedGroup: UNVERIFIED_GROUP_SCHEMA,
  PreferenceSource: PREFERENCE_SOURCE_SCHEMA,
  Preference: PREFERENCE_SCHEMA,
  RecommendResponse: RECOMMEND_RESPONSE_SCHEMA,
  RecommendProvidersResponse: RECOMMEND_PROVIDERS_RESPONSE_SCHEMA,
  Error: ERROR_SCHEMA,
  PaginatedModels: PAGINATED_MODELS_SCHEMA,
  ModelProvidersResponse: MODEL_PROVIDERS_RESPONSE_SCHEMA,
  ApiIndexResponse: API_INDEX_RESPONSE_SCHEMA,
  StatsResponse: STATS_RESPONSE_SCHEMA,
  OrgsResponse: ORGS_RESPONSE_SCHEMA,
  ProvidersMeta: PROVIDERS_META_SCHEMA,
  ProvidersResponse: PROVIDERS_RESPONSE_SCHEMA,
  UseCasesResponse: USE_CASES_RESPONSE_SCHEMA,
  ImageModel: IMAGE_MODEL_SCHEMA,
  VideoModel: VIDEO_MODEL_SCHEMA,
  PaginatedImageModels: PAGINATED_IMAGE_MODELS_SCHEMA,
  PaginatedVideoModels: PAGINATED_VIDEO_MODELS_SCHEMA,
  ImageModelResponse: IMAGE_MODEL_RESPONSE_SCHEMA,
  VideoModelResponse: VIDEO_MODEL_RESPONSE_SCHEMA,
};
