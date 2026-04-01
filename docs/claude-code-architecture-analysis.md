# Claude Code CLI Architecture Analysis

**Source**: Decompiled Claude Code CLI (github.com/VineeTagarwaL-code/claude-code)
**Date**: 2026-03-31
**Purpose**: Inform orch-agents design decisions

---

## 1. Harness/Bridge Architecture

### Overview

The bridge system is a multi-layered architecture that connects the local CLI process to Anthropic's cloud infrastructure. It has evolved through two major versions (v1 env-based, v2 env-less) and supports both single-session REPL use and multi-session daemon/server modes.

### Key Components and Relationships

```
                        bridgeMain.ts (standalone multi-session daemon)
                              |
                    +---------+---------+
                    |                   |
              replBridge.ts      remoteBridgeCore.ts
           (env-based, v1)        (env-less, v2)
                    |                   |
              sessionRunner.ts    (direct transport)
              (child process)           |
                    |                   |
            replBridgeTransport.ts      |
            (v1/v2 adapter)             |
                    |                   |
          +---------+---------+---------+
          |                   |
    HybridTransport     SSETransport + CCRClient
       (v1: WS+POST)     (v2: SSE+POST)
```

### bridgeMain.ts — The Multi-Session Daemon

This is the orchestrator for `claude remote-control` in multi-session mode. Key architectural elements:

**Core Loop**: `runBridgeLoop()` is the main poll loop that:
- Polls the Environments API for new work items
- Spawns child CLI sessions via `SessionSpawner`
- Manages session lifecycle (timeouts, heartbeats, cleanup)
- Tracks capacity via `CapacityWake`

**Backoff Configuration** (hardcoded defaults):
```typescript
const DEFAULT_BACKOFF: BackoffConfig = {
  connInitialMs: 2_000,
  connCapMs: 120_000,       // 2-minute cap
  connGiveUpMs: 600_000,    // 10-minute give-up
  generalInitialMs: 500,
  generalCapMs: 30_000,
  generalGiveUpMs: 600_000, // 10-minute give-up
}
```

**Session State Maps** (per active session):
- `activeSessions: Map<string, SessionHandle>` -- running session handles
- `sessionStartTimes: Map<string, number>` -- for duration tracking
- `sessionWorkIds: Map<string, string>` -- mapping to work dispatch IDs
- `sessionIngressTokens: Map<string, string>` -- per-session JWTs
- `sessionCompatIds: Map<string, string>` -- compat ID cache
- `sessionTimers: Map<string, setTimeout>` -- timeout watchdogs
- `sessionWorktrees: Map<string, {...}>` -- git worktree state

**Feature Gating**: Multi-session spawn is gated via GrowthBook (`tengu_ccr_bridge_multi_session`), using a blocking gate check for cold-start correctness.

### replBridge.ts — The REPL Bridge Core (Env-Based, v1)

`initBridgeCore()` is the main entry point (~2400 lines). It owns:

1. **Environment Registration**: `api.registerBridgeEnvironment(bridgeConfig)` returns `environment_id` + `environment_secret`
2. **Session Creation**: `createSession({ environmentId, title, gitRepoUrl, branch })` returns `session_id`
3. **Poll Loop**: Continuous polling for work items from the Environments API
4. **Transport Management**: Creates and manages HybridTransport (v1) or SSETransport+CCRClient (v2)
5. **JWT Refresh**: `createTokenRefreshScheduler()` schedules proactive refresh 5min before JWT expiry
6. **Crash Recovery**: Writes a "bridge pointer" file for resume-on-restart

**Key Types**:
```typescript
export type BridgeCoreParams = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  title: string
  baseUrl: string
  sessionIngressUrl: string
  workerType: string
  getAccessToken: () => string | undefined
  createSession: (opts: { environmentId; title; gitRepoUrl; branch; signal }) => Promise<string | null>
  archiveSession: (sessionId: string) => Promise<void>
  toSDKMessages?: (messages: Message[]) => SDKMessage[]
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  getPollIntervalConfig?: () => PollIntervalConfig
  perpetual?: boolean
  initialSSESequenceNum?: number
  // ... 15+ callback hooks for state changes, interrupts, model changes, etc.
}
```

The design uses **dependency injection** extensively -- all heavyweight dependencies (session creation, OAuth, message mapping) are injected as callbacks to avoid importing the full REPL tree into lean daemon builds.

### remoteBridgeCore.ts — The Env-Less Bridge (v2)

`initEnvLessBridgeCore()` removes the Environments API entirely:

1. `POST /v1/code/sessions` (OAuth) -> `session.id`
2. `POST /v1/code/sessions/{id}/bridge` (OAuth) -> `{ worker_jwt, expires_in, api_base_url, worker_epoch }`
3. `createV2ReplTransport(worker_jwt, epoch)` -> SSE + CCRClient
4. Proactive JWT refresh via `createTokenRefreshScheduler`
5. On 401: rebuild transport with fresh `/bridge` credentials (same seq-num)

No register/poll/ack/stop/heartbeat/deregister lifecycle. Each `/bridge` call bumps epoch server-side.

**Transport Rebuild Pattern** (critical for understanding failover):
```typescript
async function rebuildTransport(fresh: RemoteCredentials, cause): Promise<void> {
  flushGate.start()          // Queue writes during rebuild
  const seq = transport.getLastSequenceNum()
  transport.close()
  transport = await createV2ReplTransport({
    sessionUrl: buildCCRv2SdkUrl(fresh.api_base_url, sessionId),
    ingressToken: fresh.worker_jwt,
    epoch: fresh.worker_epoch,
    initialSequenceNum: seq,  // Resume from where we left off
    // ...
  })
  wireTransportCallbacks()
  transport.connect()
  // After connect, drain the flush gate
}
```

### sessionRunner.ts — Child Process Spawner

`createSessionSpawner()` returns a `SessionSpawner` that spawns child `claude` processes:

**Spawn Arguments**:
```typescript
const args = [
  '--print',
  '--sdk-url', opts.sdkUrl,
  '--session-id', opts.sessionId,
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--replay-user-messages',
]
```

**Environment Injection**:
- `CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge'`
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken`
- v1: `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1'`
- v2: `CLAUDE_CODE_USE_CCR_V2: '1'` + `CLAUDE_CODE_WORKER_EPOCH`

**Activity Tracking**: Parses NDJSON from child stdout, extracts `SessionActivity` events (tool_start, text, result, error). Maintains a ring buffer of last 10 activities.

**Permission Forwarding**: Detects `control_request` messages with `subtype: 'can_use_tool'` and forwards them to the bridge for server-side approval.

### bridgeMessaging.ts — Shared Message Handling

Provides pure functions (no closure state) for both bridge cores:

- `handleIngressMessage()` -- Parse ingress WS/SSE data, route to handlers, echo-dedup via `BoundedUUIDSet`
- `handleServerControlRequest()` -- Respond to `initialize`, `set_model`, `interrupt`, `set_permission_mode`, `set_max_thinking_tokens`
- `makeResultMessage()` -- Build minimal `SDKResultSuccess` for session archival
- `isEligibleBridgeMessage()` -- Filter user/assistant turns (skip virtual, tool_result, progress)
- `extractTitleText()` -- Derive session title from user messages

**BoundedUUIDSet** -- A FIFO-bounded ring buffer for echo dedup:
```typescript
export class BoundedUUIDSet {
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0
  // O(1) add/has, O(capacity) memory, oldest evicted automatically
}
```

### bridgeConfig.ts — Auth/URL Resolution

Consolidates ant-only dev overrides:
```typescript
export function getBridgeAccessToken(): string | undefined {
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}
export function getBridgeBaseUrl(): string {
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}
```

---

## 2. Always-On / Loop Query Strategy

### Poll Configuration

**pollConfigDefaults.ts** defines the baseline intervals:

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `poll_interval_ms_not_at_capacity` | 2,000ms | Seeking work (fast) |
| `poll_interval_ms_at_capacity` | 600,000ms (10min) | Connected/idle (slow liveness) |
| `non_exclusive_heartbeat_interval_ms` | 0 (disabled) | Per-work-item heartbeat |
| `multisession_poll_interval_ms_partial_capacity` | 2,000ms | Some slots free |
| `multisession_poll_interval_ms_at_capacity` | 600,000ms | All slots full |
| `reclaim_older_than_ms` | 5,000ms | Stale work item reclaim threshold |
| `session_keepalive_interval_v2_ms` | 120,000ms | Proxy idle-timeout prevention |

**pollConfig.ts** fetches live overrides from GrowthBook with a 5-minute refresh:
```typescript
export function getPollIntervalConfig(): PollIntervalConfig {
  const raw = getFeatureValue_CACHED_WITH_REFRESH<unknown>(
    'tengu_bridge_poll_interval_config',
    DEFAULT_POLL_CONFIG,
    5 * 60 * 1000,
  )
  const parsed = pollIntervalConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_POLL_CONFIG
}
```

The Zod schema enforces safety invariants:
- Minimum 100ms on all non-zero intervals (prevents fat-finger ops mistakes)
- Values 1-99 rejected (prevents unit confusion: seconds vs. milliseconds)
- At least one liveness mechanism must be enabled (heartbeat OR at-capacity poll)

### CapacityWake — Interrupt-Driven Capacity Recovery

```typescript
export type CapacityWake = {
  signal(): CapacitySignal  // Merged abort signal (outer loop + capacity)
  wake(): void              // Immediately unblock the at-capacity sleep
}
```

When a session completes, `capacityWake.wake()` aborts the current at-capacity sleep so the bridge immediately polls for new work -- no waiting for the next poll interval.

The implementation merges two abort signals:
1. **Outer loop signal** -- for shutdown
2. **Capacity wake controller** -- for session-done events

Each `wake()` call creates a fresh `AbortController`, so the pattern is single-use-per-sleep.

### FlushGate — Write Ordering During Transport Bootstrap

```typescript
export class FlushGate<T> {
  start()              // Begin queuing (transport swap in progress)
  end(): T[]           // Return queued items for draining
  enqueue(...items)    // Queue if active, return false if not
  drop(): number       // Discard all (permanent close)
  deactivate()         // Clear active without dropping (transport replacement)
}
```

This ensures message ordering during the critical window between:
1. Historical message flush (single HTTP POST)
2. Transport becoming ready for live writes

Without this, live writes could arrive at the server interleaved with or before the historical flush.

### QueryEngine — The Conversation Loop

`QueryEngine` is a class-per-conversation that manages the query lifecycle:

```typescript
export class QueryEngine {
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()

  async *submitMessage(prompt, options?): AsyncGenerator<SDKMessage, void, unknown>
}
```

**submitMessage()** flow:
1. Build system prompt parts (default + user context + system context + memory mechanics)
2. Register structured output enforcement hooks
3. Process user input (slash commands, attachments)
4. Persist transcript to disk (resumability)
5. Run the query loop (delegates to `query()`)
6. Yield SDK messages as they stream

**Key Design Decisions**:
- Uses `AsyncGenerator` for streaming -- callers consume with `for await`
- System prompt is assembled from multiple parts: default, custom override, append, memory mechanics
- `ProcessUserInputContext` is rebuilt after slash-command processing to pick up model/tool changes
- Transcript is written BEFORE the API call so `--resume` works even on kill-mid-request

### query.ts — The Inner Query Loop

The `query()` generator runs the agentic loop:

**State Machine**:
```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  turnCount: number
  transition: Continue | undefined  // Why previous iteration continued
}
```

Features:
- **Auto-compact**: Detects token warnings and triggers automatic context compaction
- **Reactive compact**: Feature-gated (`REACTIVE_COMPACT`) compaction during streaming
- **Context collapse**: Feature-gated (`CONTEXT_COLLAPSE`) for long contexts
- **Token budget**: Feature-gated (`TOKEN_BUDGET`) auto-continue tracking
- **Task budget**: Server-side output budget (distinct from token budget)
- **Max output tokens recovery**: Retries up to 3 times on `max_output_tokens` errors
- **Snip compaction**: Feature-gated (`HISTORY_SNIP`) for SDK/headless session memory bounding
- **Streaming tool execution**: `StreamingToolExecutor` runs tools as they stream in

---

## 3. Agent/Task Orchestration

### Task.ts — Task Model

```typescript
export type TaskType =
  | 'local_bash'        // Shell command
  | 'local_agent'       // Local subagent
  | 'remote_agent'      // Remote subagent
  | 'in_process_teammate' // In-process teammate (shared memory)
  | 'local_workflow'    // Local workflow
  | 'monitor_mcp'       // MCP monitor
  | 'dream'             // Background processing

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'
```

**Task ID Generation**: Uses crypto-safe random bytes with type-prefix encoding:
```typescript
// Prefixes: b=bash, a=agent, r=remote, t=teammate, w=workflow, m=monitor, d=dream
// 36^8 = ~2.8 trillion combinations (safe against brute-force symlink attacks)
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
```

Each task gets a `TaskStateBase` with:
- `outputFile` -- disk-backed output (via `getTaskOutputPath(id)`)
- `outputOffset` -- read cursor for incremental output consumption
- `notified` -- whether completion has been surfaced to the user

### Tool.ts — Tool System Architecture

The `Tool<Input, Output, Progress>` interface is the core extensibility point:

```typescript
export type Tool<Input, Output, Progress> = {
  name: string
  aliases?: string[]           // Backwards-compat renames
  searchHint?: string          // For ToolSearch keyword matching
  shouldDefer?: boolean        // Deferred loading (requires ToolSearch)
  alwaysLoad?: boolean         // Never deferred
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'
  maxResultSizeChars: number   // Infinity = never persist to disk
  strict?: boolean             // Strict mode for tool instructions

  // Permission chain:
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  // Execution:
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>

  // MCP integration:
  isMcp?: boolean
  mcpInfo?: { serverName; toolName }
  inputJSONSchema?: ToolInputJSONSchema
}
```

**Tool Use Context** (`ToolUseContext`) carries per-conversation state:
- Model/thinking config, MCP clients, agent definitions
- `getAppState()` / `setAppState()` -- immutable state updates
- `setAppStateForTasks()` -- always reaches root store (critical for subagents)
- File caches, memory triggers, skill discovery tracking
- Content replacement state for tool result budgeting
- `renderedSystemPrompt` -- parent's prompt for cache-sharing forks

### Agent Handler (cli/handlers/agents.ts)

The `agentsHandler()` command lists configured agents grouped by source:
- Resolves overrides (project agents can shadow global agents)
- Shows active vs. shadowed agents
- Displays model, memory configuration

### Auto Mode (cli/handlers/autoMode.ts)

Auto mode uses an AI classifier to decide tool approval:

**Three Rule Categories**:
1. `allow` -- Auto-approve these actions
2. `soft_deny` -- Block (require user confirmation)
3. `environment` -- Context for classifier decisions

**Key Feature**: `autoModeCritiqueHandler()` uses a side-query (separate AI call) to evaluate user-written classifier rules for clarity, completeness, conflicts, and actionability.

---

## 4. Transport Layer

### Transport Hierarchy

```
Transport (interface)
  |
  +-- WebSocketTransport (WS reads + WS writes)
  |     |
  |     +-- HybridTransport (WS reads + HTTP POST writes)
  |
  +-- SSETransport (SSE reads + HTTP POST writes)
```

### WebSocketTransport

**Connection Management**:
- Dual runtime support: Bun (native WebSocket) and Node.js (ws package)
- Automatic reconnection with exponential backoff (1s base, 30s max, 10min budget)
- Sleep/wake detection: if gap > 60s, reset reconnection budget
- Permanent close codes: 1002, 4001, 4003 (no retry)
- Exception: 4003 (unauthorized) retries if `refreshHeaders` provides a new token

**Health Monitoring**:
- Ping/pong interval (10s)
- Keep-alive data frames (5min) to reset proxy idle timers
- Session activity callback registration for outbound keep-alives

**Message Buffering**: `CircularBuffer<StdoutMessage>` (1000 entries) for replay on reconnection. Server deduplicates by UUID.

### HybridTransport (v1)

Extends `WebSocketTransport` -- reads via WS, writes via HTTP POST:

**Write Pipeline**:
```
write(stream_event) --> streamEventBuffer (100ms delay) --> uploader.enqueue()
write(other)        --> flush buffer + enqueue()        --> uploader.enqueue()
                                                              |
                                                        SerialBatchEventUploader
                                                        (serial, batched, retry)
                                                              |
                                                          postOnce() (single POST)
```

- `stream_event` messages accumulate for 100ms to reduce POST count
- Non-stream writes flush buffered stream events first (ordering guarantee)
- `SerialBatchEventUploader`: at most one POST in-flight; retry with exponential backoff + jitter
- Backpressure: if queue > 100K items, `enqueue()` blocks

**Close Grace Period**: 3s window to drain queued writes (fallback; bridge teardown awaits archive first).

### SSETransport (v2)

**Read Path** (SSE):
- HTTP `fetch()` with `Accept: text/event-stream`
- Custom SSE frame parser (`parseSSEFrames()`) handles `event:`, `id:`, `data:` fields
- Sequence number tracking via `id:` field for resumption (`from_sequence_num` + `Last-Event-ID`)
- Dedup via `seenSequenceNums` set (pruned when > 1000 entries)
- Liveness timeout: 45s of silence = reconnect (server sends keepalives every 15s)
- Reconnection: 1s base, 30s max, 10min budget (same as WS)
- Permanent HTTP codes: 401, 403, 404

**Write Path** (HTTP POST):
- 10 retry attempts with exponential backoff (500ms base, 8s max)
- 4xx (except 429) = permanent drop; 429/5xx = retryable

**Frame Format**: `event: client_event` carries `StreamClientEvent` proto JSON:
```typescript
export type StreamClientEvent = {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>  // This is unwrapped and passed to onData
  created_at: string
}
```

### ReplBridgeTransport — Unified Adapter

```typescript
export type ReplBridgeTransport = {
  write(message: StdoutMessage): Promise<void>
  writeBatch(messages: StdoutMessage[]): Promise<void>
  close(): void
  setOnData / setOnClose / setOnConnect / connect
  getLastSequenceNum(): number    // For seq-num carryover across transport swaps
  droppedBatchCount: number       // Silent drop detection
  reportState(state: SessionState): void      // v2 only (PUT /worker state)
  reportMetadata(metadata): void              // v2 only
  reportDelivery(eventId, status): void       // v2 only (delivery tracking)
  flush(): Promise<void>                      // Drain before close
}
```

**v1 adapter** (`createV1ReplTransport`): Thin wrapper around `HybridTransport`. `getLastSequenceNum()` returns 0 (WS doesn't use SSE seq nums).

**v2 adapter** (`createV2ReplTransport`):
1. Set auth (per-instance closure or process-wide env var)
2. Register worker (`registerWorker()` or use epoch from `/bridge`)
3. Create `SSETransport` with `initialSequenceNum` for resumption
4. Create `CCRClient` for writes, heartbeat, state reporting
5. Wire: reads from SSE, writes through CCRClient

### Failover Strategy Summary

| Scenario | v1 (WS+POST) | v2 (SSE+POST) |
|----------|--------------|---------------|
| Transient disconnect | Auto-reconnect (10min budget) | Auto-reconnect (10min budget) |
| JWT expiry | Proactive refresh 5min before; reconnectSession on 401 | Proactive refresh; rebuild transport with new JWT+epoch |
| Server 500 | Poll retry with exponential backoff | Same |
| Proxy idle timeout | Keep-alive frames every 5min | Keep-alive SSE frames every 2min |
| System sleep/wake | Detect gap > 2x backoff cap, reset budget | Same pattern |
| Permanent close (4001/1002) | Stop immediately | Stop immediately |
| Epoch mismatch (v2) | N/A | Close code 4090 -> terminal |

---

## 5. Bootstrap/State

### bootstrap/state.ts — Global Session State

The `State` type contains ~80 fields covering the entire session lifecycle:

**Core Tracking**: `originalCwd`, `projectRoot`, `cwd`, `sessionId`, `startTime`
**Cost/Usage**: `totalCostUSD`, `totalAPIDuration`, `modelUsage`, token counters
**Model State**: `mainLoopModelOverride`, `initialMainLoopModel`, `modelStrings`
**Telemetry**: OpenTelemetry meter, counters, logger/tracer providers
**Session Flags**: `isInteractive`, `kairosActive`, `strictToolResultPairing`
**Agent State**: `agentColorMap`, `agentColorIndex`
**Prompt Cache Optimization**: `promptCache1hAllowlist`, `afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched`, `thinkingClearLatched`
**Channel System**: `allowedChannels[]`, `hasDevChannels`
**Cron/Teams**: `sessionCronTasks[]`, `sessionCreatedTeams: Set<string>`

Notable: State is NOT globally mutable -- it uses a signal pattern:
```typescript
import { createSignal } from 'src/utils/signal.js'
```

### assistant/sessionHistory.ts — Session History API

Paginated session event fetching:
```typescript
export async function fetchLatestEvents(ctx: HistoryAuthCtx, limit = 100): Promise<HistoryPage | null>
export async function fetchOlderEvents(ctx: HistoryAuthCtx, beforeId: string, limit = 100): Promise<HistoryPage | null>
```

Uses OAuth + `anthropic-beta: ccr-byoc-2025-07-29` header against `/v1/sessions/{id}/events`.

---

## 6. Key Patterns for orch-agents

### Pattern 1: Dependency Injection for Build Isolation

Claude Code aggressively injects callbacks to avoid transitive dependency chains. For example, `BridgeCoreParams.toSDKMessages` is injected because `mappers.ts` pulls in `commands.ts` via `messages.ts -> api.ts -> prompts.ts`, which drags the entire command registry into the bundle.

**Takeaway**: For orch-agents, consider injecting heavy dependencies (MCP clients, tool registries) rather than importing them directly.

### Pattern 2: Bounded Ring Buffers for Dedup

`BoundedUUIDSet` provides O(1) add/has with O(capacity) memory, automatically evicting oldest entries. Used for echo-dedup and re-delivery detection.

**Takeaway**: Implement similar bounded dedup structures for agent message routing.

### Pattern 3: FlushGate for Ordered Bootstrapping

The FlushGate pattern ensures that historical messages are fully flushed before live messages flow. This prevents interleaving during transport bootstraps.

**Takeaway**: Apply this pattern when initializing agent connections -- queue commands during handshake, drain after connection confirmed.

### Pattern 4: CapacityWake for Event-Driven Scheduling

Rather than fixed-interval polling, CapacityWake uses abort signals to immediately wake the poll loop when capacity frees up.

**Takeaway**: Use similar signal-based waking for agent pool management.

### Pattern 5: Feature Gating with Safe Defaults

Poll intervals, transport versions, and experimental features are all behind GrowthBook gates with Zod-validated configs and safe defaults on parse failure.

**Takeaway**: All tunable parameters should have validated defaults and runtime override capability.

### Pattern 6: Dual-Track Transport with Shared Adapter

The `ReplBridgeTransport` interface abstracts v1 (WS+POST) and v2 (SSE+POST) behind a single type. Transport swaps are transparent to the bridge core.

**Takeaway**: For orch-agents transport, define a minimal interface and build adapters for different backends.

### Pattern 7: Session-Scoped vs. Process-Scoped State

The codebase carefully distinguishes:
- `setAppState()` -- no-op for async subagents (scoped to their thread)
- `setAppStateForTasks()` -- always reaches root store (for infrastructure that outlives a turn)

**Takeaway**: orch-agents needs clear state scope boundaries when running nested agents.

---

## 7. Recommendations for orch-agents

1. **Adopt the transport adapter pattern**: Define a `Transport` interface with `write/writeBatch/close/connect/setOnData/setOnClose` and build adapters for different backends.

2. **Implement FlushGate**: For agent initialization sequences where message ordering matters.

3. **Use bounded dedup buffers**: For message routing between agents, especially in mesh topologies.

4. **Add CapacityWake to agent pools**: Replace fixed-interval polling with signal-based waking when agents complete tasks.

5. **Inject heavy dependencies**: Avoid importing tool registries, MCP client trees, or command registries transitively. Use callback injection.

6. **Add poll config validation**: Use Zod schemas with safe invariants (minimum intervals, required liveness mechanisms) for all tunable parameters.

7. **Support transport-level reconnection**: Build exponential backoff with time budgets and sleep/wake detection into the transport layer, not the application layer.

8. **Separate session state from process state**: Use distinct state containers for session-scoped data (messages, file caches) vs. process-scoped data (telemetry, config).
