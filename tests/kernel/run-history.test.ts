import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEventBus, type EventBus } from '../../src/kernel/event-bus';
import { createRunHistory, type RunHistory } from '../../src/kernel/run-history';
import type {
  IntakeCompletedEvent,
  PlanCreatedEvent,
  PhaseStartedEvent,
  PhaseCompletedEvent,
  AgentSpawnedEvent,
  AgentCompletedEvent,
  WorkCompletedEvent,
  WorkFailedEvent,
} from '../../src/kernel/event-types';
import type { PlanId, WorkItemId, ExecId, PhaseId } from '../../src/kernel/branded-types';

const PLAN_ID = 'plan-1' as PlanId;
const WORK_ID = 'wi-1' as WorkItemId;
const EXEC_ID = 'exec-1' as ExecId;
const PHASE_ID = 'phase-1' as PhaseId;

function intakeCompleted(correlationId: string): IntakeCompletedEvent {
  return {
    type: 'IntakeCompleted',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:00Z',
    correlationId,
    payload: {
      intakeEvent: {
        id: 'intake-1',
        timestamp: '2026-04-29T10:00:00Z',
        source: 'github',
        sourceMetadata: {
          source: 'github',
          eventType: 'pull_request',
          deliveryId: 'd1',
        },
        entities: { repo: 'acme/app', prNumber: 42 },
      },
    },
  };
}

function planCreated(correlationId: string): PlanCreatedEvent {
  return {
    type: 'PlanCreated',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:01Z',
    correlationId,
    payload: {
      workflowPlan: { id: PLAN_ID, workItemId: WORK_ID, agentTeam: [] },
    },
  };
}

function phaseStarted(correlationId: string): PhaseStartedEvent {
  return {
    type: 'PhaseStarted',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:02Z',
    correlationId,
    payload: { planId: PLAN_ID, phaseType: 'specification', agents: ['analyst'] },
  };
}

function phaseCompleted(correlationId: string): PhaseCompletedEvent {
  return {
    type: 'PhaseCompleted',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:03Z',
    correlationId,
    payload: {
      phaseResult: {
        phaseId: PHASE_ID,
        planId: PLAN_ID,
        phaseType: 'specification',
        status: 'completed',
        artifacts: [{ id: 'a1', type: 'doc', uri: 'spec.md', metadata: {} }],
        metrics: { duration: 1000, agentUtilization: 0.5, modelCost: 0.01 },
      },
    },
  };
}

function agentSpawned(correlationId: string): AgentSpawnedEvent {
  return {
    type: 'AgentSpawned',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:04Z',
    correlationId,
    payload: {
      execId: EXEC_ID,
      planId: PLAN_ID,
      agentRole: 'analyst',
      agentType: 'specification',
      phaseType: 'specification',
    },
  };
}

function agentCompleted(correlationId: string): AgentCompletedEvent {
  return {
    type: 'AgentCompleted',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:05Z',
    correlationId,
    payload: {
      execId: EXEC_ID,
      planId: PLAN_ID,
      agentRole: 'analyst',
      duration: 800,
      tokenUsage: { input: 100, output: 200 },
    },
  };
}

function workCompleted(correlationId: string): WorkCompletedEvent {
  return {
    type: 'WorkCompleted',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:06Z',
    correlationId,
    payload: { workItemId: WORK_ID, planId: PLAN_ID, phaseCount: 1, totalDuration: 6000 },
  };
}

function workFailed(correlationId: string, reason: string): WorkFailedEvent {
  return {
    type: 'WorkFailed',
    id: randomUUID(),
    timestamp: '2026-04-29T10:00:06Z',
    correlationId,
    payload: { workItemId: WORK_ID, planId: PLAN_ID, failureReason: reason, retryCount: 0 },
  };
}

describe('createRunHistory', () => {
  let bus: EventBus;
  let history: RunHistory;

  beforeEach(() => {
    bus = createEventBus();
    history = createRunHistory(bus, { capacity: 5 });
  });

  afterEach(() => {
    history.close();
    bus.removeAllListeners();
  });

  it('creates a run on IntakeCompleted with derived title', () => {
    bus.publish(intakeCompleted('corr-1'));
    const list = history.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'acme/app PR #42');
    assert.equal(list[0].source, 'github');
    assert.equal(list[0].status, 'running');
  });

  it('indexes by planId once PlanCreated fires (lookup either way)', () => {
    bus.publish(intakeCompleted('corr-1'));
    bus.publish(planCreated('corr-1'));
    assert.ok(history.get('corr-1'));
    assert.ok(history.get(PLAN_ID));
    assert.equal(history.get('corr-1')!.planId, PLAN_ID);
  });

  it('folds phase + agent events into the summary', () => {
    bus.publish(intakeCompleted('corr-1'));
    bus.publish(planCreated('corr-1'));
    bus.publish(phaseStarted('corr-1'));
    bus.publish(agentSpawned('corr-1'));
    bus.publish(agentCompleted('corr-1'));
    bus.publish(phaseCompleted('corr-1'));

    const summary = history.get('corr-1')!;
    assert.equal(summary.phases.length, 1);
    assert.equal(summary.phases[0].status, 'completed');
    assert.equal(summary.phases[0].artifactCount, 1);
    assert.equal(summary.agents.length, 1);
    assert.equal(summary.agents[0].status, 'completed');
    assert.equal(summary.agents[0].durationMs, 800);
    assert.deepEqual(summary.agents[0].tokenUsage, { input: 100, output: 200 });
  });

  it('marks run completed/failed on terminal events', () => {
    bus.publish(intakeCompleted('a'));
    bus.publish(workCompleted('a'));
    assert.equal(history.get('a')!.status, 'completed');

    bus.publish(intakeCompleted('b'));
    bus.publish(workFailed('b', 'CI failed'));
    assert.equal(history.get('b')!.status, 'failed');
    assert.equal(history.get('b')!.failureReason, 'CI failed');
  });

  it('lists most-recent first', () => {
    bus.publish(intakeCompleted('first'));
    bus.publish(intakeCompleted('second'));
    bus.publish(intakeCompleted('third'));
    const ids = history.list().map((r) => r.correlationId);
    assert.deepEqual(ids, ['third', 'second', 'first']);
  });

  it('evicts settled runs first when capacity is reached', () => {
    // Capacity 5. Settle 2 runs, then add 4 active runs (5 total = at cap).
    bus.publish(intakeCompleted('settled-a'));
    bus.publish(workCompleted('settled-a'));
    bus.publish(intakeCompleted('settled-b'));
    bus.publish(workCompleted('settled-b'));
    bus.publish(intakeCompleted('active-1'));
    bus.publish(intakeCompleted('active-2'));
    bus.publish(intakeCompleted('active-3'));
    assert.equal(history.size(), 5);

    // Trigger eviction by adding a 6th run
    bus.publish(intakeCompleted('new-arrival'));
    assert.equal(history.size(), 5);
    // The first settled one should be gone
    assert.equal(history.get('settled-a'), undefined);
    assert.ok(history.get('new-arrival'));
    // Active runs should still be present
    assert.ok(history.get('active-1'));
  });

  it('falls back to evicting the absolute oldest if no settled runs exist', () => {
    for (let i = 1; i <= 5; i++) bus.publish(intakeCompleted(`run-${i}`));
    assert.equal(history.size(), 5);
    bus.publish(intakeCompleted('run-6'));
    assert.equal(history.size(), 5);
    assert.equal(history.get('run-1'), undefined);
    assert.ok(history.get('run-6'));
  });

  it('close() unsubscribes from the bus and clears state', () => {
    bus.publish(intakeCompleted('x'));
    assert.equal(history.size(), 1);
    history.close();
    bus.publish(intakeCompleted('y'));
    assert.equal(history.size(), 0);
  });
});
