/**
 * Fastify route plugin for Linear webhook ingestion.
 *
 * Provides POST /webhooks/linear endpoint that:
 * 1. Returns 404 when LINEAR_ENABLED=false
 * 2. Verifies HMAC-SHA256 signature
 * 3. Deduplicates via event buffer
 * 4. Normalizes into an IntakeEvent
 * 5. Publishes IntakeCompleted event to the event bus
 * 6. Returns 202 Accepted immediately
 *
 * Follows the same Fastify plugin pattern as webhook-router.ts.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventBus } from '../../shared/event-bus';
import { createDomainEvent } from '../../shared/event-bus';
import type { AppConfig } from '../../shared/config';
import type { Logger } from '../../shared/logger';
import { createEventBuffer, type EventBuffer } from '../../webhook-gateway/event-buffer';
import { verifySignature } from '../../webhook-gateway/signature-verifier';
import { normalizeLinearEvent } from './linear-normalizer';
import type { LinearWebhookPayload } from './types';
import { handleWebhookError } from '../../shared/webhook-error-handler';
import type { IntakeEvent } from '../../types';

export interface LinearWebhookHandlerDeps {
  config: AppConfig;
  logger: Logger;
  eventBus: EventBus;
  eventBuffer?: EventBuffer;
  onLinearIntake?: (intakeEvent: IntakeEvent, meta: { deliveryId: string }) => Promise<void> | void;
}

/**
 * Register Linear webhook routes on a Fastify instance.
 * This is a Fastify plugin function.
 */
export async function linearWebhookHandler(
  fastify: FastifyInstance,
  deps: LinearWebhookHandlerDeps,
): Promise<void> {
  const { config, logger, eventBus } = deps;
  const buffer = deps.eventBuffer ?? createEventBuffer();

  // Capture raw body for HMAC signature verification.
  // Only register if the GitHub webhook router hasn't already registered
  // its own JSON parser on this Fastify instance.
  if (!fastify.hasContentTypeParser('application/json')) {
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        try {
          const raw = body as string;
          (req as unknown as Record<string, unknown>).__rawBody = raw;
          (req as unknown as Record<string, unknown>).rawBodyString = raw;
          const parsed = JSON.parse(raw);
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    fastify.addHook('preHandler', async (request) => {
      const raw =
        request.rawBodyString
        ?? ((request.raw as unknown as Record<string, unknown>).__rawBody as string | undefined)
        ?? ((request as unknown as Record<string, unknown>).__rawBody as string | undefined);
      if (typeof raw === 'string') {
        request.rawBodyString = raw;
      }
    });
  }

  // Dispose event buffer on server close to stop the cleanup timer
  fastify.addHook('onClose', async () => {
    buffer.dispose();
  });

  fastify.post(
    '/webhooks/linear',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const log = logger.child({ requestId: request.id });

      try {
        // Feature flag check
        if (!config.linearEnabled) {
          return reply.status(404).send({
            error: { code: 'ERR_NOT_FOUND', message: 'Linear integration disabled' },
          });
        }

        // Extract headers
        const signature = request.headers['linear-signature'] as string | undefined;
        const deliveryId = (request.headers['linear-delivery'] as string | undefined) ?? randomUUID();

        // Get raw body for signature verification
        const rawBody = request.rawBodyString ?? JSON.stringify(request.body);

        // Step 1: Verify signature (using shared verifier with no prefix for Linear)
        verifySignature(rawBody, signature ?? '', config.linearWebhookSecret, { prefix: '' });

        // Step 2: Parse payload
        const payload = request.body as LinearWebhookPayload;

        // AIG: Stop command detection in Linear comments
        if (payload.type === 'Comment' && payload.action === 'create') {
          const commentData = payload.data as unknown as Record<string, unknown>;
          const commentBody = (commentData.body as string) ?? '';
          const commentTrimmed = commentBody.trim().toLowerCase();

          if (commentTrimmed === 'stop') {
            const issueId = (commentData.issueId as string) ?? '';
            eventBus.publish(createDomainEvent('WorkCancelled', {
              workItemId: `linear-${issueId}`,
              cancellationReason: 'User requested stop via Linear comment',
            }));

            log.info('Linear stop command detected', { deliveryId, issueId });
            return reply.status(202).send({ id: deliveryId, status: 'cancelling' });
          }
        }

        // Only handle Issue events
        if (payload.type !== 'Issue') {
          log.info('Non-issue Linear event skipped', {
            type: payload.type,
            deliveryId,
          });
          return reply.status(202).send({
            id: deliveryId,
            status: 'skipped',
          });
        }

        // Step 3: Deduplication
        const eventKey = `linear-${payload.data.id}-${payload.createdAt}`;
        const teamKey = payload.data.team?.key ?? 'unknown';
        buffer.check(eventKey, teamKey);

        // Step 4: Normalize to IntakeEvent
        const intakeEvent = normalizeLinearEvent(payload, payload.updatedFrom, {
          linearBotUserId: config.linearBotUserId,
        });

        if (!intakeEvent) {
          log.info('Linear event skipped (bot sender or no matching rule)', {
            type: payload.type,
            action: payload.action,
            deliveryId,
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
        await deps.onLinearIntake?.(intakeEvent, { deliveryId });

        log.info('Linear webhook processed', {
          deliveryId,
          intent: intakeEvent.intent,
          issueId: payload.data.id,
          identifier: payload.data.identifier,
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
