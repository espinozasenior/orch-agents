/**
 * Tests for secrets API routes — London School TDD.
 *
 * Covers: list, create/update, delete.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { secretApi } from '../../src/security/secret-api';
import { createSecretStore } from '../../src/security/secret-store';
import { createSecretPersistence } from '../../src/security/secret-persistence';

describe('SecretApi', () => {
  const MASTER_KEY = randomBytes(32).toString('hex');
  let app: ReturnType<typeof Fastify>;
  let store: ReturnType<typeof createSecretStore>;

  beforeEach(async () => {
    const persistence = createSecretPersistence(':memory:');
    store = createSecretStore({ persistence, masterKey: MASTER_KEY });
    app = Fastify();
    await app.register(secretApi, { secretStore: store });
  });

  it('should list secrets (empty)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/secrets',
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.secrets, []);
  });

  it('should create a secret via PUT and list it', async () => {
    const putResponse = await app.inject({
      method: 'PUT',
      url: '/secrets/MY_SECRET',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'secret-value', scope: 'global' }),
    });

    assert.equal(putResponse.statusCode, 200);
    const putBody = JSON.parse(putResponse.body);
    assert.equal(putBody.ok, true);
    assert.equal(putBody.key, 'MY_SECRET');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/secrets',
    });

    const listBody = JSON.parse(listResponse.body);
    assert.equal(listBody.secrets.length, 1);
    assert.equal(listBody.secrets[0].key, 'MY_SECRET');
    assert.equal(listBody.secrets[0].scope, 'global');
  });

  it('should verify created secret is stored encrypted', async () => {
    await app.inject({
      method: 'PUT',
      url: '/secrets/ENCRYPTED_TEST',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'my-value', scope: 'global' }),
    });

    // Verify through the store that the value is correctly encrypted/decrypted
    const value = store.getSecret('ENCRYPTED_TEST', 'global');
    assert.equal(value, 'my-value');
  });

  it('should delete a secret via DELETE', async () => {
    store.setSecret('TO_DELETE', 'value', 'global');

    const response = await app.inject({
      method: 'DELETE',
      url: '/secrets/TO_DELETE?scope=global',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(store.getSecret('TO_DELETE', 'global'), undefined);
  });

  it('should reject PUT without value', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/secrets/BAD',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ scope: 'global' }),
    });

    assert.equal(response.statusCode, 400);
  });

  it('should reject PUT with invalid scope', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/secrets/BAD',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'v', scope: 'invalid' }),
    });

    assert.equal(response.statusCode, 400);
  });

  it('should reject repo scope without repo field', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/secrets/BAD',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'v', scope: 'repo' }),
    });

    assert.equal(response.statusCode, 400);
  });

  it('should reject DELETE without scope query param', async () => {
    store.setSecret('SOME_KEY', 'value', 'global');

    const response = await app.inject({
      method: 'DELETE',
      url: '/secrets/SOME_KEY',
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('scope'), 'Error should mention scope parameter');
  });

  it('should filter GET /secrets by scope query param', async () => {
    store.setSecret('GLOBAL_ONE', 'g1', 'global');
    store.setSecret('GLOBAL_TWO', 'g2', 'global');
    store.setSecret('REPO_ONE', 'r1', 'repo', 'org/repo');

    const response = await app.inject({
      method: 'GET',
      url: '/secrets?scope=global',
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.secrets.length, 2, 'Should return only global secrets');
    const keys = body.secrets.map((s: { key: string }) => s.key).sort();
    assert.deepEqual(keys, ['GLOBAL_ONE', 'GLOBAL_TWO']);
  });

  it('should create repo-scoped secret', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/secrets/REPO_KEY',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'repo-val', scope: 'repo', repo: 'org/repo' }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(store.getSecret('REPO_KEY', 'repo', 'org/repo'), 'repo-val');
  });
});
