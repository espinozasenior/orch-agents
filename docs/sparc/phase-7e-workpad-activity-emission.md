# Phase 7E: Workpad Reporter Activity Emission

## Goal
Extend the workpad reporter to emit structured Agent Activities alongside the existing persistent comment updates, making execution progress visible in both the workpad summary and the Agent Session timeline.

## Specification

### Problem Statement
The workpad reporter currently subscribes to EventBus events (`PhaseStarted`, `PhaseCompleted`, `AgentSpawned`, `AgentCompleted`, `WorkCompleted`, `WorkFailed`) and syncs progress to a persistent Linear comment. With the Agent API, progress should additionally appear as Agent Activities in the session timeline — these are immutable, typed entries that Linear renders in a dedicated session panel.

### Functional Requirements
- FR-7E.01: When `agentSessionId` is available, emit Agent Activities alongside comment updates
- FR-7E.02: Map internal events to activity types: `PhaseStarted` → `thought` (ephemeral), `AgentSpawned` → `action` (ephemeral), `PhaseCompleted` → `action` with result, `WorkCompleted` → `response`, `WorkFailed` → `error`
- FR-7E.03: When `agentSessionId` is absent, existing comment-only behavior is unchanged
- FR-7E.04: Activity emission failures do not block comment updates
- FR-7E.05: Ephemeral activities are used for transient progress (thoughts, in-progress actions)

### Non-Functional Requirements
- Activity emission is best-effort — failures are logged but never throw
- No additional EventBus subscriptions — reuse existing subscription handlers
- Rate limit awareness — batch rapid events if Linear rate limit is near

### Acceptance Criteria
- `PhaseStarted` emits an ephemeral thought activity with phase description
- `AgentSpawned` emits an ephemeral action activity with agent type as parameter
- `PhaseCompleted` emits an action activity with result (duration, status)
- `WorkCompleted` emits a response activity with completion summary
- `WorkFailed` emits an error activity with failure reason
- Comment updates continue to work identically regardless of activity emission

## Pseudocode

```text
MODIFY createWorkpadReporter(deps):
  // NEW: accept optional agentSessionId
  agentSessionId = deps.agentSessionId

  FUNCTION emitActivity(content, options?):
    IF NOT agentSessionId OR NOT linearClient.createAgentActivity:
      RETURN  // no-op when session not available

    TRY:
      linearClient.createAgentActivity(agentSessionId, content, options)
    CATCH err:
      logger.warn('Activity emission failed', { error: err.message })

  // Extend existing event handlers:
  ON PhaseStarted(event):
    // existing: update workpad state + comment
    emitActivity({
      type: 'thought',
      body: `Starting ${event.phaseType} phase with ${event.agents.length} agent(s)`
    }, { ephemeral: true })

  ON AgentSpawned(event):
    // existing: update workpad state + comment
    emitActivity({
      type: 'action',
      action: 'Spawning agent',
      parameter: `${event.agentType} (${event.agentRole})`
    }, { ephemeral: true })

  ON PhaseCompleted(event):
    // existing: update workpad state + comment
    emitActivity({
      type: 'action',
      action: 'Phase completed',
      parameter: event.phaseType,
      result: `${event.status} in ${event.metrics.duration}ms`
    })

  ON WorkCompleted(event):
    // existing: update workpad state + comment
    emitActivity({
      type: 'response',
      body: `Work completed. Duration: ${event.totalDuration}ms`
    })

  ON WorkFailed(event):
    // existing: update workpad state + comment
    emitActivity({
      type: 'error',
      body: `Work failed: ${event.failureReason}`
    })
```

## Architecture

### Primary Components
- `src/integration/linear/workpad-reporter.ts` — Extended with activity emission
- `src/integration/linear/linear-client.ts` — `createAgentActivity` method (Phase 7B)

### Design Decisions
- Single subscriber, dual output — DRY, no duplicate event subscriptions
- Ephemeral for transient states — Linear shows "typing indicator"-style UI for ephemeral activities
- Best-effort emission — activity failures never block the workpad comment path
- Session ID injected at construction time — when the workpad reporter is created for a Symphony issue, the agentSessionId is passed in

## Refinement

### File Targets
- `src/integration/linear/workpad-reporter.ts`
- `src/index.ts` — Pass `agentSessionId` when creating workpad reporter

### Exact Tests
- `tests/integration/linear/workpad-reporter.test.ts`
  - PhaseStarted emits ephemeral thought activity when agentSessionId present
  - WorkCompleted emits response activity when agentSessionId present
  - WorkFailed emits error activity when agentSessionId present
  - No activity emission when agentSessionId is absent (backward compat)
  - Activity emission failure does not prevent comment update

### Risks
- Rapid event bursts during execution could hit Linear's rate limit — the existing LinearClient rate limiter handles this
- `agentSessionId` availability depends on the intake path — Symphony via AgentSession has it, generic pipeline does not
