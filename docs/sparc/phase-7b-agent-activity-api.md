# Phase 7B: Agent Activity API

## Goal
Extend the Linear GraphQL client with Agent Session and Activity mutations so the system can emit structured progress (thought, action, elicitation, response, error) into Linear's Agent Session UI.

## Specification

### Problem Statement
The current `LinearClient` has comment CRUD and issue state mutations but no Agent API surface. Linear's Agent API uses typed activities (`agentActivityCreate`) to show real-time agent progress in a dedicated session UI. Without this, the agent's work is invisible in the Agent Session panel.

### Functional Requirements
- FR-7B.01: `createAgentActivity(sessionId, content, options?)` — emit one of 5 activity types
- FR-7B.02: `agentSessionUpdate(id, updates)` — set `externalUrls`, update `plan` steps
- FR-7B.03: `agentSessionCreateOnIssue(issueId)` — proactively create a session
- FR-7B.04: `agentSessionCreateOnComment(commentId)` — create session from a comment thread
- FR-7B.05: `issueRepositorySuggestions(issueId, sessionId, candidates)` — get ranked repo matches
- FR-7B.06: Support `ephemeral` flag on thought and action activities
- FR-7B.07: Support `signal` and `signalMetadata` fields on activities
- FR-7B.08: `fetchSessionActivities(sessionId, options?)` — paginated query for session activity history (Prompt + Response types for conversation reconstruction)

### Non-Functional Requirements
- All mutations share the existing `graphql()` transport, rate limiting, and error handling
- Activity content payloads are validated at the type level (TypeScript discriminated unions)
- No new dependencies required

### Acceptance Criteria
- Each of the 5 activity types can be created with valid typed payloads
- Ephemeral flag is correctly passed for thought/action activities
- Session plan can be fully replaced with an array of `{content, status}` steps
- Session `externalUrls` can be set, added, or removed
- Repository suggestions query returns ranked candidates with confidence scores

## Pseudocode

```text
TYPE AgentActivityContent =
  | { type: 'thought'; body: string }
  | { type: 'action'; action: string; parameter: string; result?: string }
  | { type: 'elicitation'; body: string }
  | { type: 'response'; body: string }
  | { type: 'error'; body: string }

TYPE AgentActivityOptions = {
  ephemeral?: boolean
  signal?: 'stop' | 'auth' | 'select'
  signalMetadata?: Record<string, unknown>
}

TYPE AgentPlanStep = {
  content: string
  status: 'pending' | 'inProgress' | 'completed' | 'canceled'
}

TYPE AgentSessionUpdateInput = {
  externalUrls?: Array<{ label: string; url: string }>
  addedExternalUrls?: Array<{ label: string; url: string }>
  removedExternalUrls?: Array<{ url: string }>
  plan?: AgentPlanStep[]
}

FUNCTION createAgentActivity(sessionId, content, options):
  RETURN graphql(AGENT_ACTIVITY_CREATE_MUTATION, {
    input: {
      agentSessionId: sessionId,
      content,
      ...(options?.ephemeral ? { ephemeral: true } : {}),
      ...(options?.signal ? { signal: options.signal, signalMetadata: options.signalMetadata } : {}),
    }
  })

FUNCTION agentSessionUpdate(id, updates):
  RETURN graphql(AGENT_SESSION_UPDATE_MUTATION, {
    id,
    input: updates,
  })
```

## Architecture

### Primary Components
- `src/integration/linear/linear-client.ts` — New methods on `LinearClient` interface + implementation
- `src/integration/linear/types.ts` — New type definitions for Agent API payloads

### GraphQL Mutations
```graphql
mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { id }
  }
}

mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) {
    success
  }
}

mutation AgentSessionCreateOnIssue($issueId: String!) {
  agentSessionCreateOnIssue(issueId: $issueId) {
    success
    agentSession { id }
  }
}

query IssueRepositorySuggestions($issueId: String!, $agentSessionId: String!, $candidates: [RepositoryCandidateInput!]!) {
  issueRepositorySuggestions(issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidates) {
    suggestions { repositoryFullName hostname confidence }
  }
}
```

### Design Decisions
- All Agent API methods added to the existing `LinearClient` interface — one client, one transport
- Content types as discriminated unions — TypeScript enforces valid payloads at compile time
- Ephemeral/signal fields are optional — backward-compatible with simple activity creation

## Refinement

### File Targets
- `src/integration/linear/linear-client.ts`
- `src/integration/linear/types.ts`

### Exact Tests
- `tests/integration/linear/linear-client.test.ts`
  - Create `thought` activity with body
  - Create `action` activity with action, parameter, and result
  - Create `elicitation` activity with body
  - Create `response` activity with body
  - Create `error` activity with body
  - Create ephemeral `thought` activity
  - Create activity with `auth` signal and signalMetadata
  - Update session with plan steps
  - Update session with externalUrls
  - Create proactive session on issue
  - Query repository suggestions

### Risks
- Linear's Agent API schema may evolve (it's in technology preview for plans) — use the raw SDL as reference
- Rate limiting: burst activity creation during rapid execution could hit limits — use the existing rate limiter
