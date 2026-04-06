# Phase 9D: Capacity-Aware Wake with AbortSignal Merging

## Goal
Implement capacity-aware wake using AbortSignal merging so the swarm coordinator wakes instantly when any agent slot becomes available, eliminating polling overhead for capacity management. Replaces fixed-interval polling with a two-tier system that sleeps efficiently when at capacity and wakes immediately on session completion.

## Specification

### Problem Statement
The current orchestrator polls for work on a fixed interval regardless of available capacity. When all agent slots are occupied, it wastes CPU cycles and API calls polling for work it cannot act on. Claude Code CLI solves this with a `CapacityWake` pattern: the daemon sleeps for a long interval (10 minutes) when at capacity, but wakes instantly via a merged `AbortSignal` the moment any session completes. This eliminates unnecessary polling while maintaining responsiveness. The orch-agents system needs this for the `SwarmDaemon` introduced in Phase 9B to manage agent slot lifecycle efficiently.

### Functional Requirements
- FR-9D.01: `CapacityWake` class with `AbortSignal`-based wake mechanism — `waitForCapacity()` returns a Promise that resolves when a slot is available
- FR-9D.02: Two-tier polling intervals — `seekingIntervalMs` (default 2000ms) when slots are available, `atCapacityIntervalMs` (default 600_000ms / 10 min) when all slots are occupied
- FR-9D.03: Instant wake via merged `AbortSignal` when ANY session completes — `AbortSignal.any([capacitySignal, timerSignal])` unblocks the at-capacity sleep
- FR-9D.04: `PollConfig` schema validated by Zod with type-safe defaults and safety invariants
- FR-9D.05: Minimum interval enforcement — both `seekingIntervalMs` and `atCapacityIntervalMs` must be >= 100ms to prevent self-DoS
- FR-9D.06: Required liveness mechanism — `PollConfig` must specify either `heartbeatIntervalMs` or `keepaliveIntervalMs` (at least one required)
- FR-9D.07: Sleep/wake detection — if elapsed time since last tick exceeds `2 * atCapacityIntervalMs`, the reconnection budget resets (device woke from OS-level sleep)
- FR-9D.08: Capacity metrics — expose `slots_total`, `slots_used`, `slots_available`, `wake_count`, `polls_skipped` counters
- FR-9D.09: Hot-reload of `PollConfig` without daemon restart — configuration changes apply on the next tick
- FR-9D.10: Integration with `SwarmDaemon` from Phase 9B — `CapacityWake` is owned by the daemon and drives its poll loop

### Non-Functional Requirements
- Wake latency from session completion to poll resumption must be < 5ms
- At-capacity state must use zero CPU (blocked on AbortSignal, no busy-wait)
- PollConfig validation must fail fast at startup with clear error messages
- Metrics must be lock-free and safe for concurrent reads from health endpoints
- Hot-reload must not interrupt an in-progress poll cycle

### Acceptance Criteria
- Daemon at full capacity (3/3 slots) sleeps for 10 minutes
- Session completes, fires abort signal — daemon wakes within 5ms and polls
- `PollConfig` with `seekingIntervalMs: 50` rejected at validation (below 100ms floor)
- `PollConfig` with neither `heartbeatIntervalMs` nor `keepaliveIntervalMs` rejected
- Config updated via hot-reload — next poll uses new intervals without restart
- Device sleeps for 30 minutes, wakes — daemon detects gap > 2x cap and resets budget
- Metrics endpoint returns accurate `slots_available` and `wake_count`

## Pseudocode

```text
TYPE PollConfig = {
  seekingIntervalMs: number      // default 2000, min 100
  atCapacityIntervalMs: number   // default 600_000, min 100
  heartbeatIntervalMs?: number   // at least one of heartbeat/keepalive required
  keepaliveIntervalMs?: number
  maxSlotsTotal: number          // e.g. 3
}

CONST PollConfigSchema = z.object({
  seekingIntervalMs: z.number().min(100).default(2000),
  atCapacityIntervalMs: z.number().min(100).default(600_000),
  heartbeatIntervalMs: z.number().min(100).optional(),
  keepaliveIntervalMs: z.number().min(100).optional(),
  maxSlotsTotal: z.number().min(1).default(3),
}).refine(
  data => data.heartbeatIntervalMs != null OR data.keepaliveIntervalMs != null,
  "At least one liveness mechanism (heartbeat or keepalive) is required"
)


CLASS CapacityWake:
  config: PollConfig
  slotsUsed: number = 0
  wakeController: AbortController | null = null
  metrics: CapacityMetrics
  lastTickTime: number = Date.now()
  closed: boolean = false

  CONSTRUCTOR(config: PollConfig):
    this.config = PollConfigSchema.parse(config)
    this.metrics = { slots_total: config.maxSlotsTotal,
                     slots_used: 0, slots_available: config.maxSlotsTotal,
                     wake_count: 0, polls_skipped: 0 }

  FUNCTION isAtCapacity(): boolean:
    RETURN this.slotsUsed >= this.config.maxSlotsTotal

  FUNCTION acquireSlot(): boolean:
    IF this.isAtCapacity():
      RETURN false
    this.slotsUsed++
    this.updateMetrics()
    EMIT 'capacity:slot_changed' { slotsUsed: this.slotsUsed, slotsTotal: this.config.maxSlotsTotal, action: 'acquired', timestamp: Date.now() }
    RETURN true

  FUNCTION releaseSlot():
    this.slotsUsed = Math.max(0, this.slotsUsed - 1)
    this.updateMetrics()
    EMIT 'capacity:slot_changed' { slotsUsed: this.slotsUsed, slotsTotal: this.config.maxSlotsTotal, action: 'released', timestamp: Date.now() }
    // Wake the capacity waiter instantly
    IF this.wakeController:
      this.wakeController.abort()
      this.wakeController = null
      this.metrics.wake_count++

  ASYNC FUNCTION waitForCapacity(): Promise<void>:
    IF NOT this.isAtCapacity():
      RETURN  // Slot available, no wait needed

    // Create abort controller for instant wake
    this.wakeController = new AbortController()

    // Create timer-based abort for the long sleep
    timerController = new AbortController()
    timer = setTimeout(
      () => timerController.abort(),
      this.config.atCapacityIntervalMs
    )

    // Merge signals: wake on EITHER session complete OR timer expiry
    mergedSignal = AbortSignal.any([
      this.wakeController.signal,
      timerController.signal,
    ])

    TRY:
      AWAIT abortableWait(mergedSignal)
    FINALLY:
      clearTimeout(timer)
      this.metrics.polls_skipped++

  ASYNC FUNCTION pollLoop(pollFn: () => Promise<void>):
    WHILE NOT this.closed:
      now = Date.now()
      elapsed = now - this.lastTickTime

      // Sleep/wake detection
      IF elapsed > 2 * this.config.atCapacityIntervalMs:
        this.resetReconnectionBudget()

      this.lastTickTime = now

      IF this.isAtCapacity():
        AWAIT this.waitForCapacity()
        CONTINUE  // Re-check capacity after wake

      TRY:
        AWAIT pollFn()
      CATCH error:
        log.error("Poll failed", error)

      AWAIT sleep(this.config.seekingIntervalMs)

  FUNCTION resetReconnectionBudget():
    log.warn("Sleep/wake detected — resetting reconnection budget")
    // Reset any exponential backoff state on upstream connections
    // Re-establish heartbeat/keepalive
    this.lastTickTime = Date.now()

  FUNCTION updateConfig(newConfig: Partial<PollConfig>):
    merged = { ...this.config, ...newConfig }
    this.config = PollConfigSchema.parse(merged)
    // Takes effect on next tick — does not interrupt current sleep
    // If at capacity and new atCapacityIntervalMs is shorter, wake immediately
    IF this.wakeController AND newConfig.atCapacityIntervalMs:
      this.wakeController.abort()
      this.wakeController = null

  FUNCTION updateMetrics():
    this.metrics.slots_used = this.slotsUsed
    this.metrics.slots_available = this.config.maxSlotsTotal - this.slotsUsed

  FUNCTION close():
    this.closed = true
    IF this.wakeController:
      this.wakeController.abort()
      this.wakeController = null


// Helper: wait on an AbortSignal (resolves when aborted)
FUNCTION abortableWait(signal: AbortSignal): Promise<void>:
  IF signal.aborted:
    RETURN Promise.resolve()
  RETURN new Promise(resolve =>
    signal.addEventListener('abort', resolve, { once: true })
  )
```

### Complexity Analysis
- `waitForCapacity()`: O(1) — creates 2 controllers, merges signals, awaits
- `releaseSlot()`: O(1) — decrement counter, abort signal
- `pollLoop()` per iteration: O(1) + cost of `pollFn`
- `updateConfig()`: O(1) — Zod parse is constant for fixed schema
- Space: O(1) — no queues, just counters and controller references
- Wake latency: O(1) — `AbortController.abort()` is synchronous, listener fires on microtask

## Architecture

### Primary Components
- `src/execution/daemon/capacity-wake.ts` (NEW) — `CapacityWake` class with AbortSignal merging
- `src/execution/daemon/poll-config.ts` (NEW) — `PollConfig` Zod schema and validation
- `src/execution/daemon/swarm-daemon.ts` — Integrate `CapacityWake` into daemon poll loop (Phase 9B)
- `src/execution/orchestrator/symphony-orchestrator.ts` — Call `releaseSlot()` on session completion
- `src/api/routes/health.ts` — Expose capacity metrics endpoint

### AbortSignal Merge Pattern
```
Session 1 completes
  │
  ▼
releaseSlot() → wakeController.abort()
  │
  ▼
AbortSignal.any([wakeSignal, timerSignal])
  │ ← fires immediately (wakeSignal aborted)
  ▼
waitForCapacity() resolves
  │
  ▼
pollLoop continues → pollFn() → picks up new work
```

### State Transitions
```
                    ┌──────────────────────┐
                    │                      │
                    ▼                      │
    ┌──────────────────────┐     slot released
    │  SEEKING             │     (instant wake)
    │  poll every 2s       │               │
    │  slots_available > 0 │               │
    └──────────┬───────────┘               │
               │                           │
          all slots                        │
          acquired                         │
               │                           │
               ▼                           │
    ┌──────────────────────┐               │
    │  AT CAPACITY         │───────────────┘
    │  sleep 10 min        │
    │  slots_available = 0 │
    │  wake on signal      │
    └──────────────────────┘
```

### Integration with SwarmDaemon (Phase 9B)
```
SwarmDaemon
  ├── capacityWake: CapacityWake
  ├── start():
  │     capacityWake.pollLoop(async () => {
  │       work = await this.fetchWork()
  │       if (work && capacityWake.acquireSlot()):
  │         this.spawnWorker(work)
  │     })
  │
  ├── onSessionComplete(sessionId):
  │     // ... cleanup ...
  │     capacityWake.releaseSlot()  // ← instant wake
  │
  └── onConfigUpdate(newConfig):
        capacityWake.updateConfig(newConfig)  // ← hot-reload
```

### Design Decisions
- **AbortSignal.any over EventEmitter** — AbortSignal is the standard primitive for cancellation in Node.js. It composes naturally with `fetch`, timers, and other async operations. EventEmitter would require custom wiring
- **Two-tier, not adaptive backoff** — the polling behavior has exactly two meaningful states: "has capacity" and "at capacity". Adaptive backoff adds complexity without benefit since the wake signal provides instant responsiveness
- **100ms minimum interval** — prevents accidental self-DoS from misconfiguration. The daemon at seeking frequency polls at 2s, which is already 30 requests/minute. Sub-100ms would be harmful
- **Liveness requirement** — without heartbeat or keepalive, a daemon at capacity for 10 minutes has no way for the upstream to know it is alive. At least one mechanism is mandatory
- **Hot-reload wakes immediately** — changing `atCapacityIntervalMs` during a long sleep should take effect promptly, not after the old timer expires. Aborting the wake controller achieves this

## Refinement

### File Targets
- `src/execution/daemon/capacity-wake.ts` (NEW)
- `src/execution/daemon/poll-config.ts` (NEW)
- `src/execution/daemon/swarm-daemon.ts` (modify — Phase 9B)
- `src/execution/orchestrator/symphony-orchestrator.ts`
- `src/api/routes/health.ts`

### Exact Tests
- `tests/execution/daemon/capacity-wake.test.ts` (NEW)
  - `waitForCapacity()` resolves immediately when slots available
  - `waitForCapacity()` blocks when at capacity
  - `releaseSlot()` wakes blocked `waitForCapacity()` within 5ms
  - Wake latency measured via `performance.now()` — assert < 5ms
  - Multiple slots released simultaneously — wake fires once
  - `acquireSlot()` returns false when at capacity
  - `acquireSlot()` returns true when slots available
  - Slot count never goes negative (release without acquire)
  - Two-tier transition: seeking interval used when slots free, at-capacity interval when full
  - `close()` unblocks `waitForCapacity()` and stops poll loop
  - Concurrent `releaseSlot()` calls are safe (no double-wake crash)
- `tests/execution/daemon/poll-config.test.ts` (NEW)
  - Valid config parses with defaults applied
  - `seekingIntervalMs: 50` rejected (below 100ms floor)
  - `atCapacityIntervalMs: 99` rejected (below 100ms floor)
  - Missing both `heartbeatIntervalMs` and `keepaliveIntervalMs` rejected
  - Config with only `heartbeatIntervalMs` accepted
  - Config with only `keepaliveIntervalMs` accepted
  - Config with both liveness mechanisms accepted
  - `maxSlotsTotal: 0` rejected (min 1)
  - Defaults applied: seeking=2000, atCapacity=600000, maxSlots=3
- `tests/execution/daemon/capacity-wake-integration.test.ts` (NEW)
  - Full poll loop: daemon acquires all slots, blocks, session completes, daemon wakes and picks up work
  - Sleep/wake detection: simulate 30-minute gap, assert reconnection budget reset
  - Hot-reload: change `atCapacityIntervalMs` during at-capacity sleep, assert immediate wake
  - Hot-reload: change `seekingIntervalMs`, assert next seeking poll uses new interval
  - Metrics accuracy: after 3 acquires and 1 release on 5-slot config, assert slots_used=2, slots_available=3
  - `polls_skipped` increments each time at-capacity wait completes
  - `wake_count` increments only on signal-triggered wake (not timer expiry)

### Performance Targets
- Wake latency: < 5ms from `releaseSlot()` to `waitForCapacity()` resolution (p99)
- CPU at capacity: 0% — no timer ticks, no polling, pure signal wait
- Memory overhead: < 1KB per `CapacityWake` instance (2 AbortControllers + counters)
- Config hot-reload: < 1ms to apply and wake

### Risks
- `AbortSignal.any()` requires Node.js >= 20.3.0 — must document minimum runtime version or provide a polyfill for older environments
- If `releaseSlot()` is called after `close()`, the abort on a null controller must be guarded. The pseudocode handles this with the null check
- Hot-reload during the `pollFn()` execution must not change intervals mid-poll. The design ensures changes apply only at the next loop iteration boundary
- Timer drift on heavily loaded systems could cause the 2x gap detection to false-positive. Using `performance.now()` instead of `Date.now()` reduces this risk but does not eliminate it on systems with aggressive power management
- Rapid slot churn (acquire-release cycles faster than seeking interval) could cause excessive polling. The seeking interval acts as a natural rate limiter, but callers should be aware that sub-second slot cycling will result in back-to-back polls
