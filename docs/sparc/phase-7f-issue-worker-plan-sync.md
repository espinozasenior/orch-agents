# Phase 7F: Issue Worker Plan Sync

## Goal
Update the issue worker to maintain a visible plan checklist in Linear's Agent Session UI, showing real-time progress through lifecycle phases, and to accept inbound `prompted` messages from the orchestrator via a new worker message channel.

## Specification

### Problem Statement
Linear's Agent Plan API lets the agent show a session-level checklist (steps with `pending`/`inProgress`/`completed`/`canceled` status). The existing issue worker has lifecycle phases (analyze, implement, commit, push, PR) but doesn't communicate these to Linear. Additionally, the Codex outside voice identified that the worker has no inbound message channel — it can only send messages OUT via `parentPort.postMessage()`, but the orchestrator cannot inject `prompted` messages into a running worker.

### Functional Requirements
- FR-7F.01: Accept optional `agentSessionId` in worker config (via `workerData`)
- FR-7F.02: Define plan steps for each lifecycle phase and update them on state transitions
- FR-7F.03: On failure, mark current step as `canceled` and remaining steps as `canceled`
- FR-7F.04: On completion, link PR URL to session `externalUrls`
- FR-7F.05: Listen for inbound `prompted` messages from orchestrator via `parentPort.on('message')`
- FR-7F.06: Inject prompted messages into the executor's next turn as additional context
- FR-7F.07: Retry plan updates on network failure (at-least-once semantics)
- FR-7F.08: Reconstruct conversation history from prior Agent Activities (Prompt + Response types, paginated) when resuming or handling `prompted` webhooks — use activities, NOT comments (comments are editable, activities are immutable)
- FR-7F.09: Inject conversation history into executor prompt as additional context for continuity

### Non-Functional Requirements
- Plan updates must replace the entire array (Linear API requirement)
- Plan update failures must not halt execution — log and continue
- Worker message channel must be type-safe (discriminated union for message types)

### Acceptance Criteria
- Worker updates plan to show "Analyze" as `inProgress` when entering analysis phase
- Worker updates plan to show "Implement" as `inProgress` after analysis completes
- On failure, remaining steps are marked `canceled`
- On completion, PR URL is added to session `externalUrls`
- Orchestrator can inject a `prompted` message into a running worker
- Plan update retry works on transient network failure

## Pseudocode

```text
TYPE WorkerInboundMessage =
  | { type: 'prompted'; body: string; agentSessionId: string }
  | { type: 'stop'; reason: string }

CONST PLAN_STEPS = [
  "Analyze issue requirements",
  "Implement changes",
  "Run tests and validate",
  "Commit and push changes",
  "Create pull request",
]

FUNCTION runIssueWorkerLifecycle(deps):
  agentSessionId = deps.agentSessionId
  pendingPrompts: string[] = []

  // Listen for inbound messages from orchestrator
  IF parentPort:
    parentPort.on('message', (msg: WorkerInboundMessage) =>
      IF msg.type == 'prompted':
        pendingPrompts.push(msg.body)
      ELSE IF msg.type == 'stop':
        // signal the executor to stop
        abortController.abort()
    )

  FUNCTION updatePlan(currentStepIndex, status):
    IF NOT agentSessionId: RETURN
    plan = PLAN_STEPS.map((step, i) => ({
      content: step,
      status:
        i < currentStepIndex ? 'completed' :
        i == currentStepIndex ? status :
        status == 'canceled' ? 'canceled' : 'pending'
    }))

    retryWithBackoff(() =>
      linearClient.agentSessionUpdate(agentSessionId, { plan })
    , maxRetries=2, baseDelayMs=1000)

  // Lifecycle with plan updates:
  updatePlan(0, 'inProgress')  // Analyze
  // ... analyze ...
  updatePlan(0, 'completed')

  updatePlan(1, 'inProgress')  // Implement
  // Inject any pending prompted messages into context
  IF pendingPrompts.length > 0:
    additionalContext = pendingPrompts.join('\n\n')
    pendingPrompts = []
  // ... implement with additionalContext ...
  updatePlan(1, 'completed')

  updatePlan(2, 'inProgress')  // Test
  // ... test ...
  updatePlan(2, 'completed')

  updatePlan(3, 'inProgress')  // Commit + push
  // ... commit ...
  updatePlan(3, 'completed')

  updatePlan(4, 'inProgress')  // Create PR
  // ... create PR ...
  updatePlan(4, 'completed')

  // Link PR to session
  IF agentSessionId AND prUrl:
    linearClient.agentSessionUpdate(agentSessionId, {
      addedExternalUrls: [{ label: 'Pull Request', url: prUrl }]
    })
```

## Architecture

### Primary Components
- `src/execution/orchestrator/issue-worker-runner.ts` — Plan update logic, inbound message handler
- `src/execution/orchestrator/issue-worker.ts` — Wire parentPort listener, pass agentSessionId
- `src/execution/orchestrator/symphony-orchestrator.ts` — Forward `AgentPrompted` events to worker via `worker.postMessage()`

### Data Flow
```
AgentPrompted event → symphony-orchestrator → worker.postMessage({ type: 'prompted', body })
                                                       │
                                                       ▼
                                              issue-worker parentPort listener
                                                       │
                                                       ▼
                                              pendingPrompts[] → injected into next turn
```

### Design Decisions
- Plan updates are fire-and-forget with retry — never block execution for a cosmetic update
- Inbound messages use a discriminated union — type-safe, extensible
- Prompted messages are queued and injected at the next turn boundary — no mid-execution interruption
- Stop messages abort the current executor via AbortController

## Refinement

### File Targets
- `src/execution/orchestrator/issue-worker-runner.ts`
- `src/execution/orchestrator/issue-worker.ts`
- `src/execution/orchestrator/symphony-orchestrator.ts`

### Exact Tests
- `tests/execution/issue-worker.test.ts`
  - Plan updated to inProgress on each phase transition
  - Plan steps marked completed after successful phase
  - Plan steps marked canceled on failure
  - PR URL linked to session externalUrls on completion
  - Prompted message injected into executor context at next turn
  - Plan update retry on transient failure

### Risks
- Worker thread message channel is bidirectional but untyped — need runtime validation of inbound messages
- Prompted messages arriving during execution are queued, not immediately acted on — user may perceive delay
- Plan array replacement means a race condition if two updates happen simultaneously — unlikely with single worker per issue
