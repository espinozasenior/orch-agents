# Phase 9C: Serial Batch Event System

## Goal
Implement a serial batch event system with backpressure to prevent agent flooding and enable graceful degradation under load. Replaces individual event firing with batched, rate-controlled uploads that guarantee at most one POST in-flight at any time.

## Specification

### Problem Statement
The current event system fires individual HTTP requests per event. Under sustained agent activity (text deltas, tool calls, status updates), this creates request storms that overwhelm both the client and the upstream API. Claude Code CLI solves this with a `SerialBatchEventUploader` that batches events, enforces serial execution, applies backpressure when the queue fills, and gracefully drops batches after repeated failures. The orch-agents system needs the same pattern for Linear activity events, internal telemetry, and worker state synchronization.

### Functional Requirements
- FR-9C.01: `SerialBatchUploader<T>` generic class with configurable `maxBatchSize`, `maxBatchBytes`, `maxQueueSize`
- FR-9C.02: Serial execution guarantee — at most 1 upload call in-flight at any time via a `draining` guard
- FR-9C.03: Backpressure via async blocking — `enqueue()` returns a Promise that blocks when `pending.length + items.length > maxQueueSize`
- FR-9C.04: Exponential backoff with jitter on upload failure — delay = `min(baseDelayMs * 2^attempt + random(0, jitter), maxDelayMs)`
- FR-9C.05: Server-supplied retry-after support — `RetryableError` carries `retryAfterMs` from HTTP 429 `Retry-After` header, clamped to `[baseDelayMs, maxDelayMs]`
- FR-9C.06: Drop policy — after `maxConsecutiveFailures` failures, batch is dropped and `onBatchDropped(batch, error)` callback fires
- FR-9C.07: Poison resistance — items that throw on `JSON.stringify()` (BigInt, circular refs, throwing `toJSON`) are silently excluded from `takeBatch()`
- FR-9C.08: `flush()` returns a Promise that resolves when the pending queue is fully drained
- FR-9C.09: `close()` drops all pending items, resolves all blocked `enqueue()` callers, and prevents future enqueues
- FR-9C.10: `CoalescingUploader<T>` variant — holds at most 1 pending item, merges incoming state via RFC 7396 JSON Merge Patch semantics
- FR-9C.11: Text delta accumulator — accumulates `text_delta` events into full-so-far snapshots, flushed on a configurable interval (default 100ms)

### Non-Functional Requirements
- Batch formation must be O(n) where n is items taken
- Backpressure must not busy-wait — blocked callers yield via Promise
- Poison detection must never crash the drain loop
- Memory usage must be bounded by `maxQueueSize * avgItemSize`
- The uploader must be safe for concurrent `enqueue()` calls from multiple async contexts

### Acceptance Criteria
- Enqueue 200 items with `maxQueueSize=100` — first 100 proceed, callers 101-200 block until drain frees space
- Upload function called with batches never exceeding `maxBatchSize` items or `maxBatchBytes` bytes
- Only 1 upload in-flight at any time regardless of enqueue rate
- After 3 consecutive failures (with `maxConsecutiveFailures=3`), batch is dropped and callback fires
- Item with `BigInt` field is silently excluded from batch; remaining items still upload
- `flush()` resolves only after all pending items have been uploaded
- `close()` resolves all blocked callers immediately with no upload
- `CoalescingUploader` with 5 rapid state updates results in 1 upload with merged state
- Text delta accumulator flushes full snapshot every 100ms under continuous deltas

## Pseudocode

```text
CLASS SerialBatchUploader<T>:
  pending: T[] = []
  draining: boolean = false
  closed: boolean = false
  consecutiveFailures: number = 0
  backpressureWaiters: { resolve, reject }[] = []
  flushWaiters: { resolve }[] = []

  CONSTRUCTOR(config):
    this.uploadFn = config.uploadFn
    this.maxBatchSize = config.maxBatchSize        // e.g. 100
    this.maxBatchBytes = config.maxBatchBytes      // e.g. 100_000
    this.maxQueueSize = config.maxQueueSize        // e.g. 500
    this.maxConsecutiveFailures = config.maxConsecutiveFailures  // e.g. 5
    this.baseDelayMs = config.baseDelayMs          // e.g. 100
    this.maxDelayMs = config.maxDelayMs            // e.g. 30_000
    this.onBatchDropped = config.onBatchDropped    // optional callback

  ASYNC FUNCTION enqueue(items: T[]):
    IF this.closed:
      RETURN

    // Backpressure: block if queue would overflow
    WHILE this.pending.length + items.length > this.maxQueueSize:
      IF this.closed:
        RETURN
      AWAIT new Promise((resolve, reject) =>
        this.backpressureWaiters.push({ resolve, reject })
      )

    this.pending.push(...items)
    this.scheduleDrain()

  FUNCTION scheduleDrain():
    IF this.draining OR this.closed:
      RETURN
    this.draining = true
    queueMicrotask(() => this.drain())

  ASYNC FUNCTION drain():
    WHILE this.pending.length > 0 AND NOT this.closed:
      batch = this.takeBatch()
      IF batch.length == 0:
        BREAK

      TRY:
        AWAIT this.uploadFn(batch)
        this.consecutiveFailures = 0
        this.releaseBackpressure()
      CATCH error:
        this.consecutiveFailures++

        IF this.consecutiveFailures >= this.maxConsecutiveFailures:
          this.onBatchDropped?.(batch, error)
          this.consecutiveFailures = 0
          this.releaseBackpressure()
          CONTINUE

        delay = this.calculateDelay(error)
        AWAIT sleep(delay)

    this.draining = false
    // Resolve flush waiters when queue is empty
    IF this.pending.length == 0:
      FOR EACH waiter IN this.flushWaiters.splice(0):
        waiter.resolve()

  FUNCTION takeBatch(): T[]:
    batch = []
    batchBytes = 0
    remaining = []

    FOR EACH item IN this.pending:
      TRY:
        serialized = JSON.stringify(item)
      CATCH:
        CONTINUE  // Poison resistance: silently drop

      itemBytes = byteLength(serialized)

      IF batch.length == 0:
        // First item always goes in regardless of size
        batch.push(item)
        batchBytes = itemBytes
      ELSE IF batch.length < this.maxBatchSize
           AND batchBytes + itemBytes <= this.maxBatchBytes:
        batch.push(item)
        batchBytes += itemBytes
      ELSE:
        remaining.push(item)

    this.pending = remaining
    RETURN batch

  FUNCTION calculateDelay(error): number:
    IF error instanceof RetryableError AND error.retryAfterMs:
      RETURN clamp(error.retryAfterMs, this.baseDelayMs, this.maxDelayMs)

    base = this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1)
    jitter = Math.random() * base * 0.1
    RETURN Math.min(base + jitter, this.maxDelayMs)

  FUNCTION releaseBackpressure():
    WHILE this.backpressureWaiters.length > 0
      AND this.pending.length < this.maxQueueSize:
      waiter = this.backpressureWaiters.shift()
      waiter.resolve()

  ASYNC FUNCTION flush(): Promise<void>:
    IF this.pending.length == 0 AND NOT this.draining:
      RETURN
    RETURN new Promise(resolve => this.flushWaiters.push({ resolve }))

  FUNCTION close():
    this.closed = true
    this.pending = []
    FOR EACH waiter IN this.backpressureWaiters.splice(0):
      waiter.resolve()
    FOR EACH waiter IN this.flushWaiters.splice(0):
      waiter.resolve()


CLASS RetryableError EXTENDS Error:
  retryAfterMs?: number


CLASS CoalescingUploader<T>:
  // Holds at most 1 pending state, merges via JSON Merge Patch (RFC 7396)
  pending: T | null = null
  uploader: SerialBatchUploader<T>

  CONSTRUCTOR(config):
    this.uploader = new SerialBatchUploader({
      ...config,
      maxBatchSize: 1,
      maxQueueSize: 1,
    })

  FUNCTION update(partial: Partial<T>):
    IF this.pending == null:
      this.pending = partial AS T
    ELSE:
      this.pending = jsonMergePatch(this.pending, partial)
    this.uploader.enqueue([this.pending])
    this.pending = null


CLASS TextDeltaAccumulator:
  buffer: string = ""
  timer: Timer | null = null
  flushIntervalMs: number         // default 100

  FUNCTION accumulate(delta: string):
    this.buffer += delta
    IF this.timer == null:
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs)

  FUNCTION flush():
    IF this.buffer.length > 0:
      snapshot = this.buffer
      this.emit('snapshot', snapshot)
    this.timer = null
```

### Complexity Analysis
- `enqueue()`: O(1) amortized, O(n) worst case when backpressure blocks
- `takeBatch()`: O(n) where n = pending queue length
- `drain()`: O(n/batchSize) iterations to empty the queue
- `releaseBackpressure()`: O(w) where w = number of blocked waiters
- Space: O(maxQueueSize) bounded by configuration

## Architecture

### Primary Components
- `src/events/serial-batch-uploader.ts` (NEW) — Generic `SerialBatchUploader<T>` and `RetryableError`
- `src/events/coalescing-uploader.ts` (NEW) — `CoalescingUploader<T>` with merge-patch semantics
- `src/events/text-delta-accumulator.ts` (NEW) — Delta-to-snapshot accumulator
- `src/events/uploader-factory.ts` (NEW) — Factory creating the 4 uploader instances
- `src/execution/orchestrator/symphony-orchestrator.ts` — Integrate uploaders into event flow
- `src/integration/linear/linear-client.ts` — Replace direct HTTP calls with uploader.enqueue()

### Uploader Instances
```
Instance              | maxBatchSize | maxQueueSize | Purpose
─────────────────────────────────────────────────────────────
eventUploader         | 100          | 100_000      | User-facing agent events
internalEventUploader | 100          | 200          | Telemetry / diagnostics
deliveryUploader      | 64           | 64           | Webhook delivery receipts
workerStateUploader   | 1 (coalesce) | 1            | Worker state sync (merge-patch)
```

### Data Flow
```
Agent event produced (text_delta, tool_call, status_change)
  │
  ▼
TextDeltaAccumulator (if text_delta)
  ├─ Accumulates deltas into buffer
  ├─ Flushes snapshot every 100ms
  │
  ▼
eventUploader.enqueue([event])
  ├─ Queue < maxQueueSize? → append, schedule drain
  ├─ Queue full? → caller blocks (backpressure)
  │
  ▼
drain() loop (serial — 1 upload at a time)
  ├─ takeBatch() → respects size + byte limits
  ├─ Poison items silently excluded
  ├─ uploadFn(batch) → HTTP POST
  │   ├─ Success → reset failures, releaseBackpressure()
  │   ├─ 429 → RetryableError with retryAfterMs
  │   ├─ 5xx → exponential backoff + jitter
  │   └─ N consecutive failures → drop batch, notify callback
  │
  ▼
releaseBackpressure()
  └─ Unblock waiting enqueue() callers
```

### Integration with Phase 9B
`SessionRunner` status events (`idle`, `working`, `requires_action`) flow through the `workerStateUploader` instance — a `CoalescingUploader` that merges rapid state transitions via JSON Merge Patch before uploading. When `SessionRunner.handleChildMessage()` updates state (e.g., `idle` -> `working`), it calls `workerStateUploader.update({ sessionId, state, timestamp })`. This ensures the daemon reports the latest worker state without flooding the upstream with per-transition POSTs.

### Design Decisions
- **Serial, not parallel** — parallel uploads create ordering issues and amplify load during degradation. Serial guarantees deterministic ordering and simple failure reasoning
- **First item always fits** — prevents deadlock when a single item exceeds `maxBatchBytes`. Without this rule, an oversized item would block the queue forever
- **Poison resistance via try/catch** — `JSON.stringify` can throw on BigInt, circular refs, or broken `toJSON()`. Silently dropping these items prevents one bad event from blocking the entire queue
- **Backpressure via Promise, not dropping** — important events should not be silently lost. Callers slow down naturally rather than losing data
- **Coalescing for state** — worker state changes rapidly (progress %, current file). Sending every intermediate state wastes bandwidth. Merge-patch keeps only the latest view

## Refinement

### File Targets
- `src/events/serial-batch-uploader.ts` (NEW)
- `src/events/coalescing-uploader.ts` (NEW)
- `src/events/text-delta-accumulator.ts` (NEW)
- `src/events/uploader-factory.ts` (NEW)
- `src/execution/orchestrator/symphony-orchestrator.ts`
- `src/integration/linear/linear-client.ts`

### Exact Tests
- `tests/events/serial-batch-uploader.test.ts` (NEW)
  - Batch respects `maxBatchSize` — enqueue 50 items with maxBatchSize=10, upload called 5 times with 10 items each
  - Batch respects `maxBatchBytes` — items cut off when cumulative JSON byte length exceeds limit
  - First item always included regardless of byte size
  - Serial guarantee — second upload does not start until first completes (verify with timestamps)
  - Backpressure blocks — enqueue beyond `maxQueueSize` blocks caller until drain frees space
  - Backpressure release — blocked caller resumes after successful upload
  - Exponential backoff — failure delays increase: baseDelay, baseDelay*2, baseDelay*4
  - Jitter — retry delays are not identical across runs (statistical check)
  - RetryableError with `retryAfterMs` — delay matches server-supplied value clamped to [base, max]
  - HTTP 429 retry-after clamped to maxDelayMs when server requests excessive delay
  - Drop policy — after `maxConsecutiveFailures`, batch dropped and `onBatchDropped` fires with batch + error
  - Consecutive failure counter resets after successful upload
  - Poison resistance — item with BigInt silently excluded, remaining items upload
  - Poison resistance — item with circular reference excluded
  - Poison resistance — item with throwing `toJSON()` excluded
  - All items poisoned — empty batch, no upload call, drain continues
  - `flush()` resolves only after all pending items uploaded
  - `flush()` on empty queue resolves immediately
  - `close()` drops pending items and resolves blocked callers
  - `close()` prevents future enqueue calls (no-op)
  - Concurrent enqueue from multiple async contexts — all items eventually uploaded
- `tests/events/coalescing-uploader.test.ts` (NEW)
  - Rapid state updates merged — 5 updates result in 1 upload with merged fields
  - RFC 7396 semantics — `null` values delete keys
  - Only latest state uploaded when updates arrive faster than drain
- `tests/events/text-delta-accumulator.test.ts` (NEW)
  - Deltas accumulated into buffer
  - Snapshot emitted after flush interval
  - Rapid deltas within interval produce single snapshot with full text
  - `flush()` emits immediately and clears buffer

### Performance Targets
- Sustained throughput: 1000 events/sec with `maxBatchSize=100` at <50ms p99 enqueue latency
- Backpressure activation: <1ms to block caller when queue full
- Drain loop overhead: <0.5ms per batch formation (excluding upload I/O)
- Memory: bounded at `maxQueueSize * 1KB` typical (configurable)

### Mock Boundaries
- **HTTP client (fetch)**: Mock the `uploadFn` callback to verify batching, retry, and drop behavior without real network I/O
- **Timers**: Mock `setTimeout`/`clearTimeout` for deterministic backoff and flush-interval testing
- **JSON.stringify**: No mock needed — poison tests use real BigInt/circular objects

### Risks
- Backpressure can propagate upstream — if all uploaders are at capacity, agent execution slows. This is intentional (graceful degradation) but must be documented so callers expect it
- `close()` during active drain must not race with `uploadFn` — the drain loop must check `this.closed` after each upload returns
- Text delta accumulator timer must be cleared on `close()` to prevent leaking timers
- Poison detection relies on `JSON.stringify` — items that serialize successfully but produce invalid JSON for the server (e.g., deeply nested objects rejected by size limits) will still cause upload failures handled by retry/drop
