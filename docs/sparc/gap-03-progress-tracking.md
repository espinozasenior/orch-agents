# SPARC Gap 3: Progress Tracking via PR Comments

## Visual Progress Reporting to GitHub PR/Issue Comments

## Priority: P1
## Estimated Effort: 3-4 days
## Status: Planning

---

## Problem Statement

Users have zero visibility into agent execution until the entire pipeline completes. The system processes intake, triage, planning, execution (potentially minutes of multi-agent work), and review with no feedback to the user. In a GitHub-native workflow, the natural feedback channel is PR comments. The Dorothy streaming layer already emits granular events (AgentSpawned, AgentChunk, AgentCompleted, AgentFailed, AgentCancelled), and the pipeline emits lifecycle events (IntakeCompleted, WorkTriaged, PlanCreated, PhaseStarted, PhaseCompleted, WorkCompleted, ReviewCompleted), but nothing subscribes to these events for the purpose of reporting progress back to the PR.

---

## S -- Specification

### Requirements

1. **R1 -- Subscribe to pipeline events and update a PR comment with visual progress.** Create `src/integration/progress-reporter.ts` that subscribes to pipeline and agent events via EventBus and posts/updates a single PR comment showing checkbox-style progress. The comment must be human-readable at a glance.

2. **R2 -- Use sticky comment pattern.** Find and update an existing comment by an HTML marker (`<!-- orch-agents-progress-{planId} -->`), never creating duplicate progress comments. If no existing comment exists, create one. On subsequent updates, edit the same comment.

3. **R3 -- Throttle updates to respect GitHub API rate limits.** Updates must be throttled to a maximum of 1 update per 5 seconds per plan. Intermediate events are buffered and the latest state is flushed on the next throttle window.

4. **R4 -- Gracefully handle missing PR context.** When IntakeEvent has no `entities.repo` or `entities.prNumber`, skip all progress reporting without errors. Log at debug level.

5. **R5 -- Handle GitHub API failures without disrupting execution.** If `postPRComment` or comment update fails, log the error and continue. Progress reporting is advisory; it must never cause pipeline failures or retries.

6. **R6 -- Support concurrent plans.** Multiple plans may execute simultaneously. Each plan gets its own progress comment and throttle state. No cross-plan interference.

### Acceptance Criteria

- AC1: After a PlanCreated event with PR context, a comment matching the checkbox format appears on the PR within 5 seconds.
- AC2: After PhaseCompleted events, the same comment is updated (not a new comment) with checked boxes.
- AC3: AgentCompleted events update the nested agent lines with duration.
- AC4: An IntakeEvent with no `prNumber` produces zero GitHub API calls.
- AC5: When `postPRComment` throws, the pipeline continues and subsequent events still attempt to update progress.
- AC6: Two concurrent plans targeting the same PR produce two distinct progress comments (different planId markers).
- AC7: Rapid-fire events (10 events in 1 second) result in at most 1 API call per 5-second window.

### Constraints

- Must use existing `GitHubClient.postPRComment(repo, prNumber, body)` for creating comments.
- Must add a `findAndUpdateComment` method to GitHubClient (or use `gh api` directly) for editing existing comments.
- Must not add new npm dependencies.
- Must integrate via EventBus subscriptions only -- no changes to pipeline control flow.
- All new types exported from `src/types.ts`.

### Edge Cases

- PR closed/merged during execution -- GitHub API returns 404/422; log and stop reporting for that plan.
- Agent produces no chunks before completing -- agent line shows "0s" duration, not stale "running..." state.
- Pipeline fails mid-execution -- last progress update shows which phase/agent failed.
- GitHub token lacks comment permissions -- first postPRComment fails; reporter disables itself for that plan.
- Plan has zero agents (trivial plan) -- progress comment shows phases only, no agent sub-items.
- Comment body exceeds GitHub's 65536 character limit -- truncate agent details, keep phase summary.

---

## P -- Pseudocode

### P1 -- ProgressReporter Core

```
interface ProgressState:
  planId: string
  repo: string
  prNumber: number
  commentId: number | null
  intake: { status: 'pending' | 'done', intent: string }
  triage: { status: 'pending' | 'done', priority: string, complexity: string }
  planning: { status: 'pending' | 'done', template: string, agentCount: number }
  execution: { status: 'pending' | 'running' | 'done', currentPhase: string }
  agents: Map<execId, { role: string, status: string, duration: number | null }>
  review: { status: 'pending' | 'done', verdict: string }
  disabled: boolean

class ProgressReporter:
  states: Map<planId, ProgressState>
  throttleTimers: Map<planId, NodeJS.Timeout>
  pendingFlush: Set<planId>
  githubClient: GitHubClient
  eventBus: EventBus
  logger: Logger

  constructor(eventBus, githubClient, logger):
    subscribe to: IntakeCompleted, WorkTriaged, PlanCreated,
      PhaseStarted, PhaseCompleted, AgentSpawned, AgentCompleted,
      AgentFailed, AgentCancelled, WorkCompleted, ReviewCompleted, WorkFailed
```

### P2 -- Event Handlers

```
  onIntakeCompleted(event):
    // Extract repo and prNumber from intakeEvent.entities
    entities = event.payload.intakeEvent.entities
    if !entities.repo or !entities.prNumber:
      return  // No PR context, skip

    state = getOrCreateState(event.correlationId, entities.repo, entities.prNumber)
    state.intake = { status: 'done', intent: event.payload.intakeEvent.intent }
    scheduleFlush(state.planId)

  onPlanCreated(event):
    plan = event.payload.workflowPlan
    state = getStateByCorrelation(event.correlationId)
    if !state: return
    state.planId = plan.id  // Replace correlationId key with planId
    state.planning = { status: 'done', template: plan.template, agentCount: plan.agentTeam.length }
    scheduleFlush(state.planId)

  onAgentSpawned(event):
    state = states.get(event.payload.planId)
    if !state: return
    state.agents.set(event.payload.execId, {
      role: event.payload.agentRole,
      status: 'running',
      duration: null
    })
    scheduleFlush(state.planId)

  onAgentCompleted(event):
    state = states.get(event.payload.planId)
    if !state: return
    agent = state.agents.get(event.payload.execId)
    if agent:
      agent.status = 'completed'
      agent.duration = event.payload.duration
    scheduleFlush(state.planId)

  onAgentFailed(event):
    state = states.get(event.payload.planId)
    if !state: return
    agent = state.agents.get(event.payload.execId)
    if agent:
      agent.status = 'failed'
      agent.duration = event.payload.duration
    scheduleFlush(state.planId)
```

### P3 -- Throttled Flush

```
  scheduleFlush(planId):
    if state.disabled: return
    pendingFlush.add(planId)
    if throttleTimers.has(planId): return  // Already scheduled
    throttleTimers.set(planId, setTimeout(() => flush(planId), 5000))

  flush(planId):
    throttleTimers.delete(planId)
    pendingFlush.delete(planId)
    state = states.get(planId)
    if !state or state.disabled: return

    body = renderComment(state)

    try:
      if state.commentId:
        await githubClient.updateComment(state.repo, state.commentId, body)
      else:
        commentId = await githubClient.postPRComment(state.repo, state.prNumber, body)
        state.commentId = commentId
    catch error:
      logger.warn('Progress update failed', { planId, error })
      if isPermissionError(error) or isNotFoundError(error):
        state.disabled = true
```

### P4 -- Comment Rendering

```
  renderComment(state) -> string:
    lines = ['## Orch-Agents Progress']

    lines.push(checkbox(state.intake.status, `Intake: received \`${state.intake.intent}\` intent`))
    lines.push(checkbox(state.triage.status, `Triage: ${state.triage.priority}, ${state.triage.complexity}`))
    lines.push(checkbox(state.planning.status, `Planning: ${state.planning.template}, ${state.planning.agentCount} agents`))

    // Execution with nested agents
    completedAgents = count agents where status != 'running'
    totalAgents = state.agents.size
    execLabel = `Execution: Phase ${state.execution.currentPhase} (${completedAgents}/${totalAgents} agents complete)`
    lines.push(checkbox(state.execution.status, execLabel))

    for each (execId, agent) in state.agents:
      icon = agent.status == 'completed' ? 'x' : agent.status == 'failed' ? 'x' : ' '
      suffix = agent.duration != null ? `${Math.round(agent.duration / 1000)}s` : 'running...'
      statusEmoji = agent.status == 'failed' ? ' (failed)' : ''
      lines.push(`  - [${icon}] Agent: ${agent.role}${statusEmoji} -- ${suffix}`)

    lines.push(checkbox(state.review.status, `Review: ${state.review.verdict || 'pending'}`))
    lines.push(`<!-- orch-agents-progress-${state.planId} -->`)

    return lines.join('\n')

  checkbox(status, label):
    return status == 'done' ? `- [x] ${label}` : `- [ ] ${label}`
```

### P5 -- Find Existing Comment

```
  findExistingComment(repo, prNumber, planId) -> number | null:
    marker = `<!-- orch-agents-progress-${planId} -->`
    comments = await githubClient.listPRComments(repo, prNumber)
    for comment in comments:
      if comment.body.includes(marker):
        return comment.id
    return null
```

### Complexity Analysis

- Event handling: O(1) per event (map lookup + state mutation)
- Flush: O(n) where n = number of agents in the plan (comment rendering)
- Find existing comment: O(c) where c = number of PR comments (done once per plan)
- Throttle: O(1) per scheduleFlush (timer check)
- Space: O(p * a) where p = concurrent plans, a = agents per plan

---

## A -- Architecture

### New Components

```
src/integration/progress-reporter.ts  -- ProgressReporter class with EventBus subscriptions
```

### Modified Components

```
src/integration/github-client.ts      -- Add updateComment(), listPRComments() methods
src/types.ts                          -- Add ProgressState type (optional, may keep internal)
src/pipeline.ts                       -- Wire ProgressReporter into pipeline startup
```

### GitHubClient Extensions

Two new methods are needed on the GitHubClient interface:

1. `updateComment(repo: string, commentId: number, body: string): Promise<void>` -- Uses `gh api -X PATCH repos/{repo}/issues/comments/{commentId} -f body={body}`.
2. `listPRComments(repo: string, prNumber: number): Promise<Array<{ id: number; body: string }>>` -- Uses `gh api repos/{repo}/issues/{prNumber}/comments`. Note: PR comments and issue comments share the same API endpoint in GitHub.

### Event Flow

```
IntakeCompleted ------> ProgressReporter.onIntakeCompleted
WorkTriaged ----------> ProgressReporter.onWorkTriaged
PlanCreated ----------> ProgressReporter.onPlanCreated
PhaseStarted ---------> ProgressReporter.onPhaseStarted
AgentSpawned ---------> ProgressReporter.onAgentSpawned
AgentCompleted -------> ProgressReporter.onAgentCompleted
AgentFailed ----------> ProgressReporter.onAgentFailed
AgentCancelled -------> ProgressReporter.onAgentCancelled
PhaseCompleted -------> ProgressReporter.onPhaseCompleted
WorkCompleted --------> ProgressReporter.onWorkCompleted
ReviewCompleted ------> ProgressReporter.onReviewCompleted
                             |
                             v
                      [Throttled Flush]
                             |
                             v
                   GitHubClient.updateComment()
```

### Integration Point

ProgressReporter is wired in `pipeline.ts` as a subscriber-only component. It receives events but never publishes events. It has no effect on pipeline control flow. If the ProgressReporter constructor or subscriptions fail, the pipeline continues without progress reporting.

### Comment Update Strategy

GitHub does not support upsert on comments. The strategy is:

1. On first flush: call `postPRComment`, store returned comment ID in state.
2. On subsequent flushes: call `updateComment` with stored comment ID.
3. If the reporter restarts mid-plan (e.g., server restart): call `listPRComments` to find existing comment by HTML marker, recover comment ID.

### Bounded Context

ProgressReporter lives in the `integration` bounded context alongside GitHubClient. It is a read-only consumer of domain events from all other contexts.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| GitHub API rate limit exhaustion | MEDIUM | 5-second throttle; GitHub allows 5000 requests/hour |
| Comment ID lost on restart | LOW | Recover by searching for HTML marker |
| Stale "running..." for crashed agents | LOW | WorkFailed event triggers final flush with failure state |
| Comment too long for GitHub | LOW | Truncate at 60000 chars; summarize agent details |
| Token lacks comment permission | LOW | Disable reporter for that plan on first failure |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: Comment renderer (pure function, 0 dependencies)

Tests (London School -- mock nothing, pure input/output):
- Test: renderComment with all phases pending produces all unchecked boxes
- Test: renderComment with intake + triage done produces checked boxes for those phases
- Test: renderComment with 2 completed agents and 1 running shows correct nested items
- Test: renderComment with failed agent shows failure marker
- Test: renderComment includes HTML marker with planId
- Test: renderComment with empty agents map shows no agent sub-items
- Test: renderComment output under 65536 characters for 50 agents (truncation)

### Step 2: GitHubClient extensions + tests (mock exec)

Tests (London School -- mock exec dependency):
- Test: updateComment calls `gh api -X PATCH` with correct repo, commentId, body
- Test: updateComment throws ExecutionError on API failure
- Test: listPRComments calls `gh api` and parses JSON response
- Test: listPRComments returns empty array when no comments
- Test: listPRComments throws ExecutionError on API failure

### Step 3: ProgressReporter event handlers + tests (mock GitHubClient, mock EventBus)

Tests (London School -- mock GitHubClient and EventBus):
- Test: onIntakeCompleted with prNumber stores state and schedules flush
- Test: onIntakeCompleted without prNumber does nothing (no API calls)
- Test: onPlanCreated updates state with plan details
- Test: onAgentSpawned adds agent to state
- Test: onAgentCompleted updates agent status and duration
- Test: onAgentFailed updates agent status with failure
- Test: onWorkCompleted marks execution as done
- Test: onReviewCompleted marks review as done

### Step 4: Throttle logic + tests (mock timers, mock GitHubClient)

Tests (London School -- fake timers):
- Test: scheduleFlush within 5s window does not trigger immediate flush
- Test: after 5s, pending state is flushed to GitHub
- Test: multiple events within window result in single API call
- Test: flush calls postPRComment on first invocation (no commentId)
- Test: flush calls updateComment on subsequent invocations (has commentId)
- Test: flush with disabled state does nothing

### Step 5: Error handling + tests (mock GitHubClient that throws)

Tests (London School -- mock GitHubClient that throws):
- Test: GitHub API failure logs warning and does not throw
- Test: 404 error disables reporter for that plan
- Test: subsequent events after disable produce zero API calls
- Test: one plan's failure does not affect another plan's reporting

### Step 6: Pipeline wiring + integration test

Tests:
- Test: startPipeline with githubClient creates ProgressReporter subscriptions
- Test: full event sequence (IntakeCompleted through ReviewCompleted) produces expected comment updates
- Test: pipeline without githubClient skips ProgressReporter (no errors)

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on progress-reporter.ts
- 100% branch coverage on new GitHubClient methods
- `npm run build` succeeds
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] ProgressReporter subscribes to all required events
- [ ] Throttle limits API calls to 1 per 5 seconds per plan
- [ ] Sticky comment pattern works (find, create, update)
- [ ] Missing PR context gracefully skipped
- [ ] GitHub API failures do not disrupt pipeline
- [ ] Concurrent plans maintain independent state
- [ ] Comment format matches specification
- [ ] HTML marker includes planId for uniqueness

### Deployment Steps

1. `npm run build` -- verify compilation
2. `npm test` -- verify all tests pass
3. Deploy with existing GitHubClient configuration (no new env vars)
4. Verify on a test PR: trigger pipeline, confirm comment appears and updates

### Rollback Plan

1. ProgressReporter is subscriber-only with no control flow impact
2. To disable: remove ProgressReporter wiring from `pipeline.ts` (one-line change)
3. No database migrations or persistent state to roll back
4. Existing PR comments are inert markdown; no cleanup needed

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/integration/progress-reporter.ts` | NEW |
| `src/integration/github-client.ts` | MODIFIED (add updateComment, listPRComments) |
| `src/pipeline.ts` | MODIFIED (wire ProgressReporter) |
| `tests/integration/progress-reporter.test.ts` | NEW |
| `tests/integration/github-client.test.ts` | MODIFIED (new method tests) |
