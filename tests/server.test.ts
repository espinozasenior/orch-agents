import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type ServerDependencies } from '../src/server';
import { loadConfig } from '../src/shared/config';
import { createLogger } from '../src/shared/logger';
import { createEventBus } from '../src/shared/event-bus';
import type { FastifyInstance } from 'fastify';

function createTestDeps(): ServerDependencies {
  const config = loadConfig({
    PORT: '3999',
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
  });
  const logger = createLogger({ level: 'fatal' });
  const eventBus = createEventBus();
  return { config, logger, eventBus };
}

describe('buildServer', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = await buildServer(createTestDeps());
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns a Fastify instance', () => {
    assert.ok(server);
    assert.equal(typeof server.listen, 'function');
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.status, 'ok');
      assert.equal(body.version, '0.1.0');
      assert.ok(body.uptime >= 0);
      assert.ok(body.timestamp);
    });
  });

  describe('error handling', () => {
    it('returns 404 for unknown routes', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/nonexistent',
      });

      assert.equal(response.statusCode, 404);
    });
  });
});
