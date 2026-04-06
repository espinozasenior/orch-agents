# Phase 9F: Task Type Taxonomy

## Goal
Replace the generic task model with a 7-type taxonomy using type-prefixed IDs for collision-safe routing. Each task type carries metadata about concurrency behavior, timeout, retry policy, and resource requirements — enabling the orchestrator to make intelligent scheduling decisions rather than treating all tasks as opaque work items.

## Specification

### Problem Statement
The current task system uses a single generic task type with a UUID. The orchestrator cannot distinguish a quick shell command from a long-running agent session, a background dream task from a critical health monitor. This forces conservative scheduling (sequential execution, uniform timeouts) and prevents the orchestrator from parallelizing compatible tasks or applying type-specific retry policies. The Claude Code CLI uses a 7-type taxonomy internally — adopting it gives the orchestrator the same intelligence.

### Functional Requirements
- FR-9F.01: `TaskType` enum with 7 types mapped to orch-agents concepts:
  - `local_bash` — shell commands (npm build, git operations)
  - `local_agent` — Claude session running on the same machine
  - `remote_agent` — Claude session running on a remote worker
  - `in_process_teammate` — peer agent sharing the same process (MCP-connected)
  - `local_workflow` — multi-step workflow (issue pipeline, deploy pipeline)
  - `monitor_mcp` — health/status watchers (Linear webhook health, daemon heartbeat)
  - `dream` — low-priority background work (memory compaction, log analysis)
- FR-9F.02: `TaskStatus` enum with 5 lifecycle states and transition rules:
  - `pending` — created, not yet started
  - `running` — actively executing
  - `completed` — finished successfully
  - `failed` — finished with error
  - `cancelled` — terminated by user or orchestrator
  - Valid transitions: pending→running, pending→cancelled, running→completed, running→failed, running→cancelled
- FR-9F.03: Type-prefixed task IDs using `crypto.randomBytes` — format: `{type_prefix}-{32 hex chars from 16 random bytes}` where prefix encodes the task type (e.g., `lb-a3f8...` for local_bash, `ra-7c2d...` for remote_agent)
- FR-9F.04: Task type metadata: default timeout, max retries, concurrency class, resource requirements
- FR-9F.05: Tool interface with `shouldDefer` (lazy-load schema), `concurrencySafe` (parallel OK), `interruptBehavior` (cancel | block), `persistResultToDisk` (large results)
- FR-9F.06: Deferred tool loading — tool schema loaded on first invocation, not at registration time
- FR-9F.07: Concurrency class declarations — orchestrator uses these to parallelize tasks in the same class
- FR-9F.08: `dream` tasks run only when capacity is available — they are the lowest priority and yield to any other task type
- FR-9F.09: `monitor_mcp` tasks auto-restart on failure with a separate retry budget (infinite retries, 30s backoff)
- FR-9F.10: Task type routing — each type dispatches to a specific executor pool

### Non-Functional Requirements
- Task ID generation must produce cryptographically unique IDs — collision probability < 1 in 2^128
- Type prefix extraction from task ID must be O(1) — simple string split, no lookup table
- State machine transitions must be atomic — no intermediate states visible to concurrent observers
- Deferred tool loading must not block the orchestrator tick loop
- Dream task scheduling must not starve — guarantee execution within 5 minutes if capacity exists

### Acceptance Criteria
- Task created with type `local_bash` has ID matching pattern `lb-[a-f0-9]{32}`
- Task type can be extracted from ID prefix without database lookup
- Invalid state transition (e.g., completed→running) throws `InvalidTransitionError`
- Dream task waits when all executor slots are occupied by higher-priority tasks
- Dream task runs immediately when capacity is available
- Monitor task restarts automatically after failure with 30s delay
- Tool with `shouldDefer: true` has no schema loaded until first invocation
- Two tasks with same concurrency class can run in parallel
- Two tasks with different concurrency classes may be serialized based on resource constraints

## Pseudocode

### Task Type Definitions

```text
ENUM TaskType:
  LOCAL_BASH           // prefix: 'lb'
  LOCAL_AGENT          // prefix: 'la'
  REMOTE_AGENT         // prefix: 'ra'
  IN_PROCESS_TEAMMATE  // prefix: 'ip'
  LOCAL_WORKFLOW       // prefix: 'lw'
  MONITOR_MCP          // prefix: 'mm'
  DREAM                // prefix: 'dr'

TYPE TaskTypeMetadata = {
  prefix: string
  defaultTimeoutMs: number
  maxRetries: number
  concurrencyClass: string
  priority: number              // lower = higher priority
  resourceRequirements: {
    memory?: 'low' | 'medium' | 'high'
    cpu?: 'low' | 'medium' | 'high'
  }
}

CONSTANT TYPE_METADATA: Map<TaskType, TaskTypeMetadata> = {
  LOCAL_BASH:          { prefix: 'lb', timeout: 120_000,   retries: 3, class: 'shell',   priority: 2, resources: { cpu: 'low' } },
  LOCAL_AGENT:         { prefix: 'la', timeout: 900_000,   retries: 1, class: 'agent',   priority: 3, resources: { memory: 'high', cpu: 'high' } },
  REMOTE_AGENT:        { prefix: 'ra', timeout: 900_000,   retries: 2, class: 'agent',   priority: 3, resources: { cpu: 'low' } },
  IN_PROCESS_TEAMMATE: { prefix: 'ip', timeout: 300_000,   retries: 1, class: 'process', priority: 1, resources: { memory: 'medium' } },
  LOCAL_WORKFLOW:      { prefix: 'lw', timeout: 1_800_000, retries: 0, class: 'workflow', priority: 2, resources: { memory: 'medium' } },
  MONITOR_MCP:         { prefix: 'mm', timeout: Infinity,  retries: Infinity, class: 'monitor', priority: 1, resources: { cpu: 'low' } },
  DREAM:               { prefix: 'dr', timeout: 600_000,   retries: 0, class: 'dream',   priority: 10, resources: { cpu: 'low', memory: 'low' } },
}
```

### Task ID Generation

```text
CONSTANT PREFIX_MAP: Map<string, TaskType> = inverse of TYPE_METADATA.prefix

FUNCTION generateTaskId(type: TaskType): string:
  meta = TYPE_METADATA.get(type)
  randomHex = crypto.randomBytes(16).toString('hex')   // 32 hex chars = 128 bits
  RETURN `${meta.prefix}-${randomHex}`

FUNCTION extractTaskType(taskId: string): TaskType:
  prefix = taskId.split('-')[0]
  type = PREFIX_MAP.get(prefix)
  IF NOT type:
    THROW Error(`Unknown task type prefix: ${prefix}`)
  RETURN type
```

### Task State Machine

```text
ENUM TaskStatus:
  PENDING
  RUNNING
  COMPLETED
  FAILED
  CANCELLED

CONSTANT VALID_TRANSITIONS: Map<TaskStatus, TaskStatus[]> = {
  PENDING:   [RUNNING, CANCELLED],
  RUNNING:   [COMPLETED, FAILED, CANCELLED],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
}

CLASS TaskStateMachine:
  status: TaskStatus = PENDING
  mutex: Mutex

  FUNCTION transition(newStatus: TaskStatus): void:
    ACQUIRE mutex:
      allowed = VALID_TRANSITIONS.get(status)
      IF newStatus NOT IN allowed:
        THROW InvalidTransitionError(
          `Cannot transition from ${status} to ${newStatus}`
        )
      oldStatus = status
      status = newStatus
      emit('transition', { from: oldStatus, to: newStatus, timestamp: now() })
```

### Task Factory

```text
TYPE Task = {
  id: string
  type: TaskType
  status: TaskStateMachine
  metadata: TaskTypeMetadata
  payload: unknown
  createdAt: number
  startedAt?: number
  completedAt?: number
  result?: unknown
  error?: Error
}

CLASS TaskFactory:
  FUNCTION create(type: TaskType, payload: unknown): Task:
    id = generateTaskId(type)
    meta = TYPE_METADATA.get(type)
    RETURN {
      id,
      type,
      status: new TaskStateMachine(),
      metadata: meta,
      payload,
      createdAt: now(),
    }
```

### Deferred Tool Registry

```text
TYPE ToolDefinition = {
  name: string
  shouldDefer: boolean
  concurrencySafe: boolean
  interruptBehavior: 'cancel' | 'block'
  persistResultToDisk: boolean
  schema?: JSONSchema              // null until loaded if shouldDefer
  handler: (input: unknown) => Promise<unknown>
}

CLASS DeferredToolRegistry:
  tools: Map<string, ToolDefinition> = new Map()
  loadedSchemas: Set<string> = new Set()

  FUNCTION register(tool: ToolDefinition): void:
    IF tool.shouldDefer:
      tool.schema = null           // defer schema loading
    tools.set(tool.name, tool)

  FUNCTION getSchema(name: string): JSONSchema:
    tool = tools.get(name)
    IF NOT tool:
      THROW Error(`Unknown tool: ${name}`)
    IF tool.schema == null:
      tool.schema = loadSchemaFromDisk(name)  // lazy load
      loadedSchemas.add(name)
    RETURN tool.schema

  FUNCTION getConcurrentTools(): string[]:
    RETURN Array.from(tools.values())
      .filter(t => t.concurrencySafe)
      .map(t => t.name)
```

### Concurrency Classifier

```text
CLASS ConcurrencyClassifier:
  FUNCTION canRunInParallel(taskA: Task, taskB: Task): boolean:
    // Same concurrency class = safe to parallelize
    IF taskA.metadata.concurrencyClass == taskB.metadata.concurrencyClass:
      RETURN true

    // Shell + agent can run in parallel
    IF classesAre(taskA, taskB, 'shell', 'agent'):
      RETURN true

    // Monitor runs alongside anything
    IF taskA.metadata.concurrencyClass == 'monitor' OR
       taskB.metadata.concurrencyClass == 'monitor':
      RETURN true

    // Dream yields to everything — only parallel with other dreams
    IF taskA.metadata.concurrencyClass == 'dream' OR
       taskB.metadata.concurrencyClass == 'dream':
      RETURN taskA.metadata.concurrencyClass == taskB.metadata.concurrencyClass

    RETURN false

  FUNCTION classesAre(a, b, classX, classY): boolean:
    RETURN (a.metadata.concurrencyClass == classX AND b.metadata.concurrencyClass == classY) OR
           (a.metadata.concurrencyClass == classY AND b.metadata.concurrencyClass == classX)
```

### Task Router

```text
CLASS TaskRouter:
  executorPools: Map<string, ExecutorPool>

  FUNCTION dispatch(task: Task): void:
    pool = executorPools.get(task.metadata.concurrencyClass)
    IF NOT pool:
      THROW Error(`No executor pool for class: ${task.metadata.concurrencyClass}`)

    IF task.type == DREAM AND NOT pool.hasCapacity():
      pool.enqueueDeferred(task)   // wait for capacity
      RETURN

    task.status.transition(RUNNING)
    task.startedAt = now()
    pool.execute(task)

  FUNCTION handleFailure(task: Task, error: Error): void:
    IF task.type == MONITOR_MCP:
      // Auto-restart monitors with infinite retries
      schedule(() => dispatch(task), 30_000)
      RETURN

    IF task.metadata.maxRetries > 0:
      task.metadata.maxRetries--
      schedule(() => dispatch(task), 1_000)
      RETURN

    task.status.transition(FAILED)
    task.error = error
    task.completedAt = now()
```

### Complexity Analysis
- Task ID generation: O(1) — fixed 16-byte random + string concat
- Task type extraction from ID: O(1) — split on first hyphen
- State transition: O(1) — array lookup + mutex acquire
- Deferred schema load: O(1) amortized — loaded once, cached
- Concurrency check: O(1) — string comparison
- Task routing: O(1) — map lookup by concurrency class

## Architecture

### Primary Components
- `src/task/task-types.ts` (NEW) — TaskType enum, TaskStatus enum, metadata constants
- `src/task/task-id.ts` (NEW) — Type-prefixed ID generation and extraction
- `src/task/task-state-machine.ts` (NEW) — Atomic state transitions with event emission
- `src/task/task-factory.ts` (NEW) — Task creation with type metadata
- `src/task/task-router.ts` (NEW) — Type-based dispatch to executor pools
- `src/task/deferred-tool-registry.ts` (NEW) — Lazy schema loading for tools
- `src/task/concurrency-classifier.ts` (NEW) — Parallel execution compatibility checks

### Task Type to Executor Pool Mapping
```
TaskType               Concurrency Class    Executor Pool
─────────────────────  ──────────────────   ─────────────────
LOCAL_BASH             shell                ShellExecutorPool
LOCAL_AGENT            agent                AgentExecutorPool
REMOTE_AGENT           agent                AgentExecutorPool
IN_PROCESS_TEAMMATE    process              ProcessExecutorPool
LOCAL_WORKFLOW         workflow             WorkflowExecutorPool
MONITOR_MCP            monitor              MonitorExecutorPool
DREAM                  dream                DreamExecutorPool
```

### Task Lifecycle State Machine
```
             ┌──────────┐
             │ PENDING   │
             └─────┬─────┘
                   │
          ┌────────┼────────┐
          ▼                 ▼
     ┌──────────┐     ┌───────────┐
     │ RUNNING   │     │ CANCELLED  │
     └─────┬─────┘     └───────────┘
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
 ┌────────┐ ┌────────┐ ┌───────────┐
 │COMPLETED│ │ FAILED  │ │ CANCELLED  │
 └────────┘ └────────┘ └───────────┘

Terminal states: COMPLETED, FAILED, CANCELLED (no outbound transitions)
```

### Task ID Format
```
Type-prefixed ID examples:
  lb-a3f8c7d2e1b94f6083a2d5e7c9b1f4a8   (local_bash)
  la-7c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f   (local_agent)
  ra-1234567890abcdef1234567890abcdef     (remote_agent)
  ip-fedcba9876543210fedcba9876543210     (in_process_teammate)
  lw-abcdef1234567890abcdef1234567890     (local_workflow)
  mm-0123456789abcdef0123456789abcdef     (monitor_mcp)
  dr-deadbeefcafebabe1234567890abcdef     (dream)

Extract type: taskId.split('-')[0] → prefix → PREFIX_MAP lookup
```

### Integration Points
- **SwarmDaemon (Phase 9B)**: Uses TaskRouter to dispatch tasks to executor pools
- **CapacityWake (Phase 9D)**: Checks dream task queue when capacity frees up
- **AgentRunner (Phase 9A)**: Executor for `local_agent` and `remote_agent` task types
- **SerialBatchUploader (Phase 9C)**: Results from completed tasks uploaded via batch

### Design Decisions
- **Type-prefixed IDs** — enables O(1) type extraction without database lookup; prefix is human-readable in logs
- **7 types, not fewer** — each type has genuinely different scheduling, retry, and resource characteristics. Collapsing types would lose orchestrator intelligence
- **Deferred tool loading** — at scale (60+ tool types), eager schema loading wastes memory and slows startup. Load on first use
- **Infinite monitor retries** — health watchers must never permanently die; they are the canary for system health
- **Dream as lowest priority** — dream tasks are speculative work (compaction, pre-warming). They must never block real work
- **Concurrency class, not task type** — parallelism is determined by resource class, not task type. Two `local_agent` tasks may conflict (same concurrency class), but a `local_bash` and `local_agent` can run in parallel

## Refinement

### File Targets
- `src/task/task-types.ts` (NEW)
- `src/task/task-id.ts` (NEW)
- `src/task/task-state-machine.ts` (NEW)
- `src/task/task-factory.ts` (NEW)
- `src/task/task-router.ts` (NEW)
- `src/task/deferred-tool-registry.ts` (NEW)
- `src/task/concurrency-classifier.ts` (NEW)

### Exact Tests

#### `tests/task/task-id.test.ts` (NEW)
- `generateTaskId(LOCAL_BASH)` produces ID matching `/^lb-[a-f0-9]{32}$/`
- `generateTaskId(DREAM)` produces ID matching `/^dr-[a-f0-9]{32}$/`
- Two consecutive `generateTaskId` calls produce different IDs
- `extractTaskType('lb-abc123...')` returns `LOCAL_BASH`
- `extractTaskType('xx-abc123...')` throws for unknown prefix
- All 7 task types have unique prefixes (no collisions in PREFIX_MAP)

#### `tests/task/task-state-machine.test.ts` (NEW)
- Initial state is PENDING
- PENDING → RUNNING is valid
- PENDING → CANCELLED is valid
- RUNNING → COMPLETED is valid
- RUNNING → FAILED is valid
- RUNNING → CANCELLED is valid
- COMPLETED → RUNNING throws `InvalidTransitionError`
- FAILED → RUNNING throws `InvalidTransitionError`
- CANCELLED → RUNNING throws `InvalidTransitionError`
- Transition emits event with from, to, and timestamp

#### `tests/task/task-factory.test.ts` (NEW)
- Created task has correct type and metadata
- Created task has status PENDING
- Created task ID has correct type prefix
- Created task has createdAt timestamp

#### `tests/task/deferred-tool-registry.test.ts` (NEW)
- Tool with `shouldDefer: true` has null schema after registration
- `getSchema()` on deferred tool triggers lazy load
- Second `getSchema()` call returns cached schema (no reload)
- Tool with `shouldDefer: false` has schema available immediately
- `getConcurrentTools()` returns only tools with `concurrencySafe: true`
- Unknown tool name throws error

#### `tests/task/concurrency-classifier.test.ts` (NEW)
- Two shell tasks can run in parallel (same class)
- Shell + agent tasks can run in parallel (compatible classes)
- Monitor + any task can run in parallel
- Dream + non-dream cannot run in parallel
- Dream + dream can run in parallel
- Two workflow tasks cannot run in parallel (resource constraint)

#### `tests/task/task-router.test.ts` (NEW)
- LOCAL_BASH dispatched to ShellExecutorPool
- DREAM task deferred when no capacity available
- DREAM task dispatched immediately when capacity exists
- MONITOR_MCP auto-restarts after failure with 30s delay
- Task with retries remaining is retried on failure
- Task with 0 retries transitions to FAILED on error

### Performance Targets
- Task ID generation: < 10 microseconds (crypto.randomBytes is fast for 16 bytes)
- Type extraction from ID: < 1 microsecond (string split)
- State transition: < 5 microseconds (mutex + array check)
- Deferred schema load: < 50ms on first call, < 1 microsecond on subsequent calls
- Concurrency classification: < 1 microsecond (string comparisons)

### Edge Cases
- All tools deferred: startup is fast, but first tool invocation per type incurs load latency. Pre-warm critical tools (Bash, Read, Edit) at startup
- Concurrent state transitions: two threads both try RUNNING→COMPLETED and RUNNING→CANCELLED. Mutex ensures only one succeeds; the other gets `InvalidTransitionError`
- Dream task starvation: all executor slots permanently occupied by agent tasks. Mitigation: reserve 1 dream slot that cannot be claimed by other types
- Monitor restart storm: monitor fails immediately after restart (bad config). Mitigation: exponential backoff on monitor restarts (30s, 60s, 120s, cap 300s) instead of fixed 30s
- Task ID prefix collision with future types: 2-char prefixes give 1,296 combinations (36^2). 7 types used = negligible collision risk for decades of evolution
- Empty executor pool: task type registered but no executor pool configured. Fail loudly at task creation, not at dispatch

### Risks
- Deferred tool loading may cause latency spikes on first invocation — mitigate by pre-warming the 5 most-used tools during startup
- `crypto.randomBytes` is synchronous in Node.js for small sizes (16 bytes) but may block in constrained environments — consider `crypto.randomUUID()` as fallback
- Monitor auto-restart with infinite retries could mask persistent failures — log escalating warnings after 10 consecutive failures
- Dream task starvation is a real risk under sustained load — the reserved dream slot is a hard guarantee but reduces total capacity by 1
