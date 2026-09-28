import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BadRequest,
  createBaseApp,
  createLogger,
  finalizeApp,
  loadConfig,
  parse,
  requireGatewayUser,
} from '../src/index.js';

const logger = createLogger('test');

function app() {
  const a = createBaseApp(logger);
  a.get('/boom', () => {
    throw BadRequest('nope');
  });
  a.post('/validate', (req, res) => {
    res.json(parse(z.object({ n: z.number() }), req.body));
  });
  a.get('/me', requireGatewayUser, (req, res) => {
    res.json(req.user);
  });
  return finalizeApp(a, logger);
}

describe('http toolkit', () => {
  it('propagates or generates a request id', async () => {
    const given = await request(app()).get('/nope').set('x-request-id', 'abc-123');
    expect(given.headers['x-request-id']).toBe('abc-123');
    const generated = await request(app()).get('/nope');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.status).toBe(404);
  });

  it('maps AppError and ZodError to JSON errors', async () => {
    const boom = await request(app()).get('/boom');
    expect(boom.status).toBe(400);
    expect(boom.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'nope' });

    const invalid = await request(app()).post('/validate').send({ n: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('reads the user identity forwarded by the gateway', async () => {
    expect((await request(app()).get('/me')).status).toBe(401);
    const res = await request(app()).get('/me').set('x-user-id', 'u1').set('x-user-email', 'a@b.c');
    expect(res.body).toEqual({ id: 'u1', email: 'a@b.c' });
  });
});

describe('loadConfig', () => {
  it('returns typed values or throws a readable error', () => {
    const schema = z.object({ PORT: z.coerce.number().default(3000), NAME: z.string() });
    expect(loadConfig(schema, { NAME: 'x' })).toEqual({ PORT: 3000, NAME: 'x' });
    expect(() => loadConfig(schema, {})).toThrow(/NAME/);
  });
});
