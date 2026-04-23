/**
 * Tests for secret persistence (SQLite CRUD) — London School TDD.
 *
 * Uses :memory: database for isolation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretPersistence, type SecretPersistence } from '../../src/security/secret-persistence';

describe('SecretPersistence', () => {
  let persistence: SecretPersistence;

  beforeEach(() => {
    persistence = createSecretPersistence(':memory:');
  });

  it('should save and load a record', () => {
    const now = new Date().toISOString();
    persistence.save({
      key: 'TEST_KEY',
      scope: 'global',
      repo: '',
      iv: 'aabbccdd',
      ciphertext: '1122334455',
      authTag: 'ffee',
      createdAt: now,
      updatedAt: now,
    });

    const loaded = persistence.load('TEST_KEY', 'global', '');
    assert.ok(loaded);
    assert.equal(loaded.key, 'TEST_KEY');
    assert.equal(loaded.scope, 'global');
    assert.equal(loaded.iv, 'aabbccdd');
    assert.equal(loaded.ciphertext, '1122334455');
    assert.equal(loaded.authTag, 'ffee');
  });

  it('should return undefined for non-existent record', () => {
    const loaded = persistence.load('MISSING', 'global', '');
    assert.equal(loaded, undefined);
  });

  it('should upsert on save with same PK', () => {
    const now = new Date().toISOString();
    persistence.save({
      key: 'K', scope: 'global', repo: '',
      iv: 'iv1', ciphertext: 'ct1', authTag: 'at1',
      createdAt: now, updatedAt: now,
    });
    persistence.save({
      key: 'K', scope: 'global', repo: '',
      iv: 'iv2', ciphertext: 'ct2', authTag: 'at2',
      createdAt: now, updatedAt: now,
    });

    const loaded = persistence.load('K', 'global', '');
    assert.ok(loaded);
    assert.equal(loaded.iv, 'iv2');
    assert.equal(loaded.ciphertext, 'ct2');
  });

  it('should remove a record', () => {
    const now = new Date().toISOString();
    persistence.save({
      key: 'DEL', scope: 'global', repo: '',
      iv: 'iv', ciphertext: 'ct', authTag: 'at',
      createdAt: now, updatedAt: now,
    });

    persistence.remove('DEL', 'global', '');
    assert.equal(persistence.load('DEL', 'global', ''), undefined);
  });

  it('should list all entries', () => {
    const now = new Date().toISOString();
    persistence.save({ key: 'A', scope: 'global', repo: '', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });
    persistence.save({ key: 'B', scope: 'repo', repo: 'org/r', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });

    const entries = persistence.list();
    assert.equal(entries.length, 2);
  });

  it('should list by scope', () => {
    const now = new Date().toISOString();
    persistence.save({ key: 'G', scope: 'global', repo: '', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });
    persistence.save({ key: 'R', scope: 'repo', repo: 'org/r', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });

    const globalEntries = persistence.list('global');
    assert.equal(globalEntries.length, 1);
    assert.equal(globalEntries[0].key, 'G');
  });

  it('should list by scope and repo', () => {
    const now = new Date().toISOString();
    persistence.save({ key: 'R1', scope: 'repo', repo: 'org/a', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });
    persistence.save({ key: 'R2', scope: 'repo', repo: 'org/b', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });

    const entries = persistence.list('repo', 'org/a');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'R1');
  });

  it('should load by scope for resolve', () => {
    const now = new Date().toISOString();
    persistence.save({ key: 'X', scope: 'global', repo: '', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });
    persistence.save({ key: 'Y', scope: 'repo', repo: 'org/r', iv: 'i', ciphertext: 'c', authTag: 'a', createdAt: now, updatedAt: now });

    const globalRecords = persistence.loadByScope('global', '');
    assert.equal(globalRecords.length, 1);
    assert.equal(globalRecords[0].key, 'X');

    const repoRecords = persistence.loadByScope('repo', 'org/r');
    assert.equal(repoRecords.length, 1);
    assert.equal(repoRecords[0].key, 'Y');
  });
});
