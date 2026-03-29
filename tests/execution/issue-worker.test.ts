import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runIssueWorkerLifecycle } from '../../src/execution/orchestrator/issue-worker-runner';
import type { WorkflowConfig } from '../../src/integration/linear/workflow-parser';
import type { LinearIssueResponse } from '../../src/integration/linear/linear-client';
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
