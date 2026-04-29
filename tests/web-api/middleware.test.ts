import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerWebMiddleware } from '../../src/web-api/middleware';

describe('registerWebMiddleware (rate-limit + CORS + helmet)', () => {
  describe('rate limiting (per IP fallback)', () => {
    let server: FastifyInstance;

    before(async () => {
      server = Fastify({ logger: false });
      await registerWebMiddleware(server, {
        productionMode: false,
        rateLimitPerMinute: 3, // tight cap so the test is fast
      });
      server.get('/v1/runs', async () => ({ runs: [] }));
      await server.ready();
    });

    after(async () => {
      await server.close();
    });

    it('429s after exceeding the per-minute quota', async () => {
      // Three should pass, the fourth must be rate-limited.
      const responses = [];
      for (let i = 0; i < 4; i++) {
        responses.push(
          await server.inject({ method: 'GET', url: '/v1/runs', remoteAddress: '10.0.0.1' }),
        );
      }
      assert.equal(responses[0].statusCode, 200);
      assert.equal(responses[1].statusCode, 200);
      assert.equal(responses[2].statusCode, 200);
      assert.equal(responses[3].statusCode, 429);
      const body = JSON.parse(responses[3].body);
      assert.equal(body.statusCode, 429);
      assert.match(body.message, /rate/i);
    });
  });

  describe('rate limiting (per token)', () => {
    let server: FastifyInstance;

    before(async () => {
      server = Fastify({ logger: false });
      // bearerAuth-equivalent must be registered as 'onRequest' BEFORE
      // registerWebMiddleware, so the rate-limit keyGenerator sees tokenId.
      server.addHook('onRequest', async (request) => {
        const header = (request.headers.authorization ?? '') as string;
        if (header.startsWith('Bearer ')) {
          (request as { tokenId?: string }).tokenId = header.slice('Bearer '.length);
        }
      });
      await registerWebMiddleware(server, {
        productionMode: false,
        rateLimitPerMinute: 2,
      });
      server.get('/v1/runs', async () => ({ runs: [] }));
      await server.ready();
    });

    after(async () => {
      await server.close();
    });

    it('quotas are independent across distinct tokens', async () => {
      const aliceA = await server.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: { authorization: 'Bearer alice' },
      });
      const aliceB = await server.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: { authorization: 'Bearer alice' },
      });
      const aliceC = await server.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: { authorization: 'Bearer alice' },
      });
      const bobA = await server.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: { authorization: 'Bearer bob' },
      });
      assert.equal(aliceA.statusCode, 200);
      assert.equal(aliceB.statusCode, 200);
      assert.equal(aliceC.statusCode, 429); // alice hit cap
      assert.equal(bobA.statusCode, 200); // bob unaffected
    });
  });

  describe('CORS', () => {
    it('rejects unknown origin in production', async () => {
      const server = Fastify({ logger: false });
      await registerWebMiddleware(server, { productionMode: true });
      server.get('/v1/x', async () => ({ ok: true }));
      await server.ready();
      try {
        const r = await server.inject({
          method: 'GET',
          url: '/v1/x',
          headers: { origin: 'https://evil.example.com' },
        });
        assert.equal(r.statusCode, 500); // CORS rejection surfaces as 500 from fastify-cors
      } finally {
        await server.close();
      }
    });

    it('allows http://localhost:3000 in dev mode', async () => {
      const server = Fastify({ logger: false });
      await registerWebMiddleware(server, { productionMode: false });
      server.get('/v1/x', async () => ({ ok: true }));
      await server.ready();
      try {
        const r = await server.inject({
          method: 'GET',
          url: '/v1/x',
          headers: { origin: 'http://localhost:3000' },
        });
        assert.equal(r.statusCode, 200);
        assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:3000');
      } finally {
        await server.close();
      }
    });

    it('allows operator-specified origins in production', async () => {
      const server = Fastify({ logger: false });
      await registerWebMiddleware(server, {
        productionMode: true,
        corsOrigins: ['https://app.acme.com'],
      });
      server.get('/v1/x', async () => ({ ok: true }));
      await server.ready();
      try {
        const r = await server.inject({
          method: 'GET',
          url: '/v1/x',
          headers: { origin: 'https://app.acme.com' },
        });
        assert.equal(r.statusCode, 200);
      } finally {
        await server.close();
      }
    });
  });

  describe('Helmet headers', () => {
    it('sets standard security headers (X-Frame-Options, X-Content-Type-Options, etc.)', async () => {
      const server = Fastify({ logger: false });
      await registerWebMiddleware(server, { productionMode: true });
      server.get('/v1/x', async () => ({ ok: true }));
      await server.ready();
      try {
        const r = await server.inject({ method: 'GET', url: '/v1/x' });
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.ok(r.headers['x-frame-options']);
      } finally {
        await server.close();
      }
    });
  });
});
