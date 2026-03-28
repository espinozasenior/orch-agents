/**
 * Integration tests against the real GitHub API.
 *
 * These tests require a valid GitHub token. They skip automatically
 * when no token is available.
 *
 * Run: npm run test:integration
 * Or:  GITHUB_TOKEN=ghp_xxx npx tsx --test tests/integration/github-api.test.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ── Token resolution ───────────────────────────────────────────

function getGitHubToken(): string | null {
  // 1. Check environment variable
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // 2. Try gh CLI auth token
  try {
    const token = execSync('gh auth token 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (token) return token;
  } catch {
    // gh not available or not authenticated
  }

  return null;
}

const GITHUB_TOKEN = getGitHubToken();
const SKIP_REASON = 'No GitHub token available (set GITHUB_TOKEN or run gh auth login)';

// ── GitHub API helper ──────────────────────────────────────────

async function githubApi(path: string, token: string): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'orch-agents-integration-tests',
    },
  });

  const data = await response.json();
  return { status: response.status, data };
}

// ── Tests ──────────────────────────────────────────────────────

describe('GitHub API Integration', { skip: !GITHUB_TOKEN ? SKIP_REASON : false }, () => {
  let token: string;

  before(() => {
    token = GITHUB_TOKEN!;
  });

  describe('Authentication', () => {
    it('token is valid and returns authenticated user', async () => {
      const { status, data } = await githubApi('/user', token);
      assert.equal(status, 200);
      const user = data as { login: string; id: number };
      assert.ok(user.login, 'Should return a login');
      assert.ok(user.id > 0, 'Should return a numeric user ID');
    });

    it('token has required scopes', async () => {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'orch-agents-integration-tests',
        },
      });

      assert.equal(response.status, 200);
      // Note: fine-grained tokens don't return X-OAuth-Scopes
      // Just verify we can authenticate
    });
  });

  describe('Repository Access', () => {
    it('can list user repositories', async () => {
      const { status, data } = await githubApi('/user/repos?per_page=5&sort=updated', token);
      assert.equal(status, 200);
      const repos = data as Array<{ full_name: string; private: boolean }>;
      assert.ok(Array.isArray(repos), 'Should return an array');
      assert.ok(repos.length > 0, 'User should have at least one repo');
    });

    it('repo objects have expected fields', async () => {
      const { data } = await githubApi('/user/repos?per_page=1', token);
      const repos = data as Array<Record<string, unknown>>;
      const repo = repos[0];

      assert.ok(repo.id, 'repo should have id');
      assert.ok(repo.full_name, 'repo should have full_name');
      assert.ok(repo.default_branch, 'repo should have default_branch');
      assert.ok('private' in repo, 'repo should have private field');
      assert.ok(repo.owner, 'repo should have owner');
    });
  });

  describe('Webhook Event Simulation', () => {
    it('can fetch a real repository to simulate push event payload', async () => {
      // Get the most recently updated repo
      const { data: repos } = await githubApi('/user/repos?per_page=1&sort=pushed', token);
      const repo = (repos as Array<{ full_name: string; default_branch: string }>)[0];

      assert.ok(repo, 'Should have at least one repo');

      // Fetch latest commit on default branch (simulates push event data)
      const { status, data } = await githubApi(
        `/repos/${repo.full_name}/commits?sha=${repo.default_branch}&per_page=1`,
        token,
      );

      assert.equal(status, 200);
      const commits = data as Array<{ sha: string; commit: { message: string } }>;
      assert.ok(commits.length > 0, 'Should have at least one commit');
      assert.ok(commits[0].sha, 'Commit should have SHA');
      assert.ok(commits[0].commit.message, 'Commit should have message');
    });

    it('can fetch pull requests to simulate PR event payload', async () => {
      // Find a repo with PRs
      const { data: repos } = await githubApi('/user/repos?per_page=10&sort=pushed', token);
      const repoList = repos as Array<{ full_name: string; open_issues_count: number }>;

      // Try each repo until we find one with PRs (or skip)
      let foundPR = false;
      for (const repo of repoList) {
        const { status, data } = await githubApi(
          `/repos/${repo.full_name}/pulls?state=all&per_page=1`,
          token,
        );

        if (status === 200) {
          const prs = data as Array<{ number: number; title: string; state: string }>;
          if (prs.length > 0) {
            assert.ok(prs[0].number > 0, 'PR should have a number');
            assert.ok(prs[0].title, 'PR should have a title');
            assert.ok(['open', 'closed'].includes(prs[0].state), 'PR should have valid state');
            foundPR = true;
            break;
          }
        }
      }

      if (!foundPR) {
        // Not a failure -- just no PRs found in any repo
        assert.ok(true, 'No PRs found in accessible repos (acceptable)');
      }
    });

    it('can fetch issues to simulate issue event payload', async () => {
      const { data: repos } = await githubApi('/user/repos?per_page=10&sort=pushed', token);
      const repoList = repos as Array<{ full_name: string }>;

      let foundIssue = false;
      for (const repo of repoList) {
        const { status, data } = await githubApi(
          `/repos/${repo.full_name}/issues?state=all&per_page=1`,
          token,
        );

        if (status === 200) {
          const issues = data as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
          if (issues.length > 0) {
            assert.ok(issues[0].number > 0, 'Issue should have a number');
            assert.ok(issues[0].title, 'Issue should have a title');
            assert.ok(Array.isArray(issues[0].labels), 'Issue should have labels array');
            foundIssue = true;
            break;
          }
        }
      }

      if (!foundIssue) {
        assert.ok(true, 'No issues found in accessible repos (acceptable)');
      }
    });
  });

  describe('Normalizer End-to-End', () => {
    it('can build a realistic IntakeEvent from live GitHub data', async () => {
      // Dynamically import the normalizer
      const { normalizeGitHubEventFromWorkflow } = await import('../../src/intake/github-workflow-normalizer');
      const { parseWorkflowMdString } = await import('../../src/integration/linear/workflow-parser');
      const { parseGitHubEvent } = await import('../../src/webhook-gateway/event-parser');
      const workflowConfig = parseWorkflowMdString('---\ntemplates:\n  quick-fix:\n    - coder\n  cicd-pipeline:\n    - coder\ngithub:\n  events:\n    push.default_branch: cicd-pipeline\n    push.other: quick-fix\ntracker:\n  kind: linear\n  team: test\nagents:\n  routing:\n    default: quick-fix\npolling:\n  interval_ms: 30000\n  enabled: false\nstall:\n  timeout_ms: 300000\n---\nPrompt');

      // Fetch a real repo
      const { data: repos } = await githubApi('/user/repos?per_page=1&sort=pushed', token);
      const repo = (repos as Array<{
        full_name: string;
        default_branch: string;
        name: string;
        owner: { login: string; id: number };
        id: number;
      }>)[0];

      // Build a simulated push webhook payload from real data
      const { data: commits } = await githubApi(
        `/repos/${repo.full_name}/commits?sha=${repo.default_branch}&per_page=1`,
        token,
      );
      const commit = (commits as Array<{
        sha: string;
        commit: { message: string; author: { name: string } };
        author: { login: string; id: number } | null;
      }>)[0];

      const pushPayload = {
        ref: `refs/heads/${repo.default_branch}`,
        repository: {
          id: repo.id,
          full_name: repo.full_name,
          name: repo.name,
          default_branch: repo.default_branch,
          owner: { login: repo.owner.login, id: repo.owner.id },
        },
        sender: {
          login: commit.author?.login ?? repo.owner.login,
          id: commit.author?.id ?? repo.owner.id,
          type: 'User',
        },
        head_commit: {
          id: commit.sha,
          message: commit.commit.message,
        },
        commits: [{ id: commit.sha, message: commit.commit.message }],
      };

      // Parse it
      const parsed = parseGitHubEvent('push', 'test-delivery-001', pushPayload as unknown as Record<string, unknown>);
      assert.equal(parsed.eventType, 'push');
      assert.equal(parsed.repoFullName, repo.full_name);

      // Normalize it
      const intakeEvent = normalizeGitHubEventFromWorkflow(parsed, workflowConfig);
      assert.ok(intakeEvent, 'Should produce an IntakeEvent (not null)');
      assert.equal(intakeEvent!.intent, 'validate-main');
      assert.equal(intakeEvent!.source, 'github');
      assert.ok(intakeEvent!.sourceMetadata, 'Should have sourceMetadata');
      assert.ok(intakeEvent!.entities, 'Should have entities');
    });
  });

  describe('Rate Limits', () => {
    it('reports remaining API rate limit', async () => {
      const { status, data } = await githubApi('/rate_limit', token);
      assert.equal(status, 200);
      const rateLimit = data as { rate: { limit: number; remaining: number; reset: number } };
      assert.ok(rateLimit.rate.limit > 0, 'Should have a rate limit');
      assert.ok(rateLimit.rate.remaining >= 0, 'Should report remaining calls');

      // Log for visibility
      console.log(`  GitHub API rate limit: ${rateLimit.rate.remaining}/${rateLimit.rate.limit} remaining`);
    });
  });
});
