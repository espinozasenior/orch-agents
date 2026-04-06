# Phase 9B: Bridge-Harness Separation

## Goal
Decouple agent lifecycle management from agent execution by introducing a 3-layer bridge architecture: SwarmDaemon (capacity manager) -> SessionRunner (child process manager) -> Agent (isolated execution via Phase 9A's AgentRunner). The daemon treats agents as stateless workers. Crash recovery is a process respawn, not state reconstruction.

## Specification

### Problem Statement
The current system conflates three concerns in a single process: (1) capacity management and work dispatch, (2) child process lifecycle, and (3) agent task execution. This makes crash recovery complex, resource isolation impossible, and scaling to multiple concurrent agents fragile. The Claude Code CLI separates these into distinct layers: `bridgeMain.ts` manages sessions and capacity, `sessionRunner.ts` spawns and monitors child processes with structured NDJSON I/O, and the agent process itself handles only task execution. Adopting this separation enables stateless agents (crash = respawn), isolated environments per agent, and clean dependency injection between layers.

### Functional Requirements
- FR-9B.01: `SwarmDaemon` class managing session capacity with configurable max slots (default 8)
- FR-9B.02: `SessionRunner` spawns agent child processes with `--input-format stream-json --output-format stream-json` flags, reads NDJSON from stdout
- FR-9B.03: NDJSON wire protocol for parent-child communication with typed message envelopes: `task`, `result`, `permission_request`, `permission_response`, `status`, `error`
- FR-9B.04: Activity tracking per session: `idle`, `working`, `requires_action`, `draining` states with transition timestamps
- FR-9B.05: Permission request forwarding -- child emits `permission_request`, parent resolves it (auto-approve or escalate), sends `permission_response` back
- FR-9B.06: Automatic crash recovery -- detect child process exit (non-zero or signal), respawn with same session context, exponential backoff (1s, 2s, 4s, max 30s), max 5 retries per session
- FR-9B.07: Bridge-safe command filtering -- tool whitelist defined in `WORKFLOW.md` frontmatter under `bridge.allowedTools[]`, with sensible defaults (Read, Grep, Glob, Bash) when not specified; reject unlisted tools with an error response
- FR-9B.08: Dependency injection for all cross-layer communication via callback functions, not direct imports, to prevent transitive dependency bloat
- FR-9B.09: Session isolation -- each agent child process gets its own working directory, environment variables, and resource limits
- FR-9B.10: Capacity reporting via `/health` endpoint and structured metrics: active sessions, idle sessions, queue depth, spawn rate, crash rate

### Non-Functional Requirements
- Child process spawn latency must be <500ms from work arrival to agent ready
- NDJSON parsing must handle lines up to 10MB without blocking the event loop
- Crash detection must occur within 1s of child process exit
- Zombie process cleanup must run on a 60s interval and on daemon shutdown
- Memory overhead of the daemon itself (excluding children) must not exceed 50MB

### Acceptance Criteria
- Daemon starts with 0 active sessions and reports capacity = maxSlots
- Work arrives, daemon spawns a SessionRunner, child process starts and reports `idle`
- Task dispatched to child via NDJSON; child transitions to `working`
- Child completes task, sends `result` via NDJSON, transitions back to `idle`
- Child crashes (kill -9); daemon detects within 1s, respawns, re-dispatches pending work
- Rapid crash loop (5 crashes in <30s) marks session as `failed`, no further respawns
- Permission request from child is forwarded to daemon, resolved, and response sent back within 2s
- Blocked tool name rejected with error before reaching the child process
- Health endpoint returns accurate session counts and queue depth
- Daemon SIGTERM triggers orderly shutdown: stop accepting work, drain all sessions, kill children, exit

## Pseudocode

```text
TYPE SessionState = "idle" | "working" | "requires_action" | "draining" | "failed"

TYPE NdjsonEnvelope = {
  type: "task" | "result" | "permission_request" | "permission_response"
      | "status" | "error"
  id: string
  sessionId: string
  payload: unknown
  timestamp: number
}

TYPE SessionInfo = {
  id: string
  state: SessionState
  pid: number | null
  workingDir: string
  crashCount: number
  lastCrash: number | null
  currentTaskId: string | null
}

CONST ALLOWED_TOOLS: Set<string>  // bridge-safe whitelist

CLASS SwarmDaemon:
  maxSlots: number              // default 8
  sessions: Map<string, SessionRunner>
  workQueue: Queue<NdjsonEnvelope>
  metrics: DaemonMetrics

  ASYNC FUNCTION run():
    startHealthEndpoint()
    startZombieReaper(interval: 60_000)
    registerShutdownHandlers()

    LOOP:
      IF workQueue.isEmpty(): AWAIT workQueue.waitForItem()
      IF activeSessions() >= maxSlots: AWAIT waitForIdleSession()

      work = workQueue.dequeue()
      session = findIdleSession() OR spawnNewSession()
      AWAIT session.dispatch(work)

  FUNCTION findIdleSession(): SessionRunner | null
    RETURN sessions.values().find(s => s.state == "idle")

  ASYNC FUNCTION spawnNewSession(): SessionRunner
    id = generateSessionId()
    workDir = createIsolatedWorkDir(id)
    runner = new SessionRunner(id, workDir, { onPermission, onCrash, onResult })
    AWAIT runner.spawn()
    sessions.set(id, runner)
    RETURN runner

  FUNCTION onPermission(sessionId, request):
    IF isAutoApprovable(request):
      sessions.get(sessionId).sendPermissionResponse(request.id, { approved: true })
    ELSE:
      escalateToOperator(sessionId, request)

  FUNCTION onCrash(sessionId):
    session = sessions.get(sessionId)
    IF session.crashCount >= 5:
      session.state = "failed"
      requeuePendingWork(session.currentTaskId)
      RETURN
    session.crashCount += 1
    backoff = min(2^session.crashCount * 1000, 30_000)
    AWAIT sleep(backoff)
    AWAIT session.respawn()

  ASYNC FUNCTION shutdown():
    workQueue.close()
    FOR EACH session IN sessions.values():
      AWAIT session.drain(timeout: 30_000)
    killRemainingChildren()

CLASS SessionRunner:
  id: string
  workDir: string
  childProcess: ChildProcess | null
  state: SessionState = "idle"
  callbacks: { onPermission, onCrash, onResult }
  crashCount: number = 0
  pendingResponses: Map<string, Resolver>

  ASYNC FUNCTION spawn():
    env = buildIsolatedEnv(workDir)
    childProcess = child_process.spawn("claude", [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--working-dir", workDir
    ], { env, stdio: ["pipe", "pipe", "pipe"] })

    childProcess.on("exit", (code, signal) => {
      IF code != 0 OR signal:
        callbacks.onCrash(id)
    })

    // Parse NDJSON from child stdout (non-blocking background listener)
    lineReader = createLineReader(childProcess.stdout)
    BACKGROUND (NOT awaited -- runs for lifetime of child process):
      FOR EACH line IN lineReader:
        envelope = JSON.parse(line) AS NdjsonEnvelope
        handleChildMessage(envelope)

    // Return immediately -- spawn() resolves once child process is started

  FUNCTION handleChildMessage(envelope):
    SWITCH envelope.type:
      CASE "result":
        oldState = state
        state = "idle"
        EMIT 'session:state_changed' { sessionId: id, from: oldState, to: 'idle', timestamp: Date.now() }
        callbacks.onResult(id, envelope)

      CASE "permission_request":
        oldState = state
        state = "requires_action"
        EMIT 'session:state_changed' { sessionId: id, from: oldState, to: 'requires_action', timestamp: Date.now() }
        callbacks.onPermission(id, envelope.payload)

      CASE "status":
        updateMetrics(envelope.payload)

      CASE "error":
        log.error("Child error", envelope.payload)

  ASYNC FUNCTION dispatch(work: NdjsonEnvelope):
    // Filter blocked tools
    IF work.payload.tool AND NOT ALLOWED_TOOLS.has(work.payload.tool):
      callbacks.onResult(id, { type: "error", payload: "tool not allowed" })
      RETURN

    oldState = state
    state = "working"
    EMIT 'session:state_changed' { sessionId: id, from: oldState, to: 'working', timestamp: Date.now() }
    currentTaskId = work.id
    writeLine(childProcess.stdin, JSON.stringify(work))

  FUNCTION sendPermissionResponse(requestId, response):
    envelope = { type: "permission_response", id: requestId, payload: response }
    writeLine(childProcess.stdin, JSON.stringify(envelope))
    state = "working"
    EMIT 'session:state_changed' { sessionId: id, from: 'requires_action', to: 'working', timestamp: Date.now() }

  ASYNC FUNCTION respawn():
    IF childProcess: childProcess.kill("SIGKILL")
    AWAIT spawn()
    IF currentTaskId:
      // Re-dispatch the in-flight task
      AWAIT dispatch(pendingWork)

  ASYNC FUNCTION drain(timeout):
    state = "draining"
    IF currentTaskId:
      AWAIT Promise.race([currentTaskPromise, sleep(timeout)])
    childProcess.kill("SIGTERM")
    AWAIT childExitPromise
```

### Complexity Analysis
- **Session lookup (idle)**: O(n) where n = maxSlots (small, bounded)
- **NDJSON parse**: O(m) where m = message size in bytes (single JSON.parse)
- **Crash recovery**: O(1) per crash event (spawn + optional re-dispatch)
- **Work dispatch**: O(1) -- dequeue + write to stdin pipe
- **Zombie reaper**: O(n) scan every 60s
- **Capacity check**: O(1) -- counter maintained on state transitions

## Architecture

### 3-Layer Diagram
```
┌──────────────────────────────────────────────────────┐
│                   SwarmDaemon                        │
│  - Capacity management (maxSlots)                    │
│  - Work queue                                        │
│  - Permission resolution                             │
│  - Health endpoint + metrics                         │
│  - Crash policy (max retries, backoff)               │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │SessionRunner│  │SessionRunner│  │SessionRunner│  │
│  │  session-01 │  │  session-02 │  │  session-03 │  │
│  │  state:work │  │  state:idle │  │  state:perm │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│         │                │                │          │
│      NDJSON           NDJSON           NDJSON        │
│      stdin/stdout     stdin/stdout     stdin/stdout  │
│         │                │                │          │
├─────────┼────────────────┼────────────────┼──────────┤
│         ▼                ▼                ▼          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ Agent (9A)  │  │ Agent (9A)  │  │ Agent (9A)  │  │
│  │ AgentRunner │  │ AgentRunner │  │ AgentRunner │  │
│  │ pid: 4201   │  │ pid: 4202   │  │ pid: 4203   │  │
│  │ /tmp/s-01/  │  │ /tmp/s-02/  │  │ /tmp/s-03/  │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│                                                      │
│  Each agent is an isolated child process with its    │
│  own working directory and environment.              │
└──────────────────────────────────────────────────────┘
```

### NDJSON Wire Protocol
```
Parent → Child (stdin):
  {"type":"task","id":"t-42","sessionId":"s-01","payload":{"tool":"Edit","args":{...}},"timestamp":1711900000}
  {"type":"permission_response","id":"pr-7","sessionId":"s-01","payload":{"approved":true},"timestamp":1711900001}

Child → Parent (stdout):
  {"type":"result","id":"t-42","sessionId":"s-01","payload":{"success":true,"output":"..."},"timestamp":1711900002}
  {"type":"permission_request","id":"pr-7","sessionId":"s-01","payload":{"tool":"Bash","command":"rm -rf /tmp/test"},"timestamp":1711900003}
  {"type":"status","id":"st-1","sessionId":"s-01","payload":{"tokensUsed":45000,"tasksCompleted":12},"timestamp":1711900004}
```

### Integration with Phase 9A
- Phase 9A's `TransportInbound` interface is implemented by `StdinTransport` in the child process
- Phase 9B's `SessionRunner` writes NDJSON to the child's stdin (which `StdinTransport` reads)
- Phase 9B's `SessionRunner` reads NDJSON from the child's stdout (which the agent writes via `sendResponse`)
- The contract between layers is the `NdjsonEnvelope` type and the `ALLOWED_TOOLS` whitelist

### Dependency Injection Pattern
```text
// SessionRunner receives callbacks, NOT direct references to SwarmDaemon
new SessionRunner(id, workDir, {
  onPermission: (sid, req) => daemon.handlePermission(sid, req),
  onCrash:      (sid)      => daemon.handleCrash(sid),
  onResult:     (sid, env) => daemon.handleResult(sid, env),
})

// This prevents SessionRunner from importing SwarmDaemon,
// keeping the dependency graph flat and testable.
```

### Design Decisions
- **Child process per agent, not thread** -- process isolation provides memory safety, independent crash domains, and OS-level resource limits. Thread-based agents share heap and a crash in one agent can corrupt others.
- **NDJSON over IPC** -- newline-delimited JSON is human-readable, debuggable with `cat`, and works across any stdio-capable transport. Node.js IPC channel is faster but opaque and Node-specific.
- **Callback-based DI** -- passing callback functions instead of class references prevents transitive imports. `SessionRunner` does not import `SwarmDaemon`, `CompactionManager`, or any daemon-level module. This keeps child process bundles small.
- **Whitelist over blacklist for tools** -- explicitly listing allowed tools is safer than trying to block dangerous ones. New tools are blocked by default until explicitly allowed.
- **Crash count per session, not global** -- a single misbehaving task should not exhaust the global retry budget. Each session independently tracks its crash history.

## Refinement

### File Targets
- `src/execution/daemon/swarm-daemon.ts` (NEW) -- Capacity manager, work queue, health endpoint
- `src/execution/daemon/session-runner.ts` (NEW) -- Child process lifecycle, NDJSON I/O
- `src/execution/daemon/ndjson-protocol.ts` (NEW) -- Envelope types, serialization, parsing
- `src/execution/daemon/crash-recovery.ts` (NEW) -- Backoff logic, retry policy
- `src/execution/daemon/tool-whitelist.ts` (NEW) -- Bridge-safe command filter
- `src/execution/daemon/health.ts` (NEW) -- `/health` endpoint, metrics collection
- `src/execution/orchestrator/symphony-orchestrator.ts` (MODIFY) -- Delegate to SwarmDaemon

### Exact Tests
- `tests/execution/daemon/swarm-daemon.test.ts` (NEW)
  - Starts with 0 active sessions and capacity = maxSlots
  - Spawns session when work arrives and no idle session exists
  - Reuses idle session instead of spawning new one
  - Rejects work when all slots full (queues it)
  - Shutdown drains all sessions and kills children
  - Health endpoint returns correct session counts
- `tests/execution/daemon/session-runner.test.ts` (NEW)
  - Spawns child process with correct flags and env
  - Parses valid NDJSON result from child stdout
  - Handles malformed NDJSON line (skip + log, do not crash parent)
  - Dispatches task via stdin NDJSON write
  - Transitions state: idle -> working -> idle on task cycle
  - Permission request transitions state to requires_action
  - Permission response transitions state back to working
  - Child exit with non-zero code triggers onCrash callback
  - Child killed by signal triggers onCrash callback
  - Respawn creates new child process with same session context
  - Drain waits for in-flight task then sends SIGTERM
- `tests/execution/daemon/crash-recovery.test.ts` (NEW)
  - First crash respawns after 1s backoff
  - Second crash respawns after 2s backoff
  - Fifth crash marks session as failed (no respawn)
  - Backoff caps at 30s
  - Pending work re-dispatched after successful respawn
- `tests/execution/daemon/ndjson-protocol.test.ts` (NEW)
  - Serializes NdjsonEnvelope to single-line JSON + newline
  - Parses valid envelope from JSON string
  - Rejects envelope with missing `type` field
  - Rejects envelope with unknown `type` value
  - Handles 10MB message without blocking (streaming parse)
- `tests/execution/daemon/tool-whitelist.test.ts` (NEW)
  - Allowed tool passes filter
  - Blocked tool rejected with error
  - Unknown tool rejected by default
  - Whitelist is configurable at daemon startup

### Performance Targets
| Metric | Target | Method |
|--------|--------|--------|
| Child spawn latency | <500ms | Timestamp: work arrival to first child `status` message |
| NDJSON round-trip (parent->child->parent) | <10ms | Timestamp diff on loopback echo test |
| Crash detection | <1s | Timestamp: child `kill -9` to `onCrash` callback |
| Zombie cleanup | 100% | Assert no orphan pids after daemon shutdown |
| Daemon memory (excl. children) | <50MB | `process.memoryUsage().rss` with 8 idle sessions |

### Mock Boundaries
- **child_process.spawn**: Mock to return a fake `ChildProcess` with writable stdin, readable stdout, and `on('exit')` handler — verifies NDJSON write/parse and crash detection without real process spawning
- **NDJSON stream**: Mock stdout as a `Readable` stream emitting controlled line-delimited JSON — tests protocol parsing in isolation

### Risks
- Zombie processes: if the daemon crashes without cleanup, child processes become orphans. Mitigation: children detect stdin close (parent died) and self-terminate after 10s grace period. The zombie reaper also runs on a 60s interval.
- NDJSON message ordering: stdout is a byte stream, not a message stream. A partial JSON line could be read if the child flushes mid-write. Mitigation: use `readline` interface which buffers until newline. Child must flush complete lines atomically.
- Large NDJSON payloads: tool results (e.g., file contents) can be megabytes. Mitigation: streaming JSON parser for messages >1MB; configurable max message size (default 10MB) with rejection for oversized messages.
- Rapid crash loops consuming resources: 5 retries with backoff still consumes spawn resources. Mitigation: circuit breaker at the daemon level -- if 3+ sessions fail within 60s, pause all spawning for 30s and alert.
- Permission escalation latency: if the operator is slow to respond, the child blocks. Mitigation: configurable permission timeout (default 300s); auto-deny on timeout with logged reason.
