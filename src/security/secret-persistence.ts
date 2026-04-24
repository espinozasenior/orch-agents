/**
 * Persistent secret storage using Node.js built-in SQLite.
 *
 * Stores encrypted secrets per key/scope/repo.
 * Uses node:sqlite DatabaseSync (same pattern as oauth-token-persistence.ts).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../shared/sqlite';
import type { SecretScope, SecretEntry } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedRecord {
  key: string;
  scope: SecretScope;
  repo: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretPersistence {
  save(record: EncryptedRecord): void;
  load(key: string, scope: SecretScope, repo: string): EncryptedRecord | undefined;
  remove(key: string, scope: SecretScope, repo: string): void;
  list(scope?: SecretScope, repo?: string): SecretEntry[];
  loadByScope(scope: SecretScope, repo: string): EncryptedRecord[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSecretPersistence(dbPath: string): SecretPersistence {
  // Ensure data directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      repo TEXT NOT NULL DEFAULT '',
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (key, scope, repo)
    )
  `);

  const saveStmt = db.prepare(`
    INSERT INTO secrets (key, scope, repo, iv, ciphertext, auth_tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key, scope, repo) DO UPDATE SET
      iv = excluded.iv,
      ciphertext = excluded.ciphertext,
      auth_tag = excluded.auth_tag,
      updated_at = excluded.updated_at
  `);

  const loadStmt = db.prepare(
    'SELECT key, scope, repo, iv, ciphertext, auth_tag, created_at, updated_at FROM secrets WHERE key = ? AND scope = ? AND repo = ?',
  );

  const removeStmt = db.prepare(
    'DELETE FROM secrets WHERE key = ? AND scope = ? AND repo = ?',
  );

  const listAllStmt = db.prepare(
    'SELECT key, scope, repo, created_at, updated_at FROM secrets',
  );

  const listByScopeStmt = db.prepare(
    'SELECT key, scope, repo, created_at, updated_at FROM secrets WHERE scope = ?',
  );

  const listByScopeRepoStmt = db.prepare(
    'SELECT key, scope, repo, created_at, updated_at FROM secrets WHERE scope = ? AND repo = ?',
  );

  const loadByScopeStmt = db.prepare(
    'SELECT key, scope, repo, iv, ciphertext, auth_tag, created_at, updated_at FROM secrets WHERE scope = ? AND repo = ?',
  );

  function toEncryptedRecord(row: Record<string, unknown>): EncryptedRecord {
    return {
      key: row.key as string,
      scope: row.scope as SecretScope,
      repo: row.repo as string,
      iv: row.iv as string,
      ciphertext: row.ciphertext as string,
      authTag: row.auth_tag as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  function toSecretEntry(row: Record<string, unknown>): SecretEntry {
    return {
      key: row.key as string,
      scope: row.scope as SecretScope,
      repo: (row.repo as string) || undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  return {
    save(record: EncryptedRecord): void {
      saveStmt.run(
        record.key, record.scope, record.repo,
        record.iv, record.ciphertext, record.authTag,
        record.createdAt, record.updatedAt,
      );
    },

    load(key: string, scope: SecretScope, repo: string): EncryptedRecord | undefined {
      const row = loadStmt.get(key, scope, repo) as Record<string, unknown> | undefined;
      return row ? toEncryptedRecord(row) : undefined;
    },

    remove(key: string, scope: SecretScope, repo: string): void {
      removeStmt.run(key, scope, repo);
    },

    list(scope?: SecretScope, repo?: string): SecretEntry[] {
      let rows: Record<string, unknown>[];
      if (scope && repo) {
        rows = listByScopeRepoStmt.all(scope, repo) as Record<string, unknown>[];
      } else if (scope) {
        rows = listByScopeStmt.all(scope) as Record<string, unknown>[];
      } else {
        rows = listAllStmt.all() as Record<string, unknown>[];
      }
      return rows.map(toSecretEntry);
    },

    loadByScope(scope: SecretScope, repo: string): EncryptedRecord[] {
      const rows = loadByScopeStmt.all(scope, repo) as Record<string, unknown>[];
      return rows.map(toEncryptedRecord);
    },

    close(): void {
      db.close();
    },
  };
}
