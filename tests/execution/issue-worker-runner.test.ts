/**
 * TDD: Tests for issue-worker-runner exports.
 *
 * London School — inject mocks via dependency objects.
 * Tests pure functions directly (sanitizePlanId, buildIssueDescription,
 * buildIntakeEvent), helpers with mock LinearClient, and the full
 * lifecycle with mocked IssueWorkerLifecycleDeps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LinearClient, LinearIssueResponse } from '../../src/integration/linear/linear-client';
import type { WorkflowConfig } from '../../src/config/workflow-config';
import type { WorktreeHandle } from '../../src/types';
import type { IssueWorkerLifecycleDeps } from '../../src/execution/orchestrator/issue-worker-runner';
import {
  sanitizePlanId,
  buildIssueDescription,
  buildIntakeEvent,
  setupIssueForExecution,
  emitTerminalActivity,
  emitSelectElicitation,
  emitAuthElicitation,
  runIssueWorkerLifecycle,
} from '../../src/execution/orchestrator/issue-worker-runner';
import { planId as pId } from '../../src/kernel/branded-types';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<LinearIssueResponse> = {}): LinearIssueResponse {
  return {
    id: 'issue-abc-123',
    identifier: 'ENG-42',
    title: 'Fix login bug',
    description: 'Users cannot log in with SSO',
    priority: 2,
    state: { id: 'state-1', name: 'In Progress', type: 'started' },
    labels: { nodes: [{ id: 'lbl-1', name: 'bug' }] },
    assignee: null,
    delegate: null,
    creator: { id: 'user-1', name: 'Alice' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: { id: 'proj-1', name: 'Auth' },
    updatedAt: '2026-04-17T00:00:00Z',
    ...overrides,
  };
}

function makeWorkflowConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    repos: {},
    defaults: {
      agents: { maxConcurrentPerOrg: 5 },
      stall: { timeoutMs: 60_000 },
      polling: { intervalMs: 10_000, enabled: false },
    },
    tracker: {
      kind: 'linear',
      apiKey: 'test-key',
      team: 'ENG',
      activeStates: ['In Progress'],
      terminalStates: ['Done'],
      activeTypes: ['started'],
      terminalTypes: ['completed'],
    },
    agents: { maxConcurrent: 3 },
    agent: { maxConcurrentAgents: 3, maxRetryBackoffMs: 5000, maxTurns: 10 },
    polling: { intervalMs: 10_000, enabled: false },
    stall: { timeoutMs: 60_000 },
    agentRunner: { stallTimeoutMs: 60_000, command: 'claude', turnTimeoutMs: 120_000 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 30_000 },
    promptTemplate: 'You are an agent.',
    ...overrides,
  };
}

function makeWorktreeHandle(overrides: Partial<WorktreeHandle> = {}): WorktreeHandle {
  return {
    planId: pId('issue-abc-123'),
    path: '/tmp/worktree/issue-abc-123',
    branch: 'eng-42-fix-login',
    baseBranch: 'main',
    status: 'active',
    ...overrides,
  };
}

interface MockLinearClientCalls {
  issueUpdate: Array<{ issueId: string; input: { delegateId?: string; stateId?: string } }>;
  fetchTeamStates: string[];
  createAgentActivity: Array<{ sessionId: string; content: unknown; options?: unknown }>;
  agentSessionUpdate: Array<{ id: string; updates: unknown }>;
  updateIssueState: Array<{ issueId: string; stateId: string }>;
  fetchSessionActivities: string[];
}

function makeMockLinearClient(
  overrides: Partial<LinearClient> = {},
): LinearClient & { _calls: MockLinearClientCalls } {
  const _calls: MockLinearClientCalls = {
    issueUpdate: [],
    fetchTeamStates: [],
    createAgentActivity: [],
    agentSessionUpdate: [],
    updateIssueState: [],
    fetchSessionActivities: [],
  };

  const client: LinearClient & { _calls: MockLinearClientCalls } = {
    _calls,
    async fetchIssue() { return makeIssue(); },
    async fetchTeamStates(teamId: string) {
      _calls.fetchTeamStates.push(teamId);
      return [
        { id: 'st-started', name: 'In Progress', type: 'started', position: 0 },
        { id: 'st-done', name: 'Done', type: 'completed', position: 1 },
      ];
    },
    async fetchActiveIssues() { return []; },
    async fetchIssuesByStates() { return []; },
    async fetchIssueStatesByIds() { return []; },
    async fetchComments() { return []; },
    async createComment() { return 'comment-id'; },
    async replyToComment() { return 'reply-id'; },
    async updateComment() {},
    async updateIssueState(issueId: string, stateId: string) {
      _calls.updateIssueState.push({ issueId, stateId });
    },
    async createAgentActivity(sessionId: string, content: unknown, options?: unknown) {
      _calls.createAgentActivity.push({ sessionId, content, options });
      return 'activity-id';
    },
    async agentSessionUpdate(id: string, updates: unknown) {
      _calls.agentSessionUpdate.push({ id, updates });
    },
    async agentSessionCreateOnIssue() { return 'session-id'; },
    async agentSessionCreateOnComment() { return 'session-id'; },
    async fetchSessionActivities(sessionId: string) {
      _calls.fetchSessionActivities.push(sessionId);
      return { activities: [], pageInfo: { hasNextPage: false } };
    },
    async issueRepositorySuggestions() { return []; },
    async issueUpdate(issueId: string, input: { delegateId?: string; stateId?: string }) {
      _calls.issueUpdate.push({ issueId, input });
    },
    async fetchViewer() { return { id: 'viewer-1' }; },
    ...overrides,
  };

  return client;
}

function makeLifecycleDeps(
  overrides: Partial<IssueWorkerLifecycleDeps> = {},
): IssueWorkerLifecycleDeps & { _released: Array<{ handle: WorktreeHandle; status: string }> } {
  const _released: Array<{ handle: WorktreeHandle; status: string }> = [];
  const handle = makeWorktreeHandle();

  return {
    _released,
    issue: makeIssue(),
    attempt: 0,
    workflowConfig: makeWorkflowConfig(),
    async acquireWorkspace() { return handle; },
    async releaseWorkspace(h: WorktreeHandle, status: string) {
      _released.push({ handle: h, status });
    },
    async executeTurn() {
      return { status: 'completed' as const, totalDuration: 500 };
    },
    async fetchIssue() {
      // Return issue in terminal state to end the loop
      return makeIssue({ state: { id: 'state-done', name: 'Done', type: 'completed' } });
    },
    async updateWorkpad() { return 'workpad-comment-id'; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('sanitizePlanId', () => {
  it('strips special characters, keeps alphanumeric/dots/dashes', () => {
    assert.equal(sanitizePlanId('abc-123.xyz'), 'abc-123.xyz');
  });

  it('replaces slashes and spaces with dashes', () => {
    assert.equal(sanitizePlanId('proj/issue 42!@#'), 'proj-issue-42---');
  });

  it('handles empty string', () => {
    assert.equal(sanitizePlanId(''), '');
  });

  it('preserves uppercase letters', () => {
    assert.equal(sanitizePlanId('ENG-42'), 'ENG-42');
  });
});

describe('buildIssueDescription', () => {
  it('with description returns it', () => {
    const issue = makeIssue({ description: 'Detailed bug report here' });
    assert.equal(buildIssueDescription(issue), 'Detailed bug report here');
  });

  it('without description returns "identifier: title"', () => {
    const issue = makeIssue({ description: undefined });
    assert.equal(buildIssueDescription(issue), 'ENG-42: Fix login bug');
  });

  it('with whitespace-only description returns "identifier: title"', () => {
    const issue = makeIssue({ description: '   \n  ' });
    assert.equal(buildIssueDescription(issue), 'ENG-42: Fix login bug');
  });
});

describe('buildIntakeEvent', () => {
  it('constructs correct IntakeEvent shape', () => {
    const issue = makeIssue();
    const event = buildIntakeEvent({
      issue,
      category: 'coordinator',
      attempt: 0,
      defaultRepo: 'my-org/my-repo',
      defaultBranch: 'develop',
    });

    assert.equal(event.id, 'issue-abc-123');
    assert.equal(event.source, 'linear');
    assert.equal(event.sourceMetadata.source, 'linear');
    assert.equal(event.entities.repo, 'my-org/my-repo');
    assert.equal(event.entities.branch, 'develop');
    assert.deepEqual(event.entities.labels, ['bug']);
    assert.equal(event.entities.requirementId, 'ENG-42');
    assert.equal(event.entities.projectId, 'proj-1');
    assert.ok(event.timestamp, 'should have a timestamp');
    assert.equal(event.rawText, 'Users cannot log in with SSO');
  });

  it('defaults branch to main when not specified', () => {
    const event = buildIntakeEvent({
      issue: makeIssue(),
      category: 'coordinator',
      attempt: 0,
    });
    assert.equal(event.entities.branch, 'main');
    assert.equal(event.entities.repo, undefined);
  });

  it('includes linearIdentifier and linearTitle in metadata', () => {
    const event = buildIntakeEvent({
      issue: makeIssue(),
      category: 'coordinator',
      attempt: 2,
    });
    const meta = event.sourceMetadata as { linearIdentifier?: string; linearTitle?: string; attempt?: number };
    assert.equal(meta.linearIdentifier, 'ENG-42');
    assert.equal(meta.linearTitle, 'Fix login bug');
    assert.equal(meta.attempt, 2);
  });
});

// ---------------------------------------------------------------------------
// Helper tests with mock LinearClient
// ---------------------------------------------------------------------------

describe('setupIssueForExecution', () => {
  it('no linearClient is a no-op', async () => {
    // Should not throw
    await setupIssueForExecution(undefined, makeIssue(), 'agent-user-1');
  });

  it('with client sets delegate and moves to started state', async () => {
    const client = makeMockLinearClient();
    const issue = makeIssue({ delegate: null, state: { id: 'st-1', name: 'Triage', type: 'triage' } });

    await setupIssueForExecution(client, issue, 'agent-user-1');

    assert.equal(client._calls.issueUpdate.length, 1);
    assert.equal(client._calls.issueUpdate[0].input.delegateId, 'agent-user-1');
    assert.equal(client._calls.updateIssueState.length, 1);
    assert.equal(client._calls.updateIssueState[0].stateId, 'st-started');
  });

  it('skips delegate set if already has delegate', async () => {
    const client = makeMockLinearClient();
    const issue = makeIssue({ delegate: { id: 'existing-delegate' } });

    await setupIssueForExecution(client, issue, 'agent-user-1');

    assert.equal(client._calls.issueUpdate.length, 0);
  });

  it('skips state change if already started', async () => {
    const client = makeMockLinearClient();
    const issue = makeIssue({ state: { id: 'st-1', name: 'In Progress', type: 'started' } });

    await setupIssueForExecution(client, issue, 'agent-user-1');

    assert.equal(client._calls.fetchTeamStates.length, 0);
    assert.equal(client._calls.updateIssueState.length, 0);
  });
});

describe('emitTerminalActivity', () => {
  it('response type on success', async () => {
    const client = makeMockLinearClient();
    await emitTerminalActivity(client, 'session-1', 'response', 'All done');

    assert.equal(client._calls.createAgentActivity.length, 1);
    const call = client._calls.createAgentActivity[0];
    assert.equal(call.sessionId, 'session-1');
    assert.deepEqual(call.content, { type: 'response', body: 'All done' });
  });

  it('error type on failure', async () => {
    const client = makeMockLinearClient();
    await emitTerminalActivity(client, 'session-1', 'error', 'Something broke');

    assert.equal(client._calls.createAgentActivity.length, 1);
    const call = client._calls.createAgentActivity[0];
    assert.deepEqual(call.content, { type: 'error', body: 'Something broke' });
  });

  it('no-op when linearClient is undefined', async () => {
    // Should not throw
    await emitTerminalActivity(undefined, 'session-1', 'response', 'done');
  });

  it('no-op when agentSessionId is undefined', async () => {
    const client = makeMockLinearClient();
    await emitTerminalActivity(client, undefined, 'response', 'done');
    assert.equal(client._calls.createAgentActivity.length, 0);
  });
});

describe('emitSelectElicitation', () => {
  it('renders options', async () => {
    const client = makeMockLinearClient();
    const options = [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
    ];

    await emitSelectElicitation(client, 'session-1', 'Pick one', options);

    assert.equal(client._calls.createAgentActivity.length, 1);
    const call = client._calls.createAgentActivity[0];
    assert.equal(call.sessionId, 'session-1');
    assert.deepEqual(call.content, { type: 'elicitation', body: 'Pick one' });
    const opts = call.options as { signal: string; signalMetadata: { options: typeof options } };
    assert.equal(opts.signal, 'select');
    assert.deepEqual(opts.signalMetadata.options, options);
  });
});

describe('emitAuthElicitation', () => {
  it('renders auth button', async () => {
    const client = makeMockLinearClient();
    await emitAuthElicitation(client, 'session-1', 'https://auth.example.com', 'GitHub');

    assert.equal(client._calls.createAgentActivity.length, 1);
    const call = client._calls.createAgentActivity[0];
    assert.deepEqual(call.content, {
      type: 'elicitation',
      body: 'Please link your GitHub account to continue.',
    });
    const opts = call.options as { signal: string; signalMetadata: { url: string; providerName: string } };
    assert.equal(opts.signal, 'auth');
    assert.equal(opts.signalMetadata.url, 'https://auth.example.com');
    assert.equal(opts.signalMetadata.providerName, 'GitHub');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe('runIssueWorkerLifecycle', () => {
  it('happy path returns completed', async () => {
    const deps = makeLifecycleDeps();

    const result = await runIssueWorkerLifecycle(deps);

    assert.equal(result.status, 'completed');
    assert.ok(result.totalDuration >= 0, 'should have a positive duration');
    assert.equal(result.workspacePath, '/tmp/worktree/issue-abc-123');
  });

  it('failure returns failed status', async () => {
    const deps = makeLifecycleDeps({
      async executeTurn() {
        return { status: 'failed' as const, totalDuration: 100 };
      },
    });

    const result = await runIssueWorkerLifecycle(deps);

    assert.equal(result.status, 'failed');
  });

  it('workspace release always called in finally block', async () => {
    // Test successful path releases workspace
    const deps = makeLifecycleDeps();
    await runIssueWorkerLifecycle(deps);

    assert.equal(deps._released.length, 1, 'should release workspace on success');
    assert.equal(deps._released[0].status, 'completed');
  });

  it('workspace release called on failure path', async () => {
    const deps = makeLifecycleDeps({
      async executeTurn() {
        return { status: 'failed' as const, totalDuration: 100 };
      },
    });

    await runIssueWorkerLifecycle(deps);

    assert.equal(deps._released.length, 1, 'should release workspace on failure');
    assert.equal(deps._released[0].status, 'failed');
  });

  it('workspace release called even when executeTurn throws', async () => {
    const deps = makeLifecycleDeps({
      async executeTurn() {
        throw new Error('boom');
      },
    });

    await assert.rejects(() => runIssueWorkerLifecycle(deps), { message: 'boom' });
    assert.equal(deps._released.length, 1, 'should release workspace when executor throws');
  });
});
