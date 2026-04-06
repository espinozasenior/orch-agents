# Phase 9G: Deferred Tool Loading

## Goal
Implement deferred tool loading so that only tool schemas actively needed are loaded into memory. For the 60+ agent types in orch-agents, this reduces startup memory by 70%+ and startup time proportionally. Tools declare `shouldDefer: true` and only their name is known initially. Full JSONSchema is loaded on first reference via `ToolSearchIndex`, cached for the session, and never re-fetched.

## Specification

### Problem Statement
The current tool system eagerly loads all 60+ tool schemas at startup regardless of whether an agent will use them. Each tool schema (JSONSchema definition with parameter descriptions, enums, defaults) averages 2-5KB. Loading all schemas into every agent process wastes memory, increases startup time, and delays time-to-first-task. The Claude Code CLI solves this with a deferred loading pattern: tools declare `shouldDefer` and only their name appears in the system prompt until the agent references them. A `ToolSearch` mechanism resolves the full schema on demand. Adopting this pattern means agents only pay the memory cost for tools they actually invoke.

### Functional Requirements
- FR-9G.01: `DeferredToolRegistry` managing tool name to schema mapping with lazy population -- tools register with name only, schema populated on first resolution
- FR-9G.02: `shouldDefer` flag on `ToolDefinition` interface -- when true, only `name` and `description` are retained at registration; full `parameters` schema is deferred
- FR-9G.03: `resolveToolSchema(name)` loads the full JSONSchema on first invocation from the tool provider, returns a cached copy on subsequent calls
- FR-9G.04: `ToolSearchIndex` with three query modes: exact select (`select:ToolName`), keyword search (fuzzy match against name and description), required-keyword filter (`+keyword remaining terms`)
- FR-9G.05: Schema caching -- once resolved, a tool schema is stored in the registry and never re-fetched within the same session
- FR-9G.06: Batch resolution: `resolveTools(names[])` for loading multiple tool schemas in a single call, reducing round-trips when a task type declares multiple tool dependencies
- FR-9G.07: `concurrencySafe` metadata per tool -- boolean flag indicating whether the tool can run in parallel with other tools; orchestrator uses this for parallelization decisions
- FR-9G.08: `interruptBehavior` metadata per tool: `cancel` (abort tool execution on user interrupt) vs `block` (wait for tool to complete before processing interrupt)
- FR-9G.09: `persistResultToDisk` flag for tools returning large results -- when output exceeds 1MB, serialize to a temp file and return a file reference instead of holding in memory
- FR-9G.10: Startup metrics: track deferred vs eager tool count, memory saved (bytes), and emit a `tool_registry_init` event with these measurements

### Non-Functional Requirements
- Startup memory reduction must be at least 70% compared to eager loading with 60+ tools
- First-invocation resolve latency must be under 50ms for local tool providers
- Schema cache must not leak across sessions (cleared on session end)
- Registry operations (register, lookup, resolve) must be safe for concurrent access
- Disk result cache must auto-evict files older than the session lifetime

### Acceptance Criteria
- Agent with 60 tools registered as deferred uses less than 30% of the memory of eager loading
- `resolveToolSchema("Read")` returns the full JSONSchema on first call and the cached copy on second call
- `ToolSearchIndex.search("select:Read")` returns exactly the Read tool schema
- `ToolSearchIndex.search("file read")` returns tools matching the keywords ranked by relevance
- `ToolSearchIndex.search("+file search")` returns only tools with "file" in their name, ranked by "search"
- `resolveTools(["Read", "Write", "Edit"])` returns all three schemas in a single batch
- Tool with `concurrencySafe: false` is never scheduled in parallel by the orchestrator
- Tool with `interruptBehavior: block` completes execution even when the user sends an interrupt
- Tool output exceeding 1MB is written to disk and a `DiskResultRef` is returned
- `tool_registry_init` event contains `{ deferred: 55, eager: 5, memorySavedBytes: 284000 }`

## Pseudocode

```text
TYPE ToolDefinition = {
  name: string
  description: string
  shouldDefer?: boolean              // default false
  concurrencySafe?: boolean          // default true
  interruptBehavior?: "cancel" | "block"  // default "cancel"
  persistResultToDisk?: boolean      // default false
  parameters?: JSONSchema            // null when deferred and unresolved
}

TYPE ResolvedTool = ToolDefinition & {
  parameters: JSONSchema             // guaranteed non-null
  resolvedAt: number                 // timestamp of first resolution
}

TYPE ToolSearchQuery = {
  mode: "exact" | "keyword" | "required_keyword"
  exactName?: string                 // for mode "exact"
  keywords?: string[]                // for mode "keyword"
  requiredKeyword?: string           // for mode "required_keyword"
  remainingKeywords?: string[]       // ranked by these after filtering
}

CLASS DeferredToolRegistry:
  eagerTools: Map<string, ResolvedTool>
  deferredTools: Map<string, ToolDefinition>
  resolvedCache: Map<string, ResolvedTool>
  resolving: Map<string, Promise<ResolvedTool>>  // dedup concurrent resolves
  schemaProvider: ToolSchemaProvider

  FUNCTION register(tool: ToolDefinition):
    IF tool.shouldDefer:
      stripped = { name: tool.name, description: tool.description,
                   shouldDefer: true, concurrencySafe: tool.concurrencySafe,
                   interruptBehavior: tool.interruptBehavior,
                   persistResultToDisk: tool.persistResultToDisk }
      deferredTools.set(tool.name, stripped)
    ELSE:
      eagerTools.set(tool.name, tool AS ResolvedTool)

  ASYNC FUNCTION resolve(name: string): ResolvedTool
    // 1. Check eager tools
    IF eagerTools.has(name):
      RETURN eagerTools.get(name)

    // 2. Check resolved cache
    IF resolvedCache.has(name):
      RETURN resolvedCache.get(name)

    // 3. Check if already resolving (dedup concurrent calls)
    IF resolving.has(name):
      RETURN AWAIT resolving.get(name)

    // 4. Resolve from provider
    IF NOT deferredTools.has(name):
      THROW ToolNotFoundError(name)

    promise = schemaProvider.fetchSchema(name)
    resolving.set(name, promise)

    TRY:
      schema = AWAIT promise
      resolved = { ...deferredTools.get(name), parameters: schema, resolvedAt: Date.now() }
      resolvedCache.set(name, resolved)
      deferredTools.delete(name)
      RETURN resolved
    FINALLY:
      resolving.delete(name)

  ASYNC FUNCTION resolveMany(names: string[]): ResolvedTool[]
    RETURN AWAIT Promise.all(names.map(n => resolve(n)))

  FUNCTION getStartupMetrics(): RegistryMetrics
    eagerSize = sumSchemaBytes(eagerTools)
    deferredEstimate = deferredTools.size * AVG_SCHEMA_BYTES
    RETURN {
      eager: eagerTools.size,
      deferred: deferredTools.size,
      memorySavedBytes: deferredEstimate
    }

CLASS ToolSearchIndex:
  registry: DeferredToolRegistry

  FUNCTION parseQuery(raw: string): ToolSearchQuery
    IF raw.startsWith("select:"):
      RETURN { mode: "exact", exactName: raw.slice(7) }
    IF raw.startsWith("+"):
      parts = raw.slice(1).split(" ")
      RETURN { mode: "required_keyword", requiredKeyword: parts[0],
               remainingKeywords: parts.slice(1) }
    RETURN { mode: "keyword", keywords: raw.split(" ") }

  FUNCTION search(raw: string, maxResults: number = 5): ResolvedTool[]
    query = parseQuery(raw)

    SWITCH query.mode:
      CASE "exact":
        tool = registry.resolve(query.exactName)
        RETURN [tool]

      CASE "keyword":
        allTools = [...registry.eagerTools, ...registry.deferredTools]
        scored = allTools.map(t => {
          score = keywordRelevance(t.name + " " + t.description, query.keywords)
          RETURN { tool: t, score }
        })
        RETURN scored.sort(desc by score).slice(0, maxResults).map(s => s.tool)

      CASE "required_keyword":
        filtered = allTools.filter(t => t.name.includes(query.requiredKeyword))
        scored = filtered.map(t => {
          score = keywordRelevance(t.description, query.remainingKeywords)
          RETURN { tool: t, score }
        })
        RETURN scored.sort(desc by score).slice(0, maxResults).map(s => s.tool)

CLASS LazyToolProxy:
  registry: DeferredToolRegistry
  toolName: string
  resolved?: ResolvedTool

  ASYNC FUNCTION invoke(params: unknown): ToolResult
    IF NOT resolved:
      resolved = AWAIT registry.resolve(toolName)
    validate(params, resolved.parameters)
    result = AWAIT executeTool(resolved, params)

    IF resolved.persistResultToDisk AND sizeOf(result) > 1_048_576:
      RETURN DiskResultCache.write(toolName, result)
    RETURN result

CLASS DiskResultCache:
  cacheDir: string   // e.g. /tmp/orch-agents/tool-results/

  STATIC FUNCTION write(toolName, result): DiskResultRef
    path = join(cacheDir, `${toolName}-${uuid()}.json`)
    writeFileSync(path, JSON.stringify(result))
    RETURN { type: "disk_ref", path, sizeBytes: sizeOf(result) }

  STATIC FUNCTION read(ref: DiskResultRef): unknown
    RETURN JSON.parse(readFileSync(ref.path))

  STATIC FUNCTION evictSession(sessionId):
    // Remove all cached results for this session
    removeDir(join(cacheDir, sessionId))
```

### Complexity Analysis
- **register()**: O(1) -- map insertion
- **resolve()**: O(1) amortized -- cache hit is map lookup; cache miss is one async fetch then map insert
- **resolveMany()**: O(k) where k = number of names, parallelized via Promise.all
- **search("select:X")**: O(1) -- direct map lookup
- **search(keywords)**: O(n * m) where n = total tools, m = keyword count (scored linear scan)
- **search("+required rest")**: O(n) filter + O(f * m) score where f = filtered count
- **DiskResultCache.write()**: O(s) where s = result size (file I/O)
- **Memory**: O(e + r) where e = eager tool count, r = resolved deferred count; unresolved deferred tools are O(1) each (name + description only)

## Architecture

### Primary Components
- `src/tools/registry/deferred-tool-registry.ts` (NEW) -- `DeferredToolRegistry` with lazy resolution, dedup, and metrics
- `src/tools/registry/tool-search-index.ts` (NEW) -- `ToolSearchIndex` with three query modes
- `src/tools/registry/lazy-tool-proxy.ts` (NEW) -- `LazyToolProxy` wrapping deferred tools for transparent invocation
- `src/tools/registry/disk-result-cache.ts` (NEW) -- Temp file caching for large tool outputs
- `src/tools/types.ts` (MODIFY) -- Add `shouldDefer`, `concurrencySafe`, `interruptBehavior`, `persistResultToDisk` to `ToolDefinition`
- `src/execution/agent/agent-runner.ts` (MODIFY) -- Use `LazyToolProxy` for tool invocations instead of direct schema access
- `src/execution/orchestrator/symphony-orchestrator.ts` (MODIFY) -- Check `concurrencySafe` before parallel tool dispatch

### Component Diagram
```
Agent Startup (60+ tools)
  │
  ├─ 5 eager tools → full schema loaded (types.ts, core tools)
  │
  └─ 55 deferred tools → name + description only
       │
       ▼
  DeferredToolRegistry
  ┌────────────────────────────────────────┐
  │  eagerTools: Map<name, ResolvedTool>   │  ← 5 entries, full schema
  │  deferredTools: Map<name, ToolDef>     │  ← 55 entries, name only
  │  resolvedCache: Map<name, Resolved>    │  ← populated on demand
  │  resolving: Map<name, Promise>         │  ← dedup in-flight
  └────────────────────────────────────────┘
       │                          │
       ▼                          ▼
  ToolSearchIndex            LazyToolProxy
  ┌──────────────┐           ┌──────────────────┐
  │ select:Name  │           │ invoke(params)    │
  │ keyword      │           │   └─ resolve()    │
  │ +required    │           │   └─ validate()   │
  └──────────────┘           │   └─ execute()    │
                             │   └─ disk cache?  │
                             └──────────────────┘
                                      │
                                      ▼
                             DiskResultCache
                             ┌──────────────────┐
                             │ >1MB → temp file  │
                             │ ≤1MB → in-memory  │
                             └──────────────────┘
```

### Integration with Phase 9F (Task Types)
Task types declare their tool dependencies via `requiredTools: string[]`. When a task of a given type is assigned to an agent, the orchestrator calls `registry.resolveMany(taskType.requiredTools)` to batch-load all needed schemas before the agent begins execution. This eliminates first-invocation latency for known tool sets.

### Integration with Phase 9A (Agent Runner)
The `AgentRunner` loop uses `LazyToolProxy` instances instead of direct tool references. When the LLM emits a tool call for a deferred tool, the proxy transparently resolves the schema, validates parameters, and executes. The agent never sees the deferred/resolved distinction.

### Design Decisions
- **Dedup via `resolving` map** -- if two concurrent tool calls reference the same unresolved tool, only one fetch occurs. The second caller awaits the same promise. Prevents redundant schema loading under parallel tool execution.
- **Batch resolution for task types** -- resolving tools one-by-one on first use adds latency to each new tool call. Batch resolution at task start amortizes the cost.
- **Disk cache for large results** -- tools like code search or file listing can return multi-megabyte results. Holding these in the conversation history bloats memory. Disk caching with a reference token keeps memory flat.
- **concurrencySafe as opt-out** -- most tools are safe for parallel execution. Only tools with side effects (file write, git operations) declare `concurrencySafe: false`. This matches the Claude Code CLI behavior where parallel tool calls are the default.
- **interruptBehavior: cancel as default** -- most tools should abort on user interrupt. Only tools with transactional semantics (database writes, git commit) use `block` to avoid partial state.

## Refinement

### File Targets
- `src/tools/registry/deferred-tool-registry.ts` (NEW)
- `src/tools/registry/tool-search-index.ts` (NEW)
- `src/tools/registry/lazy-tool-proxy.ts` (NEW)
- `src/tools/registry/disk-result-cache.ts` (NEW)
- `src/tools/types.ts` (MODIFY)
- `src/execution/agent/agent-runner.ts` (MODIFY)
- `src/execution/orchestrator/symphony-orchestrator.ts` (MODIFY)

### Exact Tests
- `tests/tools/registry/deferred-tool-registry.test.ts` (NEW)
  - Register eager tool stores full schema immediately
  - Register deferred tool stores name and description only, no parameters
  - resolve() returns eager tool without async fetch
  - resolve() fetches schema for deferred tool on first call
  - resolve() returns cached schema on second call without fetching
  - resolve() deduplicates concurrent resolution of same tool
  - resolve() throws ToolNotFoundError for unknown tool name
  - resolveMany() resolves multiple tools in parallel
  - resolveMany() uses cache for already-resolved tools
  - getStartupMetrics() returns correct eager/deferred counts and memory estimate
- `tests/tools/registry/tool-search-index.test.ts` (NEW)
  - parseQuery("select:Read") returns exact mode with name "Read"
  - parseQuery("file read") returns keyword mode with ["file", "read"]
  - parseQuery("+file search") returns required_keyword mode
  - search("select:Read") returns exactly the Read tool
  - search("file read") returns tools ranked by keyword relevance
  - search("+file search") filters to tools with "file" in name
  - search() respects maxResults parameter
  - search() works for both eager and deferred tools
- `tests/tools/registry/lazy-tool-proxy.test.ts` (NEW)
  - invoke() resolves schema on first call
  - invoke() uses cached schema on subsequent calls
  - invoke() validates parameters against resolved schema
  - invoke() rejects invalid parameters with validation error
  - invoke() writes result to disk when persistResultToDisk and result > 1MB
  - invoke() returns in-memory result when under 1MB threshold
- `tests/tools/registry/disk-result-cache.test.ts` (NEW)
  - write() creates JSON file in cache directory
  - write() returns DiskResultRef with correct path and size
  - read() deserializes JSON from disk reference
  - evictSession() removes all files for the session
  - Cache directory is created if it does not exist

### Performance Targets
| Metric | Before (eager) | After (deferred) | Method |
|--------|---------------|------------------|--------|
| Startup memory (60 tools) | ~400KB schemas | ~30KB (names only) | `process.memoryUsage().heapUsed` delta |
| Startup time | ~120ms | ~15ms | Timer around registry initialization |
| First-invocation latency | 0ms (pre-loaded) | <50ms (resolve + cache) | Timer around first `resolve()` call |
| Subsequent invocation | 0ms | 0ms (cache hit) | Timer around cached `resolve()` call |
| Large result memory | Held in heap | 0 (disk ref) | `process.memoryUsage()` after 5MB tool result |

### Mock Boundaries
- **Schema provider**: Mock `ToolSchemaProvider.fetchSchema()` to return controlled JSONSchema payloads — verifies lazy loading, caching, and dedup without real provider I/O
- **Disk I/O**: Mock `writeFileSync`/`readFileSync` in `DiskResultCache` — tests serialization and eviction logic without touching the filesystem

### Risks
- **First-invocation latency spike** -- the first call to a deferred tool pays the resolution cost. Mitigation: batch resolution via task type tool declarations (Phase 9F integration) pre-loads expected tools.
- **Schema provider unavailability** -- if the schema provider is down, deferred tools cannot resolve. Mitigation: retry with exponential backoff (1s, 2s, 4s, max 10s); fail the tool call after 3 retries rather than hanging.
- **Concurrent resolution race** -- two parallel tool calls for the same unresolved tool must not cause double-fetch. Mitigation: `resolving` map stores the in-flight promise; second caller awaits the same promise.
- **Disk cache growth** -- long-running sessions with many large tool results can fill disk. Mitigation: evict on session end; cap total cache size at 500MB with LRU eviction.
- **Search relevance quality** -- keyword search with simple string matching may return irrelevant results. Mitigation: weight name matches higher than description matches; use trigram similarity for fuzzy matching.
