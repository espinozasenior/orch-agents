/**
 * Fastify HTTP server for the Orch-Agents system.
 *
 * Provides the webhook endpoint and health checks.
 * Phase 0: skeleton with health route only.
 * Phase 1: adds webhook gateway routes.
 */

import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './shared/config';
import type { Logger } from './shared/logger';
import type { EventBus } from './kernel/event-bus';
import { webhookRouter } from './webhook-gateway/webhook-router';
import { linearWebhookHandler } from './integration/linear/linear-webhook-handler';
import { slackWebhookHandler } from './integration/slack/slack-webhook-handler';
import { setBotUsername } from './intake/github-workflow-normalizer';
import { setBotName } from './kernel/agent-identity';
import type { WorkflowConfig } from './config';
import type { IntakeEvent } from './types';
import type { StatusSurfaceSnapshot } from './webhook-gateway/webhook-router';
import type { LinearAuthStrategy } from './integration/linear/linear-client';
import type { OAuthTokenStore } from './integration/linear/oauth-token-store';
import type { OAuthTokenPersistence } from './integration/linear/oauth-token-persistence';
import type { CronScheduler } from './scheduling/cron-scheduler';
import type { SecretStore } from './security/secret-store';
import { secretApi } from './security/secret-api';

export interface ServerDependencies {
  config: AppConfig;
  logger: Logger;
  eventBus: EventBus;
  workflowConfig?: WorkflowConfig;
  onLinearIntake?: (intakeEvent: IntakeEvent, meta: { deliveryId: string }) => Promise<void> | void;
  getStatusSnapshot?: () => StatusSurfaceSnapshot;
  /** Direct spawn strategy for child agent status API (optional, only in direct mode). */
  directSpawnStrategy?: import('./execution/runtime/direct-spawn-strategy').DirectSpawnStrategy;
  /** OAuth auth strategy for Linear (optional, enables /oauth/* routes). */
  linearAuthStrategy?: LinearAuthStrategy;
  /** OAuth token store for Linear (optional, enables /oauth/* routes). */
  oauthTokenStore?: OAuthTokenStore;
  /** Linear client for Agent Activity emission in webhook handler. */
  linearClient?: import('./integration/linear/linear-client').LinearClient;
  /** Token persistence for cleanup on OAuth revocation. */
  tokenPersistence?: OAuthTokenPersistence;
  /** Cron scheduler for automation routes (optional). */
  cronScheduler?: CronScheduler;
  /** Secret store for the secrets management API (optional). */
  secretStore?: SecretStore;
}

/**
 * Build and configure the Fastify server instance.
 *
 * Does NOT start listening -- call `server.listen()` separately.
 * This factory pattern enables testing without binding to a port.
 */
export async function buildServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const { config, logger } = deps;

  if (config.botUsername) {
    setBotUsername(config.botUsername);
    setBotName(config.botUsername);
  }

  const server = Fastify({
    logger: false, // We use our own logger
    disableRequestLogging: true,
  });

  // ── Health check ─────────────────────────────────────────────
  server.get('/health', async (_request, _reply) => {
    return {
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // ── Automation scheduling API ────────────────────────────────
  if (deps.cronScheduler) {
    const cronScheduler = deps.cronScheduler;

    server.get('/automations', async () => {
      return cronScheduler.getSnapshot();
    });

    server.post<{ Params: { id: string } }>('/automations/:id/trigger', async (request, reply) => {
      try {
        const runId = await cronScheduler.triggerManually(request.params.id);
        return { runId };
      } catch (err) {
        return reply.status(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.post<{ Params: { id: string } }>('/automations/:id/resume', async (request, reply) => {
      try {
        cronScheduler.resumeAutomation(request.params.id);
        return { ok: true };
      } catch (err) {
        return reply.status(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.post<{ Params: { id: string } }>('/webhooks/automation/:id', async (request, reply) => {
      try {
        const runId = await cronScheduler.triggerWebhook(request.params.id);
        return { runId };
      } catch (err) {
        return reply.status(404).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    logger.info('Automation routes registered', {
      routes: ['/automations', '/automations/:id/trigger', '/automations/:id/resume', '/webhooks/automation/:id'],
    });
  }

  // ── Child agent status API (direct spawn mode) ──────────────
  if (deps.directSpawnStrategy) {
    const strategy = deps.directSpawnStrategy;

    server.get('/children', async (_request, _reply) => {
      return {
        paused: strategy.isPaused(),
        active: strategy.getActiveChildren(),
        all: strategy.getAllChildren(),
      };
    });

    server.get<{ Params: { id: string } }>('/children/:id', async (request, reply) => {
      const child = strategy.getChildStatus(request.params.id);
      if (!child) return reply.status(404).send({ error: 'Child not found' });
      return child;
    });

    server.post('/children/reset-pause', async (_request, _reply) => {
      strategy.resetPause();
      return { status: 'ok', paused: false };
    });

    logger.info('Child agent status API enabled', { routes: ['/children', '/children/:id', '/children/reset-pause'] });
  }

  // ── Webhook gateway routes ──────────────────────────────────
  await server.register(webhookRouter, {
    ...deps,
    workflowConfig: deps.workflowConfig,
    getStatusSnapshot: deps.getStatusSnapshot,
  });

  // ── Linear webhook route ──────────────────────────────────
  if (config.linearEnabled) {
    await server.register(linearWebhookHandler, {
      config,
      logger,
      eventBus: deps.eventBus,
      onLinearIntake: deps.onLinearIntake,
      linearClient: deps.linearClient,
      tokenPersistence: deps.tokenPersistence,
    });
    logger.info('Linear webhook route registered', { path: '/webhooks/linear' });
  }

  // ── Slack webhook route ──────────────────────────────────
  if (config.slackEnabled) {
    await server.register(slackWebhookHandler, {
      logger,
      eventBus: deps.eventBus,
      slackSigningSecret: config.slackSigningSecret,
      workflowConfig: deps.workflowConfig,
    });
    logger.info('Slack webhook route registered', { path: '/webhooks/slack' });
  }

  // ── Secrets management API ──────────────────────────────────
  if (deps.secretStore) {
    await server.register(secretApi, {
      secretStore: deps.secretStore,
    });
    logger.info('Secrets API routes registered', { routes: ['/secrets', '/secrets/:key'] });
  }

  // ── OAuth routes (Phase 7A) ──────────────────────────────────
  if (config.linearAuthMode === 'oauth' && config.linearClientId) {
    // CSRF state store: state token → creation timestamp (ms)
    const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
    const oauthStateStore = new Map<string, number>();

    /** Remove expired state entries (older than TTL). */
    function purgeExpiredStates(): void {
      const now = Date.now();
      for (const [token, ts] of oauthStateStore) {
        if (now - ts > STATE_TTL_MS) {
          oauthStateStore.delete(token);
        }
      }
    }

    server.get('/oauth/authorize', async (_request, reply) => {
      const state = randomBytes(16).toString('hex');
      oauthStateStore.set(state, Date.now());

      const params = new URLSearchParams({
        client_id: config.linearClientId,
        redirect_uri: config.linearRedirectUri,
        response_type: 'code',
        scope: 'read,write,app:assignable,app:mentionable',
        actor: 'app',
        state,
      });
      const url = `https://linear.app/oauth/authorize?${params.toString()}`;
      return reply.redirect(url);
    });

    server.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
      '/oauth/callback',
      async (request, reply) => {
        purgeExpiredStates();

        const { code, error: oauthError, state } = request.query;
        if (oauthError) {
          logger.error('OAuth callback error', { error: oauthError });
          return reply.status(400).send({ error: oauthError });
        }
        if (!state || !oauthStateStore.has(state)) {
          logger.error('OAuth callback missing or invalid state parameter');
          return reply.status(400).send({ error: 'Invalid or missing state parameter' });
        }
        oauthStateStore.delete(state);

        if (!code) {
          return reply.status(400).send({ error: 'Missing authorization code' });
        }

        const tokenStore = deps.oauthTokenStore;
        if (!tokenStore) {
          return reply.status(500).send({ error: 'OAuth token store not configured' });
        }

        try {
          await tokenStore.exchangeCode(code, config.linearRedirectUri);

          // Future: query viewer.organization.id to determine workspace ID.
          // For now, use a static key; the viewer query can be added when
          // the LinearClient gains a dedicated `fetchViewer()` method.
          const workspaceId = 'default';

          logger.info('OAuth code exchange successful', { workspaceId });
          return reply.send({
            ok: true,
            workspaceId,
            tokenKey: `linear_oauth_token_${workspaceId}`,
          });
        } catch (err) {
          logger.error('OAuth code exchange failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          return reply.status(500).send({
            error: 'Code exchange failed',
          });
        }
      },
    );

    logger.info('OAuth routes registered', {
      authorize: '/oauth/authorize',
      callback: '/oauth/callback',
    });
  }

  // ── Request logging hook ─────────────────────────────────────
  server.addHook('onRequest', async (request) => {
    logger.debug('Incoming request', {
      method: request.method,
      url: request.url,
      requestId: request.id,
    });
  });

  server.addHook('onResponse', async (request, reply) => {
    logger.info('Request completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      requestId: request.id,
    });
  });

  // ── Error handler ────────────────────────────────────────────
  server.setErrorHandler(async (err, _request, reply) => {
    const fastifyError = err as { message?: string; statusCode?: number };
    const message = fastifyError.message ?? 'Unknown error';
    const statusCode = fastifyError.statusCode ?? 500;

    logger.error('Unhandled request error', { message, statusCode });

    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: statusCode >= 500 ? 'An unexpected error occurred' : message,
      },
    });
  });

  return server;
}
