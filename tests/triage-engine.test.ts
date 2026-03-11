/**
 * Tests for the Triage Engine.
 *
 * Covers: priority scoring, complexity assessment, impact classification,
 * risk evaluation, SPARC phase selection, fast triage (skipTriage=true),
 * and event bus integration.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent } from '../src/types';
import {
  triageEvent,
  setUrgencyRules,
  resetUrgencyRules,
  startTriageEngine,
} from '../src/triage/triage-engine';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import { createLogger } from '../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'test-intake-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: { eventType: 'push', template: 'cicd-pipeline', phases: ['refinement', 'completion'], skipTriage: false },
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
  labelBoosts: { bug: 0.2, security: 0.4, hotfix: 0.3, enhancement: 0.0, P0: 0.5, P1: 0.3, P2: 0.0, P3: -0.2 },
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

describe('Triage Engine', () => {
  beforeEach(() => {
    setUrgencyRules(TEST_RULES);
  });

  afterEach(() => {
    resetUrgencyRules();
  });

  describe('triageEvent()', () => {
    it('returns a TriageResult with all required fields', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.ok(result.intakeEventId);
      assert.ok(result.priority);
      assert.ok(result.complexity);
      assert.ok(result.impact);
      assert.ok(result.risk);
      assert.ok(result.recommendedPhases.length > 0);
      assert.ok(result.estimatedEffort);
      assert.equal(typeof result.requiresApproval, 'boolean');
      assert.equal(typeof result.skipTriage, 'boolean');
    });

    it('assigns correct intakeEventId', () => {
      const result = triageEvent(makeIntakeEvent({ id: 'my-event-123' }));
      assert.equal(result.intakeEventId, 'my-event-123');
    });

    it('defaults to non-skipTriage', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.equal(result.skipTriage, false);
    });
  });

  describe('Priority scoring', () => {
    it('critical severity + security label + many files → P1-high or higher', () => {
      const files = Array.from({ length: 25 }, (_, i) => `dir${i}/file.ts`);
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'critical', labels: ['security'], files },
      }));
      assert.ok(
        result.priority === 'P0-immediate' || result.priority === 'P1-high',
        `Expected P0 or P1, got ${result.priority}`,
      );
    });

    it('low severity, no labels → P3-backlog', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'low' },
      }));
      assert.equal(result.priority, 'P3-backlog');
    });

    it('medium severity default → P3-backlog (isolated, no labels)', () => {
      const result = triageEvent(makeIntakeEvent());
      // isolated impact + medium severity + no labels = low score
      assert.equal(result.priority, 'P3-backlog');
    });
  });

  describe('Complexity assessment', () => {
    it('no files = low base complexity', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.ok(result.complexity.percentage <= 30, `Expected <=30, got ${result.complexity.percentage}`);
      assert.equal(result.complexity.level, 'low');
    });

    it('many files increase complexity', () => {
      const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', files },
      }));
      assert.ok(result.complexity.percentage >= 40, `Expected >=40, got ${result.complexity.percentage}`);
    });

    it('security label boosts complexity', () => {
      const base = triageEvent(makeIntakeEvent());
      const withSecurity = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', labels: ['security'] },
      }));
      assert.ok(withSecurity.complexity.percentage > base.complexity.percentage);
    });

    it('incident-response intent boosts complexity', () => {
      const result = triageEvent(makeIntakeEvent({ intent: 'incident-response' }));
      assert.ok(result.complexity.percentage >= 40, `Expected >=40, got ${result.complexity.percentage}`);
    });
  });

  describe('Impact classification', () => {
    it('no files → isolated', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.equal(result.impact, 'isolated');
    });

    it('many files (>20) → system-wide', () => {
      const files = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', files },
      }));
      assert.equal(result.impact, 'system-wide');
    });

    it('files in multiple dirs → cross-cutting', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', files: ['src/a.ts', 'tests/b.ts', 'config/c.json', 'docs/d.md'] },
      }));
      assert.equal(result.impact, 'cross-cutting');
    });

    it('4+ files in one dir → module', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] },
      }));
      assert.equal(result.impact, 'module');
    });
  });

  describe('Risk assessment', () => {
    it('critical severity + system-wide → critical risk', () => {
      const files = Array.from({ length: 25 }, (_, i) => `dir${i}/file.ts`);
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'critical', files },
      }));
      assert.equal(result.risk, 'critical');
    });

    it('low severity + isolated → low risk', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'low' },
      }));
      assert.equal(result.risk, 'low');
    });
  });

  describe('SPARC phases', () => {
    it('uses routing-provided phases when available', () => {
      const result = triageEvent(makeIntakeEvent({
        sourceMetadata: { phases: ['refinement', 'completion'], skipTriage: false },
      }));
      assert.deepEqual(result.recommendedPhases, ['refinement', 'completion']);
    });

    it('high complexity → all 5 phases', () => {
      const files = Array.from({ length: 20 }, (_, i) => `dir${i}/file.ts`);
      const result = triageEvent(makeIntakeEvent({
        sourceMetadata: { skipTriage: false },
        intent: 'incident-response',
        entities: { repo: 'org/repo', severity: 'critical', labels: ['security', 'bug'], files },
      }));
      assert.equal(result.recommendedPhases.length, 5);
    });
  });

  describe('Effort estimation', () => {
    it('low complexity + few files → trivial or small', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.ok(
        result.estimatedEffort === 'trivial' || result.estimatedEffort === 'small',
        `Expected trivial/small, got ${result.estimatedEffort}`,
      );
    });

    it('high complexity + many files → large or epic', () => {
      const files = Array.from({ length: 30 }, (_, i) => `dir${i % 5}/file${i}.ts`);
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'critical', labels: ['security', 'bug'], files },
        intent: 'incident-response',
      }));
      assert.ok(
        result.estimatedEffort === 'large' || result.estimatedEffort === 'epic',
        `Expected large/epic, got ${result.estimatedEffort}`,
      );
    });
  });

  describe('skipTriage fast path', () => {
    it('returns fast result when skipTriage=true', () => {
      const result = triageEvent(makeIntakeEvent({
        sourceMetadata: { skipTriage: true, phases: ['refinement'], template: 'quick-fix' },
      }));
      assert.equal(result.skipTriage, true);
      assert.equal(result.complexity.level, 'low');
      assert.equal(result.impact, 'isolated');
      assert.equal(result.risk, 'low');
      assert.equal(result.requiresApproval, false);
      assert.deepEqual(result.recommendedPhases, ['refinement']);
    });

    it('fast path uses severity for priority', () => {
      const result = triageEvent(makeIntakeEvent({
        sourceMetadata: { skipTriage: true, phases: ['refinement'] },
        entities: { repo: 'org/repo', severity: 'critical' },
      }));
      assert.equal(result.priority, 'P0-immediate');
    });
  });

  describe('requiresApproval', () => {
    it('true when risk is critical', () => {
      const files = Array.from({ length: 25 }, (_, i) => `dir${i}/file.ts`);
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'critical', files },
      }));
      assert.equal(result.requiresApproval, true);
    });

    it('false for low-risk items', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.equal(result.requiresApproval, false);
    });
  });

  describe('Event bus integration', () => {
    it('publishes WorkTriaged on IntakeCompleted', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const unsub = startTriageEngine({ eventBus, logger });

      const received: unknown[] = [];
      eventBus.subscribe('WorkTriaged', (evt) => {
        received.push(evt);
      });

      // Publish IntakeCompleted
      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const workTriaged = received[0] as { payload: { triageResult: { intakeEventId: string } } };
      assert.equal(workTriaged.payload.triageResult.intakeEventId, 'test-intake-001');

      unsub();
      eventBus.removeAllListeners();
    });
  });
});
