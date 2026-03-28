# SPARC Gap 10: Session Resume

## Priority: P2
## Estimated Effort: 3-5 days
## Status: Planning

---

## Problem Statement

Each pipeline invocation is fully stateless. When an agent process is interrupted (runner restart, timeout, crash, deployment), all in-flight work is lost. The system must start from scratch on the next trigger, re-running triage, planning, and all completed execution phases.

The architecture is event-sourced: all state transitions are recorded as domain events through the EventBus. However, the EventBus (`shared/event-bus.ts`) is backed by an in-memory `EventEmitter` -- events are lost on process exit. The 28+ domain event types in `shared/event-types.ts` cover the full pipeline lifecycle, and key domain objects (`WorkflowPlan`, `PhaseResult`, `ReviewVerdict`) are serializable. The foundation for replay-based state recovery exists, but there is no persistence layer.

---

## S -- Specification

### Functional Requirements

- **FR-001**: Create `src/shared/event-store.ts` with an `EventStore` interface: `append(event)`, `getByCorrelationId(id)`, `getAll()`, `checkpoint(correlationId)`.
- **FR-002**: Implement `FileEventStore` using append-only JSON Lines files. One file per correlationId at `data/events/{correlationId}.jsonl`.
- **FR-003**: Create `src/shared/session-manager.ts` with: `save(correlationId)` to checkpoint, `restore(correlationId)` to replay and resume, `list()` to enumerate sessions.
- **FR-004**: Wire `EventStore` into `EventBus` so every published event is automatically appended to the store.
- **FR-005**: Resume logic: replay events up to the last checkpoint, reconstruct pipeline state, then continue execution from the last completed phase.
- **FR-006**: Expose session management via HTTP: `POST /sessions/{id}/resume`, `GET /sessions`, `GET /sessions/{id}`.
- **FR-007**: Handle corrupted event files gracefully (skip malformed lines, log warnings).
- **FR-008**: Handle events from incompatible schema versions (version field in events, skip unknown event types).
- **FR-009**: Auto-cleanup sessions older than configurable TTL (default 24 hours).

### Non-Functional Requirements

- **NFR-001** (durability): Events must be fsynced to disk before the `append()` call returns. Crash-safe writes.
- **NFR-002** (performance): Appending a single event must complete in under 5ms. Replaying 1000 events must complete in under 500ms.
- **NFR-003** (storage): Each event is approximately 500 bytes serialized. A typical pipeline produces 30-50 events. Storage per session: ~25KB. Auto-cleanup prevents unbounded growth.
- **NFR-004** (concurrency): Only one pipeline instance should resume a given session at a time. Use file-based locking.

### Acceptance Criteria

- AC1: Publishing an event via EventBus results in a new line appended to `data/events/{correlationId}.jsonl`.
- AC2: `eventStore.getByCorrelationId(id)` returns all events in order for a given correlationId.
- AC3: After `checkpoint(correlationId)`, `restore(correlationId)` replays events up to the checkpoint and returns the reconstructed state (last completed phase, workflow plan).
- AC4: `POST /sessions/{id}/resume` resumes a previously checkpointed session, continuing from the last completed phase.
- AC5: `GET /sessions` returns a list of sessions with metadata (correlationId, eventCount, lastEventTimestamp, lastCheckpoint).
- AC6: A corrupted line in a JSONL file is skipped with a warning log; remaining events are still loaded.
- AC7: Sessions older than 24 hours are automatically cleaned up.
- AC8: Concurrent resume attempts on the same session fail with a 409 Conflict response.

### Constraints

- Must not modify existing domain event type definitions. The event store is purely additive.
- Must not require external dependencies (no SQLite, no Redis). File-based storage only.
- Must not change the EventBus interface. The store is wired as a subscriber, not a middleware.
- Must work on both macOS and Linux filesystems.
- `data/events/` directory must be created automatically on first use.

### Edge Cases

- Process crashes mid-write -- partial JSONL line is detected and skipped on replay.
- Pipeline completes normally -- session is cleaned up (or marked complete) automatically.
- Resume called on a completed session -- return 400 with message "Session already completed".
- Resume called on a session with no checkpoint -- replay all events from the beginning.
- Event file is empty (0 bytes) -- return empty event list, no error.
- Two concurrent processes try to resume the same session -- file lock prevents second process; returns 409.
- `data/events/` directory does not exist -- create it automatically.
- Disk full during append -- throw and propagate error to EventBus publish (log error, do not lose the in-memory event).
- Events from a newer schema version (unknown type) -- skip with warning, do not fail replay.

---

## P -- Pseudocode

### P1 -- EventStore Interface

```
interface EventStore:
  append(event: DomainEvent): void
  getByCorrelationId(id: string): DomainEvent[]
  getAll(): Map<string, DomainEvent[]>
  checkpoint(correlationId: string): void
  getCheckpoint(correlationId: string): string | null  // returns checkpoint eventId
  listSessions(): SessionInfo[]
  deleteSession(correlationId: string): void

interface SessionInfo:
  correlationId: string
  eventCount: number
  firstEventTimestamp: string
  lastEventTimestamp: string
  lastCheckpointEventId: string | null
  status: 'active' | 'completed' | 'failed'
```

### P2 -- FileEventStore

```
class FileEventStore implements EventStore:
  baseDir: string  // 'data/events'

  constructor(baseDir):
    this.baseDir = baseDir
    fs.mkdirSync(baseDir, { recursive: true })

  filePath(correlationId):
    // Sanitize correlationId to prevent directory traversal
    sanitized = correlationId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return path.join(this.baseDir, sanitized + '.jsonl')

  append(event):
    file = this.filePath(event.correlationId)
    line = JSON.stringify({
      ...event,
      _version: 1,
      _storedAt: new Date().toISOString(),
    }) + '\n'
    fd = fs.openSync(file, 'a')
    try:
      fs.writeSync(fd, line)
      fs.fsyncSync(fd)
    finally:
      fs.closeSync(fd)

  getByCorrelationId(id):
    file = this.filePath(id)
    if !fs.existsSync(file): return []
    lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    events = []
    for lineNum, line of lines:
      try:
        parsed = JSON.parse(line)
        events.push(parsed)
      catch:
        logger.warn('Skipping malformed event line', { file, lineNum })
    return events

  checkpoint(correlationId):
    events = this.getByCorrelationId(correlationId)
    if events.length === 0: return
    lastEventId = events[events.length - 1].id
    checkpointFile = this.filePath(correlationId) + '.checkpoint'
    fs.writeFileSync(checkpointFile, JSON.stringify({
      correlationId,
      eventId: lastEventId,
      timestamp: new Date().toISOString(),
    }))

  getCheckpoint(correlationId):
    checkpointFile = this.filePath(correlationId) + '.checkpoint'
    if !fs.existsSync(checkpointFile): return null
    try:
      data = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8'))
      return data.eventId
    catch:
      return null

  listSessions():
    files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.jsonl'))
    return files.map(f => {
      correlationId = f.replace('.jsonl', '')
      events = this.getByCorrelationId(correlationId)
      checkpoint = this.getCheckpoint(correlationId)
      lastEvent = events[events.length - 1]
      status = inferStatus(events)
      return {
        correlationId,
        eventCount: events.length,
        firstEventTimestamp: events[0]?.timestamp,
        lastEventTimestamp: lastEvent?.timestamp,
        lastCheckpointEventId: checkpoint,
        status,
      }
    })

  deleteSession(correlationId):
    file = this.filePath(correlationId)
    checkpointFile = file + '.checkpoint'
    lockFile = file + '.lock'
    for f of [file, checkpointFile, lockFile]:
      try: fs.unlinkSync(f)
      catch: // ignore

function inferStatus(events):
  types = events.map(e => e.type)
  if types.includes('WorkCompleted'): return 'completed'
  if types.includes('WorkFailed'): return 'failed'
  return 'active'
```

### P3 -- SessionManager

```
class SessionManager:
  eventStore: EventStore
  eventBus: EventBus
  logger: Logger

  save(correlationId):
    eventStore.checkpoint(correlationId)
    logger.info('Session checkpointed', { correlationId })

  restore(correlationId) -> ResumeState:
    // 1. Acquire file lock
    lockFile = eventStore.filePath(correlationId) + '.lock'
    if !acquireLock(lockFile):
      throw new Error('Session is locked by another process')

    try:
      // 2. Load events
      events = eventStore.getByCorrelationId(correlationId)
      if events.length === 0:
        throw new Error('No events found for session')

      // 3. Find checkpoint
      checkpointEventId = eventStore.getCheckpoint(correlationId)

      // 4. Replay events to reconstruct state
      state = replayEvents(events, checkpointEventId)

      return state
    catch:
      releaseLock(lockFile)
      throw

  list() -> SessionInfo[]:
    return eventStore.listSessions()

  cleanup(maxAgeMs = 24 * 60 * 60 * 1000):
    sessions = eventStore.listSessions()
    now = Date.now()
    for session of sessions:
      age = now - new Date(session.lastEventTimestamp).getTime()
      if age > maxAgeMs:
        eventStore.deleteSession(session.correlationId)
        logger.info('Session cleaned up', {
          correlationId: session.correlationId,
          ageHours: Math.round(age / 3600000),
        })
```

### P4 -- Event Replay and State Reconstruction

```
interface ResumeState:
  correlationId: string
  workflowPlan: WorkflowPlan | null
  completedPhases: SPARCPhase[]
  lastPhaseResult: PhaseResult | null
  resumeFromPhase: SPARCPhase | null  // next phase to execute
  reviewVerdict: ReviewVerdict | null

function replayEvents(events, checkpointEventId) -> ResumeState:
  state = {
    correlationId: events[0]?.correlationId,
    workflowPlan: null,
    completedPhases: [],
    lastPhaseResult: null,
    resumeFromPhase: null,
    reviewVerdict: null,
  }

  for event of events:
    switch event.type:
      case 'PlanCreated':
        state.workflowPlan = event.payload.workflowPlan

      case 'PhaseCompleted':
        result = event.payload.phaseResult
        state.completedPhases.push(result.phaseType)
        state.lastPhaseResult = result

      case 'ReviewCompleted':
        state.reviewVerdict = event.payload.reviewVerdict

      case 'WorkCompleted':
        state.resumeFromPhase = null  // nothing to resume
        return state

      case 'WorkFailed':
        state.resumeFromPhase = null
        return state

    // Stop at checkpoint if specified
    if checkpointEventId && event.id === checkpointEventId:
      break

  // Determine next phase to resume
  if state.workflowPlan:
    allPhases = state.workflowPlan.phases.map(p => p.type)
    nextPhaseIndex = state.completedPhases.length
    if nextPhaseIndex < allPhases.length:
      state.resumeFromPhase = allPhases[nextPhaseIndex]

  return state
```

### P5 -- EventBus Wiring

```
// In pipeline.ts or index.ts:

function wireEventStore(eventBus, eventStore):
  // Subscribe to ALL event types and persist
  // Use a catch-all approach by wrapping eventBus.publish

  originalPublish = eventBus.publish
  eventBus.publish = (event) => {
    try:
      eventStore.append(event)
    catch err:
      logger.error('Failed to persist event', { eventType: event.type, error: err.message })
      // Do NOT throw -- event bus must not be blocked by store failures
    originalPublish(event)
  }
```

### P6 -- HTTP Routes

```
// In server.ts or a new routes file:

POST /sessions/:id/resume
  session = sessionManager.restore(req.params.id)
  if !session.resumeFromPhase:
    return 400 { error: 'Session already completed or failed' }

  // Re-publish PlanCreated with resume metadata
  eventBus.publish(createDomainEvent('PlanCreated', {
    workflowPlan: session.workflowPlan,
    _resume: {
      fromPhase: session.resumeFromPhase,
      completedPhases: session.completedPhases,
    },
  }))

  return 202 { message: 'Session resumed', resumeFromPhase: session.resumeFromPhase }

GET /sessions
  sessions = sessionManager.list()
  return 200 { sessions }

GET /sessions/:id
  events = eventStore.getByCorrelationId(req.params.id)
  checkpoint = eventStore.getCheckpoint(req.params.id)
  return 200 { correlationId: req.params.id, eventCount: events.length, checkpoint }
```

### Complexity Analysis

- `append`: O(1) -- single file write + fsync.
- `getByCorrelationId`: O(n) where n = events in session. Typically 30-50.
- `replayEvents`: O(n) -- single pass over events.
- `listSessions`: O(s * n) where s = number of sessions. Bounded by cleanup.
- `cleanup`: O(s) -- one stat + unlink per expired session.

---

## A -- Architecture

### New Components

```
src/shared/event-store.ts       -- EventStore interface + FileEventStore
src/shared/session-manager.ts   -- SessionManager (save, restore, list, cleanup)
src/shared/file-lock.ts         -- Simple file-based locking (acquireLock, releaseLock)
```

### Modified Components

```
src/shared/event-bus.ts         -- No interface change; wiring done externally
src/pipeline.ts                 -- Accept optional EventStore; wire publish interception
src/server.ts                   -- Add session HTTP routes
src/index.ts                    -- Create EventStore, SessionManager; wire into pipeline
src/shared/event-types.ts       -- Add _version field to DomainEvent base (backward compatible)
```

### Component Diagram

```
                    EventBus.publish(event)
                         |
                    +----v----+
                    | intercept|
                    +----+----+
                         |
              +----------+----------+
              |                     |
      EventStore.append(event)   Original publish
              |                  (in-memory dispatch)
      +-------v--------+
      | FileEventStore |
      | data/events/   |
      | {id}.jsonl     |
      +-------+--------+
              |
    +---------+---------+
    |                   |
  checkpoint()     getByCorrelationId()
    |                   |
    v                   v
  .checkpoint      SessionManager
    file              .restore()
                      .list()
                        |
                   replayEvents()
                        |
                   ResumeState
                        |
                   Pipeline resumes
                   from last phase
```

### Event Store File Format

Each `.jsonl` file contains one JSON object per line:

```jsonl
{"type":"IntakeCompleted","id":"uuid-1","timestamp":"...","correlationId":"corr-1","payload":{...},"_version":1,"_storedAt":"..."}
{"type":"WorkTriaged","id":"uuid-2","timestamp":"...","correlationId":"corr-1","payload":{...},"_version":1,"_storedAt":"..."}
{"type":"PlanCreated","id":"uuid-3","timestamp":"...","correlationId":"corr-1","payload":{...},"_version":1,"_storedAt":"..."}
```

Checkpoint file (`.jsonl.checkpoint`):
```json
{"correlationId":"corr-1","eventId":"uuid-3","timestamp":"2026-03-17T10:00:00Z"}
```

### Key Design Decisions

- **Append-only JSONL**: Simple, crash-safe (partial last line is detectable), human-readable, no schema migrations needed. Each event is self-contained.

- **File-per-correlationId**: Enables O(1) session lookup without scanning all events. Cleanup is a simple `unlink`. No index maintenance.

- **Publish interception over EventBus middleware**: The EventBus interface is not modified. The event store is wired by wrapping `publish` in `index.ts`. This keeps the EventBus pure and testable.

- **File-based locking**: Simple `O_EXCL` file creation for lock acquisition. No external lock manager needed. Lock files are cleaned up on session completion or TTL expiry.

- **Checkpoint as separate file**: Checkpoints are updated independently of the event log. This avoids modifying the append-only event file.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Disk full during append | MEDIUM | Log error, do not block EventBus; pipeline continues in-memory |
| Stale lock files from crashed processes | MEDIUM | Lock files include PID and timestamp; cleanup detects stale locks |
| Large event payloads (WorkflowPlan) | LOW | Typical plan is <5KB serialized; 50 events = ~25KB total |
| Resume with incompatible code version | MEDIUM | `_version` field enables detection; skip unknown event types |
| JSONL file corruption from concurrent writes | LOW | Single-process model; file lock prevents concurrent resume |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: file-lock.ts + tests (0 dependencies)

Tests:
- `acquireLock(path)` creates lock file, returns true
- `acquireLock(path)` on existing lock returns false
- `releaseLock(path)` removes lock file
- `releaseLock(path)` on non-existent file does not throw
- Lock file contains PID and timestamp
- `isLockStale(path, maxAgeMs)` detects old lock files

### Step 2: event-store.ts -- FileEventStore + tests (depends on file-lock.ts)

Tests:
- `append(event)` creates JSONL file if not exists
- `append(event)` appends to existing file
- `getByCorrelationId(id)` returns events in order
- `getByCorrelationId(id)` for non-existent session returns empty array
- `getByCorrelationId(id)` skips malformed lines with warning
- `checkpoint(correlationId)` creates checkpoint file with last event ID
- `getCheckpoint(correlationId)` returns checkpoint event ID
- `getCheckpoint(correlationId)` returns null when no checkpoint
- `listSessions()` returns metadata for all sessions
- `listSessions()` infers status from event types (completed, failed, active)
- `deleteSession(correlationId)` removes JSONL, checkpoint, and lock files
- Directory is created automatically on construction
- `filePath()` sanitizes correlationId to prevent directory traversal
- Partial line at end of file (simulated crash) is skipped

### Step 3: session-manager.ts -- replayEvents + tests (pure function, depends on types)

Tests:
- Empty events array returns null state
- Events with `PlanCreated` reconstructs workflowPlan
- Events with `PhaseCompleted` tracks completed phases
- Events with `WorkCompleted` sets resumeFromPhase to null
- Events with `WorkFailed` sets resumeFromPhase to null
- Partial execution (2 of 5 phases done) sets correct resumeFromPhase
- Checkpoint event ID limits replay to events up to checkpoint
- Unknown event types are skipped without error

### Step 4: session-manager.ts -- SessionManager + tests (depends on EventStore)

Tests (mock EventStore):
- `save(correlationId)` calls `eventStore.checkpoint()`
- `restore(correlationId)` acquires lock and replays events
- `restore(correlationId)` with existing lock throws error
- `restore(correlationId)` with no events throws error
- `list()` delegates to `eventStore.listSessions()`
- `cleanup(maxAgeMs)` deletes sessions older than threshold
- `cleanup()` preserves sessions newer than threshold

### Step 5: EventBus wiring + tests

Tests:
- After wiring, `eventBus.publish(event)` also calls `eventStore.append(event)`
- EventStore failure does not prevent event dispatch
- EventStore failure is logged as error

### Step 6: HTTP routes + tests

Tests (mock SessionManager):
- `POST /sessions/:id/resume` calls `sessionManager.restore()` and publishes PlanCreated
- `POST /sessions/:id/resume` returns 400 for completed session
- `POST /sessions/:id/resume` returns 409 when session is locked
- `GET /sessions` returns session list
- `GET /sessions/:id` returns session detail with event count
- `GET /sessions/:id` returns 404 for unknown session

### Step 7: index.ts wiring + integration test

Tests:
- EventStore created with `data/events` base directory
- SessionManager created and cleanup scheduled
- EventStore wired into EventBus publish
- Session routes registered on server
- Full pipeline run produces events in JSONL file
- Session list shows the completed pipeline

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on event-store.ts, session-manager.ts, file-lock.ts
- `npm run build` succeeds
- `npm test` passes
- Performance: append 1000 events in under 5 seconds (benchmark test)
- Performance: replay 1000 events in under 500ms (benchmark test)

---

## C -- Completion

### Verification Checklist

- [ ] FileEventStore creates and reads JSONL files correctly
- [ ] Append is crash-safe (fsync after write)
- [ ] Malformed lines are skipped with warning
- [ ] Checkpoint files track last event ID
- [ ] SessionManager save/restore/list/cleanup work correctly
- [ ] File locking prevents concurrent resume
- [ ] EventBus publish interception persists all events
- [ ] EventStore failure does not block EventBus dispatch
- [ ] HTTP routes expose session management
- [ ] Auto-cleanup removes sessions older than TTL
- [ ] Directory traversal prevented by correlationId sanitization
- [ ] All existing tests pass

### Deployment Steps

1. Merge to main after all tests pass.
2. `data/events/` directory is created automatically on first pipeline run.
3. Set `SESSION_TTL_HOURS=24` (or leave default) in environment.
4. To resume a session: `curl -X POST http://localhost:3000/sessions/{correlationId}/resume`.
5. To list sessions: `curl http://localhost:3000/sessions`.
6. No database migration required.

### Rollback Plan

- Revert the merge commit. The EventBus wiring is the only behavioral change; reverting removes event persistence.
- `data/events/` directory can be deleted safely; it contains only operational data.
- Session HTTP routes are additive; removing them has no impact on existing endpoints.
- No schema migration to reverse; JSONL files are standalone.

---

## Cross-Plan Dependencies

- **Depends on Gap 7** (Multi-Provider Auth): If auth provider is stored in config, resumed sessions must use the same auth provider. The auth provider is determined by environment variables at startup, so resume inherits the current environment.
- **Benefits from Gap 8** (Output Suppression): Events persisted to disk should have output sanitized to avoid storing secrets in event files. Wire sanitization before event store append.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/shared/event-store.ts` | NEW |
| `src/shared/session-manager.ts` | NEW |
| `src/shared/file-lock.ts` | NEW |
| `src/server.ts` | MODIFIED (add session routes) |
| `src/pipeline.ts` | MODIFIED (accept optional EventStore) |
| `src/index.ts` | MODIFIED (create EventStore, SessionManager, wire) |
| `tests/shared/event-store.test.ts` | NEW |
| `tests/shared/session-manager.test.ts` | NEW |
| `tests/shared/file-lock.test.ts` | NEW |
| `tests/server.test.ts` | MODIFIED (session route tests) |
