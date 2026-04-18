/**
 * Webhook Updater.
 *
 * Updates all configured repo webhooks with a new URL
 * (e.g., after tunnel starts with a new public URL).
 */

import type { RepoConfig } from '../integration/linear/workflow-parser';
import { createJWT } from '../integration/github-app-auth';

// All GitHub event types we subscribe to
const ALL_WEBHOOK_EVENTS = [
  'pull_request',
  'issues',
  'issue_comment',
  'push',
  'pull_request_review',
  'workflow_run',
  'release',
];

async function githubFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options?.headers,
    },
  });
}

interface WebhookUpdateResult {
  repo: string;
  action: 'updated' | 'created' | 'skipped';
  hookId?: number;
  error?: string;
}

export async function updateRepoWebhooks(
  repos: Record<string, RepoConfig>,
  webhookUrl: string,
  getToken: (repoFullName: string) => Promise<string>,
  webhookSecret: string,
): Promise<WebhookUpdateResult[]> {
  const results: WebhookUpdateResult[] = [];
  const fullWebhookUrl = `${webhookUrl}/webhooks/github`;

  for (const repoFullName of Object.keys(repos)) {
    try {
      // Resolve token for this repo's org/owner
      const token = await getToken(repoFullName);

      // List existing hooks
      const hooksRes = await githubFetch(`/repos/${repoFullName}/hooks`, token);
      if (!hooksRes.ok) {
        const errBody = await hooksRes.text().catch(() => '');
        results.push({
          repo: repoFullName,
          action: 'skipped',
          error: `Failed to list hooks (${hooksRes.status}): ${errBody}`,
        });
        continue;
      }

      const hooks = (await hooksRes.json()) as Array<{
        id: number;
        config: { url?: string };
      }>;

      // Find existing hook that points to our webhook path
      const existing = hooks.find(
        (h) => h.config.url?.includes('/webhooks/github'),
      );

      if (existing) {
        // Update existing hook with new URL
        const patchRes = await githubFetch(
          `/repos/${repoFullName}/hooks/${existing.id}`,
          token,
          {
            method: 'PATCH',
            body: JSON.stringify({
              config: {
                url: fullWebhookUrl,
                content_type: 'json',
                secret: webhookSecret,
                insecure_ssl: '0',
              },
            }),
          },
        );

        if (patchRes.ok) {
          results.push({ repo: repoFullName, action: 'updated', hookId: existing.id });
        } else {
          results.push({
            repo: repoFullName,
            action: 'skipped',
            error: `Failed to update hook #${existing.id} (${patchRes.status})`,
          });
        }
      } else {
        // Create new hook
        const createRes = await githubFetch(
          `/repos/${repoFullName}/hooks`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              name: 'web',
              active: true,
              events: ALL_WEBHOOK_EVENTS,
              config: {
                url: fullWebhookUrl,
                content_type: 'json',
                secret: webhookSecret,
                insecure_ssl: '0',
              },
            }),
          },
        );

        if (createRes.ok) {
          const created = (await createRes.json()) as { id: number };
          results.push({ repo: repoFullName, action: 'created', hookId: created.id });
        } else {
          results.push({
            repo: repoFullName,
            action: 'skipped',
            error: `Failed to create hook (${createRes.status})`,
          });
        }
      }
    } catch (err) {
      results.push({
        repo: repoFullName,
        action: 'skipped',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Update the GitHub App's own webhook URL.
 * Uses JWT auth (app-level, not installation-level).
 * Endpoint: PATCH /app/hook/config
 */
export async function updateAppWebhook(
  webhookUrl: string,
  appId: string,
  privateKeyPath: string,
  webhookSecret: string,
): Promise<{ action: 'updated' | 'skipped'; error?: string }> {
  try {
    const { readFileSync } = require('node:fs');
    const privateKey = readFileSync(privateKeyPath, 'utf-8');
    const jwt = createJWT(appId, privateKey);

    const res = await fetch('https://api.github.com/app/hook/config', {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        url: `${webhookUrl}/webhooks/github`,
        content_type: 'json',
        secret: webhookSecret,
        insecure_ssl: '0',
      }),
    });

    if (res.ok) {
      return { action: 'updated' };
    }
    return { action: 'skipped', error: `PATCH /app/hook/config failed (${res.status})` };
  } catch (err) {
    return { action: 'skipped', error: err instanceof Error ? err.message : String(err) };
  }
}
