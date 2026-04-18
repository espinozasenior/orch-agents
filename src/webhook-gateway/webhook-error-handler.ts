/**
 * Webhook error handler for Fastify webhook routes.
 *
 * Maps AppError subclasses to appropriate HTTP status codes and
 * structured error responses. Used by both the GitHub webhook router
 * and the Linear webhook handler.
 */

import type { FastifyReply } from 'fastify';
import type { Logger } from '../shared/logger';
import {
  AppError,
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ValidationError,
} from '../kernel/errors';

/**
 * Handle webhook errors by mapping AppError subclasses to HTTP responses.
 *
 * Falls back to 500 Internal Server Error for unknown error types.
 */
export function handleWebhookError(
  err: unknown,
  reply: FastifyReply,
  log: Logger,
): FastifyReply {
  if (err instanceof AuthenticationError) {
    log.warn('Webhook authentication failed', { error: err.message });
    return reply.status(401).send({
      error: { code: err.code, message: err.message },
    });
  }

  if (err instanceof ConflictError) {
    log.info('Duplicate webhook delivery', { error: err.message });
    return reply.status(409).send({
      error: { code: err.code, message: err.message },
    });
  }

  if (err instanceof RateLimitError) {
    log.warn('Webhook rate limited', { retryAfter: err.retryAfter });
    return reply
      .status(429)
      .header('Retry-After', String(err.retryAfter))
      .send({
        error: { code: err.code, message: err.message, retryAfter: err.retryAfter },
      });
  }

  if (err instanceof ValidationError) {
    log.warn('Webhook validation failed', { error: err.message, fields: err.fields });
    return reply.status(400).send({
      error: { code: err.code, message: err.message, fields: err.fields },
    });
  }

  if (err instanceof AppError) {
    log.error('Webhook processing error', { error: err.message, code: err.code });
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
  }

  log.error('Unexpected webhook error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return reply.status(500).send({
    error: { code: 'ERR_INTERNAL', message: 'An unexpected error occurred' },
  });
}
