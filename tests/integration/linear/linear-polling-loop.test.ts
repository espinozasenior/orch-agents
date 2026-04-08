/**
 * Tests for LinearPollingLoop -- London School TDD with mocked LinearClient.
 *
 * Covers: AC5 (change detection via polling), AC6 (dedup against webhooks).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLinearPollingLoop,
} from '../../../src/integration/linear/linear-polling-loop';
import type { LinearPollingLoopDeps } from '../../../src/integration/linear/linear-polling-loop';
import type { LinearClient, LinearIssueResponse } from '../../../src/integration/linear/linear-client';
import { LinearRateLimitError } from '../../../src/integration/linear/linear-client';
import { createEventBus, type EventBus } from '../../../src/shared/event-bus';
import { createLogger } from '../../../src/shared/logger';
import {
  setWorkflowConfig,
  resetWorkflowConfig,
  setLinearBotUserId,
} from '../../../src/integration/linear/linear-normalizer';
import type { WorkflowConfig } from '../../../src/integration/linear/workflow-parser';
import type { IntakeCompletedEvent } from '../../../src/shared/event-types';

// ---------------------------------------------------------------------------
// Test workflow config
// ---------------------------------------------------------------------------

const TEST_WORKFLOW_CONFIG: WorkflowConfig = {
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

function makeIssue(overrides: Partial<LinearIssueResponse> = {}): LinearIssueResponse {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Test issue',
    priority: 2,
    updatedAt: '2026-01-01T00:00:00Z',
    state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
    labels: { nodes: [] },
    assignee: null,
    creator: { id: 'user-1', name: 'Test' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    ...overrides,
  };
}

function createMockLinearClient(issues: LinearIssueResponse[]): LinearClient {
  return {
    fetchIssue: async () => issues[0],
    fetchActiveIssues: async () => issues,
    fetchComments: async () => [],
    createComment: async () => 'comment-1',
    updateComment: async () => {},
    updateIssueState: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearPollingLoop', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    setWorkflowConfig(TEST_WORKFLOW_CONFIG);
    setLinearBotUserId('');
    eventBus = createEventBus();
  });

  afterEach(() => {
    resetWorkflowConfig();
    eventBus.removeAllListeners();
  });

  // AC5: Detect state changes via polling
  it('should detect state changes and emit IntakeCompleted (AC5)', async () => {
    // First poll: issue in Backlog (cached without emitting)
    let pollCount = 0;
    const issueV1 = makeIssue({ state: { id: 'state-1', name: 'Backlog', type: 'backlog' } });
    const issueV2 = makeIssue({
      state: { id: 'state-2', name: 'Todo', type: 'unstarted' },
      updatedAt: '2026-01-01T00:01:00Z',
    });

    const client: LinearClient = {
      fetchIssue: async () => issueV1,
      fetchActiveIssues: async () => {
        pollCount++;
        return pollCount === 1 ? [issueV1] : [issueV2];
      },
      fetchComments: async () => [],
      createComment: async () => 'comment-1',
      updateComment: async () => {},
      updateIssueState: async () => {},
    };

    const capturedEvents: IntakeCompletedEvent[] = [];
    eventBus.subscribe('IntakeCompleted', (event) => {
      capturedEvents.push(event);
    });

    const loop = createLinearPollingLoop({
      linearClient: client,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      teamId: 'team-1',
      pollIntervalMs: 60_000,
    });

    // First poll: cache the issue
    await loop.poll();
    assert.equal(capturedEvents.length, 0);

    // Second poll: detect state change
    await loop.poll();
    assert.equal(capturedEvents.length, 1);
    assert.equal(capturedEvents[0].payload.intakeEvent.source, 'linear');
    assert.equal(capturedEvents[0].payload.intakeEvent.sourceMetadata.intent, 'custom:linear-todo');
  });

  // AC6: Dedup against webhook events
  it('should deduplicate events already received via webhook (AC6)', async () => {
    const issueV1 = makeIssue({ state: { id: 'state-1', name: 'Backlog', type: 'backlog' } });
    const issueV2 = makeIssue({
      state: { id: 'state-2', name: 'Todo', type: 'unstarted' },
      updatedAt: '2026-01-01T00:01:00Z',
    });

    let pollCount = 0;
    const client: LinearClient = {
      fetchIssue: async () => issueV1,
      fetchActiveIssues: async () => {
        pollCount++;
        return pollCount === 1 ? [issueV1] : [issueV2];
      },
      fetchComments: async () => [],
      createComment: async () => 'comment-1',
      updateComment: async () => {},
      updateIssueState: async () => {},
    };

    // Pre-populate dedup set (simulating webhook already processed)
    const recentWebhookKeys = new Set<string>();
    recentWebhookKeys.add(`linear-issue-1-state-2026-01-01T00:01:00Z`);

    const capturedEvents: IntakeCompletedEvent[] = [];
    eventBus.subscribe('IntakeCompleted', (event) => {
      capturedEvents.push(event);
    });

    const loop = createLinearPollingLoop({
      linearClient: client,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      teamId: 'team-1',
      pollIntervalMs: 60_000,
      recentWebhookKeys,
    });

    await loop.poll();
    await loop.poll();

    // Should be deduped
    assert.equal(capturedEvents.length, 0);
  });

  it('should not emit events on first poll (cache only)', async () => {
    const client = createMockLinearClient([
      makeIssue({ state: { id: 'state-2', name: 'Todo', type: 'unstarted' } }),
    ]);

    const capturedEvents: IntakeCompletedEvent[] = [];
    eventBus.subscribe('IntakeCompleted', (event) => {
      capturedEvents.push(event);
    });

    const loop = createLinearPollingLoop({
      linearClient: client,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      teamId: 'team-1',
      pollIntervalMs: 60_000,
    });

    await loop.poll();
    assert.equal(capturedEvents.length, 0);
  });

  it('should handle rate limit errors with backoff', async () => {
    let callCount = 0;
    const client: LinearClient = {
      fetchIssue: async () => { throw new Error('unused'); },
      fetchActiveIssues: async () => {
        callCount++;
        if (callCount === 1) {
          throw new LinearRateLimitError(1); // 1 second
        }
        return [];
      },
      fetchComments: async () => [],
      createComment: async () => 'comment-1',
      updateComment: async () => {},
      updateIssueState: async () => {},
    };

    const loop = createLinearPollingLoop({
      linearClient: client,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      teamId: 'team-1',
      pollIntervalMs: 60_000,
    });

    // First poll triggers rate limit error but doesn't throw
    await loop.poll();
    assert.equal(callCount, 1);
  });

  it('should stop cleanly', () => {
    const client = createMockLinearClient([]);
    const loop = createLinearPollingLoop({
      linearClient: client,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      teamId: 'team-1',
      pollIntervalMs: 60_000,
    });

    loop.start();
    loop.stop();
    // Should not throw
  });
});
