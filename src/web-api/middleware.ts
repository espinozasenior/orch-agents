/**
 * Cross-cutting middleware for the `/v1/*` web surface.
 *
 *   - Rate-limit: 60 req/min per token (configurable). Keyed by token id when
 *     `request.tokenId` is populated by `bearerAuth`, else falls back to IP.
 *   - CORS: deny in production by default; allow `http://localhost:3000` in
 *     dev. Operators can override with WEB_CORS_ORIGINS.
 *   - Helmet: standard security headers.
 */

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';

export interface MiddlewareOptions {
  /** When true (production), CORS is deny-by-default. */
  productionMode: boolean;
  /** Comma-separated allowed origins. Empty = none. Defaults applied per env. */
  corsOrigins?: string[];
  /** Requests per minute per token (or IP if no token). Default 60. */
  rateLimitPerMinute?: number;
}

export async function registerWebMiddleware(
  fastify: FastifyInstance,
  options: MiddlewareOptions,
): Promise<void> {
  const { productionMode } = options;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? 60;

  // ── Helmet (always on) ───────────────────────────────────────
  await fastify.register(helmet, {
    // The web surface is consumed by the Next.js BFF, not directly by browsers.
    // CSP is therefore disabled here — the BFF sets its own.
    contentSecurityPolicy: false,
  });

  // ── CORS ─────────────────────────────────────────────────────
  // Default origins: localhost:3000 in dev, none in production.
  // Operators can override with WEB_CORS_ORIGINS=https://app.example.com
  const defaultOrigins = productionMode ? [] : ['http://localhost:3000'];
  const allowedOrigins = options.corsOrigins ?? defaultOrigins;

  await fastify.register(cors, {
    origin: (requestOrigin, cb) => {
      if (!requestOrigin) {
        // Same-origin / curl / server-to-server
        cb(null, true);
        return;
      }
      if (allowedOrigins.includes(requestOrigin)) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS: origin '${requestOrigin}' is not allowed`), false);
    },
    credentials: true,
  });

  // ── Rate limit ───────────────────────────────────────────────
  // The default 429 body from @fastify/rate-limit is `{statusCode, error,
  // message}`. We rely on it (a custom errorResponseBuilder gets thrown
  // through Fastify's setErrorHandler, which loses the 429 status code).
  await fastify.register(rateLimit, {
    max: rateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Prefer token id (per-token quota); fall back to IP.
      const tokenId = (request as { tokenId?: string }).tokenId;
      if (tokenId) return `token:${tokenId}`;
      return `ip:${request.ip}`;
    },
  });
}
