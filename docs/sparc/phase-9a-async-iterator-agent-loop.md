# Phase 9A: Async Iterator Agent Loop

## Goal
Replace poll-based agent communication with an async iterator / event-stream pattern. Agents block waiting for work via `for await` instead of polling on a timer. The daemon manages capacity and routes work to idle agents. Dispatch latency drops from ~2s (poll interval) to <50ms (event-driven push).

## Specification

### Problem Statement
The current agent loop uses a poll-based model: each agent wakes on a fixed interval (default 2s), checks for pending work, processes it, then sleeps again. This creates unnecessary latency (average half the poll interval), wastes CPU on empty polls, and makes capacity management reactive rather than proactive. The Claude Code CLI internally uses an async generator pattern where the agent blocks on `for await (const message of inputStream)` and the runtime pushes messages to the agent as they arrive. Adopting this pattern eliminates poll latency, simplifies the control flow, and enables features like auto-compaction, token budgets, and graceful shutdown that depend on message-level interception.

### Functional Requirements
- FR-9A.01: `AgentRunner` class with a `messageStream(): AsyncGenerator<AgentMessage>` method that yields messages as they arrive from the daemon
- FR-9A.02: Message type enum covering all agent-facing events: `user_task`, `control_response`, `keep_alive`, `env_update`, `shutdown`
- FR-9A.03: Transport-agnostic inbound stream interface (`TransportInbound`) with implementations for stdin (NDJSON), WebSocket, and SSE
- FR-9A.04: Auto-compact: proactive context compression when accumulated tokens exceed 80% of the model's context window
- FR-9A.05: Reactive compact: emergency compression triggered when the upstream API returns a context-length-exceeded error (HTTP 400 with `context_length_exceeded` error code or equivalent `overloaded_error`), truncating to 50% of the window
- FR-9A.06: Token budget enforcement per turn -- reject or truncate messages that would exceed a configurable per-turn token ceiling
- FR-9A.07: Task budget enforcement per conversation -- track cumulative tool calls and halt the agent when it exceeds `maxTasks` (configurable, default 200)
- FR-9A.08: Max-output recovery: when the model response is truncated due to `max_output_tokens`, automatically re-prompt with a continuation hint, up to 3 retries
- FR-9A.09: Graceful shutdown on SIGTERM/SIGINT -- stop accepting new messages, drain in-flight work (30s timeout), then exit with code 0
- FR-9A.10: Keep-alive frame handling -- transport emits a `keep_alive` message every 120s (configurable); `AgentRunner` resets its idle timer on receipt

### Non-Functional Requirements
- Dispatch latency from daemon to agent must be <50ms (p99) under normal load
- Zero-work polling must produce zero CPU overhead (agent blocks, not spins)
- Transport disconnect must be detected within 2x the keep-alive interval
- Memory overhead per idle agent must not exceed 5MB
- The async generator must be cancellable without resource leaks (AbortController)

### Acceptance Criteria
- Agent receives a `user_task` message within 50ms of the daemon dispatching it
- Agent processes `keep_alive` without executing any task logic
- Auto-compact fires when token count crosses 80% threshold and reduces context below 60%
- Reactive compact fires on context overflow API error and succeeds on retry
- Token budget violation rejects the oversized message and logs a warning
- Task budget exhaustion emits a `shutdown` message and the agent exits cleanly
- Max-output recovery re-prompts up to 3 times and concatenates partial responses
- SIGTERM triggers drain; in-flight task completes; agent exits with code 0
- Transport disconnect triggers reconnect with exponential backoff (1s, 2s, 4s, max 30s)

## Pseudocode

```text
TYPE AgentMessage = {
  type: "user_task" | "control_response" | "keep_alive" | "env_update" | "shutdown"
  id: string
  payload: unknown
  timestamp: number
}

INTERFACE TransportInbound {
  connect(): Promise<void>
  messages(): AsyncGenerator<AgentMessage>
  disconnect(): Promise<void>
  isConnected(): boolean
}

CLASS StdinTransport IMPLEMENTS TransportInbound:
  // Reads NDJSON lines from process.stdin
  ASYNC GENERATOR messages():
    reader = createLineReader(process.stdin)
    FOR EACH line IN reader:
      YIELD JSON.parse(line) AS AgentMessage

CLASS CompactionManager:
  contextWindow: number       // e.g. 200_000 tokens
  autoThreshold: 0.80         // trigger proactive compact at 80%
  reactiveTarget: 0.50        // compress to 50% on overflow

  FUNCTION shouldAutoCompact(currentTokens): boolean
    RETURN currentTokens > contextWindow * autoThreshold

  FUNCTION autoCompact(conversationHistory):
    // Summarize older turns, keep recent 20% verbatim
    oldTurns = history[0 .. len-recentCount]
    summary = summarize(oldTurns)
    RETURN [summary, ...recentTurns]

  FUNCTION reactiveCompact(conversationHistory):
    // Emergency: aggressive summarization to reactiveTarget
    RETURN summarizeToTokenCount(history, contextWindow * reactiveTarget)

CLASS TokenBudgetEnforcer:
  maxPerTurn: number          // configurable ceiling per message
  maxTasks: number            // max tool calls per conversation (default 200)
  taskCount: number = 0

  FUNCTION checkTurnBudget(message): { ok: boolean, reason?: string }
    tokens = countTokens(message.payload)
    IF tokens > maxPerTurn:
      RETURN { ok: false, reason: "exceeds per-turn budget" }
    RETURN { ok: true }

  FUNCTION incrementTaskCount():
    taskCount += 1
    IF taskCount >= maxTasks:
      RETURN { exhausted: true }
    RETURN { exhausted: false }

CLASS AgentRunner:
  transport: TransportInbound
  compaction: CompactionManager
  budget: TokenBudgetEnforcer
  abortController: AbortController
  idleTimer: Timer
  keepAliveInterval: number = 120_000

  ASYNC FUNCTION run():
    signal = abortController.signal
    registerShutdownHandlers()
    AWAIT transport.connect()

    TRY:
      FOR AWAIT (message OF transport.messages()):
        IF signal.aborted: BREAK
        resetIdleTimer()

        SWITCH message.type:
          CASE "keep_alive":
            // No-op, idle timer already reset
            CONTINUE

          CASE "env_update":
            applyEnvUpdate(message.payload)
            CONTINUE

          CASE "shutdown":
            BREAK  // exit the loop

          CASE "user_task":
            budgetCheck = budget.checkTurnBudget(message)
            IF NOT budgetCheck.ok:
              log.warn("Turn budget exceeded", budgetCheck.reason)
              sendResponse(message.id, { error: budgetCheck.reason })
              CONTINUE

            response = AWAIT executeWithRetry(message, maxRetries: 3)
            sendResponse(message.id, response)

            taskResult = budget.incrementTaskCount()
            IF taskResult.exhausted:
              log.info("Task budget exhausted, shutting down")
              BREAK

            IF compaction.shouldAutoCompact(currentTokenCount()):
              history = compaction.autoCompact(conversationHistory)

          CASE "control_response":
            resolveControlPromise(message.id, message.payload)

    FINALLY:
      AWAIT drainInFlight(timeout: 30_000)
      AWAIT transport.disconnect()

  ASYNC FUNCTION executeWithRetry(message, maxRetries):
    FOR attempt IN 0..maxRetries:
      TRY:
        RETURN AWAIT executeTask(message.payload)
      CATCH contextOverflow:
        history = compaction.reactiveCompact(conversationHistory)
        CONTINUE
      CATCH outputTruncated:
        IF attempt < maxRetries:
          appendContinuationHint()
          CONTINUE
        RETURN partialResponse
    THROW MaxRetriesExceeded

  FUNCTION registerShutdownHandlers():
    process.on("SIGTERM", () => abortController.abort())
    process.on("SIGINT", () => abortController.abort())

  ASYNC FUNCTION drainInFlight(timeout):
    // Wait for any in-progress task to finish, up to timeout
    AWAIT Promise.race([inFlightPromise, sleep(timeout)])
```

### Complexity Analysis
- **Message dispatch**: O(1) -- direct push from daemon to blocked generator
- **Auto-compact**: O(n) where n = conversation history length (one-time summarization pass)
- **Token counting**: O(m) where m = message token count (per-turn)
- **Keep-alive**: O(1) -- timer reset only
- **Shutdown drain**: O(1) -- waits for single in-flight promise

## Architecture

### Primary Components
- `src/execution/runtime/agent-runner.ts` (NEW) -- Core `AgentRunner` class with async generator loop
- `src/execution/runtime/transport.ts` (NEW) -- `TransportInbound` interface and `StdinTransport`, `WSTransport`, `SSETransport` implementations
- `src/execution/runtime/compaction-manager.ts` (NEW) -- Auto and reactive context compaction
- `src/execution/runtime/token-budget.ts` (NEW) -- Per-turn and per-conversation budget enforcement
- `src/execution/runtime/message-types.ts` (NEW) -- `AgentMessage` type and message type enum
- `src/execution/orchestrator/symphony-orchestrator.ts` -- Updated to push messages to agent streams instead of polling

### Component Diagram
```
                    SwarmCoordinator / Daemon
                           │
                    dispatch(agentId, message)
                           │
                           ▼
              ┌─────────────────────────┐
              │     TransportInbound    │  (interface)
              │  ┌───────┬──────┬─────┐ │
              │  │ Stdin │  WS  │ SSE │ │  (implementations)
              │  └───┬───┴──┬───┴──┬──┘ │
              └──────┼──────┼──────┼────┘
                     │      │      │
                     ▼      ▼      ▼
              ┌─────────────────────────┐
              │      AgentRunner        │
              │  ┌───────────────────┐  │
              │  │ for await (msg    │  │  ← blocking async iteration
              │  │   of stream) {    │  │
              │  │   ...             │  │
              │  │ }                 │  │
              │  └───────────────────┘  │
              │           │             │
              │     ┌─────┴──────┐      │
              │     ▼            ▼      │
              │  Compaction   Budget    │
              │  Manager      Enforcer  │
              └─────────────────────────┘
                        │
                        ▼
                   Tool Execution
```

### Message Flow
```
Daemon has work for Agent-3
  │
  ▼
transport.push({ type: "user_task", id: "t-42", payload: {...} })
  │
  ▼
AgentRunner.run() -- for-await yields the message (was blocking)
  │
  ├─ TokenBudgetEnforcer.checkTurnBudget() -- pass
  ├─ executeTask(payload) -- runs tool calls
  ├─ TaskBudget.increment() -- 47/200
  ├─ CompactionManager.shouldAutoCompact() -- 72% < 80%, skip
  │
  ▼
sendResponse("t-42", { result: ... })
  │
  ▼
Agent blocks again on next for-await iteration
```

### Integration with Phase 9B
Phase 9A defines the inner loop of each agent (how it receives and processes messages). Phase 9B defines the outer shell (how the daemon spawns, manages, and communicates with agent processes). The `TransportInbound` interface is the contract between them -- Phase 9B's `SessionRunner` writes NDJSON to the child process stdin, and Phase 9A's `StdinTransport` reads it.

### Cross-Phase Modification Note
Multiple phases modify `symphony-orchestrator.ts`. Implementation order for these modifications follows the phase dependency chain: 9B first (daemon core), then 9A (agent runner integration), then 9D (capacity wake), then 9C (batch events), then 9G (deferred tools). Each phase's modifications are additive and non-overlapping:
- **Phase 9B**: Delegate spawning/lifecycle to `SwarmDaemon`
- **Phase 9A**: Push messages to agent streams instead of polling
- **Phase 9D**: Call `releaseSlot()` on session completion
- **Phase 9C**: Integrate serial batch uploaders into event flow
- **Phase 9G**: Check `concurrencySafe` before parallel tool dispatch

### Design Decisions
- **AsyncGenerator over EventEmitter** -- generators provide natural backpressure; the agent only pulls the next message when it is ready. EventEmitter requires manual buffering
- **Transport abstraction** -- decouples the agent loop from the communication mechanism. Stdin for local child processes, WebSocket for remote agents, SSE for browser-based clients
- **Compaction as interceptor** -- compaction runs inside the agent loop between message processing, not as a separate background task. This avoids race conditions with conversation history
- **AbortController for shutdown** -- standard Node.js cancellation primitive. Signal propagates to all async operations including the transport stream

## Refinement

### File Targets
- `src/execution/runtime/agent-runner.ts` (NEW)
- `src/execution/runtime/transport.ts` (NEW)
- `src/execution/runtime/compaction-manager.ts` (NEW)
- `src/execution/runtime/token-budget.ts` (NEW)
- `src/execution/runtime/message-types.ts` (NEW)
- `src/execution/orchestrator/symphony-orchestrator.ts` (MODIFY)

### Exact Tests
- `tests/execution/runtime/agent-runner.test.ts` (NEW)
  - Agent blocks on empty stream until message arrives
  - `user_task` message dispatched and response sent within 50ms
  - `keep_alive` message resets idle timer without executing task logic
  - `env_update` message updates environment variables
  - `shutdown` message breaks the loop and triggers drain
  - SIGTERM triggers AbortController, drains in-flight, exits cleanly
  - SIGINT triggers AbortController, drains in-flight, exits cleanly
  - In-flight task completes before exit during drain period
  - Drain timeout (30s) forces exit if task hangs
- `tests/execution/runtime/compaction-manager.test.ts` (NEW)
  - Auto-compact triggers at 80% token threshold
  - Auto-compact does not trigger below 80%
  - Auto-compact reduces context below 60% of window
  - Reactive compact fires on context overflow and reduces to 50%
  - Recent turns preserved verbatim during auto-compact
- `tests/execution/runtime/token-budget.test.ts` (NEW)
  - Per-turn budget rejects message exceeding ceiling
  - Per-turn budget passes message within ceiling
  - Task budget increments correctly
  - Task budget exhaustion returns `{ exhausted: true }`
  - Default maxTasks is 200
- `tests/execution/runtime/transport.test.ts` (NEW)
  - StdinTransport parses valid NDJSON line into AgentMessage
  - StdinTransport handles malformed JSON gracefully (skip + log)
  - StdinTransport detects stdin close as disconnect
  - Reconnect with exponential backoff on transport disconnect (1s, 2s, 4s)
  - Max reconnect backoff caps at 30s
- `tests/execution/runtime/max-output-recovery.test.ts` (NEW)
  - Truncated output triggers re-prompt with continuation hint
  - Successful continuation concatenates partial responses
  - Max 3 retries before returning partial response
  - Context overflow during retry triggers reactive compact

### Performance Targets
| Metric | Before (poll) | After (async iterator) | Method |
|--------|--------------|----------------------|--------|
| Dispatch latency (p50) | ~1000ms | <10ms | Timestamp diff: daemon send vs agent receive |
| Dispatch latency (p99) | ~2000ms | <50ms | Same, under 100 concurrent agents |
| CPU idle overhead | ~2% per agent | ~0% | `process.cpuUsage()` over 60s idle window |
| Memory per idle agent | ~8MB | <5MB | `process.memoryUsage().heapUsed` |

### Risks
- Backpressure stall: if an agent processes tasks too slowly, the transport buffer grows unbounded. Mitigation: bounded buffer with configurable high-water mark (default 100 messages); daemon stops dispatching to that agent when buffer is full.
- Compaction quality: summarization may lose important context. Mitigation: always preserve the last N turns verbatim (configurable, default 5); include tool call results in preserved window.
- Token counting accuracy: fast token counters (tiktoken) may differ from the API's actual count by a few percent. Mitigation: use 80% threshold (not 95%) to leave margin for counting drift.
- Transport reconnection during task execution: if the transport drops while a task is in-flight, the response may be lost. Mitigation: response queue with delivery confirmation; re-send on reconnect.
