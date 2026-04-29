import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createEventBus, type EventBus } from '../../src/kernel/event-bus';
import { createRunHistory, type RunHistory } from '../../src/kernel/run-history';
import { createWebTokenStore, type WebTokenStore } from '../../src/web-api/web-auth';
import { createSecretAuditLog, type SecretAuditLog } from '../../src/security/secret-audit';
import { createSecretStore, type SecretStore } from '../../src/security/secret-store';
import { createSecretPersistence } from '../../src/security/secret-persistence';
import { v1Router } from '../../src/web-api/v1-router';

describe('v1Router (integration)', () => {
  let tmp: string;
  let server: FastifyInstance;
  let bus: EventBus;
  let runHistory: RunHistory;
  let tokenStore: WebTokenStore;
  let secretStore: SecretStore;
  let audit: SecretAuditLog;
  let runsToken: string;
  let secretsToken: string;
  let automationsToken: string;
  let allScopesToken: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v1-router-'));
    bus = createEventBus();
    runHistory = createRunHistory(bus, { capacity: 10 });
    tokenStore = createWebTokenStore(join(tmp, 'tokens.db'));
    audit = createSecretAuditLog(join(tmp, 'secrets.db'));
    const secretPersistence = createSecretPersistence(join(tmp, 'secrets-store.db'));
    secretStore = createSecretStore({
      persistence: secretPersistence,
      masterKey: 'test-master-key-must-be-some-bytes-long-enough',
    });

    runsToken = tokenStore.mint({ label: 'runs', scopes: ['runs:read'] }).token;
    secretsToken = tokenStore.mint({
      label: 'secrets',
      scopes: ['secrets:read', 'secrets:write'],
    }).token;
    automationsToken = tokenStore.mint({
      label: 'auto',
      scopes: ['runs:read', 'automations:write'],
    }).token;
    allScopesToken = tokenStore.mint({
      label: 'all',
      scopes: ['runs:read', 'automations:write', 'secrets:read', 'secrets:write', 'workflow:read'],
    }).token;

    server = Fastify({ logger: false });
    await server.register((instance) =>
      v1Router(instance, {
        tokenStore,
        runHistory,
        secretStore,
        secretAudit: audit,
        productionMode: false,
        // Plenty of headroom so the test isn't rate-limited.
        rateLimitPerMinute: 1000,
      }),
    );
    await server.ready();
  });

  after(async () => {
    await server.close();
    runHistory.close();
    tokenStore.close();
    audit.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('auth + scopes', () => {
    it('401 without bearer', async () => {
      const r = await server.inject({ method: 'GET', url: '/v1/runs' });
      assert.equal(r.statusCode, 401);
    });

    it('200 with valid bearer + matching scope', async () => {
      const r = await server.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: { authorization: `Bearer ${runsToken}` },
      });
      assert.equal(r.statusCode, 200);
      const body = JSON.parse(r.body);
      assert.ok(Array.isArray(body.runs));
    });

    it('403 with valid bearer but missing scope', async () => {
      const r = await server.inject({
        method: 'GET',
        url: '/v1/secrets',
        headers: { authorization: `Bearer ${runsToken}` },
      });
      assert.equal(r.statusCode, 403);
    });
  });

  describe('GET /v1/runs/:planId', () => {
    it('404 when planId is unknown', async () => {
      const r = await server.inject({
        method: 'GET',
        url: '/v1/runs/nonexistent',
        headers: { authorization: `Bearer ${runsToken}` },
      });
      assert.equal(r.statusCode, 404);
    });
  });

  describe('PUT /v1/secrets/:key writes audit row', () => {
    it('records a `set` audit entry without leaking plaintext', async () => {
      const before = audit.count();
      const r = await server.inject({
        method: 'PUT',
        url: '/v1/secrets/MY_KEY',
        headers: { authorization: `Bearer ${secretsToken}` },
        payload: { value: 'super-sensitive', scope: 'global' },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(audit.count(), before + 1);
      const entry = audit.list(1)[0];
      assert.equal(entry.action, 'set');
      assert.equal(entry.key, 'MY_KEY');
      assert.equal(entry.scope, 'global');
      assert.ok(entry.afterHash);
      assert.equal(entry.beforeHash, null);
      // No plaintext anywhere
      assert.equal(JSON.stringify(entry).includes('super-sensitive'), false);
    });

    it('records `delete` and a beforeHash from the prior value', async () => {
      // First, set a value
      await server.inject({
        method: 'PUT',
        url: '/v1/secrets/TO_DELETE',
        headers: { authorization: `Bearer ${secretsToken}` },
        payload: { value: 'will-be-gone', scope: 'global' },
      });
      const before = audit.count();
      const r = await server.inject({
        method: 'DELETE',
        url: '/v1/secrets/TO_DELETE?scope=global',
        headers: { authorization: `Bearer ${secretsToken}` },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(audit.count(), before + 1);
      const entry = audit.list(1)[0];
      assert.equal(entry.action, 'delete');
      assert.ok(entry.beforeHash);
      assert.equal(entry.afterHash, null);
    });
  });

  describe('GET /v1/secrets', () => {
    it('returns metadata only (no values)', async () => {
      const r = await server.inject({
        method: 'GET',
        url: '/v1/secrets',
        headers: { authorization: `Bearer ${allScopesToken}` },
      });
      assert.equal(r.statusCode, 200);
      const body = JSON.parse(r.body);
      assert.ok(Array.isArray(body.secrets));
      for (const entry of body.secrets) {
        assert.equal('value' in entry, false);
      }
    });
  });

  describe('automation routes', () => {
    it('GET /v1/automations 404 when no scheduler is configured (route absent)', async () => {
      const r = await server.inject({
        method: 'GET',
        url: '/v1/automations',
        headers: { authorization: `Bearer ${automationsToken}` },
      });
      assert.equal(r.statusCode, 404);
    });
  });
});
