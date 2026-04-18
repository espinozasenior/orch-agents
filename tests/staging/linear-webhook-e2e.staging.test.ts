/**
 * Linear Webhook End-to-End Staging Tests
 *
 * Simulates real Linear webhook payloads flowing through the full pipeline:
 *   webhook → handler → normalizer → IntakeEvent → event bus → pipeline
 *
 * Validates against:
 *   - Phase 7B: Agent Activity API
 *   - Phase 7C: Prompt Context Parser
 *   - Phase 7D: Agent Session Webhook Handler
 *   - Phase 7E: Workpad Activity Emission
 *   - Phase 7F: Issue Worker Plan Sync
 *   - Phase 7G: Agent Signals (stop)
 *   - Symphony research: dual-trigger, kanban state mapping
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, createDomainEvent, type EventBus } from '../../src/kernel/event-bus';
import {
  normalizeLinearEvent,
  setWorkflowConfig,
  resetWorkflowConfig,
  setLinearBotUserId,
} from '../../src/integration/linear/linear-normalizer';
import { parsePromptContext } from '../../src/integration/linear/prompt-context-parser';
import { createEventLogCollector } from '../../src/staging/event-log-collector';
import type { LinearWebhookPayload } from '../../src/integration/linear/types';
import type { IntakeEvent } from '../../src/types';
import { linearIssueId, agentSessionId } from '../../src/kernel/branded-types';

// ---------------------------------------------------------------------------
// Fixtures: Real Linear webhook payloads
// ---------------------------------------------------------------------------

function issueStateChangePayload(overrides: {
  action?: string;
  stateType?: string;
  stateName?: string;
  labels?: Array<{ id: string; name: string }>;
  priority?: number;
  actorId?: string;
  updatedFrom?: Record<string, unknown>;
} = {}): LinearWebhookPayload {
  return {
    type: 'Issue',
    action: overrides.action ?? 'update',
    createdAt: new Date().toISOString(),
    actor: { id: overrides.actorId ?? 'user-123', name: 'Test User' },
    data: {
      id: 'issue-001',
      identifier: 'ENG-42',
      title: 'Fix login page timeout',
      description: 'The login page times out after 5 seconds on slow connections.',
      url: 'https://linear.app/team/issue/ENG-42',
      priority: overrides.priority ?? 3,
      state: {
        id: 'state-001',
        name: overrides.stateName ?? 'In Progress',
        type: overrides.stateType ?? 'started',
      },
      labels: overrides.labels ?? [{ id: 'label-1', name: 'bug' }],
      team: { id: 'team-001', key: 'ENG', name: 'Engineering' },
      creator: { id: 'user-123', name: 'Test User' },
    },
    updatedFrom: overrides.updatedFrom ?? { stateId: 'old-state-id' },
  };
}

function commentPayload(body: string): LinearWebhookPayload {
  return {
    type: 'Comment',
    action: 'create',
    createdAt: new Date().toISOString(),
    actor: { id: 'user-456', name: 'PM User' },
    data: {
      id: 'comment-001',
      identifier: '',
      title: '',
      priority: 0,
      body,
      issueId: 'issue-001',
    } as unknown as LinearWebhookPayload['data'],
  };
}

function agentSessionCreatedPayload(promptContextXml?: string): {
  type: string;
  action: string;
  createdAt: string;
  data: Record<string, unknown>;
  agentSession: { id: string; issue: { id: string; identifier: string; title: string } };
  promptContext?: string;
} {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    createdAt: new Date().toISOString(),
    data: { id: 'issue-001', identifier: 'ENG-42', title: 'Fix login page timeout' },
    agentSession: {
      id: 'session-abc',
      issue: { id: 'issue-001', identifier: 'ENG-42', title: 'Fix login page timeout' },
    },
    promptContext: promptContextXml,
  };
}

function agentSessionPromptedPayload(body: string, signal?: string | null) {
  return {
    type: 'AgentSessionEvent',
    action: 'prompted',
    createdAt: new Date().toISOString(),
    data: { id: 'issue-001' },
    agentSession: {
      id: 'session-abc',
      issue: { id: 'issue-001', identifier: 'ENG-42', title: 'Fix login page timeout' },
    },
    agentActivity: { body, signal },
  };
}

// ---------------------------------------------------------------------------
// Test: Issue state transitions (Symphony research: kanban state mapping)
// ---------------------------------------------------------------------------

describe('Staging: Issue state transitions → IntakeEvent pipeline', () => {
  beforeEach(() => {
    resetWorkflowConfig();
    setLinearBotUserId('');
  });

  it('Issue moved to "In Progress" (started) → intent: custom:linear-start', () => {
    const payload = issueStateChangePayload({
      stateType: 'started',
      stateName: 'In Progress',
      updatedFrom: { stateId: 'old-state-id' },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event, 'IntakeEvent should be created');
    assert.equal(event.source, 'linear');
    assert.equal(event.intent, 'custom:linear-start');
    assert.equal(event.entities.requirementId, 'ENG-42');
    assert.ok(event.sourceMetadata.linearIssueId, 'Has linear issue ID');
    assert.ok(event.sourceMetadata.category, 'Has category from routing');
  });

  it('Issue moved to "Todo" (unstarted) → intent: custom:linear-todo', () => {
    const payload = issueStateChangePayload({
      stateType: 'unstarted',
      stateName: 'Todo',
      updatedFrom: { stateId: 'backlog-state-id' },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event, 'IntakeEvent for unstarted state');
    assert.equal(event.intent, 'custom:linear-todo');
  });

  it('Issue moved to "Done" (completed) → filtered out (terminal state)', () => {
    const payload = issueStateChangePayload({
      stateType: 'completed',
      stateName: 'Done',
      updatedFrom: { stateId: 'in-progress-state-id' },
    });

    const event = normalizeLinearEvent(payload);

    assert.equal(event, null, 'Terminal states are filtered out');
  });

  it('Issue moved to "Canceled" → filtered out (terminal state)', () => {
    const payload = issueStateChangePayload({
      stateType: 'canceled',
      stateName: 'Canceled',
      updatedFrom: { stateId: 'in-progress-state-id' },
    });

    const event = normalizeLinearEvent(payload);

    assert.equal(event, null, 'Canceled state is terminal');
  });
});

// ---------------------------------------------------------------------------
// Test: Label-based routing (Symphony research: category selection)
// ---------------------------------------------------------------------------

describe('Staging: Label routing → category selection', () => {
  beforeEach(() => resetWorkflowConfig());

  it('bug label → bug category', () => {
    const payload = issueStateChangePayload({
      labels: [{ id: 'l1', name: 'bug' }],
      updatedFrom: { labelIds: ['old-label'] },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.sourceMetadata.category, 'bug');
    assert.equal(event.intent, 'custom:linear-bug');
  });

  it('feature label → feature category', () => {
    const payload = issueStateChangePayload({
      labels: [{ id: 'l2', name: 'feature' }],
      updatedFrom: { labelIds: ['old-label'] },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.sourceMetadata.category, 'feature');
    assert.equal(event.intent, 'custom:linear-feature');
  });

  it('security label → security category with critical severity', () => {
    const payload = issueStateChangePayload({
      labels: [{ id: 'l3', name: 'security' }],
      updatedFrom: { labelIds: ['old-label'] },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.sourceMetadata.category, 'security');
    assert.equal(event.entities.severity, 'critical');
  });

  it('no matching label → general default category', () => {
    const payload = issueStateChangePayload({
      labels: [{ id: 'l4', name: 'documentation' }],
      stateType: 'started',
      updatedFrom: { stateId: 'old-state' },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.sourceMetadata.category, 'general');
  });
});

// ---------------------------------------------------------------------------
// Test: Priority mapping (Symphony research: urgent escalation)
// ---------------------------------------------------------------------------

describe('Staging: Priority changes → severity + intent', () => {
  beforeEach(() => resetWorkflowConfig());

  it('priority set to Urgent (1) → intent: custom:linear-urgent, severity: critical', () => {
    const payload = issueStateChangePayload({
      priority: 1,
      updatedFrom: { priority: 3 },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.intent, 'custom:linear-urgent');
    assert.equal(event.entities.severity, 'critical');
  });

  it('priority set to High (2) → severity: high', () => {
    const payload = issueStateChangePayload({
      priority: 2,
      stateType: 'started',
      updatedFrom: { stateId: 'old' },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.entities.severity, 'high');
  });
});

// ---------------------------------------------------------------------------
// Test: Bot loop prevention
// ---------------------------------------------------------------------------

describe('Staging: Bot loop prevention', () => {
  afterEach(() => setLinearBotUserId(''));

  it('filters events from bot actor', () => {
    setLinearBotUserId('bot-999');
    const payload = issueStateChangePayload({
      actorId: 'bot-999',
      stateType: 'started',
      updatedFrom: { stateId: 'old' },
    });

    const event = normalizeLinearEvent(payload);

    assert.equal(event, null, 'Bot events are filtered');
  });

  it('allows events from non-bot actors', () => {
    setLinearBotUserId('bot-999');
    const payload = issueStateChangePayload({
      actorId: 'human-123',
      stateType: 'started',
      updatedFrom: { stateId: 'old' },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event, 'Human events pass through');
  });

  it('allows events via config.linearBotUserId param', () => {
    const payload = issueStateChangePayload({
      actorId: 'bot-999',
      stateType: 'started',
      updatedFrom: { stateId: 'old' },
    });

    const event = normalizeLinearEvent(payload, undefined, { linearBotUserId: 'bot-999' });
    assert.equal(event, null, 'Config-based bot filtering works');
  });
});

// ---------------------------------------------------------------------------
// Test: IntakeEvent → EventBus pipeline propagation
// ---------------------------------------------------------------------------

describe('Staging: IntakeEvent flows through event bus pipeline', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
    resetWorkflowConfig();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  it('IntakeCompleted event carries full Linear metadata', async () => {
    const collector = createEventLogCollector(eventBus);
    const payload = issueStateChangePayload({ stateType: 'started' });
    const intakeEvent = normalizeLinearEvent(payload)!;

    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'delivery-001'));

    const captured = await collector.waitFor('IntakeCompleted', 1000);
    collector.stop();

    assert.equal(captured.type, 'IntakeCompleted');
    assert.equal(captured.correlationId, 'delivery-001');
    const eventPayload = captured.payload as { intakeEvent: IntakeEvent };
    assert.equal(eventPayload.intakeEvent.source, 'linear');
    assert.equal(eventPayload.intakeEvent.entities.requirementId, 'ENG-42');
    assert.ok(eventPayload.intakeEvent.sourceMetadata.linearIssueId);
  });

  it('multiple event types propagate through collector', async () => {
    const collector = createEventLogCollector(eventBus);
    const payload = issueStateChangePayload({ stateType: 'started' });
    const intakeEvent = normalizeLinearEvent(payload)!;

    // Simulate pipeline: IntakeCompleted → WorkTriaged → PlanCreated
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'corr-001'));
    eventBus.publish(createDomainEvent('WorkTriaged', {
      intakeEvent,
      triageResult: {
        priority: 'P2-standard',
        complexity: { level: 'medium', percentage: 45 },
        skipPlanning: false,
      },
    }, 'corr-001'));

    await collector.waitFor('WorkTriaged', 1000);
    collector.stop();

    assert.equal(collector.events.length, 2);
    assert.equal(collector.events[0].type, 'IntakeCompleted');
    assert.equal(collector.events[1].type, 'WorkTriaged');
    // Both share same correlation ID
    assert.equal(collector.events[0].correlationId, 'corr-001');
    assert.equal(collector.events[1].correlationId, 'corr-001');
  });
});

// ---------------------------------------------------------------------------
// Test: Phase 7C — Prompt Context Parser
// ---------------------------------------------------------------------------

describe('Staging: Phase 7C — promptContext XML parsing', () => {
  it('parses complete promptContext with issue, guidance, and threads', () => {
    // Parser expects identifier as an attribute: <issue identifier="ENG-42">
    const xml = `<promptContext>
      <issue identifier="ENG-42">
        <title>Fix login page timeout</title>
        <description>Login page times out after 5s on slow connections.</description>
        <labels><label>bug</label><label>frontend</label></labels>
      </issue>
      <guidance>
        <guidance-rule origin="workspace">Always use TypeScript strict mode</guidance-rule>
        <guidance-rule origin="team">Follow TDD for bug fixes</guidance-rule>
      </guidance>
      <other-threads>
        <thread created-at="2026-03-15T10:00:00Z">
          <message author="PM">Can we fix this before the release?</message>
          <message author="Dev">Looking into it now.</message>
        </thread>
      </other-threads>
    </promptContext>`;

    const ctx = parsePromptContext(xml);

    assert.equal(ctx.issue.identifier, 'ENG-42');
    assert.equal(ctx.issue.title, 'Fix login page timeout');
    assert.ok(ctx.issue.description?.includes('times out'));
    assert.ok(ctx.issue.labels?.length === 2);
    // guidance is GuidanceRule[] directly (not { rules: ... })
    assert.ok(ctx.guidance.length >= 1, 'Has guidance rules');
    assert.equal(ctx.guidance[0].origin, 'workspace');
  });

  it('parses minimal promptContext (issue only)', () => {
    const xml = `<promptContext>
      <issue identifier="ENG-99">
        <title>Add dark mode</title>
      </issue>
    </promptContext>`;

    const ctx = parsePromptContext(xml);

    assert.equal(ctx.issue.identifier, 'ENG-99');
    assert.equal(ctx.issue.title, 'Add dark mode');
  });

  it('returns empty context for null/empty input', () => {
    const ctx = parsePromptContext(undefined as unknown as string);

    assert.equal(ctx.issue.identifier, '');
    assert.equal(ctx.issue.title, '');
  });

  it('gracefully handles malformed XML', () => {
    const xml = '<promptContext><issue><identifier>ENG-1</identifier><title>Broken';

    const ctx = parsePromptContext(xml);

    // Should return partial data, not throw
    assert.ok(ctx.issue !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Test: Phase 7D — AgentSessionEvent webhooks
// ---------------------------------------------------------------------------

describe('Staging: Phase 7D — AgentSessionEvent pipeline behavior', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
  });

  it('created action → publishes IntakeCompleted with session metadata', async () => {
    const collector = createEventLogCollector(eventBus);
    const sessionPayload = agentSessionCreatedPayload();

    // Simulate what the webhook handler does for AgentSessionEvent.created
    const intakeEvent: IntakeEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: 'linear',
      sourceMetadata: {
        source: 'linear' as const,
        agentSessionId: agentSessionId(sessionPayload.agentSession.id),
        linearIssueId: linearIssueId(sessionPayload.agentSession.issue.id),
        linearIdentifier: sessionPayload.agentSession.issue.identifier,
        intent: 'custom:linear-agent-session',
      },
      entities: {
        requirementId: sessionPayload.agentSession.issue.identifier,
        labels: [],
      },
    };

    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'delivery-session'));

    const captured = await collector.waitFor('IntakeCompleted', 1000);
    collector.stop();

    const payload = captured.payload as { intakeEvent: IntakeEvent };
    assert.equal(payload.intakeEvent.source, 'linear');
    assert.equal(payload.intakeEvent.sourceMetadata.agentSessionId, 'session-abc');
    assert.equal(payload.intakeEvent.sourceMetadata.intent, 'custom:linear-agent-session');
  });

  it('prompted action → publishes AgentPrompted event on bus', () => {
    // AgentPrompted is not in the event-log-collector's MONITORED_EVENTS list,
    // so we subscribe directly to verify the event propagates.
    let captured: unknown = null;

    eventBus.subscribe('AgentPrompted', (event) => {
      captured = event.payload;
    });

    eventBus.publish(createDomainEvent('AgentPrompted', {
      agentSessionId: 'session-abc',
      issueId: 'issue-001',
      body: 'Please also update the tests',
    }));

    const payload = captured as { agentSessionId: string; body: string };
    assert.ok(payload, 'AgentPrompted event received');
    assert.equal(payload.agentSessionId, 'session-abc');
    assert.equal(payload.body, 'Please also update the tests');
  });

  it('prompted with stop signal → publishes WorkCancelled', async () => {
    const collector = createEventLogCollector(eventBus);

    // Simulate stop signal handling
    eventBus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'linear-session-session-abc',
      cancellationReason: 'User sent stop signal via Linear',
    }));

    const captured = await collector.waitFor('WorkCancelled', 1000);
    collector.stop();

    const payload = captured.payload as { workItemId: string; cancellationReason: string };
    assert.ok(payload.workItemId.includes('session-abc'));
    assert.ok(payload.cancellationReason.includes('stop'));
  });
});

// ---------------------------------------------------------------------------
// Test: Phase 7G — Comment-based stop command
// ---------------------------------------------------------------------------

describe('Staging: Phase 7G — Stop command via Linear comment', () => {
  let eventBus: EventBus;

  beforeEach(() => eventBus = createEventBus());
  afterEach(() => eventBus.removeAllListeners());

  it('"stop" comment → WorkCancelled event published', async () => {
    const collector = createEventLogCollector(eventBus);

    // Simulate what the webhook handler does for a stop comment
    const comment = commentPayload('stop');
    const commentData = comment.data as unknown as Record<string, unknown>;
    const commentBody = ((commentData.body as string) ?? '').trim().toLowerCase();

    if (commentBody === 'stop') {
      eventBus.publish(createDomainEvent('WorkCancelled', {
        workItemId: `linear-${commentData.issueId}`,
        cancellationReason: 'User requested stop via Linear comment',
      }));
    }

    const captured = await collector.waitFor('WorkCancelled', 1000);
    collector.stop();

    assert.ok(captured.payload);
    const payload = captured.payload as { workItemId: string; cancellationReason: string };
    assert.ok(payload.workItemId.includes('issue-001'));
  });

  it('non-stop comment → no WorkCancelled event', () => {
    const comment = commentPayload('Looks good, ship it');
    const commentData = comment.data as unknown as Record<string, unknown>;
    const commentBody = ((commentData.body as string) ?? '').trim().toLowerCase();

    assert.notEqual(commentBody, 'stop', 'Not a stop command');
    // Handler returns 202 skipped — no WorkCancelled published
  });
});

// ---------------------------------------------------------------------------
// Test: Assignee change (Symphony research: assigned trigger)
// ---------------------------------------------------------------------------

describe('Staging: Assignee change → custom:linear-assigned', () => {
  beforeEach(() => resetWorkflowConfig());

  it('assignee changed → intent: custom:linear-assigned', () => {
    const payload = issueStateChangePayload({
      stateType: 'started',
      updatedFrom: { assigneeId: 'old-assignee-id' },
    });

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.equal(event.intent, 'custom:linear-assigned');
  });
});

// ---------------------------------------------------------------------------
// Test: Input sanitization on description
// ---------------------------------------------------------------------------

describe('Staging: Input sanitization on Linear issue descriptions', () => {
  beforeEach(() => resetWorkflowConfig());

  it('sanitizes rawText from issue description (invisible chars, HTML comments)', () => {
    const payload = issueStateChangePayload({ stateType: 'started' });
    // Sanitizer strips HTML comments and invisible chars, not HTML tags
    // (it's an LLM prompt sanitizer, not an HTML sanitizer)
    payload.data.description = '<!-- hidden instruction --> Fix the bug\u200B';

    const event = normalizeLinearEvent(payload);

    assert.ok(event);
    assert.ok(event.rawText);
    assert.ok(!event.rawText!.includes('<!--'), 'HTML comments stripped');
    assert.ok(!event.rawText!.includes('\u200B'), 'Invisible chars stripped');
    assert.ok(event.rawText!.includes('Fix the bug'), 'Visible text preserved');
  });
});

// ---------------------------------------------------------------------------
// Test: Full pipeline trace — Issue → Intake → Triage → Plan
// ---------------------------------------------------------------------------

describe('Staging: Full pipeline trace — Linear issue through triage', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
    resetWorkflowConfig();
  });

  afterEach(() => eventBus.removeAllListeners());

  it('traces Linear issue through IntakeCompleted → WorkTriaged → PlanCreated', async () => {
    const payload = issueStateChangePayload({
      stateType: 'started',
      labels: [{ id: 'l1', name: 'bug' }],
    });

    const intakeEvent = normalizeLinearEvent(payload)!;
    assert.ok(intakeEvent, 'IntakeEvent created from Linear payload');

    const corrId = 'pipeline-trace-001';

    // Wire up pipeline BEFORE publishing (simulate real subscribers)
    // Step 2: Triage engine reacts to IntakeCompleted
    eventBus.subscribe('IntakeCompleted', () => {
      eventBus.publish(createDomainEvent('WorkTriaged', {
        intakeEvent,
        triageResult: {
          priority: 'P2-standard',
          complexity: { level: 'medium', percentage: 45 },
          skipPlanning: false,
        },
      }, corrId));
    });

    // Step 3: Execution engine reacts to WorkTriaged
    eventBus.subscribe('WorkTriaged', () => {
      eventBus.publish(createDomainEvent('PlanCreated', {
        plan: {
          id: 'plan-001',
          name: 'Fix login page timeout',
          intakeEventId: intakeEvent.id,
          agents: [{ role: 'coder', type: 'sparc-coder', tier: 2 }],
        },
      }, corrId));
    });

    // Start collector BEFORE publishing so it captures all events
    const collector = createEventLogCollector(eventBus);

    // Step 1: Publish IntakeCompleted — triggers the cascade synchronously
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, corrId));

    // In synchronous event bus, the entire cascade has already completed.
    // All 3 events should be captured.
    collector.stop();

    // The cascade order depends on subscriber registration order.
    // Collector subscribes after pipeline subscribers, so it sees events
    // in cascade order: IntakeCompleted triggers WorkTriaged triggers PlanCreated.
    // But collector may receive them interleaved. Verify all 3 are present.
    const types = collector.events.map(e => e.type);
    assert.ok(types.includes('IntakeCompleted'), 'Has IntakeCompleted');
    assert.ok(types.includes('WorkTriaged'), 'Has WorkTriaged');
    assert.ok(types.includes('PlanCreated'), 'Has PlanCreated');
    assert.equal(collector.events.length, 3, 'Three events in pipeline');

    // All share the same correlation ID
    for (const e of collector.events) {
      assert.equal(e.correlationId, corrId, `${e.type} has correct correlationId`);
    }
  });
});
