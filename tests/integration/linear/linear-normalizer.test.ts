/**
 * Tests for LinearNormalizer -- London School TDD with WorkflowConfig.
 *
 * Covers: AC3, AC4, AC12 (bot loop prevention), label-based categorization.
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
import type { WorkflowConfig } from '../../../src/config';

// ---------------------------------------------------------------------------
// Test workflow config (multi-repo schema)
// ---------------------------------------------------------------------------

const TEST_WORKFLOW_CONFIG: WorkflowConfig = {
  repos: {},
  defaults: {
    agents: { maxConcurrent: 8 },
    stall: { timeoutMs: 300_000 },
    polling: { intervalMs: 30_000, enabled: false },
  },
  tracker: {
    kind: 'linear',
    apiKey: '',
    team: 'ENG',
    activeTypes: ['unstarted', 'started'],
    terminalTypes: ['completed', 'canceled'],
    activeStates: [],
    terminalStates: [],
  },
  agents: {
    maxConcurrent: 8,
  },
  agent: {
    maxConcurrentAgents: 8,
    maxRetryBackoffMs: 300_000,
    maxTurns: 20,
  },
  polling: { intervalMs: 30_000, enabled: false },
  stall: { timeoutMs: 300_000 },
  agentRunner: {
    stallTimeoutMs: 300_000,
    command: 'claude',
    turnTimeoutMs: 3_600_000,
  },
  hooks: {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
  },
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
      state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
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
    assert.equal(result.sourceMetadata.intent, 'custom:linear-todo');
    assert.equal(result.sourceMetadata.category, 'general');
    assert.equal(result.sourceMetadata.linearIssueId, 'issue-abc');
    assert.equal(result.sourceMetadata.linearIdentifier, 'ENG-42');
  });

  it('should produce IntakeEvent for state change to In Progress', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-2', name: 'In Progress', type: 'started' },
    });
    const updatedFrom = { state: { id: 'state-1' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-start');
    assert.equal(result.entities.severity, 'high'); // priority 2
  });

  // AC4: Label bug -> 'bug' category
  it('should produce IntakeEvent with bug category for label bug (AC4)', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-1', name: 'bug' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-bug');
    assert.equal(result.sourceMetadata.category, 'bug');
  });

  it('should produce IntakeEvent with feature category for label feature', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-2', name: 'feature' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-feature');
    assert.equal(result.sourceMetadata.category, 'feature');
  });

  it('should produce IntakeEvent with security category for label security', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-3', name: 'security' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-security');
    assert.equal(result.sourceMetadata.category, 'security');
    assert.equal(result.entities.severity, 'critical');
  });

  it('should produce IntakeEvent with refactor category for label refactor', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-4', name: 'refactor' }],
    });
    const updatedFrom = { labelIds: ['old-label-id'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-refactor');
    assert.equal(result.sourceMetadata.category, 'refactor');
  });

  it('should produce IntakeEvent for assignee change', () => {
    const payload = makeLinearPayload({}, {
      assignee: { id: 'user-1', name: 'Bob' },
    });
    const updatedFrom = { assigneeId: null };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-assigned');
    assert.equal(result.sourceMetadata.category, 'general');
  });

  it('should produce IntakeEvent for urgent priority change', () => {
    const payload = makeLinearPayload({}, {
      priority: 1, // Urgent
    });
    const updatedFrom = { priority: 3 };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-urgent');
    assert.equal(result.entities.severity, 'critical');
  });

  it('should produce IntakeEvent for non-urgent priority change (with default category)', () => {
    const payload = makeLinearPayload({}, {
      priority: 3, // Normal
    });
    const updatedFrom = { priority: 4 };

    const result = normalizeLinearEvent(payload, updatedFrom);

    // Non-urgent priority change still routes through but with default category
    assert.ok(result);
    assert.equal(result.sourceMetadata.category, 'general');
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
      state: { id: 'state-x', name: 'Done', type: 'completed' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  it('should return null for terminal state (Cancelled)', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-x', name: 'Cancelled', type: 'canceled' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  // Resilience to state renames: "Todo" renamed to "Ready" still has type "unstarted"
  it('should match by type when state is renamed (e.g. Todo -> Ready)', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-1', name: 'Ready', type: 'unstarted' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-todo');
  });

  // Resilience: "In Progress" renamed to "Doing" still has type "started"
  it('should match by type when In Progress is renamed to Doing', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-2', name: 'Doing', type: 'started' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-start');
  });

  // Resilience: "Done" renamed to "Shipped" still has type "completed" → terminal, skip
  it('should reject renamed terminal state (Done -> Shipped, type completed)', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-x', name: 'Shipped', type: 'completed' },
    });
    const updatedFrom = { state: { id: 'old-state' } };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.equal(result, null);
  });

  // Polling reconciler sends stateId in updatedFrom, not state
  it('should detect state change when updatedFrom uses stateId (polling compat)', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-2', name: 'Todo', type: 'unstarted' },
    });
    const updatedFrom = { stateId: 'old-state-id' };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.intent, 'custom:linear-todo');
  });

  it('should return null when state changed to non-active, non-terminal state', () => {
    const payload = makeLinearPayload({}, {
      state: { id: 'state-x', name: 'Backlog', type: 'backlog' },
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
    assert.equal(result.sourceMetadata.intent, 'custom:linear-bug');
    assert.equal(result.sourceMetadata.category, 'bug');
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

  // Phase 5: model:* label extraction
  it('should extract modelOverride from model:* label', () => {
    const payload = makeLinearPayload({}, {
      labels: [
        { id: 'label-m', name: 'model:opus' },
        { id: 'label-b', name: 'bug' },
      ],
    });
    const updatedFrom = { labelIds: ['old'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.modelOverride, 'opus');
  });

  it('should not set modelOverride when no model:* label present', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-b', name: 'bug' }],
    });
    const updatedFrom = { labelIds: ['old'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.modelOverride, undefined);
  });

  it('should handle model label with whitespace after colon', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-m', name: 'model: sonnet' }],
    });
    const updatedFrom = { labelIds: ['old'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.modelOverride, 'sonnet');
  });

  it('should use general category when no labels match known categories', () => {
    const payload = makeLinearPayload({}, {
      labels: [{ id: 'label-x', name: 'unknown-label' }],
    });
    const updatedFrom = { labelIds: ['old'] };

    const result = normalizeLinearEvent(payload, updatedFrom);

    assert.ok(result);
    assert.equal(result.sourceMetadata.category, 'general');
  });
});
