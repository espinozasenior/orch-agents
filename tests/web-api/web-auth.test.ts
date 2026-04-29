import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ALL_SCOPES,
  bearerAuth,
  createWebTokenStore,
  requireScope,
  webTokenAdminRoutes,
  type WebTokenStore,
} from '../../src/web-api/web-auth';

describe('createWebTokenStore', () => {
  let tmp: string;
  let store: WebTokenStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'web-auth-test-'));
    store = createWebTokenStore(join(tmp, 'tokens.db'));
  });

  function teardown(): void {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  it('mints a token with id, plaintext, scopes and persists the hash', () => {
    const minted = store.mint({ label: 'dev', scopes: ['runs:read'] });
    teardown();
    try {
      assert.match(minted.token, /^orch_[A-Za-z0-9_-]+$/);
      assert.equal(minted.token.length, 'orch_'.length + 64);
      assert.equal(minted.label, 'dev');
      assert.deepEqual(minted.scopes, ['runs:read']);
      assert.match(minted.id, /^[a-f0-9]{16}$/);
    } catch (e) {
      teardown();
      throw e;
    }
  });

  it('validates a freshly-minted token and surfaces its scopes', () => {
    try {
      const minted = store.mint({ label: 'dev', scopes: ['runs:read', 'secrets:write'] });
      const result = store.validate(minted.token);
      assert.ok(result, 'expected validate() to return a result');
      assert.equal(result!.id, minted.id);
      assert.deepEqual(result!.scopes.sort(), ['runs:read', 'secrets:write']);
    } finally {
      teardown();
    }
  });

  it('returns undefined for unknown / malformed / wrong-length tokens', () => {
    try {
      store.mint({ label: 'dev', scopes: ['runs:read'] });
      assert.equal(store.validate('orch_unknown_token_value_blah'), undefined);
      assert.equal(store.validate('not_even_prefixed'), undefined);
      assert.equal(store.validate(''), undefined);
    } finally {
      teardown();
    }
  });

  it('lists tokens without leaking plaintext or hash', () => {
    try {
      const a = store.mint({ label: 'a', scopes: ['runs:read'] });
      const b = store.mint({ label: 'b', scopes: ['secrets:write'] });
      const list = store.list();
      assert.equal(list.length, 2);
      const ids = list.map((t) => t.id).sort();
      assert.deepEqual(ids, [a.id, b.id].sort());
      // No plaintext or hash field should ever be exposed
      for (const summary of list) {
        assert.equal('hash' in summary, false);
        assert.equal('token' in summary, false);
      }
    } finally {
      teardown();
    }
  });

  it('revokes a token so subsequent validate() returns undefined', () => {
    try {
      const minted = store.mint({ label: 'dev', scopes: ['runs:read'] });
      assert.ok(store.validate(minted.token));
      assert.equal(store.revoke(minted.id), true);
      assert.equal(store.validate(minted.token), undefined);
      assert.equal(store.revoke(minted.id), false); // already gone
    } finally {
      teardown();
    }
  });

  it('updates lastUsedAt on successful validate', async () => {
    try {
      const minted = store.mint({ label: 'dev', scopes: ['runs:read'] });
      const before = store.list()[0].lastUsedAt;
      assert.equal(before, null);
      // Sleep 5ms so timestamps differ
      await new Promise((r) => setTimeout(r, 5));
      store.validate(minted.token);
      const after = store.list()[0].lastUsedAt;
      assert.ok(after, 'lastUsedAt should be set after validate');
    } finally {
      teardown();
    }
  });

  it('rejects mint with empty label or empty scopes', () => {
    try {
      assert.throws(() => store.mint({ label: '', scopes: ['runs:read'] }));
      assert.throws(() => store.mint({ label: 'ok', scopes: [] }));
      assert.throws(() => store.mint({ label: 'ok', scopes: ['bogus' as never] }));
    } finally {
      teardown();
    }
  });
});

describe('bearerAuth + requireScope (Fastify integration)', () => {
  let tmp: string;
  let store: WebTokenStore;
  let server: FastifyInstance;
  let validToken: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'web-auth-fastify-'));
    store = createWebTokenStore(join(tmp, 'tokens.db'));
    validToken = store.mint({ label: 'dev', scopes: ['runs:read'] }).token;

    server = Fastify({ logger: false });
    server.addHook('preHandler', bearerAuth(store));
    server.get('/v1/runs', { preHandler: requireScope('runs:read') }, async () => ({
      runs: [],
    }));
    server.get('/v1/secrets', { preHandler: requireScope('secrets:read') }, async () => ({
      secrets: [],
    }));
    await server.ready();
  });

  after(async () => {
    await server.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('401 when Authorization header is missing', async () => {
    const r = await server.inject({ method: 'GET', url: '/v1/runs' });
    assert.equal(r.statusCode, 401);
  });

  it('401 when bearer token is invalid', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: 'Bearer orch_completely_bogus_value_xyz_padding_padding_padding_padding' },
    });
    assert.equal(r.statusCode, 401);
  });

  it('200 with the right scope', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${validToken}` },
    });
    assert.equal(r.statusCode, 200);
  });

  it('403 when the token lacks the required scope', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/v1/secrets',
      headers: { authorization: `Bearer ${validToken}` },
    });
    assert.equal(r.statusCode, 403);
  });
});

describe('webTokenAdminRoutes', () => {
  let tmp: string;
  let store: WebTokenStore;
  let server: FastifyInstance;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'web-auth-admin-'));
    store = createWebTokenStore(join(tmp, 'tokens.db'));
    server = Fastify({ logger: false });
    await server.register(webTokenAdminRoutes, { tokenStore: store });
    await server.ready();
  });

  after(async () => {
    await server.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('POST /admin/web-tokens mints and returns plaintext exactly once', async () => {
    const r = await server.inject({
      method: 'POST',
      url: '/admin/web-tokens',
      payload: { label: 'first', scopes: ['runs:read'] },
    });
    assert.equal(r.statusCode, 201);
    const body = JSON.parse(r.body);
    assert.match(body.token, /^orch_/);
    assert.equal(body.label, 'first');
  });

  it('GET /admin/web-tokens lists without plaintext', async () => {
    const r = await server.inject({ method: 'GET', url: '/admin/web-tokens' });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.tokens));
    assert.ok(body.tokens.length >= 1);
    for (const t of body.tokens) {
      assert.equal('token' in t, false);
      assert.equal('hash' in t, false);
    }
  });

  it('DELETE /admin/web-tokens/:id revokes', async () => {
    const minted = store.mint({ label: 'to-revoke', scopes: ['runs:read'] });
    const r = await server.inject({ method: 'DELETE', url: `/admin/web-tokens/${minted.id}` });
    assert.equal(r.statusCode, 204);
    const r404 = await server.inject({ method: 'DELETE', url: `/admin/web-tokens/${minted.id}` });
    assert.equal(r404.statusCode, 404);
  });

  it('rejects invalid scopes at the API boundary', async () => {
    const r = await server.inject({
      method: 'POST',
      url: '/admin/web-tokens',
      payload: { label: 'x', scopes: ['runs:read', 'not-a-real-scope'] },
    });
    assert.equal(r.statusCode, 400);
  });

  it('exports ALL_SCOPES as a frozen list of the documented scopes', () => {
    assert.deepEqual([...ALL_SCOPES].sort(), [
      'automations:write',
      'runs:read',
      'secrets:read',
      'secrets:write',
      'workflow:read',
    ]);
  });
});
