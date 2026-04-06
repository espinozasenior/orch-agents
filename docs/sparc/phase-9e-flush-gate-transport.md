# Phase 9E: FlushGate and Multi-Transport Layer

## Goal
Implement FlushGate for ordered message delivery during transport bootstrap, and a multi-transport layer with automatic failover. Prevents out-of-order messages during reconnection and provides resilient connectivity across SSE, WebSocket, and hybrid transport modes.

## Specification

### Problem Statement
When a transport reconnects (after network blip, sleep/wake, or transport swap), there is a window where both historical (replayed) messages and live (real-time) messages arrive simultaneously. Without a gating mechanism, live messages can interleave with historical replay, causing the agent to process events out of order. Additionally, relying on a single transport protocol creates a single point of failure — the system needs prioritized failover across SSE, WebSocket, and hybrid modes.

### Functional Requirements
- FR-9E.01: `FlushGate<T>` generic class that queues live messages while historical flush completes
- FR-9E.02: Gate opens after historical message POST completes; queued live messages drain in FIFO order
- FR-9E.03: `Transport` interface with `connect()`, `write()`, `close()`, `setOnData()`, `setOnClose()`, optionally `setOnEvent()`
- FR-9E.04: Three transport implementations: `WSTransport`, `SSETransport`, `HybridTransport` (WS reads + POST writes)
- FR-9E.05: Priority-based transport selection with feature-flag control: SSE > Hybrid > WebSocket
- FR-9E.06: Reconnection budget — 10-minute window with exponential backoff (base 1s, cap 30s, jitter +/-20%)
- FR-9E.07: Sleep/wake detection — if gap between reconnection attempts exceeds 2x backoff cap (60s), reset the reconnection budget to full
- FR-9E.08: Permanent close code handling — abort reconnection on codes 1000, 1001, 4000-4099 (application-defined fatal range)
- FR-9E.09: Sequence number continuity across transport swaps via `getLastSequenceNum()` / `initialSequenceNum` — prevents full history replay on failover
- FR-9E.10: NDJSON wire format with U+2028/U+2029 escaping for safe newline-delimited splitting

### Non-Functional Requirements
- FlushGate must impose zero overhead in the passthrough state (gate already open)
- Transport failover must complete within 5 seconds of detecting primary transport failure
- Reconnection backoff must not block the event loop — use timer-based scheduling
- Memory: FlushGate queue must cap at 10,000 messages to prevent unbounded growth during prolonged flushes
- All transports must share the same wire format (NDJSON) for interchangeability

### Acceptance Criteria
- Live messages arriving during historical flush are queued and delivered after flush completes, in order
- Transport failover from SSE to Hybrid occurs automatically when SSE connection drops
- Reconnection budget exhaustion (10 minutes) triggers permanent disconnect with error event
- Sleep/wake cycle resets the budget — agent reconnects after laptop lid open
- Permanent close code (e.g., 4001) immediately stops reconnection attempts
- Sequence numbers carry across transport swap — no duplicate message delivery
- NDJSON lines containing U+2028/U+2029 are parsed correctly without line-split errors

## Pseudocode

### FlushGate Lifecycle

```text
TYPE FlushGateState = 'queuing' | 'flushing' | 'open'

CLASS FlushGate<T>:
  state: FlushGateState = 'queuing'
  queue: T[] = []
  onMessage: async (msg: T) => Promise<void>   // async handler — await each call to preserve ordering
  maxQueueSize: number = 10_000

  ASYNC FUNCTION receive(msg: T):
    IF state == 'open':
      AWAIT onMessage(msg)        // passthrough — await preserves ordering
      RETURN

    IF queue.length >= maxQueueSize:
      THROW FlushGateOverflowError('Queue exceeded 10,000 messages')

    queue.push(msg)               // buffer while flushing

  ASYNC FUNCTION flush(historicalMessages: T[]):
    state = 'flushing'
    FOR EACH msg IN historicalMessages:
      AWAIT onMessage(msg)        // deliver historical in order, await preserves ordering

    // Now drain queued live messages
    state = 'open'
    WHILE queue.length > 0:
      AWAIT onMessage(queue.shift())  // deliver buffered live messages, await each

  FUNCTION reset():
    state = 'queuing'
    queue = []
```

### Transport Interface and Reconnection

```text
INTERFACE Transport:
  connect(url: string, options?: TransportOptions): Promise<void>
  write(data: Uint8Array | string): Promise<void>
  close(): void
  setOnData(handler: (data: Uint8Array) => void): void
  setOnClose(handler: (code: number, reason: string) => void): void
  setOnEvent?(handler: (event: string, data: string) => void): void

TYPE ReconnectionState = {
  budgetMs: number              // 600_000 (10 minutes)
  budgetStartTime: number
  currentBackoffMs: number      // starts at 1_000
  lastAttemptTime: number
}

CONSTANT BACKOFF_BASE = 1_000
CONSTANT BACKOFF_CAP = 30_000
CONSTANT BUDGET_MS = 600_000
CONSTANT PERMANENT_CLOSE_CODES = [1000, 1001, ...range(4000, 4100)]

FUNCTION shouldReconnect(state: ReconnectionState, closeCode: number): boolean:
  IF closeCode IN PERMANENT_CLOSE_CODES:
    RETURN false                 // fatal — no retry

  elapsed = now() - state.budgetStartTime
  IF elapsed >= BUDGET_MS:
    RETURN false                 // budget exhausted

  // Sleep/wake detection
  gap = now() - state.lastAttemptTime
  IF gap > 2 * BACKOFF_CAP:
    state.budgetStartTime = now()   // reset budget
    state.currentBackoffMs = BACKOFF_BASE

  RETURN true

FUNCTION nextBackoff(state: ReconnectionState): number:
  jitter = state.currentBackoffMs * 0.2 * (random() * 2 - 1)
  delay = state.currentBackoffMs + jitter
  state.currentBackoffMs = min(state.currentBackoffMs * 2, BACKOFF_CAP)
  state.lastAttemptTime = now()
  RETURN delay
```

### Transport Selection

```text
TYPE TransportPriority = { type: TransportType, enabled: boolean }

FUNCTION getTransportForUrl(
  sessionUrl: string,
  flags: FeatureFlags
): Transport:
  priorities: TransportPriority[] = [
    { type: 'sse',    enabled: flags.sseTransport ?? true },
    { type: 'hybrid', enabled: flags.hybridTransport ?? true },
    { type: 'ws',     enabled: flags.wsTransport ?? true },
  ]

  selected = priorities.find(p => p.enabled)
  IF NOT selected:
    THROW Error('No transport enabled')

  SWITCH selected.type:
    CASE 'sse':
      streamUrl = sessionUrl + '/worker/events/stream'
      RETURN new SSETransport(streamUrl)
    CASE 'hybrid':
      wsUrl = sessionUrl.replace('https:', 'wss:')
      RETURN new HybridTransport(wsUrl, sessionUrl)
    CASE 'ws':
      wsUrl = sessionUrl.replace('https:', 'wss:')
      RETURN new WSTransport(wsUrl)
```

### Sequence Tracking

```text
CLASS SequenceTracker:
  lastSeq: number = -1

  FUNCTION advance(seq: number): boolean:
    IF seq <= lastSeq:
      RETURN false               // duplicate — skip
    lastSeq = seq
    RETURN true                  // new message — process

  FUNCTION getLastSequenceNum(): number:
    RETURN lastSeq

FUNCTION connectWithContinuity(transport, tracker, flushGate):
  transport.connect({
    initialSequenceNum: tracker.getLastSequenceNum()
  })

  transport.setOnData((raw) =>
    msg = parseNDJSON(raw)
    IF tracker.advance(msg.seq):
      flushGate.receive(msg)
  )
```

### NDJSON Encoding

```text
FUNCTION escapeNDJSON(text: string): string:
  RETURN text
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

FUNCTION parseNDJSON(line: string): object:
  RETURN JSON.parse(line)        // safe after escaping on write side
```

### Complexity Analysis
- FlushGate.receive: O(1) in open state, O(1) amortized when queuing
- FlushGate.flush: O(H + Q) where H = historical count, Q = queued count
- Transport selection: O(P) where P = number of transport types (constant = 3)
- Sequence tracking: O(1) per message
- Reconnection decision: O(1)

## Architecture

### Primary Components
- `src/transport/flush-gate.ts` (NEW) — Generic FlushGate<T> implementation
- `src/transport/transport.ts` (NEW) — Transport interface and shared types
- `src/transport/ws-transport.ts` (NEW) — WebSocket read + write transport
- `src/transport/sse-transport.ts` (NEW) — SSE read + POST write transport
- `src/transport/hybrid-transport.ts` (NEW) — WebSocket read + POST write transport
- `src/transport/reconnection.ts` (NEW) — Reconnection budget, backoff, sleep/wake detection
- `src/transport/sequence-tracker.ts` (NEW) — Cross-transport sequence continuity
- `src/transport/ndjson.ts` (NEW) — NDJSON encode/decode with Unicode escaping

### Transport Hierarchy
```
                    Transport (interface)
                    ├── connect()
                    ├── write()
                    ├── close()
                    ├── setOnData()
                    └── setOnClose()
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    SSETransport    HybridTransport  WSTransport
    (SSE + POST)    (WS + POST)     (WS + WS)
    [priority: 1]   [priority: 2]   [priority: 3]
```

### FlushGate State Machine
```
             ┌─────────┐
             │ queuing  │ ◄── initial state
             └────┬─────┘
                  │ flush(historical) called
                  ▼
             ┌──────────┐
             │ flushing  │ ── delivers historical messages
             └────┬──────┘
                  │ historical delivery complete
                  ▼
             ┌──────────┐
             │   open    │ ── drains queue, then passthrough
             └────┬──────┘
                  │ reset() on reconnect
                  ▼
             ┌──────────┐
             │ queuing   │ ── cycle repeats
             └──────────┘
```

### Integration Points
- **SerialBatchUploader (Phase 9C)**: Writes outbound messages through `transport.write()`
- **AgentRunner (Phase 9A)**: Receives inbound messages via FlushGate
- **SwarmDaemon (Phase 9B)**: Monitors transport health, triggers failover

### Data Flow
```
Agent reconnects after sleep/wake
  │
  ▼
ReconnectionManager detects gap > 60s → resets budget
  │
  ▼
getTransportForUrl() → SSETransport (primary)
  │ fails → HybridTransport (fallback)
  │
  ▼
connect({ initialSequenceNum: 4827 })
  │
  ▼
Server sends historical messages from seq 4828
  │
  ├─ FlushGate state: 'flushing'
  │  ├─ historical msgs delivered in order
  │  └─ live msgs arriving → queued
  │
  ▼
Historical flush completes → gate opens
  │
  ├─ Queued live msgs drain in FIFO order
  └─ All subsequent msgs pass through directly
```

### URL Derivation
```
Session URL:  https://agent.linear.app/sessions/abc123
SSE stream:   https://agent.linear.app/sessions/abc123/worker/events/stream
WebSocket:    wss://agent.linear.app/sessions/abc123
POST writes:  POST https://agent.linear.app/sessions/abc123/worker/events
```

### Design Decisions
- **SSE as primary** — SSE has better proxy/CDN compatibility than raw WebSocket; POST writes are reliable through HTTP infrastructure
- **FlushGate is generic** — `FlushGate<T>` works with any message type, not coupled to transport layer
- **Sequence numbers over timestamps** — monotonic integers are simpler, deterministic, and avoid clock skew issues
- **10-minute budget** — matches observed Claude Code CLI behavior; long enough for transient outages, short enough to surface permanent failures
- **Sleep/wake resets budget** — a laptop closing is not a network failure; the agent should reconnect fresh after waking

## Refinement

### File Targets
- `src/transport/flush-gate.ts` (NEW)
- `src/transport/transport.ts` (NEW)
- `src/transport/ws-transport.ts` (NEW)
- `src/transport/sse-transport.ts` (NEW)
- `src/transport/hybrid-transport.ts` (NEW)
- `src/transport/reconnection.ts` (NEW)
- `src/transport/sequence-tracker.ts` (NEW)
- `src/transport/ndjson.ts` (NEW)

### Exact Tests

#### `tests/transport/flush-gate.test.ts` (NEW)
- Gate in queuing state buffers messages and does not deliver them
- `flush()` delivers historical messages in order, then drains queue in FIFO order
- Gate in open state passes messages through immediately (zero-copy path)
- Queue overflow at 10,000 messages throws `FlushGateOverflowError`
- `reset()` returns gate to queuing state and clears the queue
- Concurrent `receive()` calls during `flush()` are safely queued
- Empty historical array followed by `flush()` immediately opens the gate

#### `tests/transport/reconnection.test.ts` (NEW)
- Exponential backoff doubles from 1s to 30s cap
- Jitter stays within +/-20% of current backoff
- Budget exhaustion after 10 minutes returns `shouldReconnect = false`
- Permanent close code (4001) returns `shouldReconnect = false` immediately
- Sleep/wake gap > 60s resets budget to full 10 minutes
- Normal gap (< 60s) does not reset budget
- Close code 1006 (abnormal) is treated as retriable

#### `tests/transport/transport-failover.test.ts` (NEW)
- SSE transport selected when SSE feature flag enabled
- Hybrid transport selected when SSE disabled
- WS transport selected when SSE and Hybrid disabled
- All transports disabled throws configuration error
- Failover from SSE to Hybrid on connection failure
- Failover preserves sequence number via SequenceTracker

#### `tests/transport/sequence-tracker.test.ts` (NEW)
- Sequential messages (seq 1, 2, 3) all return `advance = true`
- Duplicate message (seq 2 after seq 2) returns `advance = false`
- Out-of-order message (seq 1 after seq 3) returns `advance = false`
- `getLastSequenceNum()` returns -1 before any messages
- `getLastSequenceNum()` returns highest seen sequence number

#### `tests/transport/ndjson.test.ts` (NEW)
- U+2028 (line separator) is escaped in output
- U+2029 (paragraph separator) is escaped in output
- Standard JSON with no special chars passes through unchanged
- Multi-line NDJSON stream splits correctly on newlines

### Performance Targets
- FlushGate passthrough: < 1 microsecond per message (no allocation)
- Transport failover: < 5 seconds from detection to reconnected
- Reconnection decision: < 100 microseconds (pure arithmetic)
- NDJSON parse: < 50 microseconds per message (standard JSON.parse)

### Edge Cases
- Gate timeout: flush never completes (server sends incomplete history) — implement a 30-second flush timeout that opens the gate with a warning
- Transport swap mid-message: partial NDJSON line on old transport — discard partial, new transport starts from `initialSequenceNum`
- Sleep/wake boundary: system sleeps exactly at 2x backoff cap — use `>=` comparison, not `>`
- Rapid reconnection: multiple failovers in quick succession — debounce transport creation to 1 per second
- Server sends seq 0 after reconnect despite `initialSequenceNum: 4827` — SequenceTracker filters duplicates silently

### Risks
- SSE connections may be terminated by corporate proxies after 60 seconds of inactivity — implement SSE keepalive pings
- WebSocket compression (permessage-deflate) can interfere with NDJSON framing in some runtimes — disable compression by default
- FlushGate queue memory: 10,000 queued messages at 1KB each = 10MB — acceptable, but log a warning at 5,000
- Node.js EventSource polyfill behavior varies — test with `eventsource` npm package specifically
