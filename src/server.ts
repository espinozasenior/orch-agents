/**
 * Fastify HTTP server for the Orch-Agents system.
 *
 * Provides the webhook endpoint and health checks.
 * Phase 0: skeleton with health route only.
 * Phase 1: adds webhook gateway routes.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './shared/config';
import type { Logger } from './shared/logger';
import type { EventBus } from './shared/event-bus';
import { webhookRouter } from './webhook-gateway/webhook-router';
import { linearWebhookHandler } from './integration/linear/linear-webhook-handler';
import { setBotUsername } from './intake/github-workflow-normalizer';
import { setBotName } from './shared/agent-identity';
import type { WorkflowConfig } from './integration/linear/workflow-parser';

export interface ServerDependencies {
  config: AppConfig;
  logger: Logger;
  eventBus: EventBus;
  workflowConfig?: WorkflowConfig;
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

  // ── Webhook gateway routes ──────────────────────────────────
  await server.register(webhookRouter, { ...deps, workflowConfig: deps.workflowConfig });

  // ── Linear webhook route ──────────────────────────────────
  if (config.linearEnabled) {
    await server.register(linearWebhookHandler, {
      config,
      logger,
      eventBus: deps.eventBus,
    });
    logger.info('Linear webhook route registered', { path: '/webhooks/linear' });
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
