# Phase 7D: Agent Session Webhook Handler

## Goal
Extend the Linear webhook handler to process `AgentSessionEvent` payloads (`created` and `prompted` actions), meeting Linear's 10-second response SLA by emitting a `thought` activity immediately before dispatching to the orchestrator.

## Specification

### Problem Statement
The current `linear-webhook-handler.ts` only processes `Issue` type payloads. Linear's Agent API sends `AgentSessionEvent` webhooks when a user mentions or delegates the agent (`created`) or sends a follow-up message (`prompted`). The agent must respond to the webhook within 5 seconds and emit a thought activity within 10 seconds of session creation, or it's marked as "unresponsive."

### Functional Requirements
- FR-7D.01: Route incoming webhooks by `payload.type` — `Issue` to existing flow, `AgentSessionEvent` to new flow
- FR-7D.02: On `created` action — parse `promptContext`, emit `thought` activity immediately, then dispatch to orchestrator
- FR-7D.03: On `prompted` action — extract `agentActivity.body`, publish `AgentPrompted` event to EventBus
- FR-7D.04: Return 200/202 within 5 seconds for all webhook types
- FR-7D.05: Handle `stop` signal in `prompted` webhooks — halt execution, emit final activity
- FR-7D.06: Pass `agentSessionId` through to all downstream consumers via IntakeEvent metadata
- FR-7D.07: Skip duplicate `AgentSessionEvent` webhooks via existing event buffer

### Non-Functional Requirements
- Thought activity emission must happen BEFORE returning the HTTP response (synchronous in handler)
- The handler must be resilient to `createAgentActivity` failures (log + continue, don't block intake)
- Signature verification uses the same HMAC-SHA256 as Issue webhooks

### Acceptance Criteria
- `AgentSessionEvent` with `created` action emits a thought activity and publishes `IntakeCompleted`
- `AgentSessionEvent` with `prompted` action publishes `AgentPrompted` with session ID and body
- `AgentSessionEvent` with `prompted` + `stop` signal publishes `WorkCancelled` and emits final activity
- `Issue` type payloads continue to work unchanged
- Unknown payload types return 202 with `skipped` status
- Thought activity is emitted within 5 seconds of webhook receipt

## Pseudocode

```text
HANDLER POST /webhooks/linear:
  verify signature
  payload = parse body

  SWITCH payload.type:
    CASE 'Issue':
      // existing flow unchanged
      handleIssueEvent(payload)

    CASE 'AgentSessionEvent':
      handleAgentSessionEvent(payload)

    DEFAULT:
      RETURN 202 { status: 'skipped' }

FUNCTION handleAgentSessionEvent(payload):
  sessionId = payload.agentSession.id
  issueId = payload.agentSession.issue.id
  action = payload.action

  IF action == 'created':
    // 1. Parse rich context
    promptContext = parsePromptContext(payload.promptContext)

    // 2. Emit thought activity immediately (10s SLA)
    TRY:
      linearClient.createAgentActivity(sessionId, {
        type: 'thought',
        body: 'Analyzing your request...'
      })
    CATCH:
      log.warn('Failed to emit initial thought activity')

    // 3. Normalize to IntakeEvent with enriched metadata
    intakeEvent = normalizeAgentSessionToIntake(payload, promptContext)
    intakeEvent.sourceMetadata.agentSessionId = sessionId
    intakeEvent.sourceMetadata.promptContext = promptContext

    // 4. Publish to event bus + trigger Symphony tick
    eventBus.publish('IntakeCompleted', { intakeEvent })
    await onLinearIntake?.(intakeEvent, { deliveryId })

    RETURN 202 { status: 'queued' }

  ELSE IF action == 'prompted':
    body = payload.agentActivity?.body
    signal = payload.agentActivity?.signal

    IF signal == 'stop':
      eventBus.publish('WorkCancelled', {
        workItemId: `linear-session-${sessionId}`,
        cancellationReason: 'User sent stop signal via Linear'
      })
      TRY:
        linearClient.createAgentActivity(sessionId, {
          type: 'response',
          body: 'Stopped. No further changes will be made.'
        })
      CATCH: log.warn(...)
      RETURN 202 { status: 'cancelling' }

    // Normal follow-up prompt
    eventBus.publish('AgentPrompted', {
      agentSessionId: sessionId,
      issueId,
      body,
    })

    RETURN 202 { status: 'queued' }
```

## Architecture

### Primary Components
- `src/integration/linear/linear-webhook-handler.ts` — Extended with AgentSessionEvent routing
- `src/integration/linear/prompt-context-parser.ts` — Parses `promptContext` XML (Phase 7C)
- `src/shared/event-types.ts` — New `AgentPrompted` event type
- `src/integration/linear/linear-client.ts` — `createAgentActivity` method (Phase 7B)

### Data Flow
```
Linear webhook POST → signature verify → route by type
  │
  ├── Issue → existing normalizer → IntakeCompleted
  │
  └── AgentSessionEvent
        ├── created → parse promptContext → emit thought → IntakeCompleted
        └── prompted → extract body/signal → AgentPrompted or WorkCancelled
```

### Design Decisions
- Thought emission is synchronous within the handler — guarantees the 10s SLA
- `AgentPrompted` is a new event type distinct from `IntakeCompleted` — it feeds into an existing worker, not a new dispatch
- The stop signal reuses the existing `WorkCancelled` event and orchestrator termination path
- `agentSessionId` flows through `IntakeEvent.sourceMetadata` — no new types needed

## Refinement

### File Targets
- `src/integration/linear/linear-webhook-handler.ts`
- `src/shared/event-types.ts`
- `src/integration/linear/linear-normalizer.ts`

### Exact Tests
- `tests/integration/linear/linear-webhook-handler.test.ts`
  - AgentSessionEvent `created` emits thought activity and publishes IntakeCompleted
  - AgentSessionEvent `created` includes agentSessionId in IntakeEvent metadata
  - AgentSessionEvent `prompted` publishes AgentPrompted event with body
  - AgentSessionEvent `prompted` with `stop` signal publishes WorkCancelled
  - Unknown AgentSessionEvent actions return 202 skipped
  - Issue payload continues to work (regression test)
  - Thought activity failure does not block intake dispatch

### Risks
- If `createAgentActivity` is slow (network latency), the 5-second HTTP response deadline may be at risk — use a short timeout (3s) with fire-and-forget fallback
- The `AgentPrompted` event needs a consumer — Phase 7F must wire the worker to receive prompted messages
- Signature verification must work for both payload types (same HMAC)
