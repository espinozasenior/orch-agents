# Phase 10A: Agent Activity Response Pipeline

| Field | Value |
|-------|-------|
| **Priority** | Critical |
| **Est. Effort** | 3 days |
| **Status** | Spec Ready |
| **Depends On** | Phase 7B (Agent Activity API), Phase 7D (AgentSession Webhook) |
| **Research Source** | `docs/research_linear-weather-bot_20260404.md` |

---

## 1. Specification

### Problem

The system uses `createComment` for Linear responses, which:
1. Posts as the **OAuth authorizing user** instead of the bot actor
2. Appears as a **top-level comment** instead of in the agent activity feed
3. Provides no streaming visibility (no thought/action steps during execution)
4. Has no conversation continuity (fresh session per comment)

Linear's official reference implementation (weather-bot) uses `createAgentActivity` exclusively. Our `createComment` should be reserved for non-Linear platforms (GitHub PRs, GitHub issues).

### Functional Requirements

**FR-10A.01: Platform-Routed Response Channel**
- Linear sources: ALL responses via `createAgentActivity({ type: 'response', body })` — posts as bot actor
- GitHub sources: responses via `createComment` on PRs/issues — existing behavior
- Other sources: `createComment` fallback

**FR-10A.02: Streaming Thought Activities**
- Emit `thought` activity when coordinator starts: "Analyzing your request..."
- Emit `thought` activity when research workers spawn: "Researching {area}..."
- Emit `action` activity when tool is used: `action: 'read_file', parameter: 'src/index.ts'`
- Emit `response` activity with final answer
- All via `createAgentActivity` — visible in Linear's agent activity sidebar

**FR-10A.03: Session Activity History (Conversation Continuity)**
- Before executing a coordinator session, fetch previous activities from `linearClient.fetchSessionActivities(agentSessionId)`
- Map `Prompt` activities to user messages, `Response` activities to assistant messages
- Include as conversation prefix in the coordinator prompt
- Enables multi-turn follow-up questions without losing context

**FR-10A.04: Agent Session ID Propagation**
- `agentSessionId` must flow from webhook → execution engine → simple executor → SDK executor
- Required for `createAgentActivity` calls from the worker context
- Pass via `intakeEvent.sourceMetadata.agentSessionId`

**FR-10A.05: createComment Reserved for GitHub**
- `createComment` in `simple-executor.ts` only fires when `intakeEvent.source === 'github'`
- Linear responses use `createAgentActivity` via the session ID
- Bot marker (`<!-- automata-bot -->`) still appended to GitHub comments for loop prevention

---

## 2. Pseudocode

### Response Router

```
function postResponse(intakeEvent, agentSessionId, body, linearClient):
  if intakeEvent.source === 'linear' AND agentSessionId:
    // Linear: use Agent Activity API (posts as bot actor)
    linearClient.createAgentActivity(agentSessionId, {
      type: 'response',
      body: body,
    })
  else if intakeEvent.source === 'github' AND intakeEvent.entities.prNumber:
    // GitHub: use PR comment
    githubClient.postPRComment(repo, prNumber, body + BOT_MARKER)
  else:
    // Fallback: use Linear comment (top-level)
    linearClient.createComment(issueId, body + BOT_MARKER)
```

### Streaming Activities

```
function emitThought(agentSessionId, message, linearClient):
  if agentSessionId:
    linearClient.createAgentActivity(agentSessionId, {
      type: 'thought',
      body: message,
      ephemeral: true,  // thought activities are ephemeral
    })

function emitAction(agentSessionId, action, parameter, result, linearClient):
  if agentSessionId:
    linearClient.createAgentActivity(agentSessionId, {
      type: 'action',
      action: action,
      parameter: parameter,
      result: result,
    })
```

### Conversation History Fetch

```
function fetchConversationHistory(agentSessionId, linearClient):
  activities = linearClient.fetchSessionActivities(agentSessionId)
  
  messages = []
  for activity in activities:
    if activity.type === 'Prompt':
      messages.push({ role: 'user', content: activity.body })
    elif activity.type === 'Response':
      messages.push({ role: 'assistant', content: activity.body })
  
  return messages
```

---

## 3. Architecture

### Files to Modify

| File | Change |
|------|--------|
| `src/execution/simple-executor.ts` | Route responses by platform: `createAgentActivity` for Linear, `createComment` for GitHub |
| `src/execution/orchestrator/execution-engine.ts` | Pass `agentSessionId` through synthesized IntakeEvent; fetch conversation history before execution |
| `src/integration/linear/workpad-reporter.ts` | Use `createAgentActivity` for streaming thought/action/response updates |
| `src/execution/runtime/sdk-executor.ts` | Accept `agentSessionId` in request; emit thought activities during execution |

### New File

| File | Purpose |
|------|---------|
| `src/integration/linear/activity-router.ts` | `postAgentResponse(intakeEvent, sessionId, body, clients)` — platform-routed response posting |

### Data Flow

```
Comment webhook → AgentPrompted (with agentSessionId)
  → execution-engine.ts: fetch conversation history from Linear
  → synthesize IntakeEvent with history + agentSessionId
  → simple-executor.ts: pass agentSessionId to SDK executor
  → SDK executor: emit thought activities during execution
  → simple-executor.ts: postAgentResponse routes to createAgentActivity
  → Linear displays response in agent activity sidebar (as bot)
```

---

## 4. Refinement

### Edge Cases

- **No agentSessionId**: Fall back to `createComment` (e.g., issue state change trigger has no session)
- **Session expired**: If `createAgentActivity` returns 404, fall back to `createComment`
- **Multiple sessions per issue**: Use the most recent session ID from the webhook
- **GitHub + Linear dual-source**: GitHub PR events still use `createComment`; Linear events use activities
- **Activity fetch pagination**: The weather-bot paginates through all activities; we should too (use cursor-based pagination via `fetchSessionActivities`)

### Performance Considerations

- Activity fetch adds ~200ms per request (one GraphQL call)
- Streaming thought activities add ~100ms each (non-blocking, fire-and-forget)
- Conversation history capped at last 20 exchanges to avoid prompt overflow

---

## 5. Completion Checklist

- [ ] `activity-router.ts` created with platform-routed `postAgentResponse`
- [ ] `simple-executor.ts` uses `postAgentResponse` instead of direct `createComment`
- [ ] `execution-engine.ts` fetches conversation history from Linear before coordinator execution
- [ ] `agentSessionId` propagated through IntakeEvent → plan → executor
- [ ] Thought activities emitted during coordinator execution
- [ ] Action activities emitted for tool use
- [ ] Response activity emitted for final answer
- [ ] `createComment` only fires for GitHub sources
- [ ] Bot marker still appended to GitHub comments
- [ ] Pagination for activity history fetch
- [ ] Fallback to `createComment` when no session ID
- [ ] Staging test covering full Linear response flow
- [ ] Build passes, all tests pass

---

## Acceptance Criteria (Gherkin)

```gherkin
Scenario: Linear comment response via Agent Activity
  Given a user comments on a Linear issue mentioning @automata
  When the coordinator completes execution
  Then the response is posted via createAgentActivity with type "response"
  And the response appears in Linear's agent activity sidebar
  And the response is attributed to the bot actor (not the user)

Scenario: GitHub PR comment response via createComment
  Given a GitHub PR webhook triggers execution
  When the agent completes execution
  Then the response is posted via createComment on the PR
  And the comment includes the bot marker

Scenario: Streaming thought activities
  Given a coordinator session is running for a Linear issue
  When the coordinator spawns research workers
  Then a thought activity "Researching..." is emitted to Linear
  And the user sees it in the agent activity sidebar in real-time

Scenario: Conversation continuity
  Given a user has previously asked "@automata is this implemented?"
  And the bot responded "Yes, it's implemented"
  When the user follows up with "@automata show me the code"
  Then the coordinator receives the previous exchange as conversation context
  And the response references the prior conversation
```
