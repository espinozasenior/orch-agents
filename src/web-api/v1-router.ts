/**
 * `/v1/*` Fastify plugin — the bearer-auth web API consumed by the
 * Next.js BFF. Mounts onto the dedicated `web` server surface.
 *
 * Hook ordering matters:
 *   1. bearerAuth (onRequest)        — populates request.tokenId/tokenScopes
 *   2. registerWebMiddleware         — rate-limit (keys on tokenId), CORS, helmet
 *   3. per-route preHandler guards   — requireScope(...)
 *
 * The order is enforced by registering bearerAuth BEFORE registering this
 * plugin (or before the middleware inside it). Doing so ensures the
 * @fastify/rate-limit hook sees a populated tokenId for per-token quotas.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SecretScope } from '../security/types';
import type { SecretStore } from '../security/secret-store';
import type { SecretAuditLog } from '../security/secret-audit';
import type { CronScheduler } from '../scheduling/cron-scheduler';
import type { AutomationRunPersistence } from '../scheduling/automation-run-persistence';
import type { RunHistory } from '../kernel/run-history';
import type { WorkflowConfig } from '../config';
import type { StatusSurfaceSnapshot } from '../webhook-gateway/webhook-router';
import { bearerAuth, requireScope, type WebTokenStore } from './web-auth';
import { registerWebMiddleware } from './middleware';

export interface V1RouterDeps {
  tokenStore: WebTokenStore;
  runHistory: RunHistory;
  secretStore?: SecretStore;
  secretAudit?: SecretAuditLog;
  cronScheduler?: CronScheduler;
  automationRunPersistence?: AutomationRunPersistence;
  workflowConfig?: WorkflowConfig;
  getStatusSnapshot?: () => StatusSurfaceSnapshot;
  /** Production mode disables permissive CORS defaults. */
  productionMode: boolean;
  /** Override allowed CORS origins. */
  corsOrigins?: string[];
  /** Per-token rate limit. Default 60/min. */
  rateLimitPerMinute?: number;
}

export async function v1Router(
  fastify: FastifyInstance,
  deps: V1RouterDeps,
): Promise<void> {
  // ── Hook 1: bearer auth ───────────────────────────────────────
  // Must be onRequest so downstream onRequest hooks (rate-limit) see tokenId.
  fastify.addHook('onRequest', bearerAuth(deps.tokenStore));

  // ── Hook 2: cross-cutting middleware (rate-limit + CORS + helmet) ─
  await registerWebMiddleware(fastify, {
    productionMode: deps.productionMode,
    corsOrigins: deps.corsOrigins,
    rateLimitPerMinute: deps.rateLimitPerMinute,
  });

  // ── Status ────────────────────────────────────────────────────
  fastify.get('/v1/status', { preHandler: requireScope('runs:read') }, async () => {
    const snapshot = deps.getStatusSnapshot?.();
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      ...(snapshot ?? {}),
    };
  });

  // ── Runs ──────────────────────────────────────────────────────
  fastify.get('/v1/runs', { preHandler: requireScope('runs:read') }, async () => {
    return { runs: deps.runHistory.list() };
  });

  fastify.get<{ Params: { planId: string } }>(
    '/v1/runs/:planId',
    { preHandler: requireScope('runs:read') },
    async (request, reply) => {
      const summary = deps.runHistory.get(request.params.planId);
      if (!summary) return reply.status(404).send({ error: 'run not found' });
      return summary;
    },
  );

  fastify.get<{ Params: { planId: string } }>(
    '/v1/runs/:planId/artifacts',
    { preHandler: requireScope('runs:read') },
    async (request, reply) => {
      const summary = deps.runHistory.get(request.params.planId);
      if (!summary) return reply.status(404).send({ error: 'run not found' });
      // Artifacts are derived from completed phases. For v1 we expose phase
      // metadata only; the binary artifacts themselves stay in the repo.
      return {
        planId: summary.planId,
        correlationId: summary.correlationId,
        phases: summary.phases,
        agentCount: summary.agents.length,
      };
    },
  );

  // ── Automations ───────────────────────────────────────────────
  if (deps.cronScheduler) {
    const cronScheduler = deps.cronScheduler;

    fastify.get('/v1/automations', { preHandler: requireScope('runs:read') }, async () => {
      return cronScheduler.getSnapshot();
    });

    fastify.post<{ Params: { id: string } }>(
      '/v1/automations/:id/trigger',
      { preHandler: requireScope('automations:write') },
      async (request, reply) => {
        try {
          const runId = await cronScheduler.triggerManually(request.params.id);
          return { runId };
        } catch (err) {
          return reply
            .status(404)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    fastify.post<{ Params: { id: string } }>(
      '/v1/automations/:id/resume',
      { preHandler: requireScope('automations:write') },
      async (request, reply) => {
        try {
          cronScheduler.resumeAutomation(request.params.id);
          return { ok: true };
        } catch (err) {
          return reply
            .status(404)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );
  }

  if (deps.automationRunPersistence) {
    const runPersistence = deps.automationRunPersistence;
    fastify.get<{ Querystring: { automationId?: string; limit?: string } }>(
      '/v1/automations/runs',
      { preHandler: requireScope('runs:read') },
      async (request, reply) => {
        const { automationId, limit } = request.query;
        if (!automationId) {
          return reply.status(400).send({ error: 'automationId is required' });
        }
        const parsedLimit = limit ? Number(limit) : 50;
        if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
          return reply.status(400).send({ error: 'limit must be a positive integer' });
        }
        return { runs: runPersistence.getRunHistory(automationId, parsedLimit) };
      },
    );
  }

  // ── Secrets (with audit hook) ─────────────────────────────────
  if (deps.secretStore) {
    const secretStore = deps.secretStore;
    const audit = deps.secretAudit;

    fastify.get<{ Querystring: { scope?: SecretScope; repo?: string } }>(
      '/v1/secrets',
      { preHandler: requireScope('secrets:read') },
      async (request) => {
        const { scope, repo } = request.query;
        return { secrets: secretStore.listSecrets(scope, repo) };
      },
    );

    fastify.put<{
      Params: { key: string };
      Body: { value?: string; scope?: SecretScope; repo?: string };
    }>(
      '/v1/secrets/:key',
      { preHandler: requireScope('secrets:write') },
      async (request, reply) => {
        const { key } = request.params;
        const { value, scope, repo } = request.body ?? {};
        if (!value || !scope) {
          return reply.status(400).send({ error: 'value and scope are required' });
        }
        if (scope !== 'global' && scope !== 'repo') {
          return reply.status(400).send({ error: 'scope must be "global" or "repo"' });
        }
        if (scope === 'repo' && !repo) {
          return reply.status(400).send({ error: 'repo is required when scope is "repo"' });
        }
        const beforeValue = secretStore.getSecret(key, scope, repo);
        secretStore.setSecret(key, value, scope, repo);
        audit?.record({
          tokenId: tokenIdOf(request),
          action: 'set',
          key,
          scope,
          repo: repo ?? null,
          beforeValue: beforeValue ?? null,
          afterValue: value,
        });
        return reply.status(200).send({ ok: true, key, scope, repo });
      },
    );

    fastify.delete<{
      Params: { key: string };
      Querystring: { scope?: SecretScope; repo?: string };
    }>(
      '/v1/secrets/:key',
      { preHandler: requireScope('secrets:write') },
      async (request, reply) => {
        const { key } = request.params;
        const { scope, repo } = request.query;
        if (!scope) {
          return reply.status(400).send({ error: 'scope query parameter is required' });
        }
        const beforeValue = secretStore.getSecret(key, scope, repo);
        secretStore.deleteSecret(key, scope, repo);
        audit?.record({
          tokenId: tokenIdOf(request),
          action: 'delete',
          key,
          scope,
          repo: repo ?? null,
          beforeValue: beforeValue ?? null,
          afterValue: null,
        });
        return reply.status(200).send({ ok: true });
      },
    );
  }

  // ── Workflow (read-only in v1; ADR-003) ──────────────────────
  if (deps.workflowConfig !== undefined) {
    const workflowConfig = deps.workflowConfig;
    fastify.get('/v1/workflow', { preHandler: requireScope('workflow:read') }, async () => {
      return { workflow: workflowConfig };
    });
  }
}

function tokenIdOf(request: FastifyRequest): string | null {
  return request.tokenId ?? null;
}
