/**
 * Tests for repo-resolver — Phase 8: Multi-Repository Workspace Resolution.
 *
 * Covers: label matching, team key matching, issueRepositorySuggestions API,
 * select elicitation, default repo fallback, error cases, ensureRepoCloned.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRepoForIssue,
  extractFullName,
  ensureRepoCloned,
  type ResolvedRepo,
  type RepoResolutionResult,
} from '../../src/execution/orchestrator/repo-resolver';
import type { RepoConfig } from '../../src/config';
import type { LinearClient, LinearIssueResponse } from '../../src/integration/linear/linear-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<LinearIssueResponse> = {}): LinearIssueResponse {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Test issue',
    description: 'desc',
    priority: 2,
    updatedAt: '2026-03-28T00:00:00Z',
    state: { id: 'state-1', name: 'Todo' },
    labels: { nodes: [] },
    assignee: null,
    creator: null,
    team: { id: 'team-1', key: 'ENG' },
    project: null,
    ...overrides,
  };
}

function makeRepos(overrides?: Record<string, RepoConfig>): Record<string, RepoConfig> {
  if (overrides !== undefined) return overrides;
  return {
    'espinozasenior/orch-agents': {
      url: 'git@github.com:espinozasenior/orch-agents.git',
      defaultBranch: 'main',
      teams: ['AUT'],
      labels: ['backend', 'agent', 'infra'],
    },
    'espinozasenior/frontend-app': {
      url: 'git@github.com:espinozasenior/frontend-app.git',
      defaultBranch: 'main',
      teams: ['FE'],
      labels: ['frontend', 'ui'],
    },
  };
}

function makeMockLinearClient(overrides: Partial<LinearClient> = {}): LinearClient {
  return {
    fetchIssue: async () => makeIssue(),
    fetchTeamStates: async () => [],
    fetchActiveIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchComments: async () => [],
    createComment: async () => 'comment-1',
    updateComment: async () => {},
    updateIssueState: async () => {},
    createAgentActivity: async () => 'activity-1',
    agentSessionUpdate: async () => {},
    agentSessionCreateOnIssue: async () => 'session-1',
    agentSessionCreateOnComment: async () => 'session-1',
    fetchSessionActivities: async () => ({ activities: [], hasNextPage: false }),
    issueRepositorySuggestions: async () => [],
    issueUpdate: async () => {},
    fetchViewer: async () => ({ id: 'viewer-1' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveRepoForIssue tests
// ---------------------------------------------------------------------------

describe('resolveRepoForIssue (Phase 8)', () => {
  it('returns correct repo on label match (case-insensitive)', async () => {
    const issue = makeIssue({
      labels: { nodes: [{ id: 'l1', name: 'Frontend' }] },
    });
    const repos = makeRepos();

    const result = await resolveRepoForIssue(issue, repos);

    assert.equal(result.status, 'resolved');
    assert.equal((result as { repo: ResolvedRepo }).repo.name, 'espinozasenior/frontend-app');
  });

  it('returns correct repo on team key match when no label match', async () => {
    const issue = makeIssue({
      labels: { nodes: [{ id: 'l1', name: 'bug' }] },
      team: { id: 'team-fe', key: 'fe' },
    });
    const repos = makeRepos();

    const result = await resolveRepoForIssue(issue, repos);

    assert.equal(result.status, 'resolved');
    assert.equal((result as { repo: ResolvedRepo }).repo.name, 'espinozasenior/frontend-app');
  });

  it('calls issueRepositorySuggestions when no label/team match', async () => {
    const issue = makeIssue({
      labels: { nodes: [{ id: 'l1', name: 'bug' }] },
      team: { id: 'team-x', key: 'UNKNOWN' },
    });
    const repos = makeRepos();

    let suggestionsCalled = false;
    const client = makeMockLinearClient({
      issueRepositorySuggestions: async () => {
        suggestionsCalled = true;
        return [
          { repositoryFullName: 'espinozasenior/orch-agents', hostname: 'github.com', confidence: 0.5 },
        ];
      },
    });

    await resolveRepoForIssue(issue, repos, client, 'session-1');

    assert.equal(suggestionsCalled, true);
  });

  it('auto-selects when suggestion confidence > 0.8', async () => {
    const issue = makeIssue({
      labels: { nodes: [] },
      team: { id: 'team-x', key: 'UNKNOWN' },
    });
    const repos = makeRepos();

    const client = makeMockLinearClient({
      issueRepositorySuggestions: async () => [
        { repositoryFullName: 'espinozasenior/frontend-app', hostname: 'github.com', confidence: 0.95 },
        { repositoryFullName: 'espinozasenior/orch-agents', hostname: 'github.com', confidence: 0.3 },
      ],
    });

    const result = await resolveRepoForIssue(issue, repos, client, 'session-1');

    assert.equal(result.status, 'resolved');
    assert.equal((result as { repo: ResolvedRepo }).repo.name, 'espinozasenior/frontend-app');
  });

  it('returns PENDING when low-confidence triggers select elicitation', async () => {
    const issue = makeIssue({
      labels: { nodes: [] },
      team: { id: 'team-x', key: 'UNKNOWN' },
    });
    const repos = makeRepos();

    let selectEmitted = false;
    const client = makeMockLinearClient({
      issueRepositorySuggestions: async () => [
        { repositoryFullName: 'espinozasenior/frontend-app', hostname: 'github.com', confidence: 0.5 },
        { repositoryFullName: 'espinozasenior/orch-agents', hostname: 'github.com', confidence: 0.3 },
      ],
      createAgentActivity: async () => {
        selectEmitted = true;
        return 'activity-1';
      },
    });

    const result = await resolveRepoForIssue(issue, repos, client, 'session-1');

    assert.equal(result.status, 'pending');
    assert.equal(selectEmitted, true);
  });

  it('throws when no repos configured (empty map)', async () => {
    const issue = makeIssue();

    await assert.rejects(
      () => resolveRepoForIssue(issue, {}),
      (err: Error) => err.message.includes('repos is required'),
    );
  });

  it('falls back to first repo when no label/team/suggestion match', async () => {
    const issue = makeIssue({
      labels: { nodes: [] },
      team: { id: 'team-x', key: 'UNKNOWN' },
    });
    const repos = makeRepos();

    const result = await resolveRepoForIssue(issue, repos);

    assert.equal(result.status, 'resolved');
    assert.equal((result as { repo: ResolvedRepo }).repo.name, 'espinozasenior/orch-agents');
  });

  it('handles multiple label matches and returns first hit', async () => {
    const issue = makeIssue({
      labels: { nodes: [{ id: 'l1', name: 'backend' }, { id: 'l2', name: 'frontend' }] },
    });
    const repos = makeRepos();

    const result = await resolveRepoForIssue(issue, repos);

    assert.equal(result.status, 'resolved');
    // 'backend' matches orch-agents (first repo checked)
    assert.equal((result as { repo: ResolvedRepo }).repo.name, 'espinozasenior/orch-agents');
  });
});

// ---------------------------------------------------------------------------
// extractFullName helper
// ---------------------------------------------------------------------------

describe('extractFullName', () => {
  it('extracts from SSH URL', () => {
    assert.equal(extractFullName('git@github.com:espinozasenior/orch-agents.git'), 'espinozasenior/orch-agents');
  });

  it('extracts from HTTPS URL', () => {
    assert.equal(extractFullName('https://github.com/espinozasenior/frontend-app.git'), 'espinozasenior/frontend-app');
  });

  it('extracts from HTTPS URL without .git', () => {
    assert.equal(extractFullName('https://github.com/espinozasenior/frontend-app'), 'espinozasenior/frontend-app');
  });
});

// ---------------------------------------------------------------------------
// ensureRepoCloned tests (using mock exec)
// ---------------------------------------------------------------------------

describe('ensureRepoCloned', () => {
  it('is exported as a function', () => {
    assert.equal(typeof ensureRepoCloned, 'function');
  });
});
