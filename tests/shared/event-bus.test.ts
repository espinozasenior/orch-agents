import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, createDomainEvent } from '../../src/shared/event-bus';
import type { EventBus } from '../../src/shared/event-bus';
import { createLogger } from '../../src/shared/logger';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus(createLogger({ level: 'fatal' }));
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  describe('publish and subscribe', () => {
    it('should deliver event to subscriber', (_, done) => {
      const event = createDomainEvent('IntakeCompleted', {
        intakeEvent: {
          id: 'evt-1',
          timestamp: new Date().toISOString(),
          source: 'github' as const,
          sourceMetadata: {},
          intent: 'review-pr' as const,
          entities: { repo: 'test/repo' },
        },
      });

      bus.subscribe('IntakeCompleted', (received) => {
        assert.equal(received.type, 'IntakeCompleted');
        assert.equal(received.payload.intakeEvent.id, 'evt-1');
        done();
      });

      bus.publish(event);
    });

    it('should not deliver events of other types', () => {
      let called = false;

      bus.subscribe('WorkFailed', () => {
        called = true;
      });

      const event = createDomainEvent('IntakeCompleted', {
        intakeEvent: {
          id: 'evt-2',
          timestamp: new Date().toISOString(),
          source: 'github' as const,
          sourceMetadata: {},
          intent: 'review-pr' as const,
          entities: {},
        },
      });

      bus.publish(event);
      assert.equal(called, false);
    });

    it('should deliver to multiple subscribers', () => {
      let count = 0;

      bus.subscribe('PhaseRetried', () => { count++; });
      bus.subscribe('PhaseRetried', () => { count++; });

      const event = createDomainEvent('PhaseRetried', {
        phaseId: 'p-1',
        retryCount: 1,
        feedback: 'test retry',
      });

      bus.publish(event);
      assert.equal(count, 2);
    });
  });

  describe('unsubscribe', () => {
    it('should stop receiving events after unsubscribe', () => {
      let count = 0;

      const unsub = bus.subscribe('WorkCancelled', () => { count++; });

      const event = createDomainEvent('WorkCancelled', {
        workItemId: 'w-1',
        cancellationReason: 'test',
      });

      bus.publish(event);
      assert.equal(count, 1);

      unsub();
      bus.publish(event);
      assert.equal(count, 1);
    });
  });

  describe('error handling', () => {
    it('should catch handler errors without crashing', () => {
      bus.subscribe('SwarmInitialized', () => {
        throw new Error('handler exploded');
      });

      const event = createDomainEvent('SwarmInitialized', {
        swarmId: 's-1',
        topology: 'hierarchical',
        agentCount: 5,
      });

      // Should not throw
      assert.doesNotThrow(() => bus.publish(event));
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all subscribers', () => {
      let count = 0;

      bus.subscribe('WorkPaused', () => { count++; });
      bus.removeAllListeners();

      const event = createDomainEvent('WorkPaused', {
        workItemId: 'w-2',
        pauseReason: 'test',
        resumable: true,
      });

      bus.publish(event);
      assert.equal(count, 0);
    });
  });
});

describe('createDomainEvent', () => {
  it('should generate unique IDs', () => {
    const e1 = createDomainEvent('WorkFailed', {
      workItemId: 'w-1',
      failureReason: 'test',
      retryCount: 0,
    });
    const e2 = createDomainEvent('WorkFailed', {
      workItemId: 'w-2',
      failureReason: 'test',
      retryCount: 0,
    });

    assert.notEqual(e1.id, e2.id);
  });

  it('should set type correctly', () => {
    const event = createDomainEvent('PlanCreated', {
      workflowPlan: {
        id: 'plan-1',
        workItemId: 'w-1',
        methodology: 'sparc-full' as const,
        template: 'sparc-full-cycle',
        topology: 'hierarchical' as const,
        swarmStrategy: 'specialized' as const,
        consensus: 'raft' as const,
        maxAgents: 8,
        phases: [],
        agentTeam: [],
        estimatedDuration: 3600,
        estimatedCost: 1.5,
      },
    });

    assert.equal(event.type, 'PlanCreated');
    assert.ok(event.timestamp);
    assert.ok(event.correlationId);
  });

  it('should use provided correlationId', () => {
    const event = createDomainEvent(
      'WeightsUpdated',
      { patternId: 'p-1', newWeight: 0.8, previousWeight: 0.5 },
      'corr-123',
    );

    assert.equal(event.correlationId, 'corr-123');
  });
});
