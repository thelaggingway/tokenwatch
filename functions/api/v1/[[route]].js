// Cloudflare Pages Functions — catch-all API route
// Serves pricing data with query filtering and sorting.
//
// Endpoints:
//   GET /api/v1/                              — API info + endpoint directory
//   GET /api/v1/stats                         — summary statistics (text models)
//   GET /api/v1/orgs                           — all orgs with model counts
//   GET /api/v1/providers[?zdr=true]          — provider metadata
//   GET /api/v1/use-cases                     — workload recommendation presets
//   GET /api/v1/recommend                     — workload-aware model shortlist
//   GET /api/v1/recommend/providers            — provider ranking for a model
//   GET /api/v1/models                         — list text models (with filters)
//   GET /api/v1/models/:canonicalId/providers  — all providers for a model, sorted by cost
//   GET /api/v1/models/:canonicalId/history    — daily cheapest-provider price history
//   GET /api/v1/images                         — list image models
//   GET /api/v1/images/:id                     — single image model with pricing variants
//   GET /api/v1/videos                         — list video models
//   GET /api/v1/videos/:id                     — single video model with pricing variants
//   OPTIONS *                                  — CORS preflight

import { canonicalId } from '../../../shared/normalize.mjs';
import { endpointDirectory } from '../../../shared/api-meta.mjs';
import { blendedRate } from '../../../shared/cost.mjs';
import { PRIORITY_PROVIDER_WEIGHTS, USE_CASES } from '../../../shared/use-cases.mjs';
import { isOpenWeightModel, rankProviders, shortlistModels } from '../../../shared/recommend.mjs';
import {
  MAX_HISTORY_DAYS,
  buildHistorySeries,
  capHistoryDays,
  parseDaysParam,
  parseMixParam,
  utcDay,
  windowStartDay,
} from '../../../shared/price-history.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

// Data responses are cacheable for a short window: the underlying catalogs
// refresh every two hours, so 5 minutes keeps a shared cache useful without
// serving a stale price beyond one refresh cycle.
const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
};

function json(data, status = 200, { pretty = false } = {}) {
  const body = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const headers = { ...CORS_HEADERS, ...(status === 200 ? CACHE_HEADERS : { 'Cache-Control': 'no-store' }) };
  return new Response(body, { status, headers });
}

/**
 * Every error body carries a stable `code` so clients can branch without
 * matching prose. `error` stays a string: the WebMCP tools and the embed
 * widget read it directly.
 */
function errorJson(code, message, status, extra = {}) {
  return json({ error: message, code, ...extra }, status);
}

function invalidParameter(parameter, message) {
  return errorJson('invalid_parameter', message, 400, { parameter });
}

/** ISO-3166-1 alpha-2 codes, for validating exclude_hq without a dependency. */
const ISO_3166_ALPHA2 = new Set(`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT
MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG
UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/).filter(Boolean));

const PRIORITIES = new Set(Object.keys(PRIORITY_PROVIDER_WEIGHTS));

function parseOptionalBoolean(params, name) {
  if (!params.has(name)) return { ok: true, value: false };
  const value = params.get(name);
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return { ok: false, error: `${name} must be true or false` };
}

function parseRecommendationParams(params, { requireModel = false } = {}) {
  const useCase = params.get('use_case');
  if (!useCase || !Object.hasOwn(USE_CASES, useCase)) {
    return { ok: false, error: useCase ? `Unknown use_case: ${useCase}` : 'use_case is required', parameter: 'use_case' };
  }

  const priority = params.get('priority') ?? 'balanced';
  if (!PRIORITIES.has(priority)) {
    return { ok: false, error: `priority must be one of: ${[...PRIORITIES].join(', ')}`, parameter: 'priority' };
  }

  const detail = params.get('detail') ?? 'compact';
  if (detail !== 'compact' && detail !== 'full') {
    return { ok: false, error: 'detail must be compact or full', parameter: 'detail' };
  }

  let pretty = false;
  if (params.has('pretty')) {
    const value = params.get('pretty');
    if (value === '1' || value === 'true') pretty = true;
    else if (value !== '0' && value !== 'false') {
      return { ok: false, error: 'pretty must be 1, 0, true, or false', parameter: 'pretty' };
    }
  }

  let limit = 10;
  if (params.has('limit')) {
    const value = params.get('limit');
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 100) {
      return { ok: false, error: 'limit must be an integer between 1 and 100', parameter: 'limit' };
    }
    limit = Number(value);
  }

  // `detail=full` returns each candidate with every explanation and prepared
  // offering. At limit=100 that is roughly 4 MB of JSON, so the combination is
  // capped instead of letting one request serialize the whole corpus.
  const MAX_FULL_DETAIL_LIMIT = 25;
  if (detail === 'full' && limit > MAX_FULL_DETAIL_LIMIT) {
    return {
      ok: false,
      error: `limit must be ${MAX_FULL_DETAIL_LIMIT} or less when detail=full; use detail=compact for larger pages`,
      parameter: 'limit',
    };
  }

  const zdr = parseOptionalBoolean(params, 'zdr');
  if (!zdr.ok) return { ...zdr, parameter: 'zdr' };
  const includeProprietary = parseOptionalBoolean(params, 'include_proprietary');
  if (!includeProprietary.ok) return { ...includeProprietary, parameter: 'include_proprietary' };

  let excludeHQ = [];
  if (params.has('exclude_hq')) {
    const value = params.get('exclude_hq');
    if (!value || !/^[a-z]{2}(?:,[a-z]{2})*$/i.test(value)) {
      return { ok: false, error: 'exclude_hq must be a comma-separated list of two-letter country codes', parameter: 'exclude_hq' };
    }
    const codes = [...new Set(value.split(',').map((country) => country.toUpperCase()))];
    const unknown = codes.filter((code) => !ISO_3166_ALPHA2.has(code));
    if (unknown.length) {
      return { ok: false, error: `exclude_hq has unknown country codes: ${unknown.join(', ')}`, parameter: 'exclude_hq' };
    }
    excludeHQ = codes;
  }

  let model = null;
  if (requireModel) {
    model = params.get('model')?.trim() || null;
    if (!model) return { ok: false, error: 'model is required', parameter: 'model' };
  }

  return {
    ok: true,
    useCase,
    priority,
    detail,
    pretty,
    limit,
    requireZdr: zdr.value,
    includeProprietary: includeProprietary.value,
    excludeHQ,
    model,
  };
}

async function loadRecommendationAssets(context) {
  const { request, env } = context;
  const load = async (filename) => {
    const response = await env.ASSETS.fetch(new URL(`/${filename}`, request.url));
    if (!response.ok) throw new Error(`${filename} not found: ${response.status}`);
    return response.json();
  };
  try {
    const [benchmarks, performance] = await Promise.all([
      load('benchmarks.json'),
      load('performance.json'),
    ]);
    return { ok: true, benchmarks, performance };
  } catch (error) {
    console.error('Failed to load recommendation assets:', error?.message || error);
    return { ok: false, response: errorJson('recommendation_data_unavailable', 'Failed to load recommendation data', 503) };
  }
}

function compactRecommendationOffering(offering) {
  if (!offering) return null;
  return {
    id: offering.id,
    provider: offering.provider,
    name: offering.name ?? null,
    pricing: offering.pricing ?? null,
    context_length: offering.context_length ?? null,
    max_prompt_tokens: offering.max_prompt_tokens ?? null,
    max_completion_tokens: offering.max_completion_tokens ?? null,
    quantization: offering.quantization ?? null,
    zdr: offering.zdr === true,
    subscription: offering.subscription === true,
  };
}

function compactRecommendationProvider(provider, includeExplanation = true) {
  if (!provider) return null;
  const { explanation, ...summary } = provider;
  return {
    ...summary,
    ...(includeExplanation && explanation ? { explanation } : {}),
    offering: compactRecommendationOffering(provider.offering),
  };
}

function compactRecommendationCandidate(candidate, includeProviderExplanations = true) {
  return {
    ...candidate,
    recommendedProvider: compactRecommendationProvider(candidate.recommendedProvider, includeProviderExplanations),
    cheapestProvider: compactRecommendationProvider(candidate.cheapestProvider, includeProviderExplanations),
    offering: compactRecommendationOffering(candidate.offering),
    cheapestOffering: compactRecommendationOffering(candidate.cheapestOffering),
    unverifiedProviders: (candidate.unverifiedProviders || []).map((provider) =>
      includeProviderExplanations ? compactRecommendationProvider(provider, true) : compactUnverifiedProviderRow(provider)),
    ...(Array.isArray(candidate.providers)
      ? { providers: includeProviderExplanations ? candidate.providers : candidate.providers.map(compactProviderRow) }
      : {}),
  };
}

function compactRecommendationPreference(preference) {
  if (!preference) return null;
  const favorite = preference.favorite;
  return {
    field: preference.field,
    label: preference.label,
    board: preference.board,
    source: preference.source,
    favorite: favorite ? {
      id: favorite.id,
      name: favorite.name,
      rank: favorite.rank,
      rating: favorite.rating,
      providers: (favorite.providers || []).map(compactProviderRow),
    } : null,
    ranking: preference.ranking,
  };
}

function compactRecommendationRow(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    score: candidate.qualityScore ?? null,
    coverage: candidate.qualityCoverage ?? null,
    blendedRate: candidate.blendedRate ?? null,
    reason: candidate.reasons?.[0] ?? candidate.unknowns?.[0] ?? null,
  };
}

function compactProviderRow(provider) {
  const reason = provider.reasons?.find((item) => /lowest blended price|lowest .*ttft|highest throughput|reported uptime|only qualifying option|subscription plan|low-bit quantization/i.test(item));
  return {
    provider: provider.provider,
    name: provider.offering?.provider_display || provider.provider,
    score: provider.score ?? null,
    blendedRate: provider.blendedRate ?? null,
    confidence: provider.confidence?.level ?? null,
    reason: reason ?? provider.reasons?.[0] ?? provider.unknowns?.[0] ?? null,
  };
}

function compactUnverifiedProviderRow(provider) {
  return {
    provider: provider.provider,
    offeringId: provider.offering?.id ?? null,
    blendedRate: provider.blendedRate ?? null,
    reason: provider.unknowns?.[0] ?? provider.reasons?.[0] ?? null,
  };
}

function recommendationGroup(items, parsed, compactRow) {
  return {
    totalCount: items.length,
    items: items.slice(0, parsed.limit).map((item) => parsed.detail === 'full' ? item : compactRow(item)),
  };
}

function providerGroup(items, parsed, { explainTopThree = false } = {}) {
  return {
    totalCount: items.length,
    items: items.slice(0, parsed.limit).map((item, index) =>
      parsed.detail === 'full' || (explainTopThree && index < 3) ? item : compactProviderRow(item)),
  };
}

function recommendationConstraints(parsed, pricing) {
  return {
    priority: parsed.priority,
    requireZdr: parsed.requireZdr,
    excludeHQ: parsed.excludeHQ,
    providersMeta: pricing.providers_meta || {},
  };
}

// ── Canonical ID normalization ────────────────────────────────────────────────
// canonicalId is imported from shared/normalize.mjs — the same source of truth
// the Node pipeline uses. This replaces the former local normalizeId, which had
// a greedy -preview-.*$ catch-all that over-stripped -preview-customtools and
// caused distinct models (e.g. gemini-3.1-pro vs gemini-3.1-pro-preview-customtools)
// to collide in /models/:id/providers.

// ── Pagination helper ─────────────────────────────────────────────────────────

/**
 * Sort key for the default (non-mix) provider ordering: published input+output
 * $/M. An offering with no published price is unpriceable, not free, so it
 * compares as Infinity and sorts last.
 */
function listCost(model) {
  const { input, output } = model.pricing || {};
  if (input == null && output == null) return Infinity;
  return (input ?? 0) + (output ?? 0);
}

// ── Asset cache ───────────────────────────────────────────────────────────────

/**
 * Parsed-asset cache held in module scope for the isolate, keyed by filename.
 *
 * The catalogs only change when a deploy replaces them, and re-parsing
 * pricing.json (4.4 MB, ~20 ms CPU plus the asset read) on every request
 * dominated the handler. Each entry records the asset's ETag; when the asset
 * still carries that ETag the parsed body is reused, so a refreshed catalog is
 * always picked up by the next request rather than served stale.
 */
const assetCache = new Map();

async function loadAssetJson(context, filename) {
  const { request, env } = context;
  const cached = assetCache.get(filename);
  const response = await env.ASSETS.fetch(new URL(`/${filename}`, request.url));
  if (!response.ok) throw new Error(`${filename} not found: ${response.status}`);

  // Reuse only on a matching ETag: without one there is no cheap way to prove
  // the asset is unchanged, so the body is parsed again.
  const etag = response.headers.get('ETag');
  if (cached && etag && cached.etag === etag) return cached.data;

  const data = await response.json();
  assetCache.set(filename, { etag, generatedAt: data?.generated_at ?? null, data });
  return data;
}

/**
 * Resolve one image/video model by id.
 *
 * canonicalId strips the org prefix and recognized preview/date suffixes, so
 * distinct media rows (e.g. `google/gemini-3-pro-image` vs the vendored
 * `…-image-preview`) can share a canonical id. Prefer the exact id the caller
 * named and fall back to the canonical match, so a single-record route never
 * answers with a different model than the one requested.
 */
function findMediaModel(models, requestedId, canonicalTarget) {
  const exact = String(requestedId).toLowerCase();
  return models.find((m) => String(m.id).toLowerCase() === exact)
    ?? models.find((m) => canonicalId(String(m.id)) === canonicalTarget);
}

const MAX_PAGE_LIMIT = 500;

/**
 * Parse `limit`/`offset` for a list route.
 *
 * Rejects anything that is not a plain non-negative integer rather than
 * truncating it: `1.5`, `1e3` and `abc` used to become 1, which silently
 * returned the wrong page. `limit` above the documented cap still clamps to
 * MAX_PAGE_LIMIT and the response reports the applied value.
 */
function paginationFor(params, total) {
  let limit = 100;
  if (params.has('limit')) {
    const raw = params.get('limit');
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      return { ok: false, response: invalidParameter('limit', 'limit must be a positive integer') };
    }
    limit = Math.min(Number(raw), MAX_PAGE_LIMIT);
  }

  let offset = 0;
  if (params.has('offset')) {
    const raw = params.get('offset');
    if (!/^\d+$/.test(raw)) {
      return { ok: false, response: invalidParameter('offset', 'offset must be a non-negative integer') };
    }
    offset = Number(raw);
  }

  return { ok: true, total, offset, limit, paged: null };
}

/** Split a validated page out of the array. */
function pageOf(items, page) {
  return { ...page, paged: items.slice(page.offset, page.offset + page.limit) };
}

/** `order=asc|desc`, case-insensitive. `desc` reverses the comparator. */
function parseOrder(params) {
  if (!params.has('order')) return { ok: true, order: 1 };
  const raw = String(params.get('order')).toLowerCase();
  if (raw === 'asc') return { ok: true, order: 1 };
  if (raw === 'desc') return { ok: true, order: -1 };
  return { ok: false, response: invalidParameter('order', 'order must be asc or desc') };
}

/** A documented sort key, or a 400 naming it. */
function parseSort(params, validSorts, fallback = 'id') {
  if (!params.has('sort')) return { ok: true, sort: fallback };
  const raw = params.get('sort');
  if (!validSorts.includes(raw)) {
    return {
      ok: false,
      response: invalidParameter('sort', `sort must be one of: ${validSorts.join(', ')}`),
    };
  }
  return { ok: true, sort: raw };
}

// ── Price history ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/models/:canonicalId/history?days=90&mix=2.5,97,0.5
 *
 * Reads raw USD-per-million snapshot rows and blends them at read time, so the
 * stored history is independent of any visitor's token mix.
 *
 * Contract:
 *   - `mix` defaults to the agentic mix (2.5/97/0.5) and is validated; a mix
 *     that does not sum to 100, or a `days` outside [1, 90], is a 400.
 *   - Each returned point is the cheapest offering that day for the requested
 *     mix. A day where nothing can be priced is absent — never $0.
 *   - `series` carries every offering for the day so a chart can show a
 *     provider switch without a second request.
 *   - At most 90 points, chronologically ascending (oldest → newest).
 *   - `cache_read: null` falls back to the offering's INPUT price (the same
 *     semantics as /providers and the calculator) rather than disqualifying it.
 */
async function historyResponse(context, pricing, rawId) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;

  if (!rawId) return errorJson('not_found', 'Not found', 404); // "models/history"

  let requestedId;
  try {
    requestedId = decodeURIComponent(rawId);
  } catch {
    return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
  }

  const mixParam = parseMixParam(params.get('mix'));
  if (!mixParam.ok) return json({ error: mixParam.error, parameter: 'mix' }, 400);
  const daysParam = parseDaysParam(params.get('days'));
  if (!daysParam.ok) return json({ error: daysParam.error, parameter: 'days' }, 400);
  const mix = mixParam.mix;
  const days = daysParam.days;

  const target = canonicalId(requestedId);
  const known = pricing.models.some((m) => canonicalId(m.id) === target);
  if (!known) {
    return errorJson('model_not_found', 'Model not found', 404, { canonical_id: requestedId });
  }

  const db = env?.PRICE_HISTORY;
  if (!db) {
    // Local dev without the D1 binding, or a deployment missing it. Fail
    // loudly with a 503 rather than pretending the model has no history.
    return json({
      error: 'Price history is not configured',
      detail: 'The PRICE_HISTORY D1 binding is unavailable in this environment',
    }, 503);
  }

  const today = utcDay(new Date());
  const startDay = windowStartDay(today, days);

  // Legacy snapshots stored both HY4 releases under `hy4`; model_id retains
  // the original release identity, so reads need no production backfill.
  const splitHy4 = target === 'hy4' || target === 'hy4-preview';
  const modelPredicate = splitHy4 ? 'canonical_model IN (?, ?)' : 'canonical_model = ?';
  const bindings = splitHy4 ? ['hy4', 'hy4-preview', startDay, today] : [target, startDay, today];

  let rows;
  try {
    const result = await db
      .prepare(
        `SELECT utc_day, offering_key, provider, model_id, quantization,
                input_price, output_price, cache_read, cache_write, input_billing, discount
           FROM price_snapshot
          WHERE ${modelPredicate} AND utc_day >= ? AND utc_day <= ?
          ORDER BY utc_day ASC`,
      )
      .bind(...bindings)
      .all();
    rows = result?.results ?? [];
    if (splitHy4) rows = rows.filter((row) => canonicalId(row.model_id) === target);
  } catch (err) {
    console.error('Failed to read price history:', err?.message || err);
    return errorJson('history_unavailable', 'Failed to read price history', 503);
  }

  const allDays = buildHistorySeries(rows, mix);
  const points = capHistoryDays(allDays, MAX_HISTORY_DAYS);
  const providerChanges = points.reduce(
    (count, entry, index) => count + (index > 0 && entry.point.provider !== points[index - 1].point.provider ? 1 : 0),
    0,
  );

  return json({
    canonical_id: target,
    days,
    mix: { input: mix.inputPct, cache_read: mix.cacheReadPct, output: mix.outputPct },
    from: startDay,
    to: today,
    point_count: points.length,
    provider_switches: providerChanges,
    points: points.map((entry) => entry.point),
    series: points.map((entry) => ({ day: entry.day, offerings: entry.series })),
  });
}

// ── Main router ───────────────────────────────────────────────────────────────

function useCasesResponse(pricing) {
  const use_cases = Object.values(USE_CASES).map((useCase) => ({
    id: useCase.id,
    label: useCase.label,
    mix: { ...useCase.mix, assumed: true },
    weights: {
      benchmark: { ...useCase.benchmarkWeights },
      provider: { ...useCase.providerWeights },
    },
    requirements: { ...useCase.hardRequirements },
    quantizationPolicy: { ...useCase.quantizationPolicy, reject: [...useCase.quantizationPolicy.reject] },
    floors: { ...useCase.qualityFloor },
  }));
  return json({ generated_at: pricing.generated_at, use_cases });
}

async function recommendationResponse(context, pricing, providersOnly) {
  const { request } = context;
  const params = new URL(request.url).searchParams;
  const parsed = parseRecommendationParams(params, { requireModel: providersOnly });
  if (!parsed.ok) return invalidParameter(parsed.parameter, parsed.error);

  const target = providersOnly ? canonicalId(parsed.model) : null;
  if (target && !pricing.models.some((model) => canonicalId(String(model.id)) === target)) {
    return errorJson('model_not_found', 'Model not found', 404, { canonical_id: parsed.model });
  }

  const assets = await loadRecommendationAssets(context);
  if (!assets.ok) return assets.response;

  const constraints = recommendationConstraints(parsed, pricing);
  const timestamps = {
    generated_at: pricing.generated_at,
    benchmarks_generated_at: assets.benchmarks.generated_at ?? null,
    performance_generated_at: assets.performance._meta?.generated_at ?? null,
  };

  if (providersOnly) {
    const offerings = pricing.models.filter((model) =>
      canonicalId(String(model.id)) === target
      && (parsed.includeProprietary || isOpenWeightModel(model)));
    const result = rankProviders(parsed.useCase, target, offerings, assets.performance, constraints);
    return json({
      ...timestamps,
      useCase: parsed.useCase,
      priority: parsed.priority,
      mix: { ...USE_CASES[parsed.useCase].mix, assumed: true },
      canonical_id: target,
      ranked: providerGroup(result.ranked, parsed, { explainTopThree: true }),
      unverified: {
        totalCount: result.unverified.length,
        items: result.unverified.slice(0, parsed.limit).map((item) => parsed.detail === 'full' ? item : compactUnverifiedProviderRow(item)),
      },
      message: result.message,
    }, 200, { pretty: parsed.pretty });
  }

  const result = shortlistModels(parsed.useCase, pricing.models, {
    benchmarks: assets.benchmarks,
    performance: assets.performance,
    includeProprietary: parsed.includeProprietary,
    constraints,
  });
  const selectedIds = new Set([
    result.bestQuality?.id,
    result.bestValue?.id,
    result.cheapestAboveFloor?.id,
  ].filter(Boolean));
  const alsoConsideredById = new Map();
  for (const candidate of [...result.paretoFrontier, ...result.qualityRanking]) {
    if (!selectedIds.has(candidate.id)) alsoConsideredById.set(candidate.id, candidate);
  }

  return json({
    ...timestamps,
    useCase: result.useCase,
    priority: result.priority,
    mix: { ...USE_CASES[result.useCase].mix, assumed: true },
    qualityFloor: result.qualityFloor,
    preference: compactRecommendationPreference(result.preference),
    picks: {
      bestQuality: result.bestQuality ? compactRecommendationCandidate(result.bestQuality, parsed.detail === 'full') : null,
      bestValue: result.bestValue ? compactRecommendationCandidate(result.bestValue, parsed.detail === 'full') : null,
      cheapestAboveFloor: result.cheapestAboveFloor ? compactRecommendationCandidate(result.cheapestAboveFloor, parsed.detail === 'full') : null,
    },
    alsoConsidered: recommendationGroup([...alsoConsideredById.values()], parsed, compactRecommendationRow),
    partiallyBenchmarked: recommendationGroup(result.partiallyBenchmarked, parsed, compactRecommendationRow),
    unbenchmarked: recommendationGroup(result.unbenchmarked, parsed, compactRecommendationRow),
    unverified: recommendationGroup(result.unverified, parsed, compactRecommendationRow),
  }, 200, { pretty: parsed.pretty });
}

/**
 * Strong ETag over the exact response bytes, so a conditional request can be
 * answered with 304 and no body. FNV-1a is used because Workers' SubtleCrypto
 * digest is async and this runs on every response.
 */
function strongETag(body) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `"${(hash >>> 0).toString(16)}-${body.length.toString(16)}"`;
}

async function withETag(context, response) {
  if (response.status !== 200 || context.request.method === 'HEAD') return response;
  let body = await response.text();
  // `pretty=1` is opt-in on every data route. The handlers build compact JSON
  // by default, so re-format here rather than threading the flag through each
  // route's json() call.
  if (new URL(context.request.url).searchParams.get('pretty') === '1'
    || new URL(context.request.url).searchParams.get('pretty') === 'true') {
    body = `${JSON.stringify(JSON.parse(body), null, 2)}`;
  }
  const etag = strongETag(body);
  const headers = new Headers(response.headers);
  headers.set('ETag', etag);
  if (context.request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

async function handleGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v1/, '').replace(/^\//, '');
  const params = url.searchParams;

  // Pricing is loaded lazily: /images and /videos never touch it, so they must
  // not pay to read and parse a 4.4 MB catalog they do not use.
  const pricingOrError = async () => {
    try {
      const pricing = await loadAssetJson(context, 'pricing.json');
      // A truncated or replaced catalog must not surface as an uncaught
      // TypeError from every route that iterates pricing.models.
      if (!pricing || !Array.isArray(pricing.models)) throw new Error('pricing.json is missing its models array');
      return { pricing };
    } catch (err) {
      console.error('Failed to load pricing data:', err?.message || err);
      return { response: errorJson('catalog_unavailable', 'Failed to load pricing data', 503) };
    }
  };

  // ── Route: /api/v1/ (empty path) → API info ──
  if (!path || path === '') {
    const { pricing, response } = await pricingOrError();
    if (response) return response;
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: [...new Set(pricing.models.map(m => m.provider))].length,
      source_count: pricing.providers.length,
      endpoints: endpointDirectory(),
    });
  }

  // ── Route: /api/v1/stats ──
  if (path === 'stats') {
    const { pricing, response } = await pricingOrError();
    if (response) return response;
    const providers = {};
    const orgs = {};
    const quantizations = {};
    let zdrCount = 0, subCount = 0;
    let cacheReadCount = 0, cacheWriteCount = 0;
    for (const m of pricing.models) {
      providers[m.provider] = (providers[m.provider] || 0) + 1;
      orgs[m.org] = (orgs[m.org] || 0) + 1;
      if (m.zdr) zdrCount++;
      if (m.subscription) subCount++;
      if (m.pricing?.cache_read != null) cacheReadCount++;
      if (m.pricing?.cache_write != null) cacheWriteCount++;
      const q = m.quantization || 'unknown';
      quantizations[q] = (quantizations[q] || 0) + 1;
    }
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: Object.keys(providers).length,
      org_count: Object.keys(orgs).length,
      zdr_count: zdrCount,
      subscription_count: subCount,
      cache_read_count: cacheReadCount,
      cache_write_count: cacheWriteCount,
      providers,
      orgs,
      quantizations,
      source_providers: pricing.providers,
    });
  }

  // ── Route: /api/v1/orgs ──
  if (path === 'orgs') {
    const { pricing, response } = await pricingOrError();
    if (response) return response;
    const orgs = {};
    for (const m of pricing.models) {
      orgs[m.org] = (orgs[m.org] || 0) + 1;
    }
    const sorted = Object.entries(orgs)
      .sort(([, a], [, b]) => b - a)
      .map(([org, count]) => ({ org, model_count: count }));
    return json({
      generated_at: pricing.generated_at,
      org_count: sorted.length,
      orgs: sorted,
    });
  }

  // ── Route: /api/v1/providers[?zdr=true] ──
  if (path === 'providers') {
    const { pricing, response } = await pricingOrError();
    if (response) return response;
    let meta = pricing.providers_meta || {};
    const zdrParam = parseOptionalBoolean(params, 'zdr');
    if (!zdrParam.ok) return invalidParameter('zdr', zdrParam.error);
    if (zdrParam.value) {
      const filtered = {};
      for (const [key, val] of Object.entries(meta)) {
        if (val.retains_prompts === false) filtered[key] = val;
      }
      meta = filtered;
    }
    return json({
      generated_at: pricing.generated_at,
      provider_count: Object.keys(meta).length,
      providers_meta: meta,
    });
  }

  // ── Workload-aware model and provider recommendations ──
  if (path === 'use-cases' || path === 'recommend' || path === 'recommend/providers') {
    const { pricing, response } = await pricingOrError();
    if (response) return response;
    if (path === 'use-cases') return useCasesResponse(pricing);
    return recommendationResponse(context, pricing, path === 'recommend/providers');
  }

  // ── Route: /api/v1/models[/:canonicalId/providers|/:canonicalId/history] ──
  if (path === 'models' || path.startsWith('models/')) {
    const { pricing, response } = await pricingOrError();
    if (response) return response;
    // 'models' → '' (list); 'models/<rest>' → '<rest>'
    const subPath = path === 'models' ? '' : path.replace(/^models\//, '');

    // /api/v1/models/:canonicalId/history — daily raw snapshots, blended at read
    // time with the requested visitor mix. Registered before the providers
    // branch so `models/<id>/history` is never mistaken for an unknown shape.
    if (subPath !== '' && subPath.endsWith('/history')) {
      return historyResponse(context, pricing, subPath.slice(0, -'/history'.length));
    }

    // /api/v1/models/:canonicalId/providers — id may itself contain slashes (org/model).
    // Only a non-empty suffix ending exactly in `/providers` is the detail route;
    // anything else (models/foo, models/foo/bar, models/providers) is NOT a valid
    // shape and must 404 rather than fall through to the list handler.
    if (subPath !== '' && subPath.endsWith('/providers')) {
      const rawId = subPath.slice(0, -'/providers'.length);
      if (!rawId) return errorJson('not_found', 'Not found', 404); // "models/providers" (empty id)
      let requestedId;
      try {
        requestedId = decodeURIComponent(rawId);
      } catch {
        return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
      }
      const target = canonicalId(requestedId);
      const matches = pricing.models.filter(m => canonicalId(m.id) === target);

      if (matches.length === 0) {
        return errorJson('model_not_found', 'Model not found', 404, { canonical_id: requestedId });
      }

      // Sort by cost — use mix-aware cost if params provided, else input+output
      // `mix` alone is enough to sort by blended rate — public/app.js tells
      // agents to call providers?mix=… without tokens. `tokens` only scales the
      // figure; it never changes the order.
      const mixParam = parseMixParam(params.get('mix'));
      if (!mixParam.ok) return invalidParameter('mix', mixParam.error);
      let reqTokens = null;
      if (params.has('tokens')) {
        const raw = params.get('tokens');
        const value = Number(raw);
        if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value <= 0) {
          return invalidParameter('tokens', 'tokens must be a positive number');
        }
        reqTokens = value;
      }

      let sorted;
      if (params.has('mix')) {
        const { inputPct, cacheReadPct, outputPct } = mixParam.mix;
        const costFn = (m) => {
          const rate = blendedRate(m.pricing, { inputPct, cacheReadPct, outputPct });
          return rate == null ? Infinity : rate;
        };
        sorted = matches.sort((a, b) => costFn(a) - costFn(b));
      } else {
        // Unknown is not free: an offering with no published price must rank
        // after every priced one instead of comparing as $0.
        sorted = matches.sort((a, b) => listCost(a) - listCost(b));
      }

      return json({
        canonical_id: target,
        model_count: sorted.length,
        providers: sorted.map(m => ({
          provider: m.provider,
          provider_display: m.provider_display,
          quantization: m.quantization,
          discount: m.discount,
          zdr: m.zdr || false,
          subscription: m.subscription || false,
          context_length: m.context_length,
          max_completion_tokens: m.max_completion_tokens,
          uptime_30m: m.uptime_30m,
          uptime_1d: m.uptime_1d ?? null,
          open_weights: typeof m.open_weights === 'boolean' ? m.open_weights : null,
          open_weights_source: m.open_weights_source ?? null,
          license: m.license ?? null,
          supported_parameters: m.supported_parameters ?? null,
          supports_tool_choice: m.supports_tool_choice ?? null,
          supports_implicit_caching: m.supports_implicit_caching ?? null,
          max_prompt_tokens: m.max_prompt_tokens ?? null,
          lifecycle_status: m.lifecycle_status ?? null,
          context_price_tiers: m.context_price_tiers ?? null,
          pricing: m.pricing,
        })),
      });
    }

    // List route: only an empty subPath (`models` or `models/`). Reject every other
    // non-empty shape not handled by the detail route above — covers models/foo,
    // models/foo/bar, models/providers, and models/models.
    if (subPath !== '') return errorJson('not_found', 'Not found', 404);

    // /api/v1/models — list with filters
    let models = pricing.models;

    // Filters
    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    // Numeric minimums are integers only: "1M"/"1e6" must not be truncated to 1
    // by parseInt, which silently returned nearly the whole catalog.
    for (const [param, field, read] of [
      ['min_context', 'context_length', (m) => m.context_length],
      ['min_output', 'max_completion_tokens', (m) => m.max_completion_tokens],
      ['min_intelligence', 'intelligence_index', (m) => m.benchmarks?.intelligence_index],
    ]) {
      if (!params.has(param)) continue;
      const raw = params.get(param);
      if (!/^\d+$/.test(raw)) {
        return invalidParameter(param, `${param} must be a non-negative integer`);
      }
      const min = Number(raw);
      if (min > 0) models = models.filter((m) => {
        const value = read(m);
        return value != null && value >= min;
      });
    }

    const quantization = params.get('quantization');
    if (quantization) models = models.filter(m => (m.quantization || 'unknown') === quantization.toLowerCase());

    // Boolean filters are strict. `=== 'true'` alone used to return the
    // UNFILTERED catalog for a typo like zdr=1, so a client believed it had a
    // filtered set. open_weights keeps its documented true|false semantics.
    for (const [param, test] of [
      ['zdr', (m) => m.zdr === true],
      ['sub', (m) => m.subscription === true],
      ['benchmarked', (m) => !!m.benchmarks],
      ['cache_read', (m) => m.pricing?.cache_read != null],
      ['cache_write', (m) => m.pricing?.cache_write != null],
      ['promo', (m) => m.discount > 0],
      ['open_weights', (m) => m.open_weights === true],
    ]) {
      const parsed = parseOptionalBoolean(params, param);
      if (!parsed.ok) return invalidParameter(param, parsed.error);
      if (parsed.value) models = models.filter(test);
    }
    if (params.get('open_weights') === 'false') models = models.filter((m) => m.open_weights === false);

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const validSorts = ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'];
    const sortParam = parseSort(params, validSorts);
    if (!sortParam.ok) return sortParam.response;
    const sortKey = sortParam.sort;
    const orderParam = parseOrder(params);
    if (!orderParam.ok) return orderParam.response;
    const order = orderParam.order;
    models = [...models].sort((a, b) => {
      let va, vb;
      if (sortKey === 'id') { va = a.id.toLowerCase(); vb = b.id.toLowerCase(); }
      else if (sortKey === 'context') { va = a.context_length; vb = b.context_length; }
      else if (sortKey === 'max_output') { va = a.max_completion_tokens; vb = b.max_completion_tokens; }
      else if (sortKey === 'uptime') { va = a.uptime_30m; vb = b.uptime_30m; }
      else if (sortKey === 'intelligence') { va = a.benchmarks?.intelligence_index; vb = b.benchmarks?.intelligence_index; }
      else if (sortKey === 'coding') { va = a.benchmarks?.coding_index; vb = b.benchmarks?.coding_index; }
      else if (sortKey === 'agentic') { va = a.benchmarks?.agentic_index; vb = b.benchmarks?.agentic_index; }
      else if (sortKey === 'discount') { va = a.discount; vb = b.discount; }
      else { va = a.pricing[sortKey]; vb = b.pricing[sortKey]; }
      // Nulls sort last in BOTH directions; a null/null pair compares equal so
      // the comparator stays antisymmetric (V8 requires that for stability).
      if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    // Pagination
    const page = paginationFor(params, models.length);
    if (!page.ok) return page.response;
    const { total, offset, limit, paged } = pageOf(models, page);

    return json({
      generated_at: pricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // ── Route: /api/v1/images[/:id] ──
  if (path === 'images' || path.startsWith('images/')) {
    let imagePricing;
    try {
      imagePricing = await loadAssetJson(context, 'image-pricing.json');
    } catch (err) {
      console.error('Failed to load image pricing data:', err?.message || err);
      return errorJson('catalog_unavailable', 'Failed to load image pricing data', 503);
    }

    const subPath = path.replace(/^images\//, '');

    // /api/v1/images/:id — single model (accepts org/model or bare canonical id)
    if (path.startsWith('images/') && subPath) {
      let requestedId;
      try {
        requestedId = decodeURIComponent(subPath);
      } catch {
        return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
      }
      const target = canonicalId(requestedId);
      const model = findMediaModel(imagePricing.models, requestedId, target);
      if (!model) {
        return errorJson('model_not_found', 'Image model not found', 404, { id: subPath });
      }
      return json({
        generated_at: imagePricing.generated_at,
        model,
      });
    }

    // /api/v1/images — list with filters
    let models = imagePricing.models;

    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const mediaSorts = ['id', 'org', 'provider'];
    const sortParam = parseSort(params, mediaSorts);
    if (!sortParam.ok) return sortParam.response;
    const sortKey = sortParam.sort;
    const orderParam = parseOrder(params);
    if (!orderParam.ok) return orderParam.response;
    const order = orderParam.order;
    models = [...models].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    const page = paginationFor(params, models.length);
    if (!page.ok) return page.response;
    const { total, offset, limit, paged } = pageOf(models, page);

    return json({
      generated_at: imagePricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // ── Route: /api/v1/videos[/:id] ──
  if (path === 'videos' || path.startsWith('videos/')) {
    let videoPricing;
    try {
      videoPricing = await loadAssetJson(context, 'video-pricing.json');
    } catch (err) {
      console.error('Failed to load video pricing data:', err?.message || err);
      return errorJson('catalog_unavailable', 'Failed to load video pricing data', 503);
    }

    const subPath = path.replace(/^videos\//, '');

    // /api/v1/videos/:id — single model (accepts org/model or bare canonical id)
    if (path.startsWith('videos/') && subPath) {
      let requestedId;
      try {
        requestedId = decodeURIComponent(subPath);
      } catch {
        return json({ error: 'Invalid model id encoding' }, 400); // malformed %-encoding
      }
      const target = canonicalId(requestedId);
      const model = findMediaModel(videoPricing.models, requestedId, target);
      if (!model) {
        return errorJson('model_not_found', 'Video model not found', 404, { id: subPath });
      }
      return json({
        generated_at: videoPricing.generated_at,
        model,
      });
    }

    // /api/v1/videos — list with filters
    let models = videoPricing.models;

    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const videoSorts = ['id', 'org', 'provider'];
    const sortParam = parseSort(params, videoSorts);
    if (!sortParam.ok) return sortParam.response;
    const sortKey = sortParam.sort;
    const orderParam = parseOrder(params);
    if (!orderParam.ok) return orderParam.response;
    const order = orderParam.order;
    models = [...models].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    const page = paginationFor(params, models.length);
    if (!page.ok) return page.response;
    const { total, offset, limit, paged } = pageOf(models, page);

    return json({
      generated_at: videoPricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // Unknown route
  return errorJson('not_found', 'Not found', 404);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

/** GET plus a strong ETag and a 304 fast path for conditional requests. */
export async function onRequestGet(context) {
  return withETag(context, await handleGet(context));
}

/**
 * HEAD mirrors GET headers without a body, so a monitor can check freshness
 * (generated_at / ETag) without transferring the payload.
 */
export async function onRequestHead(context) {
  const response = await handleGet(context);
  return new Response(null, { status: response.status, headers: response.headers });
}
