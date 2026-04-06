/**
 * LocalAgentTask — coordinator dispatch tests.
 *
 * Mock-first London School. Verifies the CC-aligned coordinator dispatch
 * path that lives in src/tasks/local-agent/LocalAgentTask.ts. The legacy
 * multi-agent template path remains tested in tests/execution/simple-executor.test.ts.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLocalAgentTaskExecutor,
  type LocalAgentTaskDeps,
  type LocalAgentTaskExecutor,
} from '../../../src/tasks/local-agent';
import type { WorkflowPlan, IntakeEvent, WorktreeHandle } from '../../../src/types';
import type { InteractiveTaskExecutor, InteractiveExecutionRequest } from '../../../src/execution/runtime/interactive-executor';
import type { TaskExecutionResult } from '../../../src/execution/runtime/task-executor';
import type { WorktreeManager } from '../../../src/execution/workspace/worktree-manager';
import type { ArtifactApplier, ApplyResult } from '../../../src/execution/workspace/artifact-applier';
import type { AgentRegistry } from '../../../src/agent-registry/agent-registry';
import type { GitHubClient } from '../../../src/integration/github-client';
import type { LinearClient } from '../../../src/integration/linear/linear-client';
import type { Logger } from '../../../src/shared/logger';
import { clearTrackedCommits, isAgentCommit } from '../../../src/shared/agent-commit-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-1',
    timestamp: new Date().toISOString(),
    source: 'linear',
    sourceMetadata: { linearIssueId: 'issue-1', agentSessionId: 'session-1' },
    intent: 'custom:linear-prompted',
    entities: { requirementId: 'ENG-1', branch: 'main' },
    rawText: 'Investigate the regression in src/foo.ts',
    ...overrides,
  };
}

function makeCoordinatorPlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-coord-1',
    workItemId: 'work-1',
    template: 'coordinator',
    methodology: 'coordinator',
    agentTeam: [{ role: 'coordinator', type: 'coordinator', tier: 2, required: true }],
    maxAgents: 1,
    ...overrides,
  };
}

function makeHandle(planId: string = 'plan-coord-1'): WorktreeHandle {
  return {
    planId,
    path: `/tmp/orch-agents/${planId}`,
    branch: `agent/${planId}/coordinator`,
    baseBranch: 'main',
    status: 'active',
  };
}

function makeNoopLogger(): Logger {
  return {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return makeNoopLogger(); },
  };
}

function makeCompletedExecResult(output = 'coordinator output'): TaskExecutionResult {
  return { status: 'completed', output, duration: 1000 };
}

function makeFailedExecResult(): TaskExecutionResult {
  return { status: 'failed', output: '', duration: 500, error: 'coordinator failed' };
}

function makeAppliedResult(sha: string = 'coord-sha-1'): ApplyResult {
  return { status: 'applied', commitSha: sha, changedFiles: ['src/foo.ts'] };
}

interface Mocks {
  interactiveExecutor: InteractiveTaskExecutor;
  worktreeManager: WorktreeManager;
  artifactApplier: ArtifactApplier;
  agentRegistry: AgentRegistry;
  githubClient: GitHubClient;
  linearClient: Pick<LinearClient, 'createComment' | 'createAgentActivity'>;
  logger: Logger;
}

function createMocks(): Mocks {
  return {
    interactiveExecutor: {
      execute: mock.fn(async () => makeCompletedExecResult()),
    },
    worktreeManager: {
      create: mock.fn(async (planId: string) => makeHandle(planId)),
      commit: mock.fn(async () => 'sha'),
      push: mock.fn(async () => {}),
      diff: mock.fn(async () => ''),
      dispose: mock.fn(async () => {}),
    },
    artifactApplier: {
      apply: mock.fn(async () => makeAppliedResult()),
      rollback: mock.fn(async () => {}),
    },
    agentRegistry: {
      getAll: () => [],
      getNames: () => [],
      getByName: mock.fn(() => undefined),
      getByPath: mock.fn(() => undefined),
      getByCategory: () => [],
      has: () => false,
      refresh: () => {},
    },
    githubClient: {
      postPRComment: mock.fn(async () => {}),
      postInlineComment: mock.fn(async () => {}),
      pushBranch: mock.fn(async () => {}),
      submitReview: mock.fn(async () => {}),
    },
    linearClient: {
      createComment: mock.fn(async () => 'comment-1'),
      createAgentActivity: mock.fn(async () => 'activity-1'),
    },
    logger: makeNoopLogger(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalAgentTask (coordinator dispatch)', () => {
  let mocks: Mocks;
  let executor: LocalAgentTaskExecutor;

  beforeEach(() => {
    mocks = createMocks();
    clearTrackedCommits();
  });

  function buildExecutor(overrides: Partial<LocalAgentTaskDeps> = {}): LocalAgentTaskExecutor {
    return createLocalAgentTaskExecutor({
      interactiveExecutor: mocks.interactiveExecutor,
      worktreeManager: mocks.worktreeManager,
      artifactApplier: mocks.artifactApplier,
      agentRegistry: mocks.agentRegistry,
      githubClient: mocks.githubClient,
      linearClient: mocks.linearClient,
      logger: mocks.logger,
      ...overrides,
    });
  }

  // -----------------------------------------------------------------------
  // Coordinator prompt assembly
  // -----------------------------------------------------------------------

  it('builds the coordinator system prompt with worker tools context', async () => {
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const calls = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls;
    assert.equal(calls.length, 1);
    const req = calls[0].arguments[0] as InteractiveExecutionRequest;
    assert.ok(req.prompt.includes('You are a coordinator'));
    assert.ok(req.prompt.includes('AgentTool'));
    assert.ok(req.prompt.includes('SendMessage'));
    assert.ok(req.prompt.includes('Workers spawned via AgentTool'));
  });

  it('labels prompted intent as a follow-up comment', async () => {
    executor = buildExecutor();
    await executor.execute(
      makeCoordinatorPlan(),
      makeIntakeEvent({ intent: 'custom:linear-prompted', rawText: 'Why is the test failing?' }),
    );

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.ok(req.prompt.includes('User Comment (follow-up on the issue above)'));
    assert.ok(req.prompt.includes('Why is the test failing?'));
  });

  it('uses generic Task heading for non-prompted intents', async () => {
    executor = buildExecutor();
    await executor.execute(
      makeCoordinatorPlan(),
      makeIntakeEvent({ intent: 'review-pr', rawText: 'Review PR #42' }),
    );

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.ok(req.prompt.includes('## Task'));
    assert.ok(req.prompt.includes('Review PR #42'));
    assert.ok(!req.prompt.includes('follow-up on the issue above'));
  });

  it('falls back to a default Task body when rawText is missing', async () => {
    executor = buildExecutor();
    await executor.execute(
      makeCoordinatorPlan(),
      makeIntakeEvent({ intent: 'review-pr', rawText: '' }),
    );

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.ok(req.prompt.includes('Complete the assigned task.'));
  });

  it('includes the requirement identifier when present', async () => {
    executor = buildExecutor();
    await executor.execute(
      makeCoordinatorPlan(),
      makeIntakeEvent({ entities: { requirementId: 'ENG-42', branch: 'main' } }),
    );

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.ok(req.prompt.includes('## Issue: ENG-42'));
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  it('returns completed when the coordinator session succeeds', async () => {
    executor = buildExecutor();
    const result = await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    assert.equal(result.status, 'completed');
    assert.equal(result.agentResults.length, 1);
    assert.equal(result.agentResults[0].status, 'completed');
    assert.equal(result.agentResults[0].agentRole, 'coordinator');
    assert.equal(result.agentResults[0].commitSha, 'coord-sha-1');
    assert.equal((mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('returns failed when the coordinator session fails', async () => {
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => makeFailedExecResult(),
    );
    executor = buildExecutor();

    const result = await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    assert.equal(result.status, 'failed');
    assert.equal(result.agentResults[0].status, 'failed');
    assert.equal((mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('returns failed and disposes the worktree when the executor throws', async () => {
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('SDK crash'); },
    );
    executor = buildExecutor();

    const result = await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    assert.equal(result.status, 'failed');
    assert.equal((mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('does not crash when worktree dispose itself throws', async () => {
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('SDK crash'); },
    );
    (mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('dispose failed'); },
    );
    executor = buildExecutor();

    const result = await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());
    assert.equal(result.status, 'failed');
  });

  // -----------------------------------------------------------------------
  // Linear activity emission (FR-10A.02 / FR-10A.05)
  // -----------------------------------------------------------------------

  it('emits a thought activity before execution when an agent session is present', async () => {
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const calls = (mocks.linearClient.createAgentActivity as ReturnType<typeof mock.fn>).mock.calls;
    // First call is the thought; later call is the response.
    assert.ok(calls.length >= 1);
    const thoughtCall = calls[0].arguments;
    assert.equal(thoughtCall[0], 'session-1');
    assert.equal((thoughtCall[1] as { type: string }).type, 'thought');
  });

  it('emits a response activity on completion when an agent session is present', async () => {
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const calls = (mocks.linearClient.createAgentActivity as ReturnType<typeof mock.fn>).mock.calls;
    const responseCall = calls.find((c) => (c.arguments[1] as { type: string }).type === 'response');
    assert.ok(responseCall, 'expected a response activity to be emitted');
    assert.equal(responseCall!.arguments[0], 'session-1');
  });

  it('does not crash when Linear activity posting fails', async () => {
    (mocks.linearClient.createAgentActivity as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('Linear API error'); },
    );
    executor = buildExecutor();

    const result = await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());
    assert.equal(result.status, 'completed');
  });

  // -----------------------------------------------------------------------
  // Fork eligibility — coordinator mode always blocks fork
  // -----------------------------------------------------------------------

  it('does not pass forkContextPrefix in coordinator mode (feature gate blocks)', async () => {
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.equal(req.forkContextPrefix, undefined);
  });

  it('does not include forkAgent metadata in coordinator mode', async () => {
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.equal(req.metadata.forkAgent, undefined);
    assert.equal(req.metadata.forkModel, undefined);
  });

  // -----------------------------------------------------------------------
  // Commit tracking + push
  // -----------------------------------------------------------------------

  it('tracks the agent commit SHA after a successful apply', async () => {
    (mocks.artifactApplier.apply as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => makeAppliedResult('tracked-coord-sha'),
    );
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    assert.equal(isAgentCommit('tracked-coord-sha'), true);
  });

  it('pushes the branch via githubClient when a commit was produced', async () => {
    executor = buildExecutor();
    await executor.execute(
      makeCoordinatorPlan(),
      makeIntakeEvent({ entities: { requirementId: 'ENG-1', branch: 'feature-branch', repo: 'owner/repo' } }),
    );

    const pushCalls = (mocks.githubClient.pushBranch as ReturnType<typeof mock.fn>).mock.calls;
    assert.equal(pushCalls.length, 1);
    const opts = pushCalls[0].arguments[2] as { remoteBranch: string; repo: string };
    assert.equal(opts.remoteBranch, 'feature-branch');
    assert.equal(opts.repo, 'owner/repo');
  });

  it('does not crash when push fails', async () => {
    (mocks.githubClient.pushBranch as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('push rejected'); },
    );
    executor = buildExecutor();

    const result = await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());
    assert.equal(result.status, 'completed');
  });

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  it('honors a custom agentTimeoutMs', async () => {
    executor = buildExecutor({ agentTimeoutMs: 60_000 });
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.equal(req.timeout, 60_000);
  });

  it('falls back to the default 900s timeout when none provided', async () => {
    executor = buildExecutor();
    await executor.execute(makeCoordinatorPlan(), makeIntakeEvent());

    const req = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0]
      .arguments[0] as InteractiveExecutionRequest;
    assert.equal(req.timeout, 900_000);
  });

  it('returns failed for an empty agent team', async () => {
    executor = buildExecutor();
    const result = await executor.execute(makeCoordinatorPlan({ agentTeam: [] }), makeIntakeEvent());

    assert.equal(result.status, 'failed');
    assert.equal(result.agentResults.length, 0);
  });
});
