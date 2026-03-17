/**
 * Tests for the Interactive Strategy — Phase 5 domain event emission.
 *
 * Validates that the interactive strategy emits the correct domain events
 * at the right points during execution:
 *   - ArtifactsApplied after successful artifact apply
 *   - CommitCreated after successful commit
 *   - ReviewRequested before fix-it loop
 *   - ReviewRejected when review fails
 *   - FixRequested when entering fix attempt
 *   - RollbackTriggered on rollback
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, WorkflowPlan, PlannedPhase, ReviewVerdict } from '../../src/types';
import { createEventBus, type EventBus } from '../../src/shared/event-bus';
import type { DomainEventType, DomainEventMap } from '../../src/shared/event-types';
import { createInteractiveStrategy } from '../../src/execution/strategies/interactive-strategy';
import type { StrategyDeps } from '../../src/execution/strategies/phase-strategy';
import type { TaskExecutor } from '../../src/execution/task-executor';
import type { InteractiveTaskExecutor } from '../../src/execution/interactive-executor';
import type { WorktreeManager } from '../../src/execution/worktree-manager';
import type { ArtifactApplier } from '../../src/execution/artifact-applier';
import type { FixItLoop } from '../../src/execution/fix-it-loop';
import type { ReviewGate } from '../../src/review/review-gate';
import type { Logger } from '../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-ev-001',
    workItemId: 'work-ev-001',
    methodology: 'sparc-partial',
    template: 'github-ops',
    topology: 'hierarchical',
    swarmStrategy: 'specialized',
    consensus: 'raft',
    maxAgents: 4,
    phases: [
      { type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false },
    ],
    agentTeam: [
      { role: 'coder', type: 'coder', tier: 3, required: true },
    ],
    estimatedDuration: 15,
    estimatedCost: 0.02,
    ...overrides,
  };
}

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-ev-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: {},
    intent: 'review-pr',
    entities: {
      repo: 'org/repo',
      branch: 'feature/fix',
      prNumber: 42,
    },
    ...overrides,
  };
}

function makeLogger(): Logger {
  const noop = () => {};
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => makeLogger() };
}

function makePassingVerdict(): ReviewVerdict {
  return {
    phaseResultId: 'work-ev-001',
    status: 'pass',
    findings: [],
    securityScore: 100,
    testCoveragePercent: 90,
    codeReviewApproval: true,
    feedback: 'All checks passed.',
  };
}

function makeFailingVerdict(): ReviewVerdict {
  return {
    phaseResultId: 'work-ev-001',
    status: 'fail',
    findings: [{ id: 'f1', severity: 'error', category: 'test', message: 'Tests failed' }],
    securityScore: 50,
    testCoveragePercent: 40,
    codeReviewApproval: false,
    feedback: 'Tests are failing.',
  };
}

/** Collect all events of a given type emitted synchronously. */
function collectEmittedEvents<T extends DomainEventType>(
  eventBus: EventBus,
  type: T,
): DomainEventMap[T][] {
  const events: DomainEventMap[T][] = [];
  eventBus.subscribe(type, (evt) => { events.push(evt); });
  return events;
}

function makeStrategyDeps(overrides: Partial<StrategyDeps> = {}): StrategyDeps {
  const mockWorktreeManager: WorktreeManager = {
    create: mock.fn(async (planId: string, baseBranch: string) => ({
      planId, path: `/tmp/orch-agents/${planId}`, branch: `agent/${planId}`, baseBranch, status: 'active' as const,
    })),
    commit: mock.fn(async () => 'sha123'),
    push: mock.fn(async () => {}),
    diff: mock.fn(async () => 'diff text'),
    dispose: mock.fn(async () => {}),
  };

  const mockInteractiveExecutor: InteractiveTaskExecutor = {
    execute: mock.fn(async () => ({ status: 'completed' as const, output: 'done', duration: 100 })),
  };

  const mockArtifactApplier: ArtifactApplier = {
    apply: mock.fn(async () => ({
      status: 'applied' as const, commitSha: 'abc123', changedFiles: ['src/auth.ts'],
    })),
    rollback: mock.fn(async () => {}),
  };

  const mockTaskExecutor: TaskExecutor = {
    execute: mock.fn(async () => ({ status: 'completed' as const, output: '{}', duration: 10 })),
  };

  return {
    gateChecker: async () => ({ passed: true }),
    taskExecutor: mockTaskExecutor,
    interactiveExecutor: mockInteractiveExecutor,
    worktreeManager: mockWorktreeManager,
    artifactApplier: mockArtifactApplier,
    eventBus: createEventBus(),
    logger: makeLogger(),
    phaseTimeoutMs: 300_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveStrategy', () => {
  const strategy = createInteractiveStrategy();

  describe('intakeEvent guard (M7)', () => {
    it('throws ExecutionError when intakeEvent is undefined', async () => {
      const deps = makeStrategyDeps();
      const plan = makePlan();
      const phase = plan.phases[0];

      await assert.rejects(
        () => strategy.run(plan, phase, deps, deps.logger, undefined),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /intakeEvent required/i);
          return true;
        },
      );
    });
  });

  describe('canHandle — configurable phase types (M6)', () => {
    it('returns true with default refinement phase', () => {
      const deps = makeStrategyDeps();
      const phase: PlannedPhase = { type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false };
      assert.ok(strategy.canHandle(deps, phase, makeIntakeEvent()));
    });

    it('returns false for non-refinement phase with default config', () => {
      const deps = makeStrategyDeps();
      const phase: PlannedPhase = { type: 'analysis', agents: ['coder'], gate: 'tests-pass', skippable: false };
      assert.ok(!strategy.canHandle(deps, phase, makeIntakeEvent()));
    });

    it('accepts custom eligible phase types', () => {
      const customStrategy = createInteractiveStrategy({ eligiblePhaseTypes: ['analysis', 'implementation'] });
      const deps = makeStrategyDeps();
      const analysisPhase: PlannedPhase = { type: 'analysis', agents: ['coder'], gate: 'tests-pass', skippable: false };
      const implPhase: PlannedPhase = { type: 'implementation', agents: ['coder'], gate: 'tests-pass', skippable: false };
      const refinementPhase: PlannedPhase = { type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false };

      assert.ok(customStrategy.canHandle(deps, analysisPhase, makeIntakeEvent()));
      assert.ok(customStrategy.canHandle(deps, implPhase, makeIntakeEvent()));
      assert.ok(!customStrategy.canHandle(deps, refinementPhase, makeIntakeEvent()));
    });
  });

  it('canHandle returns false when eventBus is absent but other deps present', () => {
    const deps = makeStrategyDeps({ eventBus: undefined });
    const phase: PlannedPhase = { type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false };
    // Should still handle — eventBus is optional for event emission, not for canHandle
    assert.ok(strategy.canHandle(deps, phase, makeIntakeEvent()));
  });

  it('emits ArtifactsApplied and CommitCreated after successful apply', async () => {
    const deps = makeStrategyDeps();
    const plan = makePlan();
    const phase = plan.phases[0];

    const artifactsApplied = collectEmittedEvents(deps.eventBus!, 'ArtifactsApplied');
    const commitCreated = collectEmittedEvents(deps.eventBus!, 'CommitCreated');

    await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(artifactsApplied.length, 1, 'Should emit ArtifactsApplied');
    assert.equal(artifactsApplied[0].payload.planId, 'plan-ev-001');
    assert.equal(artifactsApplied[0].payload.commitSha, 'abc123');
    assert.deepEqual(artifactsApplied[0].payload.changedFiles, ['src/auth.ts']);

    assert.equal(commitCreated.length, 1, 'Should emit CommitCreated');
    assert.equal(commitCreated[0].payload.planId, 'plan-ev-001');
    assert.equal(commitCreated[0].payload.sha, 'abc123');
    assert.deepEqual(commitCreated[0].payload.files, ['src/auth.ts']);
  });

  it('emits ReviewRequested before fix-it loop when reviewGate and fixItLoop present', async () => {
    const mockFixItLoop: FixItLoop = {
      run: mock.fn(async () => ({
        status: 'passed' as const,
        attempts: 1,
        finalVerdict: makePassingVerdict(),
        commitSha: 'abc123',
        history: [],
      })),
    };

    const mockReviewGate: ReviewGate = {
      review: mock.fn(async () => makePassingVerdict()),
    };

    const deps = makeStrategyDeps({ fixItLoop: mockFixItLoop, reviewGate: mockReviewGate });
    const plan = makePlan();
    const phase = plan.phases[0];

    const reviewRequested = collectEmittedEvents(deps.eventBus!, 'ReviewRequested');

    await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(reviewRequested.length, 1, 'Should emit ReviewRequested');
    assert.equal(reviewRequested[0].payload.planId, 'plan-ev-001');
    assert.equal(reviewRequested[0].payload.commitSha, 'abc123');
    assert.equal(reviewRequested[0].payload.attempt, 1);
  });

  it('emits ReviewRejected when fix-it loop fails', async () => {
    const failingVerdict = makeFailingVerdict();

    const mockFixItLoop: FixItLoop = {
      run: mock.fn(async () => ({
        status: 'failed' as const,
        attempts: 3,
        finalVerdict: failingVerdict,
        commitSha: 'abc123',
        history: [],
      })),
    };

    const mockReviewGate: ReviewGate = {
      review: mock.fn(async () => failingVerdict),
    };

    const deps = makeStrategyDeps({ fixItLoop: mockFixItLoop, reviewGate: mockReviewGate });
    const plan = makePlan();
    const phase = plan.phases[0];

    const reviewRejected = collectEmittedEvents(deps.eventBus!, 'ReviewRejected');

    await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(reviewRejected.length, 1, 'Should emit ReviewRejected');
    assert.equal(reviewRejected[0].payload.planId, 'plan-ev-001');
    assert.equal(reviewRejected[0].payload.feedback, 'Tests are failing.');
    assert.equal(reviewRejected[0].payload.attempt, 3);
    assert.ok(reviewRejected[0].payload.findings.length > 0, 'Should include findings');
  });

  it('emits FixRequested for each fix attempt that was applied', async () => {
    const mockFixItLoop: FixItLoop = {
      run: mock.fn(async () => ({
        status: 'passed' as const,
        attempts: 2,
        finalVerdict: makePassingVerdict(),
        commitSha: 'sha456',
        history: [
          {
            attempt: 1,
            verdict: makeFailingVerdict(),
            fixApplied: true,
            commitSha: 'sha234',
            duration: 100,
          },
          {
            attempt: 2,
            verdict: makePassingVerdict(),
            fixApplied: false, // final review passed, no fix needed
            duration: 50,
          },
        ],
      })),
    };

    const mockReviewGate: ReviewGate = {
      review: mock.fn(async () => makePassingVerdict()),
    };

    const deps = makeStrategyDeps({ fixItLoop: mockFixItLoop, reviewGate: mockReviewGate });
    const plan = makePlan();
    const phase = plan.phases[0];

    const fixRequested = collectEmittedEvents(deps.eventBus!, 'FixRequested');

    await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    // Only attempt 1 had fixApplied=true
    assert.equal(fixRequested.length, 1, 'Should emit FixRequested only for applied fixes');
    assert.equal(fixRequested[0].payload.planId, 'plan-ev-001');
    assert.equal(fixRequested[0].payload.attempt, 1);
  });

  it('emits RollbackTriggered when artifact apply is rejected', async () => {
    const mockApplier: ArtifactApplier = {
      apply: mock.fn(async () => ({
        status: 'rejected' as const, changedFiles: ['src/auth.ts'],
        rejectionReason: 'path traversal detected',
      })),
      rollback: mock.fn(async () => {}),
    };

    const deps = makeStrategyDeps({ artifactApplier: mockApplier });
    const plan = makePlan();
    const phase = plan.phases[0];

    const rollbackTriggered = collectEmittedEvents(deps.eventBus!, 'RollbackTriggered');

    const result = await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(result.status, 'failed', 'Phase should fail on rejection');
    assert.equal(rollbackTriggered.length, 1, 'Should emit RollbackTriggered');
    assert.equal(rollbackTriggered[0].payload.planId, 'plan-ev-001');
    assert.equal(rollbackTriggered[0].payload.reason, 'path traversal detected');
    assert.ok(rollbackTriggered[0].payload.worktreePath.includes('plan-ev-001'));
  });

  it('emits RollbackTriggered on unexpected error', async () => {
    const mockInteractive: InteractiveTaskExecutor = {
      execute: mock.fn(async () => { throw new Error('Unexpected crash'); }),
    };

    const deps = makeStrategyDeps({ interactiveExecutor: mockInteractive });
    const plan = makePlan();
    const phase = plan.phases[0];

    const rollbackTriggered = collectEmittedEvents(deps.eventBus!, 'RollbackTriggered');

    const result = await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(result.status, 'failed', 'Phase should fail on crash');
    assert.equal(rollbackTriggered.length, 1, 'Should emit RollbackTriggered on crash');
    assert.ok(rollbackTriggered[0].payload.reason.includes('Unexpected crash'));
  });

  it('does not emit events when eventBus is not provided', async () => {
    const deps = makeStrategyDeps({ eventBus: undefined });
    const plan = makePlan();
    const phase = plan.phases[0];

    // Should not throw — event emission is no-op without eventBus
    const result = await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(result.status, 'completed', 'Should still complete without eventBus');
    assert.ok(result.artifacts.length > 0, 'Should still produce artifacts');
  });

  describe('dynamic bot marker via BOT_USERNAME', () => {
    it('uses custom BOT_USERNAME for PR comment marker', async () => {
      const originalEnv = process.env.BOT_USERNAME;
      process.env.BOT_USERNAME = 'automata';

      try {
        const postPRComment = mock.fn(async () => {});
        const mockGithubClient = { postPRComment };

        const deps = makeStrategyDeps({ githubClient: mockGithubClient as StrategyDeps['githubClient'] });
        const plan = makePlan();
        const phase = plan.phases[0];
        const intake = makeIntakeEvent();

        await strategy.run(plan, phase, deps, deps.logger, intake);

        assert.equal(postPRComment.mock.calls.length, 1, 'Should post PR comment');
        const commentBody = postPRComment.mock.calls[0].arguments[2] as string;
        assert.ok(commentBody.includes('<!-- automata-bot -->'), `Expected automata-bot marker, got: ${commentBody}`);
        assert.ok(!commentBody.includes('<!-- orch-agents-bot -->'), 'Should NOT contain default marker');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.BOT_USERNAME;
        } else {
          process.env.BOT_USERNAME = originalEnv;
        }
      }
    });

    it('falls back to orch-agents-bot when BOT_USERNAME is not set', async () => {
      const originalEnv = process.env.BOT_USERNAME;
      delete process.env.BOT_USERNAME;

      try {
        const postPRComment = mock.fn(async () => {});
        const mockGithubClient = { postPRComment };

        const deps = makeStrategyDeps({ githubClient: mockGithubClient as StrategyDeps['githubClient'] });
        const plan = makePlan();
        const phase = plan.phases[0];
        const intake = makeIntakeEvent();

        await strategy.run(plan, phase, deps, deps.logger, intake);

        assert.equal(postPRComment.mock.calls.length, 1, 'Should post PR comment');
        const commentBody = postPRComment.mock.calls[0].arguments[2] as string;
        assert.ok(commentBody.includes('<!-- orch-agents-bot -->'), `Expected default marker, got: ${commentBody}`);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.BOT_USERNAME;
        } else {
          process.env.BOT_USERNAME = originalEnv;
        }
      }
    });
  });

  it('does not emit ArtifactsApplied when no commit SHA returned', async () => {
    const mockApplier: ArtifactApplier = {
      apply: mock.fn(async () => ({
        status: 'applied' as const, commitSha: undefined, changedFiles: [],
      })),
      rollback: mock.fn(async () => {}),
    };

    const deps = makeStrategyDeps({ artifactApplier: mockApplier });
    const plan = makePlan();
    const phase = plan.phases[0];

    const artifactsApplied = collectEmittedEvents(deps.eventBus!, 'ArtifactsApplied');
    const commitCreated = collectEmittedEvents(deps.eventBus!, 'CommitCreated');

    await strategy.run(plan, phase, deps, deps.logger, makeIntakeEvent());

    assert.equal(artifactsApplied.length, 0, 'Should not emit ArtifactsApplied without commitSha');
    assert.equal(commitCreated.length, 0, 'Should not emit CommitCreated without commitSha');
  });
});
