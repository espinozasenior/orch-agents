# Phase 7G: Agent Signals

## Goal
Implement Linear's Agent Signals system — `stop` (halt execution), `auth` (account linking), and `select` (option picker) — enabling bidirectional structured communication between users and the agent through the Linear UI.

## Specification

### Problem Statement
Linear's Signals API provides typed metadata that modifies how Agent Activities are interpreted. Without signals, the agent cannot: be stopped from Linear's UI (stop button), prompt users to link accounts (OAuth flow), or present multiple-choice options (repo selection). The existing stop command detection uses raw comment text matching — signals provide a structured, reliable alternative.

### Functional Requirements
- FR-7G.01: Handle `stop` signal on `prompted` webhooks — halt all work, emit final `response` or `error` activity
- FR-7G.02: Emit `auth` signal via `elicitation` activity when OAuth linking is needed
- FR-7G.03: Emit `select` signal via `elicitation` activity for multi-choice questions (e.g., repository selection)
- FR-7G.04: `stop` signal halts the worker immediately — no further code changes, API calls, or tool invocations
- FR-7G.05: `auth` signal renders "Link account" UI in Linear with configurable URL and provider name
- FR-7G.06: `select` signal renders option buttons in Linear; user response arrives as a `prompted` webhook with selected value
- FR-7G.07: Free-text responses to `select` elicitations are also handled (user may type instead of clicking)

### Non-Functional Requirements
- Stop signal handling must be immediate — within the webhook handler, not deferred to the orchestrator
- Auth and select signals are emitted by the agent, not received — they are outbound activities
- Signal metadata must conform to Linear's expected schema

### Acceptance Criteria
- `stop` signal in a `prompted` webhook terminates the active worker and emits confirmation
- `auth` elicitation shows "Link account" button in Linear UI with the correct URL
- `select` elicitation shows option buttons in Linear UI
- User selecting an option produces a `prompted` webhook that the agent can interpret
- Stop signal is handled even when no worker is currently running (no-op with acknowledgment)

## Pseudocode

```text
// Stop signal handling (in webhook handler):
FUNCTION handlePromptedEvent(payload):
  signal = payload.agentActivity?.signal
  sessionId = payload.agentSession.id

  IF signal == 'stop':
    // Publish cancellation to event bus
    eventBus.publish('WorkCancelled', {
      workItemId: `linear-session-${sessionId}`,
      cancellationReason: 'Stop signal received from Linear UI'
    })

    // Emit confirmation activity
    linearClient.createAgentActivity(sessionId, {
      type: 'response',
      body: 'Stopped. No further changes will be made.'
    })

    RETURN 202 { status: 'cancelling' }

// Auth signal emission (in issue worker or orchestrator):
FUNCTION requestAccountLinking(sessionId, authUrl, providerName):
  linearClient.createAgentActivity(sessionId, {
    type: 'elicitation',
    body: 'Please link your account to continue.'
  }, {
    signal: 'auth',
    signalMetadata: {
      url: authUrl,
      providerName: providerName,
    }
  })

// Select signal emission (in issue worker):
FUNCTION requestRepoSelection(sessionId, candidates):
  options = candidates.map(repo => ({
    label: repo.repositoryFullName.split('/').pop(),
    value: repo.repositoryFullName
  }))

  linearClient.createAgentActivity(sessionId, {
    type: 'elicitation',
    body: 'Which repository should I work in?'
  }, {
    signal: 'select',
    signalMetadata: { options }
  })
```

## Architecture

### Primary Components
- `src/integration/linear/linear-webhook-handler.ts` — Stop signal handling (inbound)
- `src/integration/linear/linear-client.ts` — Activity creation with signal/signalMetadata (outbound)
- `src/execution/orchestrator/issue-worker-runner.ts` — Auth/select signal emission during lifecycle
- `src/execution/orchestrator/symphony-orchestrator.ts` — Forward stop to worker termination

### Signal Flow
```
INBOUND (human → agent):
  Linear UI "Stop" button → AgentSessionEvent (prompted + stop signal)
    → webhook handler → WorkCancelled → orchestrator terminates worker
    → emit response activity confirming stop

OUTBOUND (agent → human):
  Issue worker needs auth → emit elicitation with auth signal
    → Linear renders "Link account" UI
    → User clicks link → completes OAuth → webhook (prompted)
    → Worker resumes

  Issue worker needs repo → emit elicitation with select signal
    → Linear renders option buttons
    → User clicks option → webhook (prompted with selected value)
    → Worker uses selected repo
```

### Design Decisions
- Stop signal reuses the existing `WorkCancelled` event path — no new cancellation infrastructure
- Auth signal is paired with the OAuth flow in Phase 7A — when the agent detects no valid token for a workspace, it emits the auth elicitation
- Select signal is optional — the agent can also auto-select the highest-confidence repo from `issueRepositorySuggestions` without asking

## Refinement

### File Targets
- `src/integration/linear/linear-webhook-handler.ts`
- `src/integration/linear/linear-client.ts`
- `src/execution/orchestrator/issue-worker-runner.ts`
- `src/execution/orchestrator/symphony-orchestrator.ts`

### Exact Tests
- `tests/integration/linear/linear-webhook-handler.test.ts`
  - `prompted` with `stop` signal publishes `WorkCancelled` and emits confirmation activity
  - `prompted` with `stop` signal when no active worker returns acknowledgment
- `tests/execution/issue-worker.test.ts`
  - Auth signal emitted when OAuth token is missing
  - Select signal emitted with candidate repos as options
  - Worker pauses after emitting elicitation and resumes on prompted response

### Risks
- Stop signal handling must be fast enough that the worker doesn't make additional changes after receiving it — use AbortController for immediate halt
- Auth flow requires a callback mechanism — the agent emits elicitation, then waits for a `prompted` webhook after the user links their account. The worker must handle this pause/resume pattern.
- Select signal responses are free-text — the worker must use an LLM to interpret user responses, not exact string matching
