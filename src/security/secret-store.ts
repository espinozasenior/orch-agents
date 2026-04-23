/**
 * Encrypted secrets store.
 *
 * AES-256-GCM encryption/decryption using Node's crypto module.
 * Provides set/get/delete/list/resolve operations for secrets
 * scoped globally or per-repo.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SecretScope, SecretEntry } from './types';
import type { SecretPersistence } from './secret-persistence';

// ---------------------------------------------------------------------------
// Encryption primitives
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const KEY_LENGTH = 32; // 256-bit key

interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  authTag: string;
}

/**
 * Derive a 32-byte key from the master key string.
 * If the key is already 32 bytes hex-encoded (64 chars), decode it.
 * Otherwise, hash it with SHA-256.
 */
function deriveKey(masterKey: string): Buffer {
  if (masterKey.length === KEY_LENGTH * 2 && /^[0-9a-f]+$/i.test(masterKey)) {
    return Buffer.from(masterKey, 'hex');
  }
  return createHash('sha256').update(masterKey).digest();
}

export function encrypt(plaintext: string, masterKey: string): EncryptedPayload {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    iv: iv.toString('hex'),
    ciphertext,
    authTag,
  };
}

export function decrypt(encrypted: EncryptedPayload, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = Buffer.from(encrypted.iv, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));

  let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}

// ---------------------------------------------------------------------------
// Secret Store
// ---------------------------------------------------------------------------

export interface SecretStore {
  setSecret(key: string, value: string, scope: SecretScope, repo?: string): void;
  getSecret(key: string, scope: SecretScope, repo?: string): string | undefined;
  deleteSecret(key: string, scope: SecretScope, repo?: string): void;
  listSecrets(scope?: SecretScope, repo?: string): SecretEntry[];
  /** Resolve all secrets for a repo: merge global + repo-scoped (repo overrides global). */
  resolveSecrets(repoFullName: string): Record<string, string>;
}

export interface SecretStoreDeps {
  persistence: SecretPersistence;
  masterKey: string;
}

export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const { persistence, masterKey } = deps;

  return {
    setSecret(key: string, value: string, scope: SecretScope, repo?: string): void {
      const encrypted = encrypt(value, masterKey);
      const now = new Date().toISOString();
      const existing = persistence.load(key, scope, repo ?? '');

      persistence.save({
        key,
        scope,
        repo: repo ?? '',
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    getSecret(key: string, scope: SecretScope, repo?: string): string | undefined {
      const record = persistence.load(key, scope, repo ?? '');
      if (!record) return undefined;

      return decrypt(
        { iv: record.iv, ciphertext: record.ciphertext, authTag: record.authTag },
        masterKey,
      );
    },

    deleteSecret(key: string, scope: SecretScope, repo?: string): void {
      persistence.remove(key, scope, repo ?? '');
    },

    listSecrets(scope?: SecretScope, repo?: string): SecretEntry[] {
      return persistence.list(scope, repo);
    },

    resolveSecrets(repoFullName: string): Record<string, string> {
      const result: Record<string, string> = {};

      // Load global secrets first
      const globalRecords = persistence.loadByScope('global', '');
      for (const record of globalRecords) {
        result[record.key] = decrypt(
          { iv: record.iv, ciphertext: record.ciphertext, authTag: record.authTag },
          masterKey,
        );
      }

      // Load repo-scoped secrets (overrides global)
      const repoRecords = persistence.loadByScope('repo', repoFullName);
      for (const record of repoRecords) {
        result[record.key] = decrypt(
          { iv: record.iv, ciphertext: record.ciphertext, authTag: record.authTag },
          masterKey,
        );
      }

      return result;
    },
  };
}
