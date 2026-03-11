/**
 * Fastify route plugin for GitHub webhook ingestion.
 *
 * Provides POST /webhooks/github endpoint that:
 * 1. Verifies HMAC-SHA256 signature
 * 2. Deduplicates via event buffer
 * 3. Parses the GitHub event payload
 * 4. Normalizes into an IntakeEvent
 * 5. Publishes IntakeCompleted event to the event bus
 * 6. Returns 202 Accepted immediately
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventBus } from '../shared/event-bus';
import { createDomainEvent } from '../shared/event-bus';
import type { AppConfig } from '../shared/config';
import type { Logger } from '../shared/logger';
import { verifySignature } from './signature-verifier';
import { createEventBuffer, type EventBuffer } from './event-buffer';
import { parseGitHubEvent } from './event-parser';
import { normalizeGitHubEvent } from '../intake/github-normalizer';
import {
  AppError,
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ValidationError,
} from '../shared/errors';

export interface WebhookRouterDeps {
  config: AppConfig;
  logger: Logger;
  eventBus: EventBus;
  eventBuffer?: EventBuffer;
}

// Extend FastifyRequest to hold the raw body string
declare module 'fastify' {
  interface FastifyRequest {
    rawBodyString?: string;
  }
}

/**
 * Register webhook routes on a Fastify instance.
 * This is a Fastify plugin function.
 */
export async function webhookRouter(
  fastify: FastifyInstance,
  deps: WebhookRouterDeps,
): Promise<void> {
  const { config, logger, eventBus } = deps;
  const buffer = deps.eventBuffer ?? createEventBuffer();

  // Custom content type parser that preserves the raw body string
  // for HMAC signature verification.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        const raw = body as string;
        // Stash raw body on the raw request for later retrieval
        (req as unknown as Record<string, unknown>).__rawBody = raw;
        const parsed = JSON.parse(raw);
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Hook to copy raw body from the underlying request to FastifyRequest
  fastify.addHook('preHandler', async (request) => {
    const raw = (request.raw as unknown as Record<string, unknown>).__rawBody;
    if (typeof raw === 'string') {
      request.rawBodyString = raw;
    }
  });

  fastify.post(
    '/webhooks/github',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const log = logger.child({ requestId: request.id });

      try {
        // Extract headers
        const eventType = request.headers['x-github-event'] as string | undefined;
        const deliveryId = request.headers['x-github-delivery'] as string | undefined;
        const signature = request.headers['x-hub-signature-256'] as string | undefined;

        // Validate required headers
        if (!eventType || !deliveryId) {
          throw new ValidationError('Missing required GitHub webhook headers', {
            'x-github-event': eventType ? 'present' : 'missing',
            'x-github-delivery': deliveryId ? 'present' : 'missing',
          });
        }

        // Get raw body for signature verification.
        // Prefer the captured raw string; fall back to re-serializing.
        const rawBody = request.rawBodyString ?? JSON.stringify(request.body);

        // Step 1: Verify signature
        verifySignature(rawBody, signature ?? '', config.webhookSecret);

        // Step 2: Parse event
        const payload = request.body as Record<string, unknown>;
        const parsed = parseGitHubEvent(eventType, deliveryId, payload);

        // Step 3: Deduplication and rate limiting
        buffer.check(deliveryId, parsed.repoFullName);

        // Step 4: Normalize to IntakeEvent
        const intakeEvent = normalizeGitHubEvent(parsed);

        if (!intakeEvent) {
          log.info('Event skipped (bot sender or no matching rule)', {
            eventType,
            deliveryId,
            sender: parsed.sender,
          });
          return reply.status(202).send({
            id: deliveryId,
            status: 'skipped',
          });
        }

        // Step 5: Publish IntakeCompleted event
        const domainEvent = createDomainEvent(
          'IntakeCompleted',
          { intakeEvent },
          deliveryId,
        );
        eventBus.publish(domainEvent);

        log.info('Webhook processed', {
          eventType,
          deliveryId,
          intent: intakeEvent.intent,
          repo: parsed.repoFullName,
        });

        // Step 6: Return 202 Accepted
        return reply.status(202).send({
          id: deliveryId,
          status: 'queued',
        });
      } catch (err) {
        return handleWebhookError(err, reply, log);
      }
    },
  );
}

function handleWebhookError(
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
