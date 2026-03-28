# SPARC Gap 13: Persistent Memory and Cross-Run Learning

## Decision Records, Review Patterns, Project Conventions with Semantic Search

## Priority: P2
## Estimated Effort: 14-21 days
## Status: Planning

---

## Problem Statement

Every pipeline invocation starts fresh with no knowledge of past reviews, common patterns, or project-specific conventions. The `DecisionRecord` type exists in `types.ts:285-300` and `OutcomeRecordedEvent`/`WeightsUpdatedEvent` are defined in `event-types.ts`, but no actual memory storage or retrieval code exists in the codebase. CLAUDE.md references `Memory: hybrid, HNSW: Enabled, Neural: Enabled` and the claude-flow MCP has memory tools (`memory_store`, `memory_search`, `memory_retrieve`, `memory_list`), but none are used. This means the planning engine cannot learn from past template selections, the prompt builder cannot inject project-specific conventions, and the review pipeline cannot identify recurring patterns.

---

## S -- Specification

### Requirements

1. **R1 -- MemoryStore interface.** Create `src/memory/` bounded context with a `MemoryStore` interface: `{ store(key, value, metadata): Promise<void>; search(query, options): Promise<MemoryEntry[]>; retrieve(key): Promise<MemoryEntry | null>; list(namespace, options): Promise<MemoryEntry[]>; delete(key): Promise<boolean> }`.

2. **R2 -- FileMemoryStore implementation.** JSON file-based storage in `data/memory/{owner}/{repo}/` directory. Each namespace is a subdirectory. Each entry is a JSON file keyed by a sanitized key name. Supports TTL-based expiration (default 30 days).

3. **R3 -- MCPMemoryStore implementation.** Delegates to claude-flow MCP memory tools (`memory_store`, `memory_search`, `memory_retrieve`, `memory_list`). Uses MCP tool calls via the existing MCP client infrastructure.

4. **R4 -- HybridMemoryStore implementation.** Local FileMemoryStore as cache + MCPMemoryStore as backend. Reads: check local cache first, fall back to MCP. Writes: write to both. Search: merge results from both, deduplicate by key.

5. **R5 -- Memory entry types.** Three categories of stored knowledge:
   - `DecisionRecord`: what template/agents were used, classification, outcome, duration, cost. Stored after each completed pipeline via `OutcomeRecorded` event.
   - `ReviewPattern`: common review findings for a repository (e.g., "team often forgets error handling in API routes"). Extracted from review findings when same category appears 3+ times.
   - `ProjectConvention`: learned coding conventions (e.g., "uses tabs not spaces", "all API routes return { data, error }"). Extracted from successful reviews with zero findings.

6. **R6 -- Planning engine integration.** Before template selection, query past `DecisionRecord` entries for similar intakes (match by domain, complexity, scope). If a past decision with `outcome: 'success'` exists for similar input, bias toward the same template.

7. **R7 -- Prompt builder integration.** When constructing agent prompts, query `ProjectConvention` entries for the target repository. Inject matched conventions as context in the system prompt.

8. **R8 -- Review pipeline integration.** After each completed pipeline, publish `OutcomeRecorded` event. A subscriber stores the `DecisionRecord` in memory. After review, analyze findings for recurring patterns and store as `ReviewPattern`.

9. **R9 -- Semantic search.** When MCP memory tools are available, use embedding-based semantic similarity for search. When unavailable, fall back to keyword matching (case-insensitive substring match on value and metadata fields).

10. **R10 -- Per-repository isolation.** Memory entries are namespaced by `{owner}/{repo}`. A pipeline for `acme/widget` never sees memory from `acme/gadget` unless explicitly cross-referenced.

11. **R11 -- TTL and cleanup.** Memory entries expire after 30 days by default (configurable per entry). FileMemoryStore checks TTL on read and periodically prunes expired entries.

### Acceptance Criteria

- AC1: `FileMemoryStore.store('key', value, { namespace: 'decisions' })` creates a JSON file at `data/memory/{owner}/{repo}/decisions/key.json`.
- AC2: `FileMemoryStore.retrieve('key')` returns the stored entry with correct value and metadata.
- AC3: `FileMemoryStore.search('authentication')` returns entries whose value or metadata contain the search term.
- AC4: An entry stored 31 days ago is not returned by `retrieve()` or `search()`.
- AC5: `HybridMemoryStore.retrieve('key')` returns from local cache when available, from MCP when not cached locally.
- AC6: After a pipeline completes, a `DecisionRecord` is stored in memory with the correct template, agents, outcome, and duration.
- AC7: Planning engine queries memory for past decisions before selecting a template.
- AC8: Prompt builder includes project conventions in agent system prompts when conventions exist.
- AC9: Per-repository namespace isolation: storing to `acme/widget` does not appear in `acme/gadget` queries.
- AC10: `MCPMemoryStore.search()` uses MCP `memory_search` tool when available.

### Constraints

- Must not introduce external databases. FileMemoryStore uses the filesystem; MCPMemoryStore uses existing MCP infrastructure.
- `DecisionRecord` type in `types.ts:285-300` must not be modified (it is the contract).
- Memory operations must be non-blocking for the pipeline. Store operations can be fire-and-forget (async, no await in hot path).
- File paths must be sanitized to prevent directory traversal (`../` in key or namespace).
- Maximum entry size: 1MB per entry (prevent storing full diffs as memory).
- MCP memory tools may not be available -- all code paths must work with FileMemoryStore alone.

### Edge Cases

- First run for a repository: no memory exists. Planning and prompt builder proceed with defaults.
- MCP memory tools unavailable: HybridMemoryStore operates in file-only mode with info log.
- Concurrent pipeline runs for same repo: FileMemoryStore uses atomic write (write to temp file, rename).
- Key contains special characters: sanitize to filesystem-safe names (replace `/`, `\`, `..` with `_`).
- Memory directory does not exist: create recursively on first write.
- Corrupt JSON file on disk: log warning, skip entry, do not crash.
- Search returns too many results: limit parameter (default 10).
- DecisionRecord with `outcome: 'failure'` stored -- planning engine uses as negative signal (avoid that template).

---

## P -- Pseudocode

### P1 -- MemoryStore Interface and Types

```
interface MemoryEntry:
  key: string
  value: string
  metadata: Record<string, unknown>
  namespace: string
  createdAt: string   // ISO timestamp
  expiresAt: string   // ISO timestamp
  tags: string[]

interface MemoryStoreOptions:
  namespace?: string
  ttlDays?: number     // default: 30
  tags?: string[]

interface SearchOptions:
  namespace?: string
  limit?: number       // default: 10
  minRelevance?: number // 0-1, for semantic search

interface MemoryStore:
  store(key: string, value: string, opts?: MemoryStoreOptions): Promise<void>
  retrieve(key: string, namespace?: string): Promise<MemoryEntry | null>
  search(query: string, opts?: SearchOptions): Promise<MemoryEntry[]>
  list(namespace: string, limit?: number): Promise<MemoryEntry[]>
  delete(key: string, namespace?: string): Promise<boolean>
```

### P2 -- FileMemoryStore

```
class FileMemoryStore implements MemoryStore:
  constructor(basePath: string, logger?)
  // basePath = data/memory/{owner}/{repo}

  async store(key, value, opts?):
    namespace = opts?.namespace ?? 'default'
    dir = path.join(basePath, sanitize(namespace))
    await fs.mkdir(dir, { recursive: true })

    entry = {
      key: sanitize(key),
      value,
      metadata: opts?.metadata ?? {},
      namespace,
      createdAt: new Date().toISOString(),
      expiresAt: addDays(new Date(), opts?.ttlDays ?? 30).toISOString(),
      tags: opts?.tags ?? [],
    }

    // Atomic write: write to temp, rename
    tmpFile = path.join(dir, `.${sanitize(key)}.tmp`)
    targetFile = path.join(dir, `${sanitize(key)}.json`)
    await fs.writeFile(tmpFile, JSON.stringify(entry, null, 2))
    await fs.rename(tmpFile, targetFile)

  async retrieve(key, namespace?):
    ns = namespace ?? 'default'
    filePath = path.join(basePath, sanitize(ns), `${sanitize(key)}.json`)

    try:
      data = await fs.readFile(filePath, 'utf-8')
      entry = JSON.parse(data)
    catch:
      return null

    if new Date(entry.expiresAt) < new Date():
      await fs.unlink(filePath).catch(() => {})
      return null

    return entry

  async search(query, opts?):
    namespace = opts?.namespace
    limit = opts?.limit ?? 10
    results = []
    queryLower = query.toLowerCase()

    dirs = namespace
      ? [path.join(basePath, sanitize(namespace))]
      : await listSubdirs(basePath)

    for dir of dirs:
      files = await fs.readdir(dir).catch(() => [])
      for file of files:
        if !file.endsWith('.json'): continue
        try:
          data = await fs.readFile(path.join(dir, file), 'utf-8')
          entry = JSON.parse(data)
        catch:
          continue  // skip corrupt files

        if new Date(entry.expiresAt) < new Date(): continue

        if entryMatches(entry, queryLower):
          results.push(entry)
          if results.length >= limit: return results

    return results

  function entryMatches(entry, queryLower) -> boolean:
    if entry.value.toLowerCase().includes(queryLower): return true
    if entry.tags.some(t => t.toLowerCase().includes(queryLower)): return true
    if JSON.stringify(entry.metadata).toLowerCase().includes(queryLower): return true
    return false

  async list(namespace, limit?):
    dir = path.join(basePath, sanitize(namespace))
    files = await fs.readdir(dir).catch(() => [])
    entries = []

    for file of files:
      if !file.endsWith('.json'): continue
      entry = await readAndValidate(path.join(dir, file))
      if entry: entries.push(entry)
      if limit and entries.length >= limit: break

    return entries

  async delete(key, namespace?):
    ns = namespace ?? 'default'
    filePath = path.join(basePath, sanitize(ns), `${sanitize(key)}.json`)
    try:
      await fs.unlink(filePath)
      return true
    catch:
      return false

function sanitize(input: string) -> string:
  return input
    .replace(/\.\./g, '_')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .slice(0, 200)

function addDays(date, days) -> Date:
  return new Date(date.getTime() + days * 86400000)
```

### P3 -- MCPMemoryStore

```
class MCPMemoryStore implements MemoryStore:
  constructor(mcpClient: MCPClient, logger?)

  async store(key, value, opts?):
    await mcpClient.callTool('memory_store', {
      key: `${opts?.namespace ?? 'default'}:${key}`,
      value,
      namespace: opts?.namespace ?? 'default',
      tags: opts?.tags?.join(','),
      ttl: (opts?.ttlDays ?? 30) * 86400,
    })

  async retrieve(key, namespace?):
    result = await mcpClient.callTool('memory_retrieve', {
      key: `${namespace ?? 'default'}:${key}`,
      namespace: namespace ?? 'default',
    })
    if !result: return null
    return parseToMemoryEntry(result)

  async search(query, opts?):
    results = await mcpClient.callTool('memory_search', {
      query,
      namespace: opts?.namespace,
      limit: opts?.limit ?? 10,
      threshold: opts?.minRelevance ?? 0.5,
    })
    return results.map(parseToMemoryEntry)

  async list(namespace, limit?):
    results = await mcpClient.callTool('memory_list', {
      namespace,
      limit: limit ?? 50,
    })
    return results.map(parseToMemoryEntry)

  async delete(key, namespace?):
    await mcpClient.callTool('memory_delete', {
      key: `${namespace ?? 'default'}:${key}`,
    })
    return true
```

### P4 -- HybridMemoryStore

```
class HybridMemoryStore implements MemoryStore:
  constructor(local: FileMemoryStore, remote: MCPMemoryStore | null, logger?)

  async store(key, value, opts?):
    await local.store(key, value, opts)
    if remote:
      remote.store(key, value, opts).catch(err =>
        logger?.warn('MCP store failed', { key, error: err })
      )

  async retrieve(key, namespace?):
    // Local cache first
    entry = await local.retrieve(key, namespace)
    if entry: return entry

    // Fall back to MCP
    if remote:
      entry = await remote.retrieve(key, namespace).catch(() => null)
      if entry:
        // Cache locally
        await local.store(entry.key, entry.value, {
          namespace: entry.namespace,
          tags: entry.tags,
        }).catch(() => {})
        return entry

    return null

  async search(query, opts?):
    localResults = await local.search(query, opts)

    if !remote: return localResults

    remoteResults = await remote.search(query, opts).catch(() => [])
    return deduplicateByKey([...localResults, ...remoteResults])
      .slice(0, opts?.limit ?? 10)

  async list(namespace, limit?):
    return local.list(namespace, limit)  // list is local-only for performance

  async delete(key, namespace?):
    localOk = await local.delete(key, namespace)
    if remote:
      remote.delete(key, namespace).catch(() => {})
    return localOk
```

### P5 -- Memory Integration: Pipeline Outcome Recording

```
class OutcomeRecorder:
  constructor(memoryStore: MemoryStore, eventBus: EventBus, logger?)

  init():
    eventBus.subscribe('OutcomeRecorded', async (event) => {
      record = event.payload.decisionRecord
      key = `decision-${record.id}`

      await memoryStore.store(key, JSON.stringify(record), {
        namespace: 'decisions',
        tags: [record.classification.domain, record.classification.complexity,
               record.templateSelected, record.outcome],
      })

      logger?.info('DecisionRecord stored', { id: record.id, outcome: record.outcome })
    })
```

### P6 -- Memory Integration: Planning Engine Query

```
class MemoryAwarePlanningEngine:
  constructor(planningEngine: PlanningEngine, memoryStore: MemoryStore, logger?)

  async createPlan(intakeEvent, triageResult):
    // Query past decisions for similar intakes
    query = `${triageResult.classification.domain} ${triageResult.classification.complexity}`
    pastDecisions = await memoryStore.search(query, {
      namespace: 'decisions',
      limit: 5,
    })

    successfulDecisions = pastDecisions
      .map(e => JSON.parse(e.value) as DecisionRecord)
      .filter(d => d.outcome === 'success')

    if successfulDecisions.length > 0:
      // Use most recent successful template as hint
      hint = successfulDecisions[0].templateSelected
      logger?.info('Memory hint: using past successful template', { hint })
      return planningEngine.createPlan(intakeEvent, triageResult, { templateHint: hint })

    return planningEngine.createPlan(intakeEvent, triageResult)
```

### P7 -- Memory Integration: Prompt Builder

```
class MemoryAwarePromptBuilder:
  constructor(promptBuilder: PromptBuilder, memoryStore: MemoryStore, logger?)

  async buildPrompt(agent, context):
    basePrompt = promptBuilder.buildPrompt(agent, context)

    // Query project conventions
    conventions = await memoryStore.list('conventions', 10).catch(() => [])

    if conventions.length > 0:
      conventionText = conventions
        .map(c => `- ${c.value}`)
        .join('\n')

      return basePrompt + `\n\n## Project Conventions\n${conventionText}`

    return basePrompt
```

### P8 -- Review Pattern Detection

```
class ReviewPatternDetector:
  constructor(memoryStore: MemoryStore, eventBus: EventBus, logger?)

  init():
    eventBus.subscribe('ReviewCompleted', async (event) => {
      verdict = event.payload.reviewVerdict
      if !verdict.findings || verdict.findings.length === 0:
        return  // no findings to learn from

      // Count finding categories
      categoryCounts = countBy(verdict.findings, f => f.category)

      for [category, count] of Object.entries(categoryCounts):
        if count >= 3:
          // Recurring pattern -- store
          key = `pattern-${category}-${Date.now()}`
          await memoryStore.store(key, `Recurring: ${category} (${count} findings)`, {
            namespace: 'patterns',
            tags: [category, 'recurring'],
          })

          logger?.info('ReviewPattern stored', { category, count })
    })
```

### Complexity Analysis

- FileMemoryStore.store: O(1) file write
- FileMemoryStore.retrieve: O(1) file read
- FileMemoryStore.search: O(N * M) where N = files, M = avg entry size -- bounded by limit
- HybridMemoryStore: O(1) retrieve (cache hit), O(1) + network (cache miss)
- OutcomeRecorder: O(1) per event
- Planning query: O(K) where K = past decisions searched (max 5)
- Pattern detection: O(F) where F = findings in a review

---

## A -- Architecture

### New Components

```
src/memory/
  index.ts                      -- Public API: createMemoryStore(config)
  types.ts                      -- MemoryEntry, MemoryStore interface, MemoryStoreOptions
  file-memory-store.ts          -- FileMemoryStore (JSON files on disk)
  mcp-memory-store.ts           -- MCPMemoryStore (claude-flow MCP delegation)
  hybrid-memory-store.ts        -- HybridMemoryStore (local cache + MCP backend)
  sanitize.ts                   -- Path sanitization utilities
  outcome-recorder.ts           -- Subscribes to OutcomeRecorded, stores DecisionRecords
  review-pattern-detector.ts    -- Subscribes to ReviewCompleted, detects recurring patterns
```

### Modified Components

```
src/planning/planning-engine.ts -- Accept optional MemoryStore, query past decisions
src/index.ts                    -- Wire MemoryStore, OutcomeRecorder, PatternDetector
src/pipeline.ts                 -- Pass MemoryStore to planning engine
```

### Component Diagram

```
                        MemoryStore interface
                       /         |           \
           FileMemoryStore  MCPMemoryStore  HybridMemoryStore
           (JSON files)     (MCP tools)     (cache + backend)
                |                               |
          data/memory/                    claude-flow MCP
          {owner}/{repo}/                 memory_store
            decisions/                    memory_search
            patterns/                     memory_retrieve
            conventions/                  memory_list

                    Integration Points
                    ------------------
     OutcomeRecorder  -->  MemoryStore  <--  PlanningEngine
     (EventBus sub)        (decisions)       (query past)

     PatternDetector  -->  MemoryStore  <--  PromptBuilder
     (EventBus sub)        (patterns)        (conventions)
```

### Data Flow

```
Pipeline Execution:
  1. Intake -> Triage -> Planning
                           |
                      Query MemoryStore for past decisions
                      (namespace: decisions, match domain+complexity)
                           |
                      Template selection (with memory hint)
                           |
  2. Execution -> Review -> OutcomeRecorded event
                              |
                         OutcomeRecorder stores DecisionRecord
                         PatternDetector analyzes findings

Next Pipeline Execution:
  1. Planning queries MemoryStore
     -> finds past DecisionRecord with outcome=success
     -> biases toward proven template
  2. PromptBuilder queries conventions
     -> injects project-specific rules into agent prompts
```

### Key Design Decisions

1. **File-based storage over SQLite.** FileMemoryStore avoids native dependencies and is trivially inspectable (JSON files). Trade-off: search is O(N) scan, but N is small (hundreds of entries per repo, not millions).

2. **Hybrid store with local cache.** MCP memory tools provide semantic search but add latency. Local file cache provides fast reads for hot data. Writes go to both for durability.

3. **Fire-and-forget writes.** Memory storage must not block the pipeline. `store()` calls in OutcomeRecorder and PatternDetector are awaited but do not affect pipeline success/failure.

4. **Per-repository namespace isolation.** Prevents cross-contamination between projects. A convention learned in one repo does not leak into another.

5. **Keyword search fallback.** When MCP embedding-based search is unavailable, keyword matching on value, tags, and metadata provides reasonable results for known patterns.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| FileMemoryStore search is slow at scale | LOW | Bounded by repo scope (hundreds, not thousands). Limit parameter caps results. |
| MCP memory tools unavailable | LOW | HybridStore operates in file-only mode. All features work without MCP. |
| Stale memory biases planning toward outdated templates | MEDIUM | 30-day TTL. DecisionRecords include timestamp. Planning prefers recent decisions. |
| Corrupt JSON files | LOW | readAndValidate skips corrupt files with warning. Atomic writes prevent partial writes. |
| Disk space growth | LOW | TTL-based expiration. Periodic prune job. Max entry size 1MB. |
| Race condition on concurrent writes | LOW | Atomic write (temp + rename). Per-key files avoid cross-entry conflicts. |
| Path traversal in key/namespace | MEDIUM | sanitize() strips `..`, `/`, `\` and special characters. |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: sanitize.ts + tests (0 dependencies, pure functions)

Tests:
- `sanitize('normal-key')` returns `'normal-key'`
- `sanitize('../etc/passwd')` returns `'__etc_passwd'`
- `sanitize('key/with/slashes')` returns `'key_with_slashes'`
- `sanitize('a'.repeat(300))` truncates to 200 characters
- `sanitize('')` returns `'_'` (never empty)
- `sanitize('key:with:colons')` returns `'key_with_colons'`
- Does not mutate alphanumeric, dash, underscore, dot

### Step 2: types.ts (0 dependencies, type definitions only)

- Define MemoryEntry, MemoryStore, MemoryStoreOptions, SearchOptions interfaces
- Verify types compile with `npm run build`

### Step 3: file-memory-store.ts + tests (depends on 1, 2)

Tests (London School -- mock fs):
- `store()` creates directory recursively if not exists
- `store()` writes JSON file at correct path
- `store()` uses atomic write (temp file + rename)
- `retrieve()` returns stored entry
- `retrieve()` returns null for nonexistent key
- `retrieve()` returns null for expired entry (and deletes file)
- `search('auth')` returns entries containing 'auth' in value
- `search('auth')` returns entries containing 'auth' in tags
- `search()` respects limit parameter
- `search()` skips expired entries
- `search()` skips corrupt JSON files with warning
- `list()` returns all entries in namespace
- `delete()` removes file and returns true
- `delete()` returns false for nonexistent key
- Path sanitization prevents directory traversal

### Step 4: mcp-memory-store.ts + tests (depends on 2, mock MCP client)

Tests:
- `store()` calls MCP memory_store with correct parameters
- `retrieve()` calls MCP memory_retrieve and maps response
- `search()` calls MCP memory_search with correct query and options
- `list()` calls MCP memory_list with namespace
- `delete()` calls MCP memory_delete
- Handles MCP tool call failure gracefully (returns null/empty)

### Step 5: hybrid-memory-store.ts + tests (depends on 3, 4, mock both stores)

Tests:
- `retrieve()` returns local result when available (no MCP call)
- `retrieve()` calls MCP when local miss, caches result locally
- `store()` writes to both local and MCP
- `store()` succeeds even if MCP fails (local is primary)
- `search()` merges local and MCP results, deduplicates
- `search()` returns local-only results when MCP unavailable
- MCP set to null: all operations use local only

### Step 6: outcome-recorder.ts + tests (depends on 3, mock EventBus + MemoryStore)

Tests:
- Subscribes to `OutcomeRecorded` event on init
- Stores DecisionRecord with correct key, namespace, tags
- Tags include domain, complexity, template, outcome
- Handles store failure gracefully (logs warning, does not throw)

### Step 7: review-pattern-detector.ts + tests (depends on 3, mock EventBus + MemoryStore)

Tests:
- Subscribes to `ReviewCompleted` event on init
- Does NOT store pattern when findings count < 3 per category
- Stores pattern when same category appears 3+ times
- Pattern includes category name and count
- Handles reviews with zero findings (no-op)

### Step 8: planning-engine integration + tests (depends on 3)

Tests (mock MemoryStore):
- When memory has successful past decision, returns template hint
- When memory has no relevant decisions, proceeds with default planning
- When memory has only failed decisions, avoids those templates
- When MemoryStore is null/undefined, planning works as before

### Step 9: index.ts + pipeline.ts wiring + integration tests

Tests:
- `createMemoryStore(config)` returns correct implementation
- Pipeline passes MemoryStore to planning engine
- OutcomeRecorder wired to EventBus
- Full pipeline round-trip: run 1 stores decision, run 2 queries it

### Quality Gates

- All existing planning engine tests pass
- All existing pipeline tests pass
- 100% branch coverage on new modules
- `npm run build` succeeds
- `npm test` passes
- No file system side effects in unit tests (all fs mocked)

---

## C -- Completion

### Verification Checklist

- [ ] MemoryStore interface implemented by all 3 stores (File, MCP, Hybrid)
- [ ] FileMemoryStore creates/reads/searches/deletes JSON files correctly
- [ ] MCPMemoryStore delegates to claude-flow MCP memory tools
- [ ] HybridMemoryStore caches locally and delegates to MCP
- [ ] Path sanitization prevents directory traversal in all stores
- [ ] TTL expiration works (30-day default)
- [ ] Atomic writes prevent corrupt files
- [ ] OutcomeRecorder stores DecisionRecords on pipeline completion
- [ ] ReviewPatternDetector identifies recurring finding categories
- [ ] Planning engine queries past decisions before template selection
- [ ] Per-repository namespace isolation enforced
- [ ] All operations gracefully handle MCP unavailability
- [ ] No pipeline blocking on memory operations
- [ ] Corrupt file handling does not crash the system

### Deployment Steps

1. Merge `src/memory/` bounded context with all implementations.
2. Create `data/memory/` directory (or let FileMemoryStore create on first write).
3. Add `data/memory/` to `.gitignore` (memory is per-deployment, not committed).
4. Set `MEMORY_STORE=file` initially (default, no MCP dependency).
5. Wire OutcomeRecorder and PatternDetector in `src/index.ts`.
6. Run full test suite: `npm test`.
7. Deploy to staging. Run 5-10 pipeline invocations.
8. Verify: `data/memory/{owner}/{repo}/decisions/` contains JSON files.
9. Verify: second pipeline run for same repo shows "Memory hint" in logs.
10. Enable `MEMORY_STORE=hybrid` when MCP memory tools are confirmed available.

### Rollback Plan

1. Set `MEMORY_STORE=file` or remove MemoryStore from pipeline wiring -- planning engine falls back to default template selection.
2. Delete `data/memory/` directory to clear all stored memory.
3. OutcomeRecorder and PatternDetector are EventBus subscribers -- removing them has no effect on pipeline execution.
4. No schema migrations -- memory is append-only JSON files.

### Future Enhancements

- **Convention extraction:** Automatically detect coding conventions from successful reviews (tab vs spaces, naming patterns, import ordering).
- **Memory compaction:** Periodically merge similar DecisionRecords into summary entries.
- **Cross-repo insights:** Optional shared namespace for organization-level patterns.
- **Embedding-based search in FileMemoryStore:** Generate and store embeddings locally for better search without MCP dependency.

---

## Cross-Plan Dependencies

- **No hard dependency** on other gap plans.
- **Benefits from Gap 12 (NATS JetStream):** OutcomeRecorded and ReviewCompleted events are more reliable with persistent event bus. However, memory recording works with in-memory EventBus -- events just are not replayed on restart.
- **Independent of Gap 11 (Security Scanning):** Security findings flow through existing ReviewCompleted events. PatternDetector will naturally pick up recurring security findings.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/memory/index.ts` | NEW |
| `src/memory/types.ts` | NEW |
| `src/memory/file-memory-store.ts` | NEW |
| `src/memory/mcp-memory-store.ts` | NEW |
| `src/memory/hybrid-memory-store.ts` | NEW |
| `src/memory/sanitize.ts` | NEW |
| `src/memory/outcome-recorder.ts` | NEW |
| `src/memory/review-pattern-detector.ts` | NEW |
| `src/planning/planning-engine.ts` | MODIFIED |
| `src/pipeline.ts` | MODIFIED |
| `src/index.ts` | MODIFIED |
| `.gitignore` | MODIFIED (add data/memory/) |
| `tests/memory/file-memory-store.test.ts` | NEW |
| `tests/memory/mcp-memory-store.test.ts` | NEW |
| `tests/memory/hybrid-memory-store.test.ts` | NEW |
| `tests/memory/sanitize.test.ts` | NEW |
| `tests/memory/outcome-recorder.test.ts` | NEW |
| `tests/memory/review-pattern-detector.test.ts` | NEW |
| `tests/planning/planning-engine.test.ts` | MODIFIED |
