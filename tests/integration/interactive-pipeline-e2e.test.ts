/**
 * TDD: End-to-end pipeline integration test for the Artifact Execution Layer.
 *
 * Tests the pipeline with SimpleExecutor: worktree creation, interactive
 * execution, artifact application, review gate, fix-it loop, and cleanup
 * are all handled internally by SimpleExecutor.
 *
 * These tests verify the pipeline wiring with stub SimpleExecutor instances.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, ReviewVerdict } from '../../src/types';
import { createEventBus, createDomainEvent } from '../../src/shared/event-bus';
import type { EventBus } from '../../src/shared/event-bus';
import type { DomainEventType } from '../../src/shared/event-types';
import { createLogger } from '../../src/shared/logger';
import { startPipeline, type PipelineHandle } from '../../src/pipeline';
import type { SimpleExecutor, ExecutionResult } from '../../src/execution/simple-executor';
import type { WorkflowConfig } from '../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWorkflowConfig(): WorkflowConfig {
  return {
    templates: {
      'github-ops': ['reviewer'],
      'tdd-workflow': ['coder', 'tester'],
      'quick-fix': ['coder'],
      'cicd-pipeline': ['coder'],
      'feature-build': ['architect', 'coder', 'reviewer'],
      'security-audit': ['security-architect'],
    },
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeStates: ['Todo'], terminalStates: ['Done'] },
    agents: { maxConcurrent: 8, routing: { bug: 'tdd-workflow' }, defaultTemplate: 'quick-fix' },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    promptTemplate: '',
  };
}

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-interactive-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: { template: 'github-ops' },
    intent: 'review-pr',
    entities: {
      repo: 'test-org/test-repo',
      branch: 'feature/fix-auth',
      prNumber: 42,
      severity: 'high',
      files: ['src/auth.ts', 'src/session.ts'],
      labels: ['security'],
    },
    rawText: 'Fix authentication bypass in session handler',
    ...overrides,
  };
}

/** Stub SimpleExecutor that succeeds. */
function makeStubExecutor(): SimpleExecutor {
  return {
    async execute(plan): Promise<ExecutionResult> {
      return {
        status: 'completed',
        agentResults: plan.agentTeam.map((a) => ({
          agentRole: a.role,
          agentType: a.type,
          status: 'completed' as const,
          findings: [],
          duration: 10,
        })),
        totalDuration: 10 * plan.agentTeam.length,
      };
    },
  };
}

/** SimpleExecutor that rejects (all agents fail). */
function makeRejectingExecutor(): SimpleExecutor {
  return {
    async execute(plan): Promise<ExecutionResult> {
      return {
        status: 'failed',
        agentResults: plan.agentTeam.map((a) => ({
          agentRole: a.role,
          agentType: a.type,
          status: 'failed' as const,
          findings: [],
          duration: 5,
        })),
        totalDuration: 5 * plan.agentTeam.length,
      };
    },
  };
}

/** Wait for a specific event type, with a timeout for safety. */
function waitForEvent<T extends DomainEventType>(
  eventBus: EventBus,
  eventType: T,
  timeoutMs = 5000,
): Promise<{ type: T; id: string; correlationId: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for ${eventType} after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = eventBus.subscribe(eventType, (evt: unknown) => {
      clearTimeout(timer);
      unsub();
      resolve(evt as { type: T; id: string; correlationId: string; payload: unknown });
    });
  });
}

/** Collect N events of a given type, with a timeout. */
function collectEvents<T extends DomainEventType>(
  eventBus: EventBus,
  eventType: T,
  count: number,
  timeoutMs = 5000,
): Promise<{ type: T; id: string; correlationId: string; payload: unknown }[]> {
  return new Promise((resolve, reject) => {
    const collected: { type: T; id: string; correlationId: string; payload: unknown }[] = [];
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out collecting ${count} ${eventType} events (got ${collected.length}) after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = eventBus.subscribe(eventType, (evt: unknown) => {
      collected.push(evt as { type: T; id: string; correlationId: string; payload: unknown });
      if (collected.length >= count) {
        clearTimeout(timer);
        unsub();
        resolve(collected);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Artifact Execution Layer (interactive mode)', () => {
  let handle: PipelineHandle | undefined;

  afterEach(() => {
    handle?.shutdown();
    handle = undefined;
  });

  it('pipeline with SimpleExecutor completes full event chain', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      simpleExecutor: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
    });

    const workCompletedPromise = waitForEvent(eventBus, 'WorkCompleted');

    const intakeEvent = makeIntakeEvent({ id: 'intake-fallback-001' });
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'fallback-corr'));

    const workCompleted = await workCompletedPromise;
    const wcPayload = workCompleted.payload as { workItemId: string; phaseCount: number };

    assert.equal(wcPayload.workItemId, 'intake-fallback-001');
    assert.ok(wcPayload.phaseCount > 0, 'Should have executed at least one agent');
  });

  it('pipeline completes full chain including ReviewCompleted', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      simpleExecutor: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
    });

    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');

    const intakeEvent = makeIntakeEvent({ id: 'intake-stub-001' });
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'stub-corr'));

    const review = await reviewPromise;
    const rcPayload = review.payload as { reviewVerdict: ReviewVerdict };
    assert.equal(rcPayload.reviewVerdict.status, 'pass', 'Stub review should pass');
  });

  it('full pipeline with SimpleExecutor runs all events in order', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      simpleExecutor: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
    });

    const triagedPromise = waitForEvent(eventBus, 'WorkTriaged');
    const workCompletedPromise = waitForEvent(eventBus, 'WorkCompleted');
    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');

    const intakeEvent = makeIntakeEvent({ id: 'intake-interactive-full-001' });
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'interactive-corr'));

    const [triaged, workCompleted, review] = await Promise.all([
      triagedPromise, workCompletedPromise, reviewPromise,
    ]);

    assert.ok(triaged, 'Should produce a WorkTriaged event');

    const wcPayload = workCompleted.payload as { workItemId: string; phaseCount: number };
    assert.equal(wcPayload.workItemId, 'intake-interactive-full-001');
    assert.ok(wcPayload.phaseCount > 0, 'Should have executed at least one agent');

    const rcPayload = review.payload as { reviewVerdict: ReviewVerdict };
    assert.ok(
      rcPayload.reviewVerdict.status === 'pass' || rcPayload.reviewVerdict.status === 'conditional',
      'Review should pass or conditionally pass',
    );
  });

  it('pipeline handles executor rejection gracefully', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      simpleExecutor: makeRejectingExecutor(),
      workflowConfig: makeWorkflowConfig(),
    });

    const resultPromise = Promise.race([
      waitForEvent(eventBus, 'WorkCompleted').then((e) => ({ type: 'completed' as const, event: e })),
      waitForEvent(eventBus, 'WorkFailed').then((e) => ({ type: 'failed' as const, event: e })),
    ]);

    const intakeEvent = makeIntakeEvent({ id: 'intake-rejected-001' });
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'rejected-corr'));

    const result = await resultPromise;
    assert.equal(result.type, 'failed', 'Should produce WorkFailed when all agents fail');
  });

  it('preserves correlationId through pipeline events', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      simpleExecutor: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
    });

    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');

    const correlationIds: string[] = [];
    eventBus.subscribe('WorkTriaged', (evt) => correlationIds.push(evt.correlationId));
    eventBus.subscribe('WorkCompleted', (evt) => correlationIds.push(evt.correlationId));

    const intakeEvent = makeIntakeEvent({ id: 'intake-corr-interactive' });
    eventBus.publish(
      createDomainEvent('IntakeCompleted', { intakeEvent }, 'interactive-corr-001'),
    );

    const review = await reviewPromise;
    correlationIds.push(review.correlationId);

    // WorkTriaged, WorkCompleted, ReviewCompleted
    assert.ok(correlationIds.length >= 3, `Expected at least 3 events, got ${correlationIds.length}`);
    for (const cid of correlationIds) {
      assert.equal(cid, 'interactive-corr-001', 'All events should share the same correlationId');
    }
  });

  it('handles concurrent intakes without cross-contamination', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      simpleExecutor: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
    });

    const completedPromise = collectEvents(eventBus, 'WorkCompleted', 2, 8000);

    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent({ id: 'concurrent-int-001' }),
    }));
    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent({ id: 'concurrent-int-002' }),
    }));

    const completed = await completedPromise;
    const ids = completed.map((e) => (e.payload as { workItemId: string }).workItemId);

    assert.equal(ids.length, 2, 'Both work items should complete');
    assert.ok(ids.includes('concurrent-int-001'));
    assert.ok(ids.includes('concurrent-int-002'));
  });
});
