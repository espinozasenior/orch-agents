/**
 * Tests for the Planning Engine (end-to-end triage → plan).
 *
 * These tests verify the full pipeline: IntakeCompleted → WorkTriaged → PlanCreated.
 * The decision engine requires the tech-lead-router CJS module, so we test
 * the planning engine integration with the event bus.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, WorkflowPlan } from '../src/types';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import { createLogger } from '../src/shared/logger';
import { setUrgencyRules, resetUrgencyRules, startTriageEngine } from '../src/triage/triage-engine';
import { startPlanningEngine } from '../src/planning/planning-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'test-plan-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: {
      eventType: 'push',
      template: 'cicd-pipeline',
      phases: ['refinement', 'completion'],
      skipTriage: false,
    },
    intent: 'validate-main',
    entities: {
      repo: 'org/repo',
      branch: 'main',
      severity: 'medium',
    },
    ...overrides,
  };
}

const TEST_RULES = {
  priorityWeights: { severity: 0.35, impact: 0.25, skipTriage: 0.15, labelBoost: 0.15, recency: 0.10 },
  severityScores: { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 },
  impactScores: { 'system-wide': 1.0, 'cross-cutting': 0.75, module: 0.5, isolated: 0.25 },
  labelBoosts: { bug: 0.2, security: 0.4, hotfix: 0.3 },
  priorityThresholds: { 'P0-immediate': 0.85, 'P1-high': 0.60, 'P2-standard': 0.35, 'P3-backlog': 0.0 },
  effortMapping: {
    trivial: { maxComplexity: 10, maxFiles: 1 },
    small: { maxComplexity: 25, maxFiles: 3 },
    medium: { maxComplexity: 50, maxFiles: 10 },
    large: { maxComplexity: 75, maxFiles: 25 },
    epic: { maxComplexity: 100, maxFiles: 999 },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Planning Engine', () => {
  afterEach(() => {
    resetUrgencyRules();
  });

  describe('Full pipeline: IntakeCompleted → PlanCreated', () => {
    it('produces a WorkflowPlan from an IntakeEvent', async () => {
      setUrgencyRules(TEST_RULES);
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsubTriage = startTriageEngine({ eventBus, logger });
      const unsubPlanning = startPlanningEngine({ eventBus, logger });

      const plans: WorkflowPlan[] = [];
      const unsubPlan = eventBus.subscribe('PlanCreated', (evt) => {
        plans.push(evt.payload.workflowPlan);
      });

      // Trigger pipeline
      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(plans.length, 1);
      const plan = plans[0];

      // Verify plan structure
      assert.ok(plan.id, 'Plan should have an ID');
      assert.equal(plan.workItemId, 'test-plan-001');
      assert.ok(plan.methodology, 'Plan should have methodology');
      assert.ok(plan.template, 'Plan should have template');
      assert.ok(plan.topology, 'Plan should have topology');
      assert.ok(plan.phases.length > 0, 'Plan should have phases');
      assert.ok(plan.agentTeam.length > 0, 'Plan should have agents');
      assert.ok(plan.maxAgents > 0, 'Plan should have maxAgents');
      assert.ok(plan.estimatedDuration > 0, 'Plan should have estimated duration');
      assert.ok(plan.estimatedCost >= 0, 'Plan should have estimated cost');

      unsubTriage();
      unsubPlanning();
      unsubPlan();
      eventBus.removeAllListeners();
    });

    it('plan topology matches complexity', async () => {
      setUrgencyRules(TEST_RULES);
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsubTriage = startTriageEngine({ eventBus, logger });
      const unsubPlanning = startPlanningEngine({ eventBus, logger });

      const plans: WorkflowPlan[] = [];
      eventBus.subscribe('PlanCreated', (evt) => {
        plans.push(evt.payload.workflowPlan);
      });

      // Low complexity event
      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { skipTriage: true, phases: ['refinement'], template: 'quick-fix' },
          entities: { repo: 'org/repo', severity: 'low' },
        }),
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(plans.length, 1);
      const plan = plans[0];
      // Low complexity should not be hierarchical-mesh
      assert.notEqual(plan.topology, 'hierarchical-mesh');

      unsubTriage();
      unsubPlanning();
      eventBus.removeAllListeners();
    });

    it('preserves correlation ID through the pipeline', async () => {
      setUrgencyRules(TEST_RULES);
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsubTriage = startTriageEngine({ eventBus, logger });
      const unsubPlanning = startPlanningEngine({ eventBus, logger });

      const correlationIds: string[] = [];
      eventBus.subscribe('WorkTriaged', (evt) => {
        correlationIds.push(evt.correlationId);
      });
      eventBus.subscribe('PlanCreated', (evt) => {
        correlationIds.push(evt.correlationId);
      });

      const sourceEvent = createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }, 'test-correlation-xyz');

      eventBus.publish(sourceEvent);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(correlationIds.length, 2);
      assert.equal(correlationIds[0], 'test-correlation-xyz');
      assert.equal(correlationIds[1], 'test-correlation-xyz');

      unsubTriage();
      unsubPlanning();
      eventBus.removeAllListeners();
    });
  });

  describe('Feature build pipeline', () => {
    it('full SPARC feature produces all 5 phases', async () => {
      setUrgencyRules(TEST_RULES);
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsubTriage = startTriageEngine({ eventBus, logger });
      const unsubPlanning = startPlanningEngine({ eventBus, logger });

      const plans: WorkflowPlan[] = [];
      eventBus.subscribe('PlanCreated', (evt) => {
        plans.push(evt.payload.workflowPlan);
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          intent: 'custom:build-feature',
          sourceMetadata: {
            template: 'feature-build',
            phases: ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'],
            skipTriage: false,
          },
          entities: {
            repo: 'org/repo',
            labels: ['enhancement'],
            severity: 'medium',
            files: ['src/new-feature.ts', 'tests/new-feature.test.ts'],
          },
        }),
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(plans.length, 1);
      const plan = plans[0];
      assert.equal(plan.methodology, 'sparc-full');
      assert.equal(plan.phases.length, 5);
      assert.ok(plan.agentTeam.length >= 4);

      unsubTriage();
      unsubPlanning();
      eventBus.removeAllListeners();
    });
  });

  describe('Bug fix pipeline', () => {
    it('TDD workflow produces spec → refinement → completion', async () => {
      setUrgencyRules(TEST_RULES);
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsubTriage = startTriageEngine({ eventBus, logger });
      const unsubPlanning = startPlanningEngine({ eventBus, logger });

      const plans: WorkflowPlan[] = [];
      eventBus.subscribe('PlanCreated', (evt) => {
        plans.push(evt.payload.workflowPlan);
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          intent: 'custom:fix-bug',
          sourceMetadata: {
            template: 'tdd-workflow',
            phases: ['specification', 'refinement', 'completion'],
            skipTriage: false,
          },
          entities: {
            repo: 'org/repo',
            labels: ['bug'],
            severity: 'high',
          },
        }),
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(plans.length, 1);
      const plan = plans[0];
      assert.equal(plan.methodology, 'tdd');
      assert.equal(plan.phases.length, 3);
      assert.equal(plan.phases[0].type, 'specification');
      assert.equal(plan.phases[1].type, 'refinement');
      assert.equal(plan.phases[2].type, 'completion');

      unsubTriage();
      unsubPlanning();
      eventBus.removeAllListeners();
    });
  });
});
