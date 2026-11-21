import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOpenApi } from '@contractguard/openapi-parser';

const YAML = `openapi: 3.0.3
info: {title: T, version: '1'}
paths:
  /pets/{id}:
    parameters:
      - {name: id, in: path, required: true, schema: {type: string}}
    get:
      operationId: getPet
      responses:
        '200':
          description: ok
          content:
            application/json; charset=utf-8:
              schema: {$ref: '#/components/schemas/Pet'}
components:
  schemas:
    Pet:
      type: object
      required: [id]
      properties:
        id: {type: string}
        friend: {$ref: '#/components/schemas/Pet'}
`;

test('parses YAML, normalizes media types and path templates, resolves refs', () => {
  const r = parseOpenApi(YAML);
  assert.ok(r.ok, JSON.stringify(r.issues));
  const op = r.ir!.operations['GET /pets/{}']!;
  assert.equal(op.operationId, 'getPet');
  assert.ok(op.parameters['path:#0']);
  const schema = op.responses['200']!.content['application/json']!.schema!;
  assert.equal(schema.refName, 'Pet');
  assert.equal(schema.properties!.friend!.circularRef, '#/components/schemas/Pet');
});

test('parses JSON', () => {
  const r = parseOpenApi(JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: {} }));
  assert.ok(r.ok);
  assert.equal(r.ir!.openapi, '3.1.0');
});

test('locate maps pointers to source lines', () => {
  const r = parseOpenApi(YAML);
  assert.equal(r.locate('#/paths/~1pets~1{id}/get'), 7);
  assert.equal(r.locate('#/components/schemas/Pet'), 17);
  assert.equal(r.locate('#/paths/~1pets~1{id}/get/nonexistent'), 7); // falls back to deepest existing ancestor
});

test('checksum is a sha256 of the exact bytes', () => {
  assert.match(parseOpenApi(YAML).checksum, /^[0-9a-f]{64}$/);
  assert.notEqual(parseOpenApi(YAML).checksum, parseOpenApi(YAML + '\n').checksum);
});

const rejects: Array<[string, string, string]> = [
  ['empty', '   ', 'EMPTY'],
  ['malformed yaml', 'openapi: 3.0.3\ninfo: [unclosed', 'INVALID_SYNTAX'],
  ['malformed json', '{"openapi": "3.0.3",', 'INVALID_SYNTAX'],
  ['swagger 2', 'swagger: "2.0"\ninfo: {title: t, version: "1"}\npaths: {}', 'UNSUPPORTED_VERSION'],
  ['not openapi', 'foo: bar', 'NOT_OPENAPI'],
  ['array root', '- a\n- b', 'NOT_OPENAPI'],
  ['unsupported 4.x', 'openapi: 4.0.0\ninfo: {title: t, version: "1"}\npaths: {}', 'UNSUPPORTED_VERSION'],
  ['missing info', 'openapi: 3.0.3\npaths: {}', 'MISSING_INFO'],
  ['missing paths', 'openapi: 3.0.3\ninfo: {title: t, version: "1"}', 'MISSING_PATHS'],
  ['bad path', 'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths:\n  pets: {}', 'INVALID_PATH'],
  ['unresolved ref', 'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: x\n          content:\n            application/json:\n              schema: {$ref: "#/components/schemas/Nope"}', 'UNRESOLVED_REF'],
  ['duplicate keys', 'openapi: 3.0.3\nopenapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: {}', 'INVALID_SYNTAX'],
  ['nul bytes', 'openapi: 3.0.3\u0000', 'INVALID_CONTENT'],
];
for (const [name, src, code] of rejects) {
  test(`rejects: ${name}`, () => {
    const r = parseOpenApi(src);
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === code), `wanted ${code}, got ${JSON.stringify(r.issues)}`);
  });
}

test('rejects oversized input', () => {
  const r = parseOpenApi(YAML, { maxBytes: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]!.code, 'TOO_LARGE');
});

test('rejects YAML alias-expansion bombs', () => {
  const lines = ['a: &a [x,x,x,x,x,x,x,x,x]'];
  let prev = 'a';
  for (let i = 0; i < 12; i++) { const n = 'l' + i; lines.push(`${n}: &${n} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`); prev = n; }
  const r = parseOpenApi(`openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: {}\nx-bomb:\n${lines.map((l) => '  ' + l).join('\n')}\n`);
  assert.equal(r.ok, false);
});

test('external refs are flagged, never fetched', () => {
  const r = parseOpenApi('openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: x\n          content:\n            application/json:\n              schema: {$ref: "https://evil.example/schema.json"}');
  assert.ok(r.ok);
  assert.ok(r.issues.some((i) => i.code === 'EXTERNAL_REF_NOT_RESOLVED'));
  assert.ok(r.ir!.unsupported.some((u) => u.construct === 'external-ref'));
});

test('unsupported constructs are recorded, not dropped silently', () => {
  const r = parseOpenApi('openapi: 3.1.0\ninfo: {title: t, version: "1"}\nwebhooks: {}\npaths:\n  /a:\n    get:\n      callbacks: {}\n      responses:\n        "200":\n          description: x\n          content:\n            application/json:\n              schema: {not: {type: string}}');
  const kinds = r.ir!.unsupported.map((u) => u.construct);
  assert.ok(kinds.includes('webhooks') && kinds.includes('operation.callbacks') && kinds.includes('schema.not'));
});

test('operation-level parameters override path-level; missing path param warns', () => {
  const r = parseOpenApi(`openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /a/{x}:
    parameters: [{name: q, in: query, schema: {type: string}}]
    get:
      parameters: [{name: q, in: query, required: true, schema: {type: integer}}]
      responses: {"200": {description: ok}}
`);
  assert.ok(r.ok);
  const q = r.ir!.operations['GET /a/{}']!.parameters['query:q']!;
  assert.equal(q.required, true);
  assert.deepEqual(q.schema!.types, ['integer']);
  assert.ok(r.issues.some((i) => i.code === 'MISSING_PATH_PARAMETER'));
});
