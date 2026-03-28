/**
 * Tests for LinearNormalizer -- London School TDD with WorkflowConfig.
 *
 * Covers: AC3, AC4, AC12 (bot loop prevention), label-based routing.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLinearEvent,
  setWorkflowConfig,
  resetWorkflowConfig,
  setLinearBotUserId,
} from '../../../src/integration/linear/linear-normalizer';
import type { LinearWebhookPayload } from '../../../src/integration/linear/types';
import type { WorkflowConfig } from '../../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Test workflow config (mirrors the old routing rules behavior)
// ---------------------------------------------------------------------------

const TEST_WORKFLOW_CONFIG: WorkflowConfig = {
  tracker: {
    kind: 'linear',
    apiKey: '',
    team: 'ENG',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
  },
  agents: {
    maxConcurrent: 8,
    routing: {
      bug: 'tdd-workflow',
      feature: 'feature-build',
      security: 'security-audit',
      refactor: 'sparc-full',
    },
    defaultTemplate: 'quick-fix',
  },
  polling: { intervalMs: 30_000, enabled: false },
  stall: { timeoutMs: 300_000 },
  promptTemplate: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinearPayload(
  overrides: Partial<LinearWebhookPayload> = {},
  dataOverrides: Partial<LinearWebhookPayload['data']> = {},
): LinearWebhookPayload {
  return {
    action: 'update',
    type: 'Issue',
    createdAt: new Date().toISOString(),
    actor: { id: 'actor-123', name: 'Human User' },
    data: {
      id: 'issue-abc',
      identifier: 'ENG-42',
      title: 'Fix the bug',
      description: 'Something is broken',
      url: 'https://linear.app/team/issue/ENG-42',
      priority: 2,
      state: { id: 'state-1', name: 'Todo' },
      labels: [],
      assignee: null,
      creator: { id: 'creator-1', name: 'Jane' },
      team: { id: 'team-1', key: 'ENG' },
      updatedAt: new Date().toISOString(),
      ...dataOverrides,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearNormalizer', () => {
  beforeEach(() => {
    setWorkflowConfig(TEST_WORKFLOW_CONFIG);
    setLinearBotUserId('');
  });

  // AC3: State change Todo -> IntakeEvent with correct properties
  it('should produce IntakeEvent for state change to Todo (AC3)', () => {
    const payload = makeLinearPayload();
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.source, 'linear');
    assert.equal(result.intent, 'custom:linear-todo');
    assert.equal(result.sourceMetadata.template, 'quick-fix');
    assert.equal(result.sourceMetadata.linearIssueId, 'issue-abc');
    assert.equal(result.sourceMetadata.linearIdentifier, 'ENG-42');
  });

  it('should produce IntakeEvent for state change to In Progress', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-2', name: 'In Progress' },
    });
    const updatedFrom = { state: { id: 'state-1' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-start');
    assert.equal(result.entities.severity, 'high'); // priority 2
  });

  // AC4: Label bug -> tdd-workflow template
  it('should produce IntakeEvent with tdd-workflow for label bug (AC4)', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-1', name: 'bug' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-bug');
    assert.equal(result.sourceMetadata.template, 'tdd-workflow');
  });

  it('should produce IntakeEvent with feature-build for label feature', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-2', name: 'feature' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-feature');
    assert.equal(result.sourceMetadata.template, 'feature-build');
  });

  it('should produce IntakeEvent with security-audit for label security', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-3', name: 'security' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-security');
    assert.equal(result.sourceMetadata.template, 'security-audit');
    assert.equal(result.entities.severity, 'critical');
  });

  it('should produce IntakeEvent with sparc-full for label refactor', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-4', name: 'refactor' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-refactor');
    assert.equal(result.sourceMetadata.template, 'sparc-full');
  });

  it('should produce IntakeEvent for assignee change', () => {
    const payload = makeLinearPayload({}, {
      assignee: { id: 'user-1', name: 'Bob' },
    });
    const updatedFrom = { assigneeId: null };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-assigned');
    assert.equal(result.sourceMetadata.template, 'quick-fix');
  });

  it('should produce IntakeEvent for urgent priority change', () => {
    const payload = makeLinearPayload({}, {
      priority: 1, // Urgent
    });
    const updatedFrom = { priority: 3 };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.intent, 'custom:linear-urgent');
    assert.equal(result.entities.severity, 'critical');
  });

  it('should produce IntakeEvent for non-urgent priority change (with default template)', () => {
    const payload = makeLinearPayload({}, {
      priority: 3, // Normal
    });
    const updatedFrom = { priority: 4 };

    const result = normalizeLinearEvent(payload, updatedFrom);

    // Non-urgent priority change still routes through but with default template
    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'quick-fix');
  });

  // AC12: Bot loop prevention
  it('should return null when actor is the bot (AC12)', () => {
    setLinearBotUserId('bot-user-id');

    const payload = makeLinearPayload({
      actor: { id: 'bot-user-id', name: 'Bot' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  it('should return null when config.linearBotUserId matches actor', () => {
    const payload = makeLinearPayload({
      actor: { id: 'bot-999', name: 'Bot' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom, {
      linearBotUserId: 'bot-999',
    });

    assert.equal(result, null);
  });

  it('should return null for non-Issue event types', () => {
    const payload = makeLinearPayload({ type: 'Comment' });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  it('should return null for terminal state (Done)', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-x', name: 'Done' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  it('should return null for terminal state (Cancelled)', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-x', name: 'Cancelled' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  it('should return null when state changed to non-active, non-terminal state', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-x', name: 'Backlog' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  it('should return null when no updatedFrom fields are provided', () => {
    const payload = makeLinearPayload();

    const result = normalizeLinearEvent(payload, {});

    assert.equal(result, null);
  });

  it('should use first matching label rule when multiple labels present', () => {
    const payload = makeLinearPayload({}, {
      labels: [
        { id: 'label-b', name: 'bug' },
        { id: 'label-f', name: 'feature' },
      ],
    });
    const updatedFrom = { labelIds: ['old'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    // First match: bug
    assert.equal(result.intent, 'custom:linear-bug');
    assert.equal(result.sourceMetadata.template, 'tdd-workflow');
  });

  it('should include requirementId from issue identifier', () => {
    const payload = makeLinearPayload({}, {
      identifier: 'PROJ-99',
    });
    const updatedFrom = { state: { id: 'old' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.entities.requirementId, 'PROJ-99');
  });

  it('should include rawText from issue description', () => {
    const payload = makeLinearPayload({}, {
      description: 'Detailed bug report here',
    });
    const updatedFrom = { state: { id: 'old' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.rawText, 'Detailed bug report here');
  });

  it('should use default template when no labels match routing', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-x', name: 'unknown-label' }],
    });
    const updatedFrom = { labelIds: ['old'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'quick-fix');
  });
});
