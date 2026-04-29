import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type ServerDependencies } from '../src/server';
import { loadConfig } from '../src/shared/config';
import { createLogger } from '../src/shared/logger';
import { createEventBus } from '../src/kernel/event-bus';
import type { FastifyInstance } from 'fastify';

function createTestDeps(env: Record<string, string> = {}): ServerDependencies {
  const config = loadConfig({
    PORT: '3999',
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    ...env,
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

describe('buildServer (web surface)', () => {
  const VALID_TOKEN = 'a'.repeat(40);

  it("starts with surface='web' when ORCH_API_TOKEN is configured", async () => {
    const deps = createTestDeps({ ORCH_API_TOKEN: VALID_TOKEN });
    const webServer = await buildServer({ ...deps, surface: 'web' });
    try {
      const response = await webServer.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.surface, 'web');
    } finally {
      await webServer.close();
    }
  });

  it("refuses to start with surface='web' when ORCH_API_TOKEN is empty", async () => {
    const deps = createTestDeps(); // no ORCH_API_TOKEN
    await assert.rejects(
      () => buildServer({ ...deps, surface: 'web' }),
      /ORCH_API_TOKEN is empty/,
    );
  });

  it('rejects ORCH_API_TOKEN shorter than 32 characters at config-load time', () => {
    assert.throws(
      () => createTestDeps({ ORCH_API_TOKEN: 'too-short' }),
      /at least 32 characters/,
    );
  });

  it('does not register admin or webhook routes on web surface', async () => {
    const deps = createTestDeps({ ORCH_API_TOKEN: VALID_TOKEN });
    const webServer = await buildServer({ ...deps, surface: 'web' });
    try {
      const status = await webServer.inject({ method: 'GET', url: '/status' });
      assert.equal(status.statusCode, 404);
      const webhook = await webServer.inject({ method: 'POST', url: '/webhooks/github' });
      assert.equal(webhook.statusCode, 404);
    } finally {
      await webServer.close();
    }
  });
});
