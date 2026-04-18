/**
 * Repo Remove Command.
 *
 * Removes a repository from WORKFLOW.md and optionally deletes
 * the GitHub webhook. NEVER deletes the actual GitHub repository.
 */

import { resolve } from 'node:path';
import type { TerminalIO, SelectItem } from '../types';
import { singleSelect } from '../renderer';
import { readEnvFile } from '../env-writer';
import { createWorkflowEditor } from '../workflow-editor';

const ENV_PATH = resolve(process.cwd(), '.env');

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function runRepoRemove(io: TerminalIO, repoFullName: string): Promise<void> {
  io.write('\n  \x1b[1m\x1b[36mRemove Repository\x1b[0m\n\n');

  if (!repoFullName.includes('/')) {
    console.error('  Error: Repository must be in owner/repo format');
    process.exit(1);
  }

  const editor = createWorkflowEditor();
  const repos = editor.listRepos();
  const entry = repos.find((r) => r.name === repoFullName);

  if (!entry) {
    console.error(`  Error: Repository ${repoFullName} not found in WORKFLOW.md`);
    process.exit(1);
  }

  // Show repo info
  io.write(`  Repository: \x1b[1m${repoFullName}\x1b[0m\n`);
  io.write(`  URL:        ${entry.config.url}\n`);
  if (entry.config.github?.events) {
    const eventCount = Object.keys(entry.config.github.events).length;
    io.write(`  Events:     ${eventCount} configured\n`);
  }
  io.write('\n');

  // Confirm removal
  const confirmItems: SelectItem<'yes' | 'no'>[] = [
    { value: 'no', label: 'Cancel', description: 'Keep the repository', selected: true },
    { value: 'yes', label: 'Remove', description: 'Remove from WORKFLOW.md', selected: false },
  ];

  const confirm = await singleSelect(io, `Remove ${repoFullName}?`, confirmItems);
  if (confirm === 'no') {
    io.write('\n  \x1b[2mCancelled.\x1b[0m\n');
    return;
  }

  // Ask about webhook deletion
  const webhookItems: SelectItem<'yes' | 'no'>[] = [
    { value: 'no', label: 'Keep webhook', description: 'Leave the webhook on GitHub', selected: true },
    { value: 'yes', label: 'Delete webhook', description: 'Also remove webhook from GitHub', selected: false },
  ];

  const deleteWebhook = await singleSelect(io, 'Delete the webhook from GitHub?', webhookItems);

  if (deleteWebhook === 'yes') {
    const env = readEnvFile(ENV_PATH);
    const token = env.GITHUB_TOKEN;

    if (!token) {
      io.write('\n  \x1b[33mWarning: GITHUB_TOKEN not found in .env, skipping webhook deletion.\x1b[0m\n');
    } else {
      io.write(`\n  Looking for webhooks on ${repoFullName}...\n`);

      const hooksRes = await githubFetch(`/repos/${repoFullName}/hooks`, token);
      if (hooksRes.ok) {
        const hooks = (await hooksRes.json()) as Array<{ id: number; config: { url?: string } }>;
        const serverUrl = editor.getServerUrl();

        // Find webhooks that match our server URL
        const matching = serverUrl
          ? hooks.filter((h) => h.config.url?.includes(serverUrl))
          : hooks;

        if (matching.length === 0) {
          io.write('  \x1b[2mNo matching webhooks found.\x1b[0m\n');
        } else {
          for (const hook of matching) {
            const delRes = await githubFetch(`/repos/${repoFullName}/hooks/${hook.id}`, token, {
              method: 'DELETE',
            });
            if (delRes.ok || delRes.status === 204) {
              io.write(`  \x1b[32mDeleted webhook #${hook.id}\x1b[0m\n`);
            } else {
              io.write(`  \x1b[33mFailed to delete webhook #${hook.id} (${delRes.status})\x1b[0m\n`);
            }
          }
        }
      } else {
        io.write(`  \x1b[33mCould not list webhooks (${hooksRes.status})\x1b[0m\n`);
      }
    }
  }

  // Remove from WORKFLOW.md
  try {
    editor.removeRepo(repoFullName);
    console.log(`\n  \x1b[32mRepository ${repoFullName} removed from WORKFLOW.md\x1b[0m`);
  } catch (err) {
    console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
