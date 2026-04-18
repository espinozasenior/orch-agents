import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDomainEvent } from '../../src/kernel/event-bus';

/**
 * Tests that event type definitions are structurally correct.
 * These are compile-time checks expressed as runtime assertions.
 */
describe('DomainEvent type definitions', () => {
  describe('happy-path events', () => {
    it('WebhookReceived has correct shape', () => {
      const event = createDomainEvent('WebhookReceived', {
        rawPayload: { action: 'opened' },
        eventType: 'pull_request',
        deliveryId: 'del-1',
      });
      assert.equal(event.type, 'WebhookReceived');
      assert.equal(event.payload.eventType, 'pull_request');
    });

    it('RequirementSubmitted has correct shape', () => {
      const event = createDomainEvent('RequirementSubmitted', {
        requirementId: 'req-1',
        clientId: 'client-1',
        details: { title: 'Add auth' },
      });
      assert.equal(event.type, 'RequirementSubmitted');
      assert.equal(event.payload.requirementId, 'req-1');
    });

    it('IntakeCompleted has correct shape', () => {
      const event = createDomainEvent('IntakeCompleted', {
        intakeEvent: {
          id: 'evt-1',
          timestamp: '2026-01-01T00:00:00Z',
          source: 'github',
          sourceMetadata: { intent: 'review-pr' },
          entities: { repo: 'test/repo', prNumber: 42 },
        },
      });
      assert.equal(event.payload.intakeEvent.sourceMetadata.intent, 'review-pr');
      assert.equal(event.payload.intakeEvent.entities.prNumber, 42);
    });

    it('WorkTriaged has correct shape', () => {
      const event = createDomainEvent('WorkTriaged', {
        intakeEvent: {
          id: 'evt-1',
          timestamp: '2026-01-01T00:00:00Z',
          source: 'github',
          sourceMetadata: { intent: 'triage-issue' },
          entities: {},
        },
        triageResult: {
          intakeEventId: 'evt-1',
          priority: 'P2-standard',
          complexity: { level: 'medium', percentage: 45 },
          impact: 'module',
          risk: 'low',
          recommendedPhases: ['specification', 'refinement', 'completion'],
          requiresApproval: false,
          skipTriage: false,
          estimatedEffort: 'medium',
        },
      });
      assert.equal(event.payload.triageResult.priority, 'P2-standard');
    });

    it('PlanCreated has correct shape', () => {
      const event = createDomainEvent('PlanCreated', {
        workflowPlan: {
          id: 'plan-1',
          workItemId: 'w-1',
          topology: 'hierarchical',
          swarmStrategy: 'specialized',
          consensus: 'raft',
          maxAgents: 8,
          phases: [{ type: 'specification', agents: ['spec-1'], gate: 'review', skippable: false }],
          agentTeam: [{ role: 'lead', type: 'specification', tier: 3, required: true }],
          estimatedDuration: 7200,
          estimatedCost: 3.5,
        },
      });
      assert.equal(event.payload.workflowPlan.consensus, 'raft');
    });
  });

  describe('failure/recovery events', () => {
    it('PhaseRetried has correct shape', () => {
      const event = createDomainEvent('PhaseRetried', {
        phaseId: 'phase-1',
        retryCount: 2,
        feedback: 'Tests failed on assertion',
      });
      assert.equal(event.payload.retryCount, 2);
    });

    it('WorkFailed has correct shape', () => {
      const event = createDomainEvent('WorkFailed', {
        workItemId: 'w-1',
        failureReason: 'Agent timeout',
        retryCount: 3,
      });
      assert.equal(event.payload.failureReason, 'Agent timeout');
    });

    it('WorkCancelled has correct shape', () => {
      const event = createDomainEvent('WorkCancelled', {
        workItemId: 'w-1',
        cancellationReason: 'User requested',
      });
      assert.equal(event.payload.cancellationReason, 'User requested');
    });

    it('SwarmInitialized has correct shape', () => {
      const event = createDomainEvent('SwarmInitialized', {
        swarmId: 's-1',
        topology: 'hierarchical-mesh',
        agentCount: 6,
      });
      assert.equal(event.payload.agentCount, 6);
    });

    it('WorkPaused has correct shape', () => {
      const event = createDomainEvent('WorkPaused', {
        workItemId: 'w-1',
        pauseReason: 'Awaiting approval',
        resumable: true,
      });
      assert.equal(event.payload.resumable, true);
    });
  });
});
