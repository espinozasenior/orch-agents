/**
 * Persistent OAuth token storage using Node.js built-in SQLite.
 *
 * Stores tokens per-workspace so they survive server restarts.
 * Uses node:sqlite (experimental in Node 22+, no external deps).
 */

import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../shared/logger';
import type { OAuthTokenSet } from './oauth-token-store';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OAuthTokenPersistence {
  /** Load tokens for a workspace. Returns undefined if not found. */
  load(workspaceId: string): OAuthTokenSet | undefined;
  /** Save tokens for a workspace. */
  save(workspaceId: string, tokens: OAuthTokenSet): void;
  /** Delete tokens for a workspace. */
  delete(workspaceId: string): void;
  /** Close the database connection. */
  close(): void;
}

export interface OAuthTokenPersistenceDeps {
  /** Path to SQLite database file. Defaults to ./data/oauth-tokens.db */
  dbPath?: string;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOAuthTokenPersistence(deps: OAuthTokenPersistenceDeps = {}): OAuthTokenPersistence {
  const dbPath = deps.dbPath ?? './data/oauth-tokens.db';
  const logger = deps.logger;

  // Ensure data directory exists
  const { mkdirSync } = require('node:fs');
  const { dirname } = require('node:path');
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      workspace_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const loadStmt = db.prepare(
    'SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE workspace_id = ?',
  );
  const saveStmt = db.prepare(`
    INSERT INTO oauth_tokens (workspace_id, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(workspace_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `);
  const deleteStmt = db.prepare(
    'DELETE FROM oauth_tokens WHERE workspace_id = ?',
  );

  logger?.info('OAuth token persistence initialized', { dbPath });

  return {
    load(workspaceId: string): OAuthTokenSet | undefined {
      const row = loadStmt.get(workspaceId) as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
      } | undefined;

      if (!row) return undefined;

      logger?.debug('OAuth tokens loaded from persistence', { workspaceId });
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
      };
    },

    save(workspaceId: string, tokens: OAuthTokenSet): void {
      saveStmt.run(workspaceId, tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
      logger?.debug('OAuth tokens saved to persistence', { workspaceId });
    },

    delete(workspaceId: string): void {
      deleteStmt.run(workspaceId);
      logger?.debug('OAuth tokens deleted from persistence', { workspaceId });
    },

    close(): void {
      db.close();
    },
  };
}
