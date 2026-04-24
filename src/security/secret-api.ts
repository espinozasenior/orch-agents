/**
 * Fastify plugin for secrets management API.
 *
 * Provides REST endpoints for CRUD operations on encrypted secrets.
 * Never returns secret values in list/get responses — write-only.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SecretStore } from './secret-store';
import type { SecretScope } from './types';

export interface SecretApiDeps {
  secretStore: SecretStore;
}

export async function secretApi(
  fastify: FastifyInstance,
  deps: SecretApiDeps,
): Promise<void> {
  const { secretStore } = deps;

  // GET /secrets — list all secrets (keys only, never values)
  fastify.get('/secrets', async (request: FastifyRequest, _reply: FastifyReply) => {
    const query = request.query as { scope?: SecretScope; repo?: string };
    const entries = secretStore.listSecrets(query.scope, query.repo);
    return { secrets: entries };
  });

  // PUT /secrets/:key — create or update a secret
  fastify.put<{ Params: { key: string }; Body: { value: string; scope: SecretScope; repo?: string } }>(
    '/secrets/:key',
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

      secretStore.setSecret(key, value, scope, repo);
      return reply.status(200).send({ ok: true, key, scope, repo });
    },
  );

  // DELETE /secrets/:key — delete a secret
  fastify.delete<{ Params: { key: string }; Querystring: { scope: SecretScope; repo?: string } }>(
    '/secrets/:key',
    async (request, reply) => {
      const { key } = request.params;
      const { scope, repo } = request.query;

      if (!scope) {
        return reply.status(400).send({ error: 'scope query parameter is required' });
      }

      secretStore.deleteSecret(key, scope, repo);
      return reply.status(200).send({ ok: true });
    },
  );
}
