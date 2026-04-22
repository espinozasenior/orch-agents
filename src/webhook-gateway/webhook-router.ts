/**
 * Fastify route plugin for GitHub webhook ingestion.
 *
 * Provides POST /webhooks/github endpoint that:
 * 1. Verifies HMAC-SHA256 signature
 * 2. Deduplicates via event buffer
 * 3. Parses the GitHub event payload
 * 4. Normalizes into an IntakeEvent using WORKFLOW.md config
 * 5. Publishes IntakeCompleted event to the event bus
 * 6. Returns 202 Accepted immediately
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventBus } from '../kernel/event-bus';
import { createDomainEvent } from '../kernel/event-bus';
import { workItemId as wId } from '../kernel/branded-types';
import { isGitHubMeta } from '../types';
import type { AppConfig } from '../shared/config';
import type { Logger } from '../shared/logger';
import { verifySignature } from './signature-verifier';
import { createEventBuffer, type EventBuffer } from './event-buffer';
import { parseGitHubEvent } from './event-parser';
import { normalizeGitHubEventFromWorkflow } from '../intake/github-workflow-normalizer';
import type { WorkflowConfig } from '../config';
import { resolveRepoConfig } from '../config';
import { ValidationError } from '../kernel/errors';
import { sanitizeDeep } from '../shared/input-sanitizer';
import { handleWebhookError } from './webhook-error-handler';
import { getBotName, getBotMarker } from '../kernel/agent-identity';
import type { OrchestratorSnapshot } from '../execution/orchestrator/symphony-orchestrator';

export interface WebhookRouterDeps {
  config: AppConfig;
  logger: Logger;
  eventBus: EventBus;
  eventBuffer?: EventBuffer;
  workflowConfig?: WorkflowConfig;
  getStatusSnapshot?: () => StatusSurfaceSnapshot;
}

export interface StatusSurfaceSnapshot {
  workflow: {
    valid: boolean;
    error?: string;
  };
  orchestrator?: OrchestratorSnapshot;
  tunnel?: {
    enabled: boolean;
    url: string;
  };
  links?: {
    dashboardUrl?: string;
    terminalSnapshotUrl?: string;
  };
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

  // Dispose event buffer on server close to stop the cleanup timer
  fastify.addHook('onClose', async () => {
    buffer.dispose();
  });

  // Custom content type parser that preserves the raw body string
  // for HMAC signature verification.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        const raw = body as string;
        // Stash raw body in multiple places because Fastify exposes different
        // request objects at parse time vs route time depending on plugin scope.
        (req as unknown as Record<string, unknown>).__rawBody = raw;
        (req as unknown as Record<string, unknown>).rawBodyString = raw;
        const parsed = JSON.parse(raw);
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Hook to copy raw body from the underlying request to FastifyRequest
  fastify.addHook('preHandler', async (request) => {
    const raw =
      request.rawBodyString
      ?? ((request.raw as unknown as Record<string, unknown>).__rawBody as string | undefined)
      ?? ((request as unknown as Record<string, unknown>).__rawBody as string | undefined);
    if (typeof raw === 'string') {
      request.rawBodyString = raw;
    }
  });

  fastify.get('/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = deps.getStatusSnapshot?.() ?? buildEmptyStatusSnapshot(deps.workflowConfig);
    return reply.status(200).send(projectStatusSurface(snapshot));
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
        // SECURITY: rawBodyString MUST be set by the content type parser.
        // Falling back to JSON.stringify would produce a different byte sequence
        // than the original payload, potentially bypassing HMAC verification.
        if (!request.rawBodyString) {
          throw new ValidationError('Raw body not captured — cannot verify webhook signature safely', {
            hint: 'Content type parser did not preserve the raw request body',
          });
        }
        const rawBody = request.rawBodyString;

        // Step 1: Verify signature
        verifySignature(rawBody, signature ?? '', config.webhookSecret);

        // Step 2: Parse event (sanitize untrusted webhook payload first)
        const payload = sanitizeDeep(request.body) as Record<string, unknown>;
        const parsed = parseGitHubEvent(eventType, deliveryId, payload);

        // Skip push events from agent branches (prevents feedback loop)
        if (eventType === 'push' && parsed.branch?.startsWith('agent/')) {
          log.info('Skipping push from agent branch', { branch: parsed.branch, deliveryId });
          return reply.status(202).send({ id: deliveryId, status: 'skipped' });
        }

        // Skip create events for agent branches
        if (eventType === 'create' && parsed.branch?.startsWith('agent/')) {
          log.info('Skipping create for agent branch', { branch: parsed.branch, deliveryId });
          return reply.status(202).send({ id: deliveryId, status: 'skipped' });
        }

        // Skip synchronize events from bot pushes (prevents feedback loop
        // when ci-status agent pushes a fix triggering pull_request.synchronize)
        if (eventType === 'pull_request' && parsed.action === 'synchronize' && parsed.senderIsBot) {
          log.info('Skipping synchronize from bot', { sender: parsed.sender, deliveryId });
          return reply.status(202).send({ id: deliveryId, status: 'skipped' });
        }

        // Skip PR opened/reopened events from bot (prevents feedback loop
        // when agent creates a PR via gh pr create)
        if (eventType === 'pull_request' && (parsed.action === 'opened' || parsed.action === 'reopened') && parsed.senderIsBot) {
          log.info('Skipping bot-opened PR', { sender: parsed.sender, prNumber: parsed.prNumber, deliveryId });
          return reply.status(202).send({ id: deliveryId, status: 'skipped' });
        }

        // Step 2.5: Self-comment loop prevention for issue_comment events
        if (eventType === 'issue_comment' && parsed.commentBody) {
          const commentAuthor = (
            (payload as Record<string, unknown>).comment as Record<string, unknown> | undefined
          )?.user as Record<string, unknown> | undefined;
          const commentLogin = commentAuthor?.login as string | undefined;

          // Use centralized bot identity (auto-resolved from GitHub App slug or BOT_USERNAME)
          const botName = getBotName();
          const isBotMarker = parsed.commentBody.includes(getBotMarker());
          const isBotUser = botName && commentLogin === botName;

          if (isBotMarker || isBotUser) {
            log.info('Skipping self-generated bot comment', {
              eventType,
              deliveryId,
              commentLogin,
              hasBotMarker: isBotMarker,
              matchesBotUsername: isBotUser,
            });
            return reply.status(202).send({
              id: deliveryId,
              status: 'skipped',
            });
          }

          // AIG: Stop command detection — only explicit commands, not embedded words
          const commentTrimmed = parsed.commentBody.trim().toLowerCase();
          const isDirectCommand = commentTrimmed === 'stop' || commentTrimmed === 'cancel' || commentTrimmed === 'abort';
          const escapedBotName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const mentionStop = new RegExp(`@${escapedBotName}\\s+(?:stop|cancel|abort)`, 'i');
          const isMentionCommand = mentionStop.test(parsed.commentBody);

          if (isDirectCommand || isMentionCommand) {
            const cancelWorkItemId = wId(`pr-${parsed.prNumber ?? parsed.issueNumber}`);
            const cancelEvent = createDomainEvent('WorkCancelled', {
              workItemId: cancelWorkItemId,
              cancellationReason: `User requested stop via comment: "${parsed.commentBody.slice(0, 100)}"`,
            }, deliveryId);
            eventBus.publish(cancelEvent);

            log.info('Stop command detected', { sender: parsed.sender, deliveryId, workItemId: cancelWorkItemId });
            return reply.status(202).send({ id: deliveryId, status: 'cancelling' });
          }
        }

        // Step 3: Deduplication and rate limiting
        buffer.check(deliveryId, parsed.repoFullName);

        // Step 4: Resolve per-repo config from WORKFLOW.md repos: map
        if (!deps.workflowConfig) {
          throw new ValidationError('WorkflowConfig not loaded — WORKFLOW.md is required', {});
        }
        const repoConfig = resolveRepoConfig(deps.workflowConfig, parsed.repoFullName);
        if (!repoConfig) {
          log.info('Event from unconfigured repo, skipping', {
            repo: parsed.repoFullName,
            deliveryId,
          });
          return reply.status(202).send({ id: deliveryId, status: 'skipped' });
        }

        // Step 5: Normalize to IntakeEvent using per-repo config
        const intakeEvent = normalizeGitHubEventFromWorkflow(parsed, repoConfig);

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

        // Step 6: Publish IntakeCompleted event
        const domainEvent = createDomainEvent(
          'IntakeCompleted',
          { intakeEvent },
          deliveryId,
        );
        eventBus.publish(domainEvent);

        const meta = intakeEvent.sourceMetadata;
        log.info('Webhook processed', {
          eventType,
          deliveryId,
          ruleKey: isGitHubMeta(meta) ? meta.ruleKey : undefined,
          skillPath: isGitHubMeta(meta) ? meta.skillPath : undefined,
          repo: parsed.repoFullName,
        });

        // Step 7: Return 202 Accepted
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

function buildEmptyStatusSnapshot(workflowConfig?: WorkflowConfig): StatusSurfaceSnapshot {
  return {
    workflow: { valid: true },
    orchestrator: {
      starting: false,
      workflow: { valid: true },
      running: [],
      retries: [],
      claimed: [],
      completed: [],
      startup: {
        cleanedWorkspaces: [],
      },
      ...(workflowConfig?.polling.enabled ? { nextPollAt: undefined } : {}),
    },
  };
}

function projectStatusSurface(snapshot: StatusSurfaceSnapshot) {
  const orchestrator = snapshot.orchestrator ?? {
    starting: false,
    workflow: { valid: snapshot.workflow.valid, error: snapshot.workflow.error },
    running: [],
    retries: [],
    claimed: [],
    completed: [],
    startup: { cleanedWorkspaces: [] },
    nextPollAt: undefined,
  };

  const tokenTotals = orchestrator.running.reduce(
    (totals, entry) => ({
      input: totals.input + (entry.tokenUsage?.input ?? 0),
      output: totals.output + (entry.tokenUsage?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );

  const latestRunningEvent = [...orchestrator.running].sort(
    (left, right) => right.lastEventTimestamp - left.lastEventTimestamp,
  )[0];

  const latestError = snapshot.workflow.error
    ? {
      source: 'workflow',
      message: snapshot.workflow.error,
    }
    : latestRunningEvent && latestRunningEvent.lastEventType === 'error'
      ? {
        source: 'orchestrator',
        message: latestRunningEvent.lastEventType,
        issueId: latestRunningEvent.issueId,
      }
      : null;

  return {
    workflow: snapshot.workflow,
    tunnel: snapshot.tunnel ?? null,
    summary: {
      activeIssueCount: orchestrator.running.length,
      retryCount: orchestrator.retries.length,
      nextRefreshAt: orchestrator.nextPollAt ?? null,
      tokenTotals,
    },
    running: orchestrator.running.map((entry) => ({
      ...entry,
      runtimeDurationMs: Math.max(0, Date.now() - entry.startedAt),
    })),
    retries: orchestrator.retries,
    latestError,
    links: snapshot.links ?? {},
  };
}
