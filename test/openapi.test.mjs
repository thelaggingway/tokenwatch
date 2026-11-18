// Structural and completeness tests for the published OpenAPI document.
//
// The document is generated, but nothing else checks that it is a valid
// OpenAPI 3.1 object, that every $ref resolves, or that the registry and the
// parameter documentation stay in step. Those checks live here so a router
// change that adds a parameter fails CI instead of shipping a spec that lies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../scripts/seo-pages.mjs';
import { API_ENDPOINTS } from '../shared/api-meta.mjs';
import { COMPONENT_SCHEMAS } from '../shared/openapi-schemas.mjs';
import { PARAMETER_DOCS, PATH_PARAMETER_DOCS, RESPONSE_DOCS } from '../shared/openapi-params.mjs';
import { USE_CASES, PRIORITY_PROVIDER_WEIGHTS } from '../shared/use-cases.mjs';

const doc = buildOpenApiDocument();

/** Walk every node of the document, yielding each object. */
function* walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item);
    return;
  }
  yield node;
  for (const value of Object.values(node)) yield* walk(value);
}

/** Every $ref string in the document. */
function collectRefs(node, out = new Set()) {
  for (const item of walk(node)) {
    if (typeof item.$ref === 'string') out.add(item.$ref);
  }
  return out;
}

test('openapi document is a valid 3.1 object with an info block and servers', () => {
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(typeof doc.info.title, 'string');
  assert.equal(typeof doc.info.version, 'string');
  assert.equal(doc.servers[0].url, 'https://tokenwatch.wyrdwerk.com');
  assert.ok(doc.paths && Object.keys(doc.paths).length > 0);
  // A published contract must not carry filler.
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /Filter or control parameter/);
  assert.doesNotMatch(text, /Undocumented (query|path) parameter/);
});

test('every $ref resolves to a defined component schema', () => {
  const defined = new Set(Object.keys(doc.components.schemas));
  const refs = collectRefs(doc);
  assert.ok(refs.size > 0, 'expected the document to use component schemas');
  for (const ref of refs) {
    const match = ref.match(/^#\/components\/schemas\/([A-Za-z0-9_]+)$/);
    assert.ok(match, `unexpected $ref shape: ${ref}`);
    assert.ok(defined.has(match[1]), `unresolved $ref: ${ref}`);
  }
});

test('every defined component schema is reachable from a path, directly or transitively', () => {
  const reached = new Set();
  const queue = [...collectRefs(doc.paths)].map((ref) => ref.split('/').pop());
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    const schema = doc.components.schemas[name];
    assert.ok(schema, `path graph references undefined schema ${name}`);
    for (const ref of collectRefs(schema)) queue.push(ref.split('/').pop());
  }
  for (const name of Object.keys(doc.components.schemas)) {
    assert.ok(reached.has(name), `component schema ${name} is defined but unreachable from any path`);
  }
});

test('each path answers with a schema reference rather than a bare object', () => {
  for (const [path, operations] of Object.entries(doc.paths)) {
    const operation = operations.get;
    assert.ok(operation, `missing GET operation for ${path}`);
    const ok = operation.responses['200'];
    assert.ok(ok, `missing 200 response for ${path}`);
    assert.ok(ok.content['application/json'].schema.$ref, `${path} 200 has no schema $ref`);
    for (const status of ['400', '404', '503']) {
      const response = operation.responses[status];
      assert.ok(response, `missing ${status} response for ${path}`);
      assert.equal(response.content['application/json'].schema.$ref, '#/components/schemas/Error');
    }
  }
});

test('every registered query parameter is documented with a type and description', () => {
  for (const endpoint of API_ENDPOINTS) {
    const path = endpoint.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const params = doc.paths[path].get.parameters.filter((parameter) => parameter.in === 'query');
    assert.equal(params.length, endpoint.params.length, `${path} parameter count`);
    for (const name of endpoint.params) {
      const parameter = params.find((candidate) => candidate.name === name);
      assert.ok(parameter, `${path} is missing parameter ${name}`);
      assert.ok(parameter.description && parameter.description.length > 20,
        `${path}?${name} needs a real description`);
      assert.ok(parameter.schema.type, `${path}?${name} needs a type`);
      assert.ok(Object.hasOwn(PARAMETER_DOCS[endpoint.path] ?? {}, name),
        `${path}?${name} is not in PARAMETER_DOCS`);
    }
  }
});

test('documented parameters do not exceed the registered set', () => {
  for (const [endpointPath, docs] of Object.entries(PARAMETER_DOCS)) {
    const endpoint = API_ENDPOINTS.find((candidate) => candidate.path === endpointPath);
    assert.ok(endpoint, `PARAMETER_DOCS documents unknown endpoint ${endpointPath}`);
    for (const name of Object.keys(docs)) {
      assert.ok(endpoint.params.includes(name),
        `PARAMETER_DOCS documents ${endpointPath}?${name}, which the registry does not list`);
    }
  }
});

test('every endpoint has a documented 200 response body', () => {
  for (const endpoint of API_ENDPOINTS) {
    const entry = RESPONSE_DOCS[endpoint.path];
    assert.ok(entry, `no response documentation for ${endpoint.path}`);
    assert.ok(COMPONENT_SCHEMAS[entry.schema], `${endpoint.path} references unknown schema ${entry.schema}`);
    assert.ok(entry.description.length > 20, `${endpoint.path} response needs a real description`);
  }
});

test('path parameters are documented and required', () => {
  for (const endpoint of API_ENDPOINTS) {
    const names = [...endpoint.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    const path = endpoint.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const params = doc.paths[path].get.parameters.filter((parameter) => parameter.in === 'path');
    assert.equal(params.length, names.length, `${path} path parameter count`);
    for (const name of names) {
      const parameter = params.find((candidate) => candidate.name === name);
      assert.ok(parameter, `${path} is missing path parameter ${name}`);
      assert.equal(parameter.required, true);
      assert.ok(PATH_PARAMETER_DOCS[name], `path parameter ${name} has no documentation`);
      assert.ok(parameter.description.length > 20, `path parameter ${name} needs a real description`);
    }
  }
});

test('enum parameters match the preset tables the router validates against', () => {
  const useCase = doc.paths['/api/v1/recommend'].get.parameters.find((p) => p.name === 'use_case');
  assert.deepEqual(useCase.schema.enum, Object.keys(USE_CASES));
  const priority = doc.paths['/api/v1/recommend'].get.parameters.find((p) => p.name === 'priority');
  assert.deepEqual(priority.schema.enum, Object.keys(PRIORITY_PROVIDER_WEIGHTS));
  const sort = doc.paths['/api/v1/models'].get.parameters.find((p) => p.name === 'sort');
  const registrySort = API_ENDPOINTS.find((endpoint) => endpoint.path === '/api/v1/models').sort;
  assert.deepEqual(sort.schema.enum, registrySort);
});

test('limits document the validation and clamping the router actually performs', () => {
  const listLimit = doc.paths['/api/v1/models'].get.parameters.find((p) => p.name === 'limit');
  assert.deepEqual(listLimit.schema, { type: 'integer', minimum: 1, maximum: 500, default: 100 });
  assert.match(listLimit.description, /clamped to 500/);
  assert.match(listLimit.description, /are a 400/);
  const imageLimit = doc.paths['/api/v1/images'].get.parameters.find((p) => p.name === 'limit');
  assert.equal(imageLimit.schema.maximum, 500);
  const recLimit = doc.paths['/api/v1/recommend'].get.parameters.find((p) => p.name === 'limit');
  assert.deepEqual(recLimit.schema, { type: 'integer', minimum: 1, maximum: 100, default: 10 });
  const days = doc.paths['/api/v1/models/{canonicalId}/history'].get.parameters.find((p) => p.name === 'days');
  assert.deepEqual(days.schema, { type: 'integer', minimum: 1, maximum: 90, default: 90 });
});

test('price schemas keep unknown values nullable instead of defaulting to zero', () => {
  const pricing = doc.components.schemas.Pricing;
  for (const field of ['input', 'output', 'cache_read', 'cache_write']) {
    assert.deepEqual(pricing.properties[field].type, ['number', 'null'], `Pricing.${field} must be number|null`);
  }
  assert.match(pricing.description, /null value is unknown, not free/);
  // The API history contract promises a null cache-read price falls back to input.
  const historyPoint = doc.components.schemas.HistoryPoint;
  assert.deepEqual(historyPoint.properties.cache_read.type, ['number', 'null']);
  assert.match(historyPoint.description, /never emitted as zero/);
});

test('recommendation schemas cover the pick, group and preference shapes', () => {
  const recommend = doc.components.schemas.RecommendResponse;
  assert.deepEqual(recommend.required, [
    'generated_at', 'useCase', 'priority', 'mix', 'picks',
    'alsoConsidered', 'partiallyBenchmarked', 'unbenchmarked', 'unverified',
  ]);
  assert.equal(recommend.properties.picks.properties.bestQuality.$ref,
    '#/components/schemas/Recommendation');
  assert.equal(recommend.properties.preference.$ref, '#/components/schemas/Preference');
  // Chat and creative writing return a preference; other use cases return null.
  assert.deepEqual(doc.components.schemas.Preference.type, ['object', 'null']);
  const preference = doc.components.schemas.PreferenceSource;
  assert.match(preference.description, /CC BY 4\.0/);
  assert.ok(preference.required.includes('license'));
  // Provider ranking keeps unverified options out of `ranked`.
  const providers = doc.components.schemas.RecommendProvidersResponse;
  assert.equal(providers.properties.unverified.$ref, '#/components/schemas/UnverifiedGroup');
  assert.match(providers.description, /never in `ranked`/);
});

test('error schema documents the code, parameter and detail envelopes the router emits', () => {
  const error = doc.components.schemas.Error;
  assert.deepEqual(error.required, ['error', 'code']);
  assert.equal(error.properties.error.type, 'string');
  assert.ok(error.properties.code.enum.includes('invalid_parameter'));
  assert.equal(error.properties.path, undefined, '404 bodies no longer echo the request path');
  for (const field of ['parameter', 'code', 'detail', 'canonical_id', 'id']) {
    assert.ok(error.properties[field], `Error.${field} is missing`);
  }
});

test('image and video schemas describe per-unit pricing, not token pricing', () => {
  const image = doc.components.schemas.ImageModel;
  const imagePricing = image.properties.pricing.items;
  assert.deepEqual(imagePricing.properties.unit.enum, ['image', 'megapixel', 'request', 'token']);
  assert.deepEqual(imagePricing.properties.cost_per_million.type, ['number', 'null']);
  assert.match(image.description, /per-unit variants/);
  const video = doc.components.schemas.VideoModel;
  assert.ok(video.properties.pricing.items.properties.cost_per_second);
  assert.deepEqual(video.properties.pricing.items.properties.audio.type, ['boolean', 'null']);
});

test('the committed openapi.json matches what the generator produces', () => {
  const committed = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, doc,
    'public/openapi.json is stale — run `npm run seo` and commit the result');
});
