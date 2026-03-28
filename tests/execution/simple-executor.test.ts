/**
 * SimpleExecutor — London School TDD tests.
 *
 * All dependencies (interactiveExecutor, worktreeManager, artifactApplier,
 * reviewGate, fixItLoop, agentRegistry, githubClient, eventBus) are mocked.
 * Tests verify the orchestration logic without touching any real infrastructure.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSimpleExecutor,
  buildAgentPrompt,
  type SimpleExecutor,
  type SimpleExecutorDeps,
  type ExecutionResult,
} from '../../src/execution/simple-executor';
import type { WorkflowPlan, PlannedAgent, IntakeEvent, Finding, WorktreeHandle } from '../../src/types';
import type { InteractiveTaskExecutor, InteractiveExecutionRequest } from '../../src/execution/runtime/interactive-executor';
import type { TaskExecutionResult } from '../../src/execution/runtime/task-executor';
import type { WorktreeManager } from '../../src/execution/workspace/worktree-manager';
import type { ArtifactApplier, ApplyResult } from '../../src/execution/workspace/artifact-applier';
import type { ReviewGate } from '../../src/review/review-gate';
import type { FixItLoop, FixItResult, FixItContext } from '../../src/execution/fix-it-loop';
import type { AgentRegistry } from '../../src/agent-registry/agent-registry';
import type { GitHubClient } from '../../src/integration/github-client';
import type { Logger } from '../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-1',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: {},
    intent: 'review-pr',
    entities: {
      repo: 'owner/repo',
      branch: 'feature-branch',
      prNumber: 42,
      ...overrides.entities,
    },
    rawText: 'Fix the login bug',
    ...overrides,
  };
}

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-1',
    workItemId: 'work-1',
    methodology: 'adhoc',
    template: 'default',
    topology: 'star',
    swarmStrategy: 'minimal',
    consensus: 'none',
    maxAgents: 1,
    phases: [],
    agentTeam: [
      { role: 'implementer', type: 'coder', tier: 2, required: true },
    ],
    estimatedDuration: 60_000,
    estimatedCost: 0.01,
    ...overrides,
  };
}

function makeHandle(planId: string = 'plan-1', agentRole: string = 'implementer'): WorktreeHandle {
  return {
    planId,
    path: `/tmp/orch-agents/${planId}`,
    branch: `agent/${planId}/${agentRole}`,
    baseBranch: 'feature-branch',
    status: 'active',
  };
}

function makeNoopLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() { return makeNoopLogger(); },
  };
}

function makeCompletedExecResult(): TaskExecutionResult {
  return { status: 'completed', output: 'done', duration: 1000 };
}

function makeFailedExecResult(): TaskExecutionResult {
  return { status: 'failed', output: '', duration: 500, error: 'agent error' };
}

function makeAppliedResult(sha: string = 'abc1234'): ApplyResult {
  return { status: 'applied', commitSha: sha, changedFiles: ['src/foo.ts'] };
}

function makeRejectedResult(): ApplyResult {
  return { status: 'rejected', changedFiles: ['src/foo.ts'], rejectionReason: 'secret detected' };
}

function makePassFixResult(): FixItResult {
  return {
    status: 'passed',
    attempts: 1,
    finalVerdict: {
      phaseResultId: 'pr-1',
      status: 'pass',
      findings: [],
      securityScore: 100,
      testCoveragePercent: 95,
      codeReviewApproval: true,
    },
    commitSha: 'abc1234',
    history: [],
  };
}

function makeFailFixResult(findings: Finding[] = []): FixItResult {
  return {
    status: 'failed',
    attempts: 3,
    finalVerdict: {
      phaseResultId: 'pr-1',
      status: 'fail',
      findings,
      securityScore: 50,
      testCoveragePercent: 40,
      codeReviewApproval: false,
      feedback: 'Tests still failing',
    },
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface Mocks {
  interactiveExecutor: InteractiveTaskExecutor;
  worktreeManager: WorktreeManager;
  artifactApplier: ArtifactApplier;
  reviewGate: ReviewGate;
  fixItLoop: FixItLoop;
  agentRegistry: AgentRegistry;
  githubClient: GitHubClient;
  logger: Logger;
}

function createMocks(): Mocks {
  const interactiveExecutor: InteractiveTaskExecutor = {
    execute: mock.fn(async () => makeCompletedExecResult()),
  };

  const worktreeManager: WorktreeManager = {
    create: mock.fn(async (planId: string) => makeHandle(planId)),
    commit: mock.fn(async () => 'sha123'),
    push: mock.fn(async () => {}),
    diff: mock.fn(async () => 'diff content'),
    dispose: mock.fn(async () => {}),
  };

  const artifactApplier: ArtifactApplier = {
    apply: mock.fn(async () => makeAppliedResult()),
    rollback: mock.fn(async () => {}),
  };

  const reviewGate: ReviewGate = {
    review: mock.fn(async () => ({
      phaseResultId: 'pr-1',
      status: 'pass' as const,
      findings: [],
      securityScore: 100,
      testCoveragePercent: 95,
      codeReviewApproval: true,
    })),
  };

  const fixItLoop: FixItLoop = {
    run: mock.fn(async () => makePassFixResult()),
  };

  const agentRegistry: AgentRegistry = {
    getAll: () => [],
    getNames: () => [],
    getByName: mock.fn(() => ({
      name: 'coder',
      type: 'developer',
      description: 'A coding agent',
      capabilities: ['code'],
      color: '#00ff00',
      category: 'core',
      filePath: '/agents/coder.md',
      version: '1.0.0',
    })),
    getByCategory: () => [],
    has: () => true,
    refresh: () => {},
  };

  const githubClient: GitHubClient = {
    postPRComment: mock.fn(async () => {}),
    postInlineComment: mock.fn(async () => {}),
    pushBranch: mock.fn(async () => {}),
    submitReview: mock.fn(async () => {}),
  };

  return {
    interactiveExecutor,
    worktreeManager,
    artifactApplier,
    reviewGate,
    fixItLoop,
    agentRegistry,
    githubClient,
    logger: makeNoopLogger(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SimpleExecutor', () => {
  let mocks: Mocks;
  let executor: SimpleExecutor;

  beforeEach(() => {
    mocks = createMocks();
  });

  function buildExecutor(overrides: Partial<SimpleExecutorDeps> = {}): SimpleExecutor {
    return createSimpleExecutor({
      interactiveExecutor: mocks.interactiveExecutor,
      worktreeManager: mocks.worktreeManager,
      artifactApplier: mocks.artifactApplier,
      reviewGate: mocks.reviewGate,
      fixItLoop: mocks.fixItLoop,
      agentRegistry: mocks.agentRegistry,
      githubClient: mocks.githubClient,
      logger: mocks.logger,
      ...overrides,
    });
  }

  // -----------------------------------------------------------------------
  // 1. Single agent completes successfully
  // -----------------------------------------------------------------------

  it('should return completed when single agent succeeds', async () => {
    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal(result.agentResults.length, 1);
    assert.equal(result.agentResults[0].status, 'completed');
    assert.equal(result.agentResults[0].agentRole, 'implementer');
    assert.equal(result.agentResults[0].agentType, 'coder');
    assert.equal(result.agentResults[0].commitSha, 'abc1234');
    assert.ok(result.totalDuration >= 0);
  });

  // -----------------------------------------------------------------------
  // 2. Single agent fails
  // -----------------------------------------------------------------------

  it('should return failed when single agent execution fails', async () => {
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => makeFailedExecResult(),
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'failed');
    assert.equal(result.agentResults.length, 1);
    assert.equal(result.agentResults[0].status, 'failed');
    // Worktree should still be disposed
    assert.equal((mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  // -----------------------------------------------------------------------
  // 3. Two agents, both complete
  // -----------------------------------------------------------------------

  it('should return completed when all agents succeed', async () => {
    executor = buildExecutor();
    const plan = makePlan({
      agentTeam: [
        { role: 'implementer', type: 'coder', tier: 2, required: true },
        { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
      ],
    });
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal(result.agentResults.length, 2);
    assert.equal(result.agentResults[0].status, 'completed');
    assert.equal(result.agentResults[1].status, 'completed');
    assert.equal((mocks.worktreeManager.create as ReturnType<typeof mock.fn>).mock.callCount(), 2);
  });

  // -----------------------------------------------------------------------
  // 4. Two agents, first fails, second completes
  // -----------------------------------------------------------------------

  it('should return partial when some agents fail and some succeed', async () => {
    let callCount = 0;
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => {
        callCount++;
        return callCount === 1 ? makeFailedExecResult() : makeCompletedExecResult();
      },
    );

    executor = buildExecutor();
    const plan = makePlan({
      agentTeam: [
        { role: 'implementer', type: 'coder', tier: 2, required: true },
        { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
      ],
    });
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'partial');
    assert.equal(result.agentResults.length, 2);
    assert.equal(result.agentResults[0].status, 'failed');
    assert.equal(result.agentResults[1].status, 'completed');
  });

  // -----------------------------------------------------------------------
  // 5. Agent with review gate — fix-it loop runs
  // -----------------------------------------------------------------------

  it('should run fix-it loop when reviewGate and fixItLoop are provided', async () => {
    const findings: Finding[] = [
      { id: 'f1', severity: 'warning', category: 'style', message: 'minor style issue' },
    ];
    (mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => makePassFixResult(),
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal((mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.callCount(), 1);

    // Verify fix-it loop was called with correct context
    const fixCallArgs = (mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.calls[0].arguments[0] as FixItContext;
    assert.equal(fixCallArgs.planId, 'plan-1');
    assert.equal(fixCallArgs.workItemId, 'work-1');
    assert.equal(fixCallArgs.initialCommitSha, 'abc1234');
  });

  // -----------------------------------------------------------------------
  // 6. Agent with no review gate — no fix-it loop
  // -----------------------------------------------------------------------

  it('should skip fix-it loop when reviewGate is not provided', async () => {
    executor = buildExecutor({ reviewGate: undefined });
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal((mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('should skip fix-it loop when fixItLoop is not provided', async () => {
    executor = buildExecutor({ fixItLoop: undefined });
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
  });

  // -----------------------------------------------------------------------
  // 7. Worktree cleanup on failure (exception path)
  // -----------------------------------------------------------------------

  it('should dispose worktree when agent throws an exception', async () => {
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('unexpected crash'); },
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'failed');
    assert.equal(result.agentResults[0].status, 'failed');
    // Worktree dispose should still be called
    assert.equal((mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('should not crash if worktree dispose fails during error cleanup', async () => {
    (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('unexpected crash'); },
    );
    (mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('dispose failed'); },
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    // Should not throw
    const result = await executor.execute(plan, intake);
    assert.equal(result.status, 'failed');
  });

  // -----------------------------------------------------------------------
  // 8. PR comment posted on completion
  // -----------------------------------------------------------------------

  it('should post PR comment when githubClient is provided and PR exists', async () => {
    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent({ entities: { repo: 'owner/repo', prNumber: 42, branch: 'main' } });

    await executor.execute(plan, intake);

    assert.equal((mocks.githubClient.postPRComment as ReturnType<typeof mock.fn>).mock.callCount(), 1);
    const callArgs = (mocks.githubClient.postPRComment as ReturnType<typeof mock.fn>).mock.calls[0].arguments;
    assert.equal(callArgs[0], 'owner/repo');
    assert.equal(callArgs[1], 42);
    assert.ok((callArgs[2] as string).includes('coder'));
  });

  it('should not post PR comment when no prNumber', async () => {
    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent({ entities: { repo: 'owner/repo', branch: 'main' } });

    await executor.execute(plan, intake);

    assert.equal((mocks.githubClient.postPRComment as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('should not post PR comment when no githubClient', async () => {
    executor = buildExecutor({ githubClient: undefined });
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
  });

  // -----------------------------------------------------------------------
  // 9. PR comment failure doesn't crash execution
  // -----------------------------------------------------------------------

  it('should not crash when PR comment posting fails', async () => {
    (mocks.githubClient.postPRComment as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => { throw new Error('GitHub API error'); },
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal(result.agentResults[0].status, 'completed');
  });

  // -----------------------------------------------------------------------
  // 10. Agent definition not found in registry
  // -----------------------------------------------------------------------

  it('should still run agent with empty instructions when not in registry', async () => {
    (mocks.agentRegistry.getByName as ReturnType<typeof mock.fn>).mock.mockImplementation(
      () => undefined,
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    // Verify interactive executor was still called
    assert.equal((mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  // -----------------------------------------------------------------------
  // 11. Empty agent team
  // -----------------------------------------------------------------------

  it('should return completed with 0 results for empty agent team', async () => {
    executor = buildExecutor();
    const plan = makePlan({ agentTeam: [] });
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal(result.agentResults.length, 0);
    assert.ok(result.totalDuration >= 0);
  });

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  it('should return failed when artifact apply is rejected', async () => {
    (mocks.artifactApplier.apply as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => makeRejectedResult(),
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'failed');
    assert.equal(result.agentResults[0].status, 'failed');
    assert.equal((mocks.worktreeManager.dispose as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('should skip fix-it loop when commitSha is undefined (no changes)', async () => {
    (mocks.artifactApplier.apply as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => ({ status: 'applied', changedFiles: [], commitSha: undefined }),
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.status, 'completed');
    assert.equal((mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('should pass fix-it loop findings into agentResult', async () => {
    const findings: Finding[] = [
      { id: 'f1', severity: 'info', category: 'style', message: 'trailing whitespace' },
    ];
    (mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async () => makePassFixResult(),
    );
    // Override to include findings in the verdict
    (mocks.fixItLoop.run as ReturnType<typeof mock.fn>).mock.mockImplementation(
      async (): Promise<FixItResult> => ({
        status: 'passed',
        attempts: 1,
        finalVerdict: {
          phaseResultId: 'pr-1',
          status: 'pass',
          findings,
          securityScore: 100,
          testCoveragePercent: 95,
          codeReviewApproval: true,
        },
        commitSha: 'abc1234',
        history: [],
      }),
    );

    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent();

    const result = await executor.execute(plan, intake);

    assert.equal(result.agentResults[0].findings.length, 1);
    assert.equal(result.agentResults[0].findings[0].message, 'trailing whitespace');
  });

  it('should use custom agentTimeoutMs', async () => {
    executor = buildExecutor({ agentTimeoutMs: 60_000 });
    const plan = makePlan();
    const intake = makeIntakeEvent();

    await executor.execute(plan, intake);

    const callArgs = (mocks.interactiveExecutor.execute as ReturnType<typeof mock.fn>).mock.calls[0].arguments[0] as InteractiveExecutionRequest;
    assert.equal(callArgs.timeout, 60_000);
  });

  it('should use default branch main when intakeEvent has no branch', async () => {
    executor = buildExecutor();
    const plan = makePlan();
    const intake = makeIntakeEvent({ entities: { repo: 'owner/repo' } });

    await executor.execute(plan, intake);

    const createArgs = (mocks.worktreeManager.create as ReturnType<typeof mock.fn>).mock.calls[0].arguments;
    assert.equal(createArgs[1], 'main'); // baseBranch
  });
});

// ---------------------------------------------------------------------------
// buildAgentPrompt unit tests
// ---------------------------------------------------------------------------

describe('buildAgentPrompt', () => {
  const agent: PlannedAgent = { role: 'implementer', type: 'coder', tier: 2, required: true };

  it('should include agent role and type', () => {
    const plan = makePlan();
    const intake = makeIntakeEvent();
    const prompt = buildAgentPrompt('', intake, agent, plan);

    assert.ok(prompt.includes('coder'));
    assert.ok(prompt.includes('implementer'));
  });

  it('should include agent instructions when provided', () => {
    const plan = makePlan();
    const intake = makeIntakeEvent();
    const prompt = buildAgentPrompt('Use TDD approach', intake, agent, plan);

    assert.ok(prompt.includes('Use TDD approach'));
    assert.ok(prompt.includes('## Your Instructions'));
  });

  it('should not include instructions section when empty', () => {
    const plan = makePlan();
    const intake = makeIntakeEvent();
    const prompt = buildAgentPrompt('', intake, agent, plan);

    assert.ok(!prompt.includes('## Your Instructions'));
  });

  it('should include repo, branch, PR, issue when present', () => {
    const plan = makePlan();
    const intake = makeIntakeEvent({
      entities: { repo: 'owner/repo', branch: 'feat', prNumber: 10, issueNumber: 5 },
    });
    const prompt = buildAgentPrompt('', intake, agent, plan);

    assert.ok(prompt.includes('Repository: owner/repo'));
    assert.ok(prompt.includes('Branch: feat'));
    assert.ok(prompt.includes('PR: #10'));
    assert.ok(prompt.includes('Issue: #5'));
  });

  it('should include rawText as description', () => {
    const plan = makePlan();
    const intake = makeIntakeEvent({ rawText: 'Fix the login page' });
    const prompt = buildAgentPrompt('', intake, agent, plan);

    assert.ok(prompt.includes('## Description'));
    assert.ok(prompt.includes('Fix the login page'));
  });

  it('should include labels when present', () => {
    const plan = makePlan();
    const intake = makeIntakeEvent({ entities: { labels: ['bug', 'urgent'], repo: 'x/y' } });
    const prompt = buildAgentPrompt('', intake, agent, plan);

    assert.ok(prompt.includes('Labels: bug, urgent'));
  });

  it('should include workItemId from plan', () => {
    const plan = makePlan({ workItemId: 'ITEM-42' });
    const intake = makeIntakeEvent();
    const prompt = buildAgentPrompt('', intake, agent, plan);

    assert.ok(prompt.includes('Work item: ITEM-42'));
  });
});
