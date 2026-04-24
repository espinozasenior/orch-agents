/**
 * Tests for encrypted secret store — London School TDD.
 *
 * Covers: encrypt/decrypt roundtrip, set/get/delete, resolve merging global+repo.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, createSecretStore } from '../../src/security/secret-store';
import { createSecretPersistence } from '../../src/security/secret-persistence';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// Tests: Encryption primitives
// ---------------------------------------------------------------------------

describe('encrypt/decrypt', () => {
  it('should roundtrip plaintext through encrypt/decrypt', () => {
    const plaintext = 'super-secret-value-123';
    const encrypted = encrypt(plaintext, MASTER_KEY);

    assert.ok(encrypted.iv, 'IV should be present');
    assert.ok(encrypted.ciphertext, 'Ciphertext should be present');
    assert.ok(encrypted.authTag, 'Auth tag should be present');
    assert.notEqual(encrypted.ciphertext, plaintext, 'Ciphertext should not equal plaintext');

    const decrypted = decrypt(encrypted, MASTER_KEY);
    assert.equal(decrypted, plaintext);
  });

  it('should produce different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same-input';
    const encrypted1 = encrypt(plaintext, MASTER_KEY);
    const encrypted2 = encrypt(plaintext, MASTER_KEY);

    assert.notEqual(encrypted1.iv, encrypted2.iv, 'IVs should differ');
    assert.notEqual(encrypted1.ciphertext, encrypted2.ciphertext, 'Ciphertexts should differ');

    assert.equal(decrypt(encrypted1, MASTER_KEY), plaintext);
    assert.equal(decrypt(encrypted2, MASTER_KEY), plaintext);
  });

  it('should fail to decrypt with wrong key', () => {
    const encrypted = encrypt('secret', MASTER_KEY);
    const wrongKey = randomBytes(32).toString('hex');

    assert.throws(() => decrypt(encrypted, wrongKey));
  });

  it('should fail to decrypt with tampered ciphertext', () => {
    const encrypted = encrypt('secret', MASTER_KEY);
    encrypted.ciphertext = encrypted.ciphertext.replace(/^./, 'f');

    assert.throws(() => decrypt(encrypted, MASTER_KEY));
  });
});

// ---------------------------------------------------------------------------
// Tests: Secret Store
// ---------------------------------------------------------------------------

describe('SecretStore', () => {
  let store: ReturnType<typeof createSecretStore>;

  beforeEach(() => {
    // Use in-memory SQLite for tests
    const persistence = createSecretPersistence(':memory:');
    store = createSecretStore({ persistence, masterKey: MASTER_KEY });
  });

  it('should set and get a global secret', () => {
    store.setSecret('API_KEY', 'my-api-key-value', 'global');
    const value = store.getSecret('API_KEY', 'global');
    assert.equal(value, 'my-api-key-value');
  });

  it('should set and get a repo-scoped secret', () => {
    store.setSecret('DB_URL', 'postgres://localhost', 'repo', 'org/my-repo');
    const value = store.getSecret('DB_URL', 'repo', 'org/my-repo');
    assert.equal(value, 'postgres://localhost');
  });

  it('should return undefined for non-existent secret', () => {
    const value = store.getSecret('NOPE', 'global');
    assert.equal(value, undefined);
  });

  it('should delete a secret', () => {
    store.setSecret('TEMP', 'temporary', 'global');
    assert.equal(store.getSecret('TEMP', 'global'), 'temporary');

    store.deleteSecret('TEMP', 'global');
    assert.equal(store.getSecret('TEMP', 'global'), undefined);
  });

  it('should update an existing secret', () => {
    store.setSecret('KEY', 'v1', 'global');
    assert.equal(store.getSecret('KEY', 'global'), 'v1');

    store.setSecret('KEY', 'v2', 'global');
    assert.equal(store.getSecret('KEY', 'global'), 'v2');
  });

  it('should list secrets without values', () => {
    store.setSecret('A', 'value-a', 'global');
    store.setSecret('B', 'value-b', 'repo', 'org/repo');

    const entries = store.listSecrets();
    assert.equal(entries.length, 2);

    const keys = entries.map((e) => e.key).sort();
    assert.deepEqual(keys, ['A', 'B']);

    // Entries should never contain values
    for (const entry of entries) {
      assert.ok(!('value' in entry), 'Entry should not contain value');
    }
  });

  it('should list secrets filtered by scope', () => {
    store.setSecret('G1', 'global-1', 'global');
    store.setSecret('R1', 'repo-1', 'repo', 'org/repo');

    const globalEntries = store.listSecrets('global');
    assert.equal(globalEntries.length, 1);
    assert.equal(globalEntries[0].key, 'G1');

    const repoEntries = store.listSecrets('repo', 'org/repo');
    assert.equal(repoEntries.length, 1);
    assert.equal(repoEntries[0].key, 'R1');
  });

  it('should resolve secrets merging global + repo (repo overrides)', () => {
    store.setSecret('SHARED', 'global-value', 'global');
    store.setSecret('GLOBAL_ONLY', 'only-global', 'global');
    store.setSecret('SHARED', 'repo-value', 'repo', 'org/my-repo');
    store.setSecret('REPO_ONLY', 'only-repo', 'repo', 'org/my-repo');

    const resolved = store.resolveSecrets('org/my-repo');

    assert.equal(resolved.SHARED, 'repo-value', 'Repo should override global');
    assert.equal(resolved.GLOBAL_ONLY, 'only-global', 'Global-only should be present');
    assert.equal(resolved.REPO_ONLY, 'only-repo', 'Repo-only should be present');
  });

  it('should work with a non-hex master key via SHA-256 derivation', () => {
    const plainTextKey = 'my-secret-password';
    const persistence = createSecretPersistence(':memory:');
    const nonHexStore = createSecretStore({ persistence, masterKey: plainTextKey });

    nonHexStore.setSecret('TEST_KEY', 'test-value-123', 'global');
    const value = nonHexStore.getSecret('TEST_KEY', 'global');
    assert.equal(value, 'test-value-123');
  });

  it('should resolve only global secrets for repo with no repo-scoped secrets', () => {
    store.setSecret('G1', 'global-1', 'global');

    const resolved = store.resolveSecrets('org/empty-repo');

    assert.equal(resolved.G1, 'global-1');
    assert.equal(Object.keys(resolved).length, 1);
  });
});
