/**
 * Append-only audit log for secret mutations performed via `/v1/secrets/*`.
 *
 * Hashes (SHA-256 hex) only — NEVER plaintext or partial plaintext. Triggers
 * enforce append-only at the SQLite layer: UPDATE and DELETE on rows raise
 * an error. Operators can still drop the table during maintenance, but no
 * application code path can rewrite history.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../shared/sqlite';

export type SecretAuditAction = 'set' | 'delete';

export interface SecretAuditEntry {
  ts: string;
  tokenId: string | null;
  action: SecretAuditAction;
  key: string;
  scope: string;
  repo: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface SecretAuditLog {
  /**
   * Record a mutation. `beforeValue` and `afterValue` accept plaintext;
   * the audit only ever persists their SHA-256 hashes.
   */
  record(input: {
    tokenId: string | null;
    action: SecretAuditAction;
    key: string;
    scope: string;
    repo?: string | null;
    beforeValue?: string | null;
    afterValue?: string | null;
  }): void;
  list(limit?: number): SecretAuditEntry[];
  count(): number;
  close(): void;
}

function hashOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.length === 0) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createSecretAuditLog(dbPath: string): SecretAuditLog {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      token_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('set','delete')),
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      repo TEXT,
      before_hash TEXT,
      after_hash TEXT
    );

    -- Append-only enforcement: raise on any UPDATE or DELETE attempt.
    CREATE TRIGGER IF NOT EXISTS secret_audit_no_update
      BEFORE UPDATE ON secret_audit
      BEGIN
        SELECT RAISE(ABORT, 'secret_audit is append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS secret_audit_no_delete
      BEFORE DELETE ON secret_audit
      BEGIN
        SELECT RAISE(ABORT, 'secret_audit is append-only');
      END;

    CREATE INDEX IF NOT EXISTS idx_secret_audit_key ON secret_audit (key, ts DESC);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO secret_audit (ts, token_id, action, key, scope, repo, before_hash, after_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listStmt = db.prepare(`
    SELECT ts, token_id, action, key, scope, repo, before_hash, after_hash
    FROM secret_audit ORDER BY id DESC LIMIT ?
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM secret_audit');

  return {
    record({ tokenId, action, key, scope, repo, beforeValue, afterValue }) {
      const beforeHash = hashOrNull(beforeValue);
      const afterHash = hashOrNull(afterValue);
      insertStmt.run(
        new Date().toISOString(),
        tokenId,
        action,
        key,
        scope,
        repo ?? null,
        beforeHash,
        afterHash,
      );
    },
    list(limit = 100): SecretAuditEntry[] {
      const rows = listStmt.all(limit) as Array<{
        ts: string;
        token_id: string | null;
        action: SecretAuditAction;
        key: string;
        scope: string;
        repo: string | null;
        before_hash: string | null;
        after_hash: string | null;
      }>;
      return rows.map((row) => ({
        ts: row.ts,
        tokenId: row.token_id,
        action: row.action,
        key: row.key,
        scope: row.scope,
        repo: row.repo,
        beforeHash: row.before_hash,
        afterHash: row.after_hash,
      }));
    },
    count(): number {
      const row = countStmt.get() as { n: number };
      return row.n;
    },
    close(): void {
      db.close();
    },
  };
}
