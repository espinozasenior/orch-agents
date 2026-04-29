/**
 * Bearer-token authentication for the `/v1/*` web surface.
 *
 * Tokens are 48 bytes of CSPRNG output, base64url-encoded, prefixed with
 * `orch_`. Lookup is constant-time SHA-256 (high-entropy tokens don't need
 * slow hashing — that's for low-entropy passwords). Persistence is a
 * dedicated `web_tokens` table inside `data/secrets.db`.
 *
 * Endpoints (registered on the admin surface):
 *   GET    /admin/web-tokens          — list tokens (no plaintext)
 *   POST   /admin/web-tokens          — mint a new token (plaintext returned ONCE)
 *   DELETE /admin/web-tokens/:id      — revoke a token
 *
 * Per-route guard:
 *   fastify.addHook('preHandler', bearerAuth(tokenStore));
 *   fastify.get('/v1/runs', { preHandler: requireScope('runs:read') }, ...);
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerHookHandler,
} from 'fastify';
import { openDatabase } from '../shared/sqlite';

// ---------------------------------------------------------------------------
// Scopes & types
// ---------------------------------------------------------------------------

export const ALL_SCOPES = [
  'runs:read',
  'automations:write',
  'secrets:read',
  'secrets:write',
  'workflow:read',
] as const;

export type WebTokenScope = (typeof ALL_SCOPES)[number];

function isScope(value: string): value is WebTokenScope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

export interface WebTokenSummary {
  id: string;
  label: string;
  scopes: WebTokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MintedToken {
  id: string;
  /** Plaintext value — returned exactly once at mint, never persisted. */
  token: string;
  label: string;
  scopes: WebTokenScope[];
  createdAt: string;
}

export interface ValidatedToken {
  id: string;
  scopes: WebTokenScope[];
}

export interface WebTokenStore {
  mint(input: { label: string; scopes: WebTokenScope[] }): MintedToken;
  list(): WebTokenSummary[];
  revoke(id: string): boolean;
  /** Validate a presented bearer token. Updates lastUsedAt on success. */
  validate(presented: string): ValidatedToken | undefined;
  close(): void;
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = 'orch_';
const TOKEN_BYTES = 48;
/** Plaintext token length: prefix + base64url(48 bytes) */
const EXPECTED_TOKEN_LENGTH = TOKEN_PREFIX.length + Math.ceil((TOKEN_BYTES * 4) / 3);

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

function generateId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createWebTokenStore(dbPath: string): WebTokenStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS web_tokens (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `);

  const insertStmt = db.prepare(
    'INSERT INTO web_tokens (id, hash, label, scopes, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const listStmt = db.prepare(
    'SELECT id, label, scopes, created_at, last_used_at FROM web_tokens ORDER BY created_at DESC',
  );
  const lookupStmt = db.prepare(
    'SELECT id, hash, scopes FROM web_tokens WHERE hash = ?',
  );
  const touchStmt = db.prepare(
    'UPDATE web_tokens SET last_used_at = ? WHERE id = ?',
  );
  const deleteStmt = db.prepare('DELETE FROM web_tokens WHERE id = ?');

  return {
    mint({ label, scopes }) {
      if (!label.trim()) throw new Error('label is required');
      if (scopes.length === 0) throw new Error('at least one scope is required');
      for (const s of scopes) {
        if (!isScope(s)) throw new Error(`invalid scope: ${s}`);
      }
      const id = generateId();
      const token = generateToken();
      const hash = hashToken(token);
      const createdAt = new Date().toISOString();
      insertStmt.run(id, hash, label, scopes.join(','), createdAt);
      return { id, token, label, scopes, createdAt };
    },

    list() {
      const rows = listStmt.all() as Array<{
        id: string;
        label: string;
        scopes: string;
        created_at: string;
        last_used_at: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        scopes: row.scopes
          .split(',')
          .filter((s) => s.length > 0)
          .filter(isScope) as WebTokenScope[],
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }));
    },

    revoke(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },

    validate(presented) {
      // Length check first to short-circuit obviously-bogus inputs without
      // hashing (avoids leaking timing on invalid tokens vs valid-but-unknown).
      if (presented.length !== EXPECTED_TOKEN_LENGTH) return undefined;
      if (!presented.startsWith(TOKEN_PREFIX)) return undefined;
      const hash = hashToken(presented);
      const row = lookupStmt.get(hash) as
        | { id: string; hash: string; scopes: string }
        | undefined;
      if (!row) return undefined;
      // Defense-in-depth: timing-safe compare of the hashes (both are hex of
      // identical length, so comparison is well-defined).
      const presentedHashBuf = Buffer.from(hash, 'hex');
      const storedHashBuf = Buffer.from(row.hash, 'hex');
      if (presentedHashBuf.length !== storedHashBuf.length) return undefined;
      if (!timingSafeEqual(presentedHashBuf, storedHashBuf)) return undefined;
      touchStmt.run(new Date().toISOString(), row.id);
      return {
        id: row.id,
        scopes: row.scopes
          .split(',')
          .filter((s) => s.length > 0)
          .filter(isScope) as WebTokenScope[],
      };
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Fastify integration
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by bearerAuth() preHandler when a valid token is presented. */
    tokenScopes?: WebTokenScope[];
    tokenId?: string;
  }
}

/**
 * Fastify `onRequest` hook that validates `Authorization: Bearer <token>`.
 *
 * Must be registered as `onRequest` (not `preHandler`) so that downstream
 * `onRequest` hooks like `@fastify/rate-limit` see `request.tokenId` and
 * can key per-token quotas instead of falling back to IP.
 */
export function bearerAuth(tokenStore: WebTokenStore): onRequestHookHandler {
  return async function bearerAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'missing or malformed Authorization header' });
      return;
    }
    const presented = header.slice('Bearer '.length).trim();
    const result = tokenStore.validate(presented);
    if (!result) {
      reply.status(401).send({ error: 'invalid or revoked token' });
      return;
    }
    request.tokenId = result.id;
    request.tokenScopes = result.scopes;
  };
}

/** Per-route guard: rejects 403 unless the request bears the named scope. */
export function requireScope(scope: WebTokenScope): preHandlerHookHandler {
  return async function requireScopeHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.tokenScopes || !request.tokenScopes.includes(scope)) {
      reply.status(403).send({ error: `missing required scope: ${scope}` });
    }
  };
}

// ---------------------------------------------------------------------------
// Admin routes — token CRUD (mounted on the admin surface)
// ---------------------------------------------------------------------------

export interface WebTokenAdminDeps {
  tokenStore: WebTokenStore;
}

export async function webTokenAdminRoutes(
  fastify: FastifyInstance,
  deps: WebTokenAdminDeps,
): Promise<void> {
  const { tokenStore } = deps;

  fastify.get('/admin/web-tokens', async () => {
    return { tokens: tokenStore.list() };
  });

  fastify.post<{ Body: { label?: string; scopes?: string[] } }>(
    '/admin/web-tokens',
    async (request, reply) => {
      const { label, scopes } = request.body ?? {};
      if (!label || typeof label !== 'string') {
        return reply.status(400).send({ error: 'label is required' });
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return reply.status(400).send({ error: 'scopes must be a non-empty array' });
      }
      for (const s of scopes) {
        if (!isScope(s)) {
          return reply.status(400).send({ error: `invalid scope: ${s}` });
        }
      }
      const minted = tokenStore.mint({ label, scopes: scopes as WebTokenScope[] });
      return reply.status(201).send(minted);
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/admin/web-tokens/:id',
    async (request, reply) => {
      const removed = tokenStore.revoke(request.params.id);
      if (!removed) return reply.status(404).send({ error: 'token not found' });
      return reply.status(204).send();
    },
  );
}
