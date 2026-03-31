# Phase 7H: Issue Delegate + State Management

## Goal
Complete the AIG compliance surface by having the agent set itself as delegate on issues it works, move issues to the first `started` state when beginning work, and emit a terminal `response` activity on completion — making the agent's role in the issue explicit and visible.

## Specification

### Problem Statement
Linear's AIG principle states "An agent cannot be held accountable" — there must be a clear delegation model between humans and agents. The `Issue.delegate` field makes the agent's role explicit in the Linear UI (showing the agent as the worker while the human remains the assignee/accountable party). The current system does not set the delegate or manage issue state transitions through the Agent API.

### Functional Requirements
- FR-7H.01: When the issue worker starts and no `delegate` is set, set the agent as delegate via `issueUpdate` mutation
- FR-7H.02: When the issue is not in a `started` status type, move it to the first `started` state (lowest position)
- FR-7H.03: On completion, emit a `response` activity — Linear auto-creates a comment from this
- FR-7H.04: On failure, emit an `error` activity with the failure reason
- FR-7H.05: Query team workflow states to find the correct `started` state (not hardcoded)
- FR-7H.06: Only set delegate if the agent has `app:assignable` OAuth scope

### Non-Functional Requirements
- State transitions must be idempotent — moving to "In Progress" when already "In Progress" is a no-op
- Delegate setting must not override an existing delegate — only set when empty
- GraphQL calls for delegate/state are best-effort — failures don't halt execution

### Acceptance Criteria
- Agent sets itself as delegate on issues where no delegate exists
- Agent moves issue to first `started` state when it begins work
- Agent does not move issues already in `started`, `completed`, or `canceled` states
- Response activity emitted on successful completion
- Error activity emitted on failure with meaningful message
- Existing `moveLinearIssueToInProgress` pattern from execution-engine is reused

## Pseudocode

```text
FUNCTION setupIssueForExecution(linearClient, issue, agentSessionId):
  // 1. Set delegate if not already set
  IF issue.delegate is null:
    TRY:
      linearClient.issueUpdate(issue.id, { delegateId: agentAppUserId })
    CATCH: log.warn('Failed to set delegate')

  // 2. Move to started state if needed
  IF issue.state.type NOT IN ['started', 'completed', 'canceled']:
    TRY:
      states = linearClient.fetchTeamStates(issue.team.id)
      startedStates = states.filter(s => s.type == 'started')
      firstStarted = startedStates.sort(by: position).first

      IF firstStarted:
        linearClient.updateIssueState(issue.id, firstStarted.id)
    CATCH: log.warn('Failed to move issue to started state')

FUNCTION completeIssueExecution(linearClient, agentSessionId, summary):
  // Emit terminal response activity
  linearClient.createAgentActivity(agentSessionId, {
    type: 'response',
    body: summary
  })

FUNCTION failIssueExecution(linearClient, agentSessionId, reason):
  // Emit terminal error activity
  linearClient.createAgentActivity(agentSessionId, {
    type: 'error',
    body: reason
  })
```

## Architecture

### Primary Components
- `src/execution/orchestrator/issue-worker-runner.ts` — Call setup at lifecycle start, terminal activities at end
- `src/integration/linear/linear-client.ts` — Add `issueUpdate` mutation for delegate, extend `fetchIssue` to include delegate field
- `src/execution/orchestrator/execution-engine.ts` — Existing `moveLinearIssueToInProgress` pattern to reuse

### Data Flow
```
Issue worker starts
  │
  ├── fetchIssue() → check delegate and state
  ├── issueUpdate({ delegateId }) → set agent as delegate
  ├── updateIssueState() → move to first "started" state
  │
  ├── ... execute work ...
  │
  └── On exit:
        ├── success → createAgentActivity({ type: 'response', body: summary })
        └── failure → createAgentActivity({ type: 'error', body: reason })
```

### Design Decisions
- Reuse `moveLinearIssueToInProgress` pattern from execution-engine — same logic, different call site
- Delegate is the agent's app user ID, not the human assignee — preserves human accountability
- Terminal activities (response/error) are the last thing the worker emits — Linear uses these to close the session turn
- Best-effort for delegate/state — execution continues even if these calls fail

## Refinement

### File Targets
- `src/execution/orchestrator/issue-worker-runner.ts`
- `src/integration/linear/linear-client.ts`

### Exact Tests
- `tests/execution/issue-worker.test.ts`
  - Delegate set when issue has no delegate
  - Delegate not overwritten when already set
  - Issue moved to first started state when in backlog/triage
  - Issue not moved when already in started state
  - Response activity emitted on successful completion
  - Error activity emitted on failure
- `tests/integration/linear/linear-client.test.ts`
  - `issueUpdate` mutation sends correct delegate payload
  - `fetchIssue` returns delegate field

### Risks
- Agent app user ID must be known at runtime — query `viewer { id }` on startup and cache it
- Some workspaces may not have the `started` state type — graceful fallback to no state change
- Delegate field may not exist in older Linear API versions — handle missing field gracefully
