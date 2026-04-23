/**
 * Fastify route plugin for Slack webhook ingestion.
 *
 * Provides POST /webhooks/slack endpoint that:
 * 1. Handles Slack URL verification challenges
 * 2. Verifies Slack request signature (HMAC-SHA256)
 * 3. Normalizes app_mention / message events into IntakeEvents
 * 4. Publishes IntakeCompleted event to the event bus
 * 5. Returns 200 OK immediately
 *
 * Follows the same Fastify plugin pattern as linear-webhook-handler.ts.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventBus } from '../../kernel/event-bus';
import { createDomainEvent } from '../../kernel/event-bus';
import type { Logger } from '../../shared/logger';
import type { WorkflowConfig } from '../../config';
import { normalizeSlackEvent } from './slack-normalizer';
import type { SlackEventPayload, SlackEvent } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackWebhookHandlerDeps {
  logger: Logger;
  eventBus: EventBus;
  slackSigningSecret: string;
  workflowConfig?: WorkflowConfig;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function verifySlackSignature(
  signingSecret: string,
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
): void {
  if (!signature || !timestamp) {
    throw Object.assign(new Error('Missing Slack signature or timestamp'), { statusCode: 401 });
  }

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) {
    throw Object.assign(new Error('Slack request timestamp is stale'), { statusCode: 401 });
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const computedSig = 'v0=' + createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  const sigBuffer = Buffer.from(signature);
  const computedBuffer = Buffer.from(computedSig);

  if (sigBuffer.length !== computedBuffer.length || !timingSafeEqual(sigBuffer, computedBuffer)) {
    throw Object.assign(new Error('Invalid Slack signature'), { statusCode: 401 });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function slackWebhookHandler(
  fastify: FastifyInstance,
  deps: SlackWebhookHandlerDeps,
): Promise<void> {
  const { logger, eventBus, slackSigningSecret, workflowConfig } = deps;

  // Capture raw body for HMAC signature verification
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const raw = body as string;
        (_req as unknown as Record<string, unknown>).__rawBody = raw;
        (_req as unknown as Record<string, unknown>).rawBodyString = raw;
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
      ?? (request as unknown as Record<string, unknown>).__rawBody as string | undefined;
    if (typeof raw === 'string') {
      request.rawBodyString = raw;
    }
  });

  fastify.post(
    '/webhooks/slack',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const log = logger.child ? logger.child({ requestId: request.id }) : logger;

      try {
        const payload = request.body as SlackEventPayload;

        // Handle URL verification challenge
        if (payload.type === 'url_verification') {
          return reply.status(200).send({ challenge: payload.challenge });
        }

        // Verify signature for event_callback
        const rawBody = request.rawBodyString ?? '';
        const slackSignature = request.headers['x-slack-signature'] as string | undefined;
        const slackTimestamp = request.headers['x-slack-request-timestamp'] as string | undefined;

        verifySlackSignature(slackSigningSecret, slackSignature, slackTimestamp, rawBody);

        if (payload.type !== 'event_callback' || !payload.event) {
          return reply.status(200).send({ ok: true });
        }

        const event = payload.event;

        // Only handle app_mention and message events
        if (event.type !== 'app_mention' && event.type !== 'message') {
          return reply.status(200).send({ ok: true });
        }

        // Skip bot messages (subtype 'bot_message' or no user)
        if ('subtype' in event && event.subtype) {
          return reply.status(200).send({ ok: true });
        }

        const defaultConfig: WorkflowConfig = {
          repos: {},
          defaults: { agents: { maxConcurrentPerOrg: 8 }, stall: { timeoutMs: 300_000 }, polling: { intervalMs: 30_000, enabled: false } },
          agents: { maxConcurrent: 8 },
          agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 300_000, maxTurns: 20 },
          polling: { intervalMs: 30_000, enabled: false },
          stall: { timeoutMs: 300_000 },
          agentRunner: { stallTimeoutMs: 300_000, command: 'claude', turnTimeoutMs: 3_600_000 },
          hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
          promptTemplate: '',
        };

        const intakeEvent = normalizeSlackEvent(
          event as SlackEvent,
          workflowConfig ?? defaultConfig,
        );

        eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }));

        log.info('Slack webhook processed', {
          eventType: event.type,
          channel: event.channel,
          user: event.user,
        });

        return reply.status(200).send({ ok: true });
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
        const message = err instanceof Error ? err.message : String(err);
        log.error('Slack webhook error', { error: message, statusCode });
        return reply.status(statusCode).send({ error: message });
      }
    },
  );
}
