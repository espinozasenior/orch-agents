/**
 * Tests for the simplified Triage Engine.
 *
 * Covers: label-based priority assignment, severity mapping,
 * skipTriage fast path, and event bus integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent } from '../src/types';
import {
  triageEvent,
  startTriageEngine,
} from '../src/triage/triage-engine';
import { createEventBus, createDomainEvent } from '../src/kernel/event-bus';
import { createLogger } from '../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'test-intake-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: { eventType: 'push', skipTriage: false, intent: 'validate-main' },
    entities: {
      repo: 'org/repo',
      branch: 'main',
      severity: 'medium',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Triage Engine', () => {
  describe('triageEvent()', () => {
    it('returns a TriageResult with required fields', () => {
      const result = triageEvent(makeIntakeEvent());
      assert.ok(result.intakeEventId);
      assert.ok(result.priority);
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

  describe('Priority from labels', () => {
    it('security label -> P0-immediate', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', labels: ['security'] },
      }));
      assert.equal(result.priority, 'P0-immediate');
    });

    it('P0 label -> P0-immediate', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', labels: ['P0'] },
      }));
      assert.equal(result.priority, 'P0-immediate');
    });

    it('bug label -> P1-high', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', labels: ['bug'] },
      }));
      assert.equal(result.priority, 'P1-high');
    });

    it('hotfix label -> P1-high', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', labels: ['hotfix'] },
      }));
      assert.equal(result.priority, 'P1-high');
    });

    it('documentation label -> P3-backlog', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', labels: ['documentation'] },
      }));
      assert.equal(result.priority, 'P3-backlog');
    });

    it('no labels, medium severity -> P2-standard', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'medium' },
      }));
      assert.equal(result.priority, 'P2-standard');
    });
  });

  describe('Priority from severity', () => {
    it('critical severity -> P0-immediate', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'critical' },
      }));
      assert.equal(result.priority, 'P0-immediate');
    });

    it('high severity -> P1-high', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'high' },
      }));
      assert.equal(result.priority, 'P1-high');
    });

    it('low severity -> P3-backlog', () => {
      const result = triageEvent(makeIntakeEvent({
        entities: { repo: 'org/repo', severity: 'low' },
      }));
      assert.equal(result.priority, 'P3-backlog');
    });
  });

  describe('skipTriage fast path', () => {
    it('returns fast result when skipTriage=true', () => {
      const result = triageEvent(makeIntakeEvent({
        sourceMetadata: { skipTriage: true },
      }));
      assert.equal(result.skipTriage, true);
    });

    it('fast path uses severity for priority', () => {
      const result = triageEvent(makeIntakeEvent({
        sourceMetadata: { skipTriage: true },
        entities: { repo: 'org/repo', severity: 'critical' },
      }));
      assert.equal(result.priority, 'P0-immediate');
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

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));

      await new Promise((r) => setTimeout(r, 10));

      assert.equal(received.length, 1);
      const workTriaged = received[0] as { payload: { triageResult: { intakeEventId: string } } };
      assert.equal(workTriaged.payload.triageResult.intakeEventId, 'test-intake-001');

      unsub();
      eventBus.removeAllListeners();
    });
  });
});
