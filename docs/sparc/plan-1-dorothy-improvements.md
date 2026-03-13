# SPARC Plan 1: Dorothy-Inspired Improvements

## Streaming, Cancellation, Per-Agent Tracking, Output Parsing, Token Tracking

## Priority: P1 — Execute After Plan 2
## Estimated Effort: 12 days
## Status: Planning

---

## Problem Statement

The system architect compared Dorothy (desktop app with real-time streaming, SIGTERM cancellation, per-agent status) against orch-agents and found critical observability gaps:

1. **No streaming** — task-executor accumulates stdout silently for minutes, zero progress visibility
2. **No cancellation** — can't abort running agents; only blunt timeout
3. **No per-agent status tracking** — only plan-level visibility via WorkTracker
4. **No output parsing** — no tool_use/thinking/waiting detection during execution
5. **No actual token tracking** — only tier-based cost estimates, not real token counts

### Strengths to Preserve

- Event-sourced architecture with domain events
- Structured JSON logging with correlation IDs
- Retry handler with configurable max retries
- Multi-agent coordination with Promise.allSettled partial results
- Gate checking between phases

---

## S — Specification

### Requirements

1. **R1 — Streaming chunks from child processes.** The system must emit typed chunk events as bytes arrive from each `claude --print -` process, routed through the EventBus so any subscriber (logging, SSE endpoint, UI) can observe progress without coupling to the executor.

2. **R2 — Graceful cancellation via SIGTERM with escalation.** Support explicit cancellation by planId or individual agentExecId, sending SIGTERM first, then escalating to SIGKILL after configurable grace period. Cancellation surfaced as distinct `cancelled` status.

3. **R3 — Per-agent execution status tracking.** Track each agent execution independently: spawned, running (with lastActivity timestamp updated on each chunk), completed, failed, cancelled, timed-out. Queryable by planId.

4. **R4 — Heuristic output parsing during execution.** Detect patterns in stdout chunks: tool_use blocks, thinking markers, JSON fragments, stall detection (no output for N seconds). Parsed signals emitted as structured log entries and optionally as events.

5. **R5 — Actual token tracking from Claude CLI output.** Capture actual input/output token counts when available. Include in `TaskExecutionResult` and `PhaseResult.metrics`. Fall back to tier-based estimates when unavailable.

### Acceptance Criteria

- AC1: A subscriber to `AgentChunk` events receives at least one chunk before the process completes for any non-trivial prompt.
- AC2: Calling `cancel(agentExecId)` on a running agent results in SIGTERM, process exits within grace period, result status is `cancelled`.
- AC3: `AgentTracker.getAgentsByPlan(planId)` returns per-agent status objects with `lastActivity` updated within 1 second of most recent chunk.
- AC4: When Claude output contains `tool_use`, a structured log entry with `{event: 'tool_use_detected'}` is emitted.
- AC5: When Claude CLI provides token counts, `TaskExecutionResult` includes `tokenUsage: { input: number, output: number }`.

### Constraints

- Must not change the `TaskExecutor` interface contract — callers still get `Promise<TaskExecutionResult>`. Streaming is a parallel concern via EventBus.
- Must preserve Promise.allSettled in `runTaskTool` so partial results survive.
- Must not introduce Node.js native addons or external dependencies.
- All new types exported from `src/types.ts`.

### Edge Cases

- Agent produces zero stdout — must complete with empty output, not hang.
- SIGTERM ignored by process — SIGKILL escalation after grace period.
- Concurrent cancellation of all agents in a plan — must not corrupt WorkTracker state.
- Token counts absent from stderr — graceful fallback to tier estimates.
- Chunk arrives after cancellation signal — must be captured, not dropped.

---

## P — Pseudocode

### P1 — Streaming Algorithm

```
class StreamingTaskExecutor implements TaskExecutor:
  constructor(eventBus, cliBin, defaultTimeout, logger)

  execute(request) -> Promise<TaskExecutionResult>:
    execId = randomUUID()
    child = spawn(cliBin, ['--print', '-'], opts)

    child.stdout.on('data', chunk):
      buffer += chunk
      eventBus.publish('AgentChunk', {
        execId, planId, agentRole, chunk, timestamp
      })
      agentTracker.touch(execId)

    child.stderr.on('data', chunk):
      stderrBuf += chunk
      tokenUsage = tryParseTokens(stderrBuf)

    await processExit(child)
    return { status, output: extractJson(buffer), duration, tokenUsage }
```

### P2 — Cancellation Algorithm

```
class CancellationController:
  activeProcesses: Map<execId, { child, planId, timer? }>

  register(execId, child, planId):
    activeProcesses.set(execId, { child, planId })

  cancel(execId, graceMs = 5000):
    entry = activeProcesses.get(execId)
    if !entry: return false
    child.kill('SIGTERM')
    entry.timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    return true

  cancelPlan(planId, graceMs):
    for each (execId, entry) where entry.planId === planId:
      cancel(execId, graceMs)

  unregister(execId):
    entry = activeProcesses.get(execId)
    if entry?.timer: clearTimeout(entry.timer)
    activeProcesses.delete(execId)
```

### P3 — Per-Agent Tracking

```
interface AgentExecState:
  execId, planId, agentRole, agentType, phaseType
  status: 'spawned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out'
  spawnedAt, lastActivity, completedAt
  bytesReceived, chunksReceived
  parsedSignals: { toolUseCount, thinkingDetected, jsonDetected }
  tokenUsage?: { input, output }

class AgentTracker:
  agents: Map<execId, AgentExecState>
  planIndex: Map<planId, Set<execId>>

  spawn(execId, planId, agentRole, ...): void
  touch(execId): void
  complete(execId, result): void
  fail(execId, error): void
  getAgentsByPlan(planId): AgentExecState[]
  getStalled(stallThresholdMs): AgentExecState[]
```

### P4 — Output Parsing

```
function parseChunk(chunk, accumulatedBuffer) -> ParsedSignals:
  signals = {}
  if chunk contains '"type": "tool_use"' or '<tool_use>':
    signals.toolUse = true
  if chunk contains '"type": "thinking"' or '<thinking>':
    signals.thinking = true
  if chunk starts with '{' and buffer + chunk forms valid JSON:
    signals.jsonComplete = true
  return signals
```

### P5 — Token Extraction

```
function tryParseTokens(stderr) -> TokenUsage | undefined:
  match = stderr.match(jsonUsagePattern) || stderr.match(textUsagePattern)
  if match: return { input: match.inputTokens, output: match.outputTokens }
  return undefined
```

### Complexity Analysis

- Streaming: O(1) per chunk, O(n) total
- Cancellation: O(1) lookup and signal
- AgentTracker: O(1) for touch/spawn/complete, O(k) for getAgentsByPlan
- Output parsing: O(m) per chunk
- Token extraction: O(1) per attempt

---

## A — Architecture

### New Components

```
src/execution/
  streaming-executor.ts      — StreamingTaskExecutor (implements TaskExecutor)
  cancellation-controller.ts — CancellationController (process lifecycle)
  agent-tracker.ts           — AgentTracker (per-agent state)
  output-parser.ts           — parseChunk(), tryParseTokens() (pure functions)
```

### Modified Components

```
src/types.ts                 — Add AgentExecState, TokenUsage, AgentChunk event
src/execution/phase-runner.ts — Pass agentTracker + cancellationController
src/pipeline.ts              — Wire new deps, expose cancellation API
src/execution/work-tracker.ts — Link to AgentTracker for drill-down
```

### Key Design Decision

`StreamingTaskExecutor` implements the existing `TaskExecutor` interface exactly. Streaming is a **parallel concern via EventBus** — callers see no interface change. This preserves backward compatibility and keeps the phase runner's Promise.allSettled pattern unchanged.

### Event Flow (Augmented)

```
PlanCreated
  -> PhaseStarted
    -> AgentSpawned (new, per agent)
    -> AgentChunk (new, per stdout chunk)
    -> AgentCompleted | AgentFailed | AgentCancelled (new)
  -> PhaseCompleted
-> WorkCompleted
```

### Bounded Context

All new components live within the `execution` bounded context. No changes to `triage`, `planning`, `review`, or `intake` contexts.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Output parsing false positives | LOW | Parsing is advisory only, never affects control flow |
| SIGTERM not supported on platform | MEDIUM | SIGKILL escalation timer; tested on macOS/Linux |
| AgentTracker memory growth | LOW | Cleanup with maxAge, bounded by maxAgents=15 |

---

## R — Refinement (TDD Implementation Order)

### Step 1: output-parser.ts + tests (0 dependencies, pure functions)

- Test: parseChunk detects tool_use, thinking, JSON patterns
- Test: tryParseTokens extracts from JSON and text formats
- Test: returns undefined/empty for unrecognized input

### Step 2: agent-tracker.ts + tests (0 dependencies, pure state)

- Test: spawn -> touch -> complete lifecycle
- Test: getAgentsByPlan returns correct subset
- Test: getStalled identifies inactive agents
- Test: concurrent operations don't corrupt state
- Test: cleanup removes old entries

### Step 3: cancellation-controller.ts + tests (mock child_process)

- Test: register + cancel sends SIGTERM
- Test: SIGKILL escalation after grace period (fake timers)
- Test: cancelPlan cancels all agents for a plan
- Test: unregister clears timers
- Test: cancel on unknown execId returns false

### Step 4: streaming-executor.ts + tests (depends on 1, 2, 3)

- Test: returns TaskExecutionResult (interface compatibility)
- Test: publishes AgentChunk events to EventBus
- Test: updates AgentTracker on each chunk
- Test: cancellation produces 'cancelled' status
- Test: token usage extracted when available
- Test: fallback when no usage data
- Test: extractJson still works

### Step 5: types.ts updates

- Add AgentExecState, TokenUsage, new event payloads

### Step 6: phase-runner.ts + tests (integration)

- Test: runTaskTool with StreamingTaskExecutor preserves Promise.allSettled
- Test: cancelled agent produces 'cancelled' not 'failed'

### Step 7: pipeline.ts wiring

### Step 8: Integration test (full pipeline with streaming in stub mode)

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on new modules
- `npm run build` succeeds

---

## C — Completion

1. **Integration testing:** Full pipeline E2E with StreamingTaskExecutor in stub mode.
2. **Manual verification:** Real `claude --print -` process, confirm chunks arrive, token usage captured, SIGTERM works.
3. **ADR:** Document streaming as parallel EventBus concern. Document SIGTERM-SIGKILL escalation. Document AgentTracker vs WorkTracker separation.
4. **Migration:** No breaking changes. `createClaudeTaskExecutor` remains available. `StreamingTaskExecutor` is opt-in. Deprecation of old executor in future release.
5. **Deployment:** `npm run build && npm test` passes. No new dependencies.

---

## Cross-Plan Dependencies

- **Depends on Plan 2** (Hook Pollution Fix) — Plan 2's `agent-sandbox.ts` must merge before this plan's Refinement phase begins.
- Plan 1's S and P phases can run in parallel with Plan 2's R phase.
- `StreamingTaskExecutor` inherits sandbox isolation from Plan 2.

---

## Execution Timeline

```
Plan 2 (Hooks)  ═══[5.5d]═══> DONE
                    |
Plan 1 (Dorothy) ══════════════[12d]════════════════> DONE
                 S+P parallel   R starts after Plan 2
```

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/execution/streaming-executor.ts` | NEW |
| `src/execution/cancellation-controller.ts` | NEW |
| `src/execution/agent-tracker.ts` | NEW |
| `src/execution/output-parser.ts` | NEW |
| `src/types.ts` | MODIFIED |
| `src/execution/phase-runner.ts` | MODIFIED |
| `src/pipeline.ts` | MODIFIED |
| `src/execution/work-tracker.ts` | MODIFIED |
| `tests/execution/streaming-executor.test.ts` | NEW |
| `tests/execution/cancellation-controller.test.ts` | NEW |
| `tests/execution/agent-tracker.test.ts` | NEW |
| `tests/execution/output-parser.test.ts` | NEW |
| `tests/phase-runner.test.ts` | MODIFIED |
| `tests/integration/pipeline-e2e.test.ts` | MODIFIED |
