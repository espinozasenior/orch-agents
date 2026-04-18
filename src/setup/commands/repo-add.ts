/**
 * Repo Add Command.
 *
 * Adds a repository: validates via GitHub API, creates webhook
 * (if WEBHOOK_URL is set), and writes WORKFLOW.md with a
 * commented-events template.
 */

import { resolve } from 'node:path';
import { readEnvFile } from '../env-writer';
import { createWorkflowEditor } from '../workflow-editor';
import { createGitHubAppTokenProvider } from '../../integration/github-app-auth';

const ENV_PATH = resolve(process.cwd(), '.env');

// All GitHub event types we subscribe to at the webhook level
const ALL_WEBHOOK_EVENTS = [
  'pull_request',
  'issues',
  'issue_comment',
  'push',
  'pull_request_review',
  'workflow_run',
  'release',
];

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

export async function runRepoAdd(repoFullName: string): Promise<void> {
  console.log('\n  \x1b[1m\x1b[36mAdd Repository\x1b[0m\n');

  // Validate format
  if (!repoFullName.includes('/')) {
    console.error('  Error: Repository must be in owner/repo format');
    process.exit(1);
  }

  // Load credentials — support GitHub App or PAT
  const env = readEnvFile(ENV_PATH);
  let token: string;

  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY_PATH && env.GITHUB_APP_INSTALLATION_ID) {
    const provider = createGitHubAppTokenProvider({
      appId: env.GITHUB_APP_ID,
      privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    });
    token = await provider.getToken();
    console.log('  Using GitHub App authentication');
  } else if (env.GITHUB_TOKEN) {
    token = env.GITHUB_TOKEN;
  } else {
    console.error('  Error: No GitHub credentials found in .env. Run `orch-setup github` first.');
    process.exit(1);
  }

  // Validate repo exists and fetch metadata
  console.log(`  Checking ${repoFullName}...`);
  const repoRes = await githubFetch(`/repos/${repoFullName}`, token);
  if (!repoRes.ok) {
    const errBody = await repoRes.text();
    console.error(`  Error: Repository ${repoFullName} not found or not accessible (${repoRes.status})`);
    console.error(`  ${errBody}`);
    process.exit(1);
  }

  const repoData = (await repoRes.json()) as {
    default_branch: string;
    ssh_url: string;
  };
  console.log(`  \x1b[32mRepository verified.\x1b[0m`);
  console.log(`  Default branch: ${repoData.default_branch}`);

  // Webhook creation (only if WEBHOOK_URL is available)
  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;

  if (webhookUrl) {
    if (!webhookSecret) {
      console.error('  Error: GITHUB_WEBHOOK_SECRET not found in .env. Run `orch-setup github` first.');
      process.exit(1);
    }

    console.log(`\n  Creating webhook on ${repoFullName}...`);
    const webhookRes = await githubFetch(`/repos/${repoFullName}/hooks`, token, {
      method: 'POST',
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ALL_WEBHOOK_EVENTS,
        config: {
          url: `${webhookUrl}/webhooks/github`,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0',
        },
      }),
    });

    if (!webhookRes.ok) {
      const errBody = await webhookRes.text();
      console.error(`  Error: Failed to create webhook (${webhookRes.status})`);
      console.error(`  ${errBody}`);
      process.exit(1);
    }
    console.log(`  \x1b[32mWebhook created.\x1b[0m`);
  } else {
    console.log('\n  \x1b[33mWEBHOOK_URL not set — skipping webhook creation.\x1b[0m');
    console.log('  Start the server with ENABLE_TUNNEL=true or set WEBHOOK_URL manually.');
  }

  // Write to WORKFLOW.md with commented events template
  const editor = createWorkflowEditor();
  editor.addRepoWithTemplate(repoFullName, {
    url: repoData.ssh_url,
    defaultBranch: repoData.default_branch,
  });

  console.log(`\n  \x1b[32mRepository ${repoFullName} added to WORKFLOW.md\x1b[0m`);
  console.log('  Edit WORKFLOW.md to enable/disable events for this repo.\n');
}
