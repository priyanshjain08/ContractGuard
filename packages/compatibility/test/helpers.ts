import { parseOpenApi, type ApiContractIR } from '@contractguard/openapi-parser';

export type Spec = Record<string, any>;

export function baseSpec(): Spec {
  return {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    security: [{ bearer: [] }],
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['available', 'sold'] } },
          ],
          responses: {
            '200': { description: 'ok', headers: { 'X-Total': { schema: { type: 'integer' } } },
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } },
            '400': { description: 'bad' },
          },
        },
        post: {
          operationId: 'createPet',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } },
          responses: { '201': { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
        },
      },
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
        },
        delete: { operationId: 'deletePet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'gone' } } },
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-Key' } },
      schemas: {
        NewPet: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 50 },
            tag: { type: 'string' },
            age: { type: 'integer', minimum: 0 },
            kind: { type: 'string', enum: ['dog', 'cat'] },
          },
        },
        Pet: {
          type: 'object', required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            tag: { type: 'string' },
            kind: { type: 'string', enum: ['dog', 'cat'] },
            owner: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, phone: { type: 'string' } } },
          },
        },
      },
    },
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function ir(spec: Spec): ApiContractIR {
  const r = parseOpenApi(JSON.stringify(spec));
  if (!r.ok || !r.ir) throw new Error('fixture failed to parse: ' + JSON.stringify(r.issues));
  return r.ir;
}

export function mutate(fn: (s: Spec) => void): { base: ApiContractIR; target: ApiContractIR } {
  const t = clone(baseSpec());
  fn(t);
  return { base: ir(baseSpec()), target: ir(t) };
}
