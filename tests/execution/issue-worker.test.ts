import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runIssueWorkerLifecycle,
  setupIssueForExecution,
  emitTerminalActivity,
} from '../../src/execution/orchestrator/issue-worker-runner';
import type { WorkflowConfig } from '../../src/config';
import type { LinearClient, LinearIssueResponse } from '../../src/integration/linear/linear-client';
import type { WorktreeHandle } from '../../src/types';

function makeWorkflowConfig(): WorkflowConfig {
  return {
    templates: {
      'quick-fix': ['.claude/agents/core/coder.md'],
    },
    tracker: {
      kind: 'linear',
      apiKey: 'test-key',
      team: 'team-1',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
    },
    agents: {
      maxConcurrent: 1,
      routing: { default: 'quick-fix' },
      defaultTemplate: 'quick-fix',
    },
    agent: {
      maxConcurrentAgents: 1,
      maxRetryBackoffMs: 1000,
      maxTurns: 20,
    },
    polling: {
      intervalMs: 1000,
      enabled: true,
    },
    stall: {
      timeoutMs: 300000,
    },
    agentRunner: {
      stallTimeoutMs: 300000,
      command: 'claude',
      turnTimeoutMs: 60000,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    promptTemplate: 'Issue {{ issue.identifier }}',
  };
}

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

describe('issue-worker lifecycle', () => {
  it('reuses the same workspace across continuation turns', async () => {
    const handle: WorktreeHandle = {
      planId: 'issue-1',
      path: '/tmp/orch-agents/issue-1',
      branch: 'issue/issue-1',
      baseBranch: 'main',
      status: 'active',
    };
    const workspacePaths: string[] = [];
    const commentIds: Array<string | undefined> = [];
    const releasedStatuses: string[] = [];

    const result = await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => handle,
      releaseWorkspace: async (_handle, status) => {
        releasedStatuses.push(status);
      },
      executeTurn: async (_plan, _intakeEvent, turnHandle) => {
        workspacePaths.push(turnHandle.path);
        return {
          status: 'completed',
          totalDuration: 10,
          sessionId: 'session-1',
          lastActivityAt: '2026-03-29T00:00:00.000Z',
          continuationState: {
            resumable: true,
            sessionId: 'session-1',
            reason: 'max_turns',
          },
          tokenUsage: { input: 5, output: 2 },
        };
      },
      fetchIssue: async (_issueId) => {
        return workspacePaths.length === 1
          ? makeIssue({ state: { id: 'state-2', name: 'In Progress' } })
          : makeIssue({ state: { id: 'state-3', name: 'Done' } });
      },
      updateWorkpad: async ({ currentCommentId, status }) => {
        commentIds.push(currentCommentId);
        return status === 'active' && !currentCommentId ? 'comment-1' : currentCommentId;
      },
      defaultRepo: 'owner/repo',
      defaultBranch: 'main',
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(workspacePaths, ['/tmp/orch-agents/issue-1', '/tmp/orch-agents/issue-1']);
    assert.equal(commentIds[0], undefined);
    assert.equal(commentIds[1], 'comment-1');
    assert.deepEqual(releasedStatuses, ['completed']);
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.lastActivityAt, '2026-03-29T00:00:00.000Z');
    assert.deepEqual(result.continuationState, {
      resumable: true,
      sessionId: 'session-1',
      reason: 'max_turns',
    });
    assert.deepEqual(result.tokenUsage, { input: 5, output: 2 });
  });

  it('stops when the issue transitions to a terminal state', async () => {
    let executeCount = 0;
    const releasedStatuses: string[] = [];

    const result = await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
          planId: 'issue-1',
          path: '/tmp/orch-agents/issue-1',
          branch: 'issue/issue-1',
          baseBranch: 'main',
          status: 'active',
        }),
      releaseWorkspace: async (_handle, status) => {
        releasedStatuses.push(status);
      },
      executeTurn: async () => {
        executeCount += 1;
        return { status: 'completed', totalDuration: 5 };
      },
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
    });

    assert.equal(result.status, 'completed');
    assert.equal(executeCount, 1);
    assert.equal(result.workpadCommentId, 'comment-1');
    assert.deepEqual(releasedStatuses, ['completed']);
  });

  it('returns failed when a turn fails', async () => {
    const releasedStatuses: string[] = [];
    const result = await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
          planId: 'issue-1',
          path: '/tmp/orch-agents/issue-1',
          branch: 'issue/issue-1',
          baseBranch: 'main',
          status: 'active',
        }),
      releaseWorkspace: async (_handle, status) => {
        releasedStatuses.push(status);
      },
      executeTurn: async () => ({ status: 'failed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue(),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(releasedStatuses, ['failed']);
  });

  it('preserves workspace when the issue becomes paused/non-active', async () => {
    const releasedStatuses: string[] = [];

    const result = await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async (_handle, status) => {
        releasedStatuses.push(status);
      },
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-9', name: 'Human Review' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
    });

    assert.equal(result.status, 'paused');
    assert.deepEqual(releasedStatuses, ['paused']);
  });
});

// ---------------------------------------------------------------------------
// Phase 7H: setupIssueForExecution tests
// ---------------------------------------------------------------------------

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

describe('setupIssueForExecution (Phase 7H)', () => {
  it('sets delegate when issue has no delegate', async () => {
    const calls: Array<{ issueId: string; input: Record<string, unknown> }> = [];
    const client = makeMockLinearClient({
      issueUpdate: async (issueId, input) => { calls.push({ issueId, input }); },
      fetchTeamStates: async () => [
        { id: 'state-started', name: 'In Progress', type: 'started', position: 1 },
      ],
    });

    const issue = makeIssue({ delegate: null, state: { id: 's1', name: 'Todo', type: 'unstarted' } });
    await setupIssueForExecution(client, issue, 'agent-user-1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].issueId, 'issue-1');
    assert.deepEqual(calls[0].input, { delegateId: 'agent-user-1' });
  });

  it('does NOT overwrite existing delegate', async () => {
    const calls: Array<{ issueId: string; input: Record<string, unknown> }> = [];
    const client = makeMockLinearClient({
      issueUpdate: async (issueId, input) => { calls.push({ issueId, input }); },
      fetchTeamStates: async () => [
        { id: 'state-started', name: 'In Progress', type: 'started', position: 1 },
      ],
    });

    const issue = makeIssue({
      delegate: { id: 'existing-delegate', name: 'Human' },
      state: { id: 's1', name: 'Todo', type: 'unstarted' },
    });
    await setupIssueForExecution(client, issue, 'agent-user-1');

    // issueUpdate should NOT have been called for delegate
    assert.equal(calls.length, 0);
  });

  it('moves issue to first started state when in backlog/unstarted', async () => {
    const stateUpdates: Array<{ issueId: string; stateId: string }> = [];
    const client = makeMockLinearClient({
      fetchTeamStates: async () => [
        { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
        { id: 'state-in-review', name: 'In Review', type: 'started', position: 3 },
        { id: 'state-in-progress', name: 'In Progress', type: 'started', position: 1 },
        { id: 'state-done', name: 'Done', type: 'completed', position: 5 },
      ],
      updateIssueState: async (issueId, stateId) => { stateUpdates.push({ issueId, stateId }); },
    });

    const issue = makeIssue({ state: { id: 's1', name: 'Backlog', type: 'backlog' } });
    await setupIssueForExecution(client, issue, undefined);

    assert.equal(stateUpdates.length, 1);
    assert.equal(stateUpdates[0].issueId, 'issue-1');
    assert.equal(stateUpdates[0].stateId, 'state-in-progress'); // lowest position started state
  });

  it('does NOT move issue when already in started state', async () => {
    const stateUpdates: Array<{ issueId: string; stateId: string }> = [];
    const client = makeMockLinearClient({
      fetchTeamStates: async () => [
        { id: 'state-in-progress', name: 'In Progress', type: 'started', position: 1 },
      ],
      updateIssueState: async (issueId, stateId) => { stateUpdates.push({ issueId, stateId }); },
    });

    const issue = makeIssue({ state: { id: 's2', name: 'In Progress', type: 'started' } });
    await setupIssueForExecution(client, issue, undefined);

    assert.equal(stateUpdates.length, 0);
  });

  it('does NOT move issue when already in completed state', async () => {
    const stateUpdates: Array<{ issueId: string; stateId: string }> = [];
    const client = makeMockLinearClient({
      fetchTeamStates: async () => [
        { id: 'state-in-progress', name: 'In Progress', type: 'started', position: 1 },
      ],
      updateIssueState: async (issueId, stateId) => { stateUpdates.push({ issueId, stateId }); },
    });

    const issue = makeIssue({ state: { id: 's3', name: 'Done', type: 'completed' } });
    await setupIssueForExecution(client, issue, undefined);

    assert.equal(stateUpdates.length, 0);
  });

  it('does NOT move issue when already in canceled state', async () => {
    const stateUpdates: Array<{ issueId: string; stateId: string }> = [];
    const client = makeMockLinearClient({
      fetchTeamStates: async () => [
        { id: 'state-in-progress', name: 'In Progress', type: 'started', position: 1 },
      ],
      updateIssueState: async (issueId, stateId) => { stateUpdates.push({ issueId, stateId }); },
    });

    const issue = makeIssue({ state: { id: 's4', name: 'Canceled', type: 'canceled' } });
    await setupIssueForExecution(client, issue, undefined);

    assert.equal(stateUpdates.length, 0);
  });

  it('logs warning but does not throw when delegate call fails', async () => {
    const warnings: string[] = [];
    const client = makeMockLinearClient({
      issueUpdate: async () => { throw new Error('API error'); },
    });
    const logger = { warn: (msg: string) => { warnings.push(msg); } };

    const issue = makeIssue({ delegate: null, state: { id: 's1', name: 'In Progress', type: 'started' } });
    await setupIssueForExecution(client, issue, 'agent-user-1', logger);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('delegate'));
  });

  it('logs warning but does not throw when state transition fails', async () => {
    const warnings: string[] = [];
    const client = makeMockLinearClient({
      fetchTeamStates: async () => { throw new Error('API error'); },
    });
    const logger = { warn: (msg: string) => { warnings.push(msg); } };

    const issue = makeIssue({ state: { id: 's1', name: 'Todo', type: 'unstarted' } });
    await setupIssueForExecution(client, issue, undefined, logger);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('started state'));
  });

  it('skips everything when linearClient is undefined', async () => {
    // Should not throw
    await setupIssueForExecution(undefined, makeIssue(), 'agent-user-1');
  });
});

// ---------------------------------------------------------------------------
// Phase 7H: emitTerminalActivity tests
// ---------------------------------------------------------------------------

describe('emitTerminalActivity (Phase 7H)', () => {
  it('emits response activity on successful completion', async () => {
    const activities: Array<{ sessionId: string; content: { type: string; body: string } }> = [];
    const client = makeMockLinearClient({
      createAgentActivity: async (sessionId, content) => {
        activities.push({ sessionId, content: content as { type: string; body: string } });
        return 'activity-1';
      },
    });

    await emitTerminalActivity(client, 'session-1', 'response', 'Work completed');

    assert.equal(activities.length, 1);
    assert.equal(activities[0].sessionId, 'session-1');
    assert.deepEqual(activities[0].content, { type: 'response', body: 'Work completed' });
  });

  it('emits error activity on failure', async () => {
    const activities: Array<{ sessionId: string; content: { type: string; body: string } }> = [];
    const client = makeMockLinearClient({
      createAgentActivity: async (sessionId, content) => {
        activities.push({ sessionId, content: content as { type: string; body: string } });
        return 'activity-1';
      },
    });

    await emitTerminalActivity(client, 'session-1', 'error', 'Build failed');

    assert.equal(activities.length, 1);
    assert.equal(activities[0].sessionId, 'session-1');
    assert.deepEqual(activities[0].content, { type: 'error', body: 'Build failed' });
  });

  it('does not throw when createAgentActivity fails', async () => {
    const warnings: string[] = [];
    const client = makeMockLinearClient({
      createAgentActivity: async () => { throw new Error('Network error'); },
    });
    const logger = { warn: (msg: string) => { warnings.push(msg); } };

    await emitTerminalActivity(client, 'session-1', 'response', 'Done', logger);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('terminal'));
  });

  it('skips when linearClient is undefined', async () => {
    // Should not throw
    await emitTerminalActivity(undefined, 'session-1', 'response', 'Done');
  });

  it('skips when agentSessionId is undefined', async () => {
    const client = makeMockLinearClient();
    // Should not throw
    await emitTerminalActivity(client, undefined, 'response', 'Done');
  });
});

// ---------------------------------------------------------------------------
// Phase 7F: Plan sync tests
// ---------------------------------------------------------------------------

describe('issue-worker plan sync (Phase 7F)', () => {
  it('updates plan to inProgress on first phase', async () => {
    const planUpdates: Array<{ plan: Array<{ content: string; status: string }> }> = [];
    const client = makeMockLinearClient({
      agentSessionUpdate: async (_id, updates) => {
        if (updates.plan) {
          planUpdates.push({ plan: updates.plan as Array<{ content: string; status: string }> });
        }
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    // First plan update should have step 0 as inProgress
    assert.ok(planUpdates.length > 0, 'Should have plan updates');
    const firstUpdate = planUpdates[0];
    assert.equal(firstUpdate.plan[0].status, 'inProgress');
    assert.equal(firstUpdate.plan[0].content, 'Research and analyze issue');
    assert.equal(firstUpdate.plan[1].status, 'pending');
  });

  it('marks plan steps completed after successful phase', async () => {
    const planUpdates: Array<{ plan: Array<{ content: string; status: string }> }> = [];
    const client = makeMockLinearClient({
      agentSessionUpdate: async (_id, updates) => {
        if (updates.plan) {
          planUpdates.push({ plan: updates.plan as Array<{ content: string; status: string }> });
        }
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    // The last plan update on completion should have all steps completed
    const lastUpdate = planUpdates[planUpdates.length - 1];
    assert.ok(lastUpdate, 'Should have at least one plan update');
    for (const step of lastUpdate.plan) {
      assert.equal(step.status, 'completed', `Step "${step.content}" should be completed`);
    }
  });

  it('marks plan steps canceled on failure', async () => {
    const planUpdates: Array<{ plan: Array<{ content: string; status: string }> }> = [];
    const client = makeMockLinearClient({
      agentSessionUpdate: async (_id, updates) => {
        if (updates.plan) {
          planUpdates.push({ plan: updates.plan as Array<{ content: string; status: string }> });
        }
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'failed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue(),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    // The last plan update on failure should have current+remaining as canceled
    const lastUpdate = planUpdates[planUpdates.length - 1];
    assert.ok(lastUpdate, 'Should have at least one plan update');
    const canceledSteps = lastUpdate.plan.filter((s) => s.status === 'canceled');
    assert.ok(canceledSteps.length > 0, 'Should have canceled steps on failure');
  });

  it('links PR URL to session externalUrls on completion', async () => {
    const externalUrlUpdates: Array<{ addedExternalUrls: Array<{ label: string; url: string }> }> = [];
    const client = makeMockLinearClient({
      agentSessionUpdate: async (_id, updates) => {
        if (updates.addedExternalUrls) {
          externalUrlUpdates.push({ addedExternalUrls: updates.addedExternalUrls });
        }
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({
        status: 'completed',
        totalDuration: 5,
        prUrl: 'https://github.com/owner/repo/pull/42',
      }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    assert.equal(externalUrlUpdates.length, 1);
    assert.equal(externalUrlUpdates[0].addedExternalUrls[0].label, 'Pull Request');
    assert.equal(externalUrlUpdates[0].addedExternalUrls[0].url, 'https://github.com/owner/repo/pull/42');
  });

  it('retries plan update on transient failure (first call fails, second succeeds)', async () => {
    let callCount = 0;
    const client = makeMockLinearClient({
      agentSessionUpdate: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('Network error');
        }
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    // At least 2 calls: first fails, second succeeds
    assert.ok(callCount >= 2, `Expected at least 2 agentSessionUpdate calls, got ${callCount}`);
  });

  it('does not update plan when agentSessionId is absent', async () => {
    let updateCalled = false;
    const client = makeMockLinearClient({
      agentSessionUpdate: async () => {
        updateCalled = true;
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      // agentSessionId NOT provided
    });

    assert.equal(updateCalled, false, 'agentSessionUpdate should not be called without agentSessionId');
  });

  it('fetches conversation history at start when agentSessionId is present', async () => {
    const fetchedSessionIds: string[] = [];
    const client = makeMockLinearClient({
      fetchSessionActivities: async (sessionId) => {
        fetchedSessionIds.push(sessionId);
        return {
          activities: [
            { type: 'prompt', body: 'User said hello' },
            { type: 'response', body: 'Agent replied' },
          ],
          hasNextPage: false,
        };
      },
    });

    await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    assert.ok(fetchedSessionIds.includes('session-1'), 'Should have fetched session activities');
  });
});

// ---------------------------------------------------------------------------
// Phase 7G: Agent signal elicitation helpers
// ---------------------------------------------------------------------------

describe('emitAuthElicitation (Phase 7G)', () => {
  it('emits elicitation activity with auth signal and correct metadata', async () => {
    const { emitAuthElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    const activities: Array<{ sessionId: string; content: unknown; options: unknown }> = [];
    const client = makeMockLinearClient({
      createAgentActivity: async (sessionId, content, options) => {
        activities.push({ sessionId, content, options });
        return 'activity-auth';
      },
    });

    await emitAuthElicitation(client, 'session-1', 'https://example.com/oauth/start', 'GitHub');

    assert.equal(activities.length, 1);
    assert.equal(activities[0].sessionId, 'session-1');
    assert.deepStrictEqual(activities[0].content, {
      type: 'elicitation',
      body: 'Please link your GitHub account to continue.',
    });
    assert.deepStrictEqual(activities[0].options, {
      signal: 'auth',
      signalMetadata: {
        url: 'https://example.com/oauth/start',
        providerName: 'GitHub',
      },
    });
  });

  it('skips when linearClient is undefined', async () => {
    const { emitAuthElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    // Should not throw
    await emitAuthElicitation(undefined, 'session-1', 'https://example.com/oauth', 'GitHub');
  });

  it('skips when sessionId is undefined', async () => {
    const { emitAuthElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    const client = makeMockLinearClient();
    // Should not throw
    await emitAuthElicitation(client, undefined, 'https://example.com/oauth', 'GitHub');
  });

  it('logs warning but does not throw on API failure', async () => {
    const { emitAuthElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    const warnings: string[] = [];
    const client = makeMockLinearClient({
      createAgentActivity: async () => { throw new Error('API error'); },
    });
    const logger = { warn: (msg: string) => { warnings.push(msg); } };

    await emitAuthElicitation(client, 'session-1', 'https://example.com/oauth', 'GitHub', logger);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('auth elicitation'));
  });
});

describe('emitSelectElicitation (Phase 7G)', () => {
  it('emits elicitation activity with select signal and options', async () => {
    const { emitSelectElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    const activities: Array<{ sessionId: string; content: unknown; options: unknown }> = [];
    const client = makeMockLinearClient({
      createAgentActivity: async (sessionId, content, options) => {
        activities.push({ sessionId, content, options });
        return 'activity-select';
      },
    });

    const options = [
      { label: 'frontend', value: 'org/frontend' },
      { label: 'backend', value: 'org/backend' },
    ];

    await emitSelectElicitation(
      client, 'session-1', 'Which repository should I work in?', options,
    );

    assert.equal(activities.length, 1);
    assert.equal(activities[0].sessionId, 'session-1');
    assert.deepStrictEqual(activities[0].content, {
      type: 'elicitation',
      body: 'Which repository should I work in?',
    });
    assert.deepStrictEqual(activities[0].options, {
      signal: 'select',
      signalMetadata: {
        options: [
          { label: 'frontend', value: 'org/frontend' },
          { label: 'backend', value: 'org/backend' },
        ],
      },
    });
  });

  it('skips when linearClient is undefined', async () => {
    const { emitSelectElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    // Should not throw
    await emitSelectElicitation(undefined, 'session-1', 'Pick one', []);
  });

  it('skips when sessionId is undefined', async () => {
    const { emitSelectElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    const client = makeMockLinearClient();
    // Should not throw
    await emitSelectElicitation(client, undefined, 'Pick one', []);
  });

  it('logs warning but does not throw on API failure', async () => {
    const { emitSelectElicitation } = await import('../../src/execution/orchestrator/issue-worker-runner');
    const warnings: string[] = [];
    const client = makeMockLinearClient({
      createAgentActivity: async () => { throw new Error('API error'); },
    });
    const logger = { warn: (msg: string) => { warnings.push(msg); } };

    await emitSelectElicitation(
      client, 'session-1', 'Pick one',
      [{ label: 'a', value: 'a' }],
      logger,
    );

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('select elicitation'));
  });
});

// ---------------------------------------------------------------------------
// Phase 7H: Integration with lifecycle — terminal activities wired in
// ---------------------------------------------------------------------------

describe('issue-worker lifecycle with Phase 7H deps', () => {
  it('emits response activity on completed lifecycle', async () => {
    const activities: Array<{ type: string; body: string }> = [];
    const client = makeMockLinearClient({
      createAgentActivity: async (_sid, content) => {
        activities.push(content as { type: string; body: string });
        return 'activity-1';
      },
    });

    const result = await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'completed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue({ state: { id: 'state-3', name: 'Done' } }),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    assert.equal(result.status, 'completed');
    const responseActivity = activities.find((a) => a.type === 'response');
    assert.ok(responseActivity, 'Should have emitted a response activity');
    assert.ok(responseActivity.body.includes('ENG-1'));
  });

  it('emits error activity on failed lifecycle', async () => {
    const activities: Array<{ type: string; body: string }> = [];
    const client = makeMockLinearClient({
      createAgentActivity: async (_sid, content) => {
        activities.push(content as { type: string; body: string });
        return 'activity-1';
      },
    });

    const result = await runIssueWorkerLifecycle({
      issue: makeIssue(),
      attempt: 1,
      workflowConfig: makeWorkflowConfig(),
      acquireWorkspace: async () => ({
        planId: 'issue-1',
        path: '/tmp/orch-agents/issue-1',
        branch: 'issue/issue-1',
        baseBranch: 'main',
        status: 'active',
      }),
      releaseWorkspace: async () => {},
      executeTurn: async () => ({ status: 'failed', totalDuration: 5 }),
      fetchIssue: async () => makeIssue(),
      updateWorkpad: async ({ currentCommentId }) => currentCommentId ?? 'comment-1',
      linearClient: client,
      agentSessionId: 'session-1',
    });

    assert.equal(result.status, 'failed');
    const errorActivity = activities.find((a) => a.type === 'error');
    assert.ok(errorActivity, 'Should have emitted an error activity');
    assert.ok(errorActivity.body.includes('ENG-1'));
  });
});
