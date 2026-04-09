/**
 * TDD: End-to-end pipeline integration test.
 *
 * Verifies the simplified event-sourced pipeline:
 * IntakeCompleted -> Execution -> WorkCompleted -> Review -> ReviewCompleted
 *
 * Triage runs independently for observability (IntakeCompleted -> WorkTriaged)
 * but execution does not depend on it.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, ReviewVerdict } from '../../src/types';
import { createEventBus, createDomainEvent } from '../../src/shared/event-bus';
import type { EventBus } from '../../src/shared/event-bus';
import type { DomainEventType } from '../../src/shared/event-types';
import { createLogger } from '../../src/shared/logger';
import { startPipeline, type PipelineHandle } from '../../src/pipeline';
import type { CoordinatorDispatcher as LocalAgentTaskExecutor, ExecutionResult } from '../../src/execution/coordinator-dispatcher';
import type { WorkflowConfig } from '../../src/integration/linear/workflow-parser';
import type { SkillResolver, ResolvedSkill } from '../../src/intake/skill-resolver';

const STUB_SKILL: ResolvedSkill = {
  path: '/abs/SKILL.md',
  body: 'stub body',
  frontmatter: {
    name: 'stub', type: null, description: null, color: null,
    capabilities: [], version: null, contextFetchers: [],
    whenToUse: null, allowedTools: [],
  },
};
const STUB_RESOLVER: SkillResolver = {
  resolvePath: () => ({ relPath: '.claude/skills/stub/SKILL.md', ruleKey: 'stub' }),
  resolveByPath: () => STUB_SKILL,
  resolveSkillForEvent: () => STUB_SKILL,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWorkflowConfig(): WorkflowConfig {
  return {
    templates: {
      'github-ops': ['.claude/agents/core/reviewer.md'],
      'tdd-workflow': ['.claude/agents/core/coder.md', '.claude/agents/core/tester.md'],
      'quick-fix': ['.claude/agents/core/coder.md'],
      'cicd-pipeline': ['.claude/agents/core/coder.md'],
      'feature-build': ['.claude/agents/core/architect.md', '.claude/agents/core/coder.md', '.claude/agents/core/reviewer.md'],
      'security-audit': ['.claude/agents/v3/security-architect.md'],
    },
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeTypes: ['unstarted', 'started'], terminalTypes: ['completed', 'canceled'], activeStates: [], terminalStates: [] },
    agents: { maxConcurrent: 8, routing: { bug: 'tdd-workflow' }, defaultTemplate: 'quick-fix' },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    promptTemplate: '',
  };
}

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-e2e-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: { template: 'quick-fix', intent: 'validate-branch', skillPath: '.claude/skills/stub/SKILL.md', ruleKey: 'stub' },
    entities: {
      repo: 'test-org/test-repo',
      branch: 'feature/e2e',
      severity: 'medium',
      files: ['src/index.ts'],
      labels: [],
    },
    ...overrides,
  };
}

/** Stub LocalAgentTask that always succeeds. */
function makeStubExecutor(): LocalAgentTaskExecutor {
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

describe('Pipeline E2E', () => {
  let handle: PipelineHandle | undefined;

  afterEach(() => {
    handle?.shutdown();
    handle = undefined;
  });

  it('IntakeCompleted flows through execution to WorkCompleted and ReviewCompleted', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      localAgentTask: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
      skillResolver: STUB_RESOLVER,
    });

    // Set up event-driven waits before publishing
    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');
    const workCompletedPromise = waitForEvent(eventBus, 'WorkCompleted');
    // Triage still runs independently
    const triagedPromise = waitForEvent(eventBus, 'WorkTriaged');

    // Act
    const intakeEvent = makeIntakeEvent();
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'e2e-corr-001'));

    // Wait for all events
    const [triaged, workCompleted, review] = await Promise.all([
      triagedPromise, workCompletedPromise, reviewPromise,
    ]);

    // Assert triage ran independently
    assert.ok(triaged, 'Should produce a WorkTriaged event');

    const wcPayload = workCompleted.payload as { workItemId: string; phaseCount: number };
    assert.equal(wcPayload.workItemId, 'intake-e2e-001');
    assert.ok(wcPayload.phaseCount > 0, 'Should have executed at least one agent');

    const rcPayload = review.payload as { reviewVerdict: ReviewVerdict };
    assert.equal(rcPayload.reviewVerdict.status, 'pass', 'Stub review should pass');
    assert.equal(rcPayload.reviewVerdict.codeReviewApproval, true);
    assert.equal(rcPayload.reviewVerdict.phaseResultId, 'intake-e2e-001');
  });

  it('preserves correlationId through the full pipeline', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      localAgentTask: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
      skillResolver: STUB_RESOLVER,
    });

    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');

    const correlationIds: string[] = [];
    eventBus.subscribe('WorkTriaged', (evt) => correlationIds.push(evt.correlationId));
    eventBus.subscribe('WorkCompleted', (evt) => correlationIds.push(evt.correlationId));

    const intakeEvent = makeIntakeEvent({ id: 'intake-corr-001' });
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'pipeline-corr-001'));

    const review = await reviewPromise;
    correlationIds.push(review.correlationId);

    assert.equal(correlationIds.length, 3);
    for (const cid of correlationIds) {
      assert.equal(cid, 'pipeline-corr-001', 'All events should share the same correlationId');
    }
  });

  it('handles multiple IntakeCompleted events concurrently', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      localAgentTask: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
      skillResolver: STUB_RESOLVER,
    });

    // Wait for 2 WorkCompleted events
    const completedPromise = collectEvents(eventBus, 'WorkCompleted', 2);

    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent({ id: 'concurrent-001' }),
    }));
    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent({ id: 'concurrent-002' }),
    }));

    const completed = await completedPromise;
    const ids = completed.map((e) => (e.payload as { workItemId: string }).workItemId);

    assert.equal(ids.length, 2, 'Both work items should complete');
    assert.ok(ids.includes('concurrent-001'));
    assert.ok(ids.includes('concurrent-002'));
  });

  it('shutdown stops all engines (no events processed after)', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus, logger,
      localAgentTask: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
      skillResolver: STUB_RESOLVER,
    });
    handle.shutdown();

    const triagedEvents: unknown[] = [];
    eventBus.subscribe('WorkTriaged', (evt) => triagedEvents.push(evt));

    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent(),
    }));

    // Short wait
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(triagedEvents.length, 0, 'No events should be processed after shutdown');

    handle = undefined;
  });

  it('does not send Linear intake through the old generic execution path in Symphony mode', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });

    handle = startPipeline({
      eventBus,
      logger,
      localAgentTask: makeStubExecutor(),
      workflowConfig: makeWorkflowConfig(),
      linearExecutionMode: 'symphony',
    });

    eventBus.subscribe('WorkCompleted', () => {
      throw new Error('Linear intake should not produce WorkCompleted through the generic execution engine');
    });

    const intakeEvent = makeIntakeEvent({
      id: 'linear-pipeline-001',
      source: 'linear',
      sourceMetadata: {
        template: 'quick-fix',
        linearIssueId: 'issue-linear-001',
        intent: 'custom:linear-todo',
      },
    });

    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'linear-pipeline-corr-001'));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
