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
import { parsePromptContext } from './prompt-context-parser';
import type { LinearWebhookPayload } from './types';
import { agentSessionId as asId, workItemId as wId } from '../../shared/branded-types';
import { sanitizeDeep } from '../../shared/input-sanitizer';
import { handleWebhookError } from '../../shared/webhook-error-handler';
import type { IntakeEvent } from '../../types';
import type { LinearClient } from './linear-client';
import type { OAuthTokenPersistence } from './oauth-token-persistence';

/**
 * Payload shape for AgentSessionEvent webhooks from Linear.
 */
export interface AgentSessionEventPayload {
  type: 'AgentSessionEvent';
  action: 'created' | 'prompted';
  createdAt: string;
  data: { id: string; identifier?: string; title?: string; priority?: number };
  agentSession: {
    id: string;
    issue: { id: string; identifier?: string; title?: string };
    comment?: { body?: string };
  };
  promptContext?: string;
  agentActivity?: { body?: string; signal?: string | null };
}

export interface LinearWebhookHandlerDeps {
  config: AppConfig;
  logger: Logger;
  eventBus: EventBus;
  eventBuffer?: EventBuffer;
  onLinearIntake?: (intakeEvent: IntakeEvent, meta: { deliveryId: string }) => Promise<void> | void;
  linearClient?: LinearClient;
  /** Token persistence for cleanup on OAuth revocation. */
  tokenPersistence?: OAuthTokenPersistence;
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
  // Remove the default Fastify JSON parser so we can install one that
  // preserves the raw bytes for HMAC verification. When the GitHub
  // webhook router has already registered its own parser on this instance,
  // this is a no-op because the default is already gone.
  fastify.removeContentTypeParser('application/json');
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

  // Dispose event buffer on server close to stop the cleanup timer
  fastify.addHook('onClose', async () => {
    buffer.dispose();
  });

  // -------------------------------------------------------------------------
  // AgentSessionEvent handler (Phase 7D)
  // -------------------------------------------------------------------------

  async function handleAgentSessionEvent(
    payload: AgentSessionEventPayload,
    ctx: { deliveryId: string; log: Logger; reply: FastifyReply },
  ): Promise<FastifyReply> {
    const { deliveryId, log, reply } = ctx;
    const sessionId = payload.agentSession.id;
    const issueId = payload.agentSession.issue.id;
    const action = payload.action;

    // Deduplication via event buffer (FR-7D.07)
    const eventKey = `linear-session-${sessionId}-${payload.createdAt}-${action}`;
    buffer.check(eventKey, 'agent-session');

    if (action === 'created') {
      // 1. Parse rich context
      const promptContext = parsePromptContext(payload.promptContext);

      // 2. Emit thought activity immediately (10s SLA) -- must NOT block intake
      if (deps.linearClient) {
        try {
          await deps.linearClient.createAgentActivity(sessionId, {
            type: 'thought',
            body: 'Analyzing your request...',
          });
        } catch (err) {
          log.warn('Failed to emit initial thought activity', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 2b. All AgentSessionEvent (created) go to AgentPrompted — let the running
      // Claude Code session handle the content. The triage/workflow pipeline is
      // reserved for issue status changes (state, label, priority, assignee) and
      // GitHub webhooks only.
      const commentBody = payload.agentSession.comment?.body;
      const body = commentBody || promptContext.issue.description || payload.agentSession.issue.title || '';

      eventBus.publish(createDomainEvent('AgentPrompted', {
        agentSessionId: asId(sessionId),
        issueId,
        body,
      }));

      log.info('AgentSessionEvent forwarded as AgentPrompted', { deliveryId, sessionId, issueId });
      return reply.status(202).send({ id: deliveryId, status: 'prompted' });
    }

    if (action === 'prompted') {
      const body = payload.agentActivity?.body ?? '';
      const signal = payload.agentActivity?.signal;

      if (signal === 'stop') {
        // Publish WorkCancelled
        eventBus.publish(createDomainEvent('WorkCancelled', {
          workItemId: wId(`linear-session-${sessionId}`),
          cancellationReason: 'User sent stop signal via Linear',
        }));

        // Emit final response activity
        if (deps.linearClient) {
          try {
            await deps.linearClient.createAgentActivity(sessionId, {
              type: 'response',
              body: 'Stopped. No further changes will be made.',
            });
          } catch (err) {
            log.warn('Failed to emit stop response activity', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        log.info('AgentSessionEvent stop signal processed', { deliveryId, sessionId });
        return reply.status(202).send({ id: deliveryId, status: 'cancelling' });
      }

      // Normal follow-up prompt
      eventBus.publish(createDomainEvent('AgentPrompted', {
        agentSessionId: asId(sessionId),
        issueId,
        body,
      }));

      log.info('AgentSessionEvent prompted processed', { deliveryId, sessionId, issueId });
      return reply.status(202).send({ id: deliveryId, status: 'queued' });
    }

    // Unknown action
    log.info('Unknown AgentSessionEvent action skipped', { action, deliveryId, sessionId });
    return reply.status(202).send({ id: deliveryId, status: 'skipped' });
  }

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
        // SECURITY: rawBodyString MUST be set by the content type parser.
        // Falling back to JSON.stringify would produce a different byte sequence
        // than the original payload, potentially bypassing HMAC verification.
        if (!request.rawBodyString) {
          throw new Error('Raw body not captured — cannot verify webhook signature safely');
        }
        const rawBody = request.rawBodyString;

        // Step 1: Verify signature (using shared verifier with no prefix for Linear)
        verifySignature(rawBody, signature ?? '', config.linearWebhookSecret, { prefix: '' });

        // Step 2: Parse payload (sanitize untrusted webhook payload first)
        const payload = sanitizeDeep(request.body) as LinearWebhookPayload;

        // Route by payload.type
        switch (payload.type) {
          case 'Issue': {
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
              intent: intakeEvent.sourceMetadata.source === 'linear' ? intakeEvent.sourceMetadata.intent : undefined,
              issueId: payload.data.id,
              identifier: payload.data.identifier,
            });

            // Step 6: Return 202 Accepted
            return reply.status(202).send({
              id: deliveryId,
              status: 'queued',
            });
          }

          case 'AgentSessionEvent': {
            return handleAgentSessionEvent(
              payload as unknown as AgentSessionEventPayload,
              { deliveryId, log, reply },
            );
          }

          case 'OAuthAuthorization': {
            // Linear sends this when the app is revoked from a workspace.
            // Clean up persisted tokens so stale credentials don't linger.
            const action = (payload as unknown as Record<string, unknown>).action as string | undefined;
            if (action === 'revoked' || action === 'remove') {
              if (deps.tokenPersistence) {
                deps.tokenPersistence.delete('default');
                log.warn('OAuth tokens deleted — app revoked from Linear workspace', {
                  deliveryId,
                  action,
                });
              } else {
                log.warn('OAuth revocation received but no token persistence configured', {
                  deliveryId,
                  action,
                });
              }

              return reply.status(200).send({ id: deliveryId, status: 'revoked' });
            }

            log.info('OAuthAuthorization event received', { deliveryId, action });
            return reply.status(202).send({ id: deliveryId, status: 'acknowledged' });
          }

          default: {
            log.info('Unrecognized Linear event type skipped', {
              type: payload.type,
              deliveryId,
            });
            return reply.status(202).send({
              id: deliveryId,
              status: 'skipped',
            });
          }
        }
      } catch (err) {
        return handleWebhookError(err, reply, log);
      }
    },
  );
}
