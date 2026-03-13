# SPARC Plan 2: Hook Pollution Fix

## Priority: P0 — Execute First
## Estimated Effort: 5.5 days
## Status: Planning

---

## Problem Statement

Every `spawn('claude', ['--print', '-'])` call in `task-executor.ts` inherits the project's `.claude/settings.json` hooks. This causes:

1. **Hook output pollution** — SessionStart, UserPromptSubmit, Stop, SessionEnd hooks write to stdout, mixing with Claude's actual response. `extractJson()` may fail.
2. **Race condition** — SessionEnd intelligence consolidation and auto-memory sync run on every agent exit. 8 concurrent agents = 8 parallel writes to same files.
3. **Orphaned sessions** — Each `--print` agent creates persistent session JSONL files (~25MB accumulated).
4. **Wasted latency** — session-restore, memory import, routing all run on agents whose prompts are already determined.
5. **Ghost hooks** — 5 user-level Dorothy hooks reference nonexistent directory, fail silently on every spawn.

---

## S — Specification

### Requirements

1. **R1 — Isolate agent processes from project hooks.** Spawned `claude --print -` processes must not execute any hooks defined in the project's `.claude/settings.json`. Mechanism: set the working directory of the child process to a clean temporary directory that contains no `.claude/settings.json`.

2. **R2 — Prevent session file accumulation.** Each `--print` invocation currently creates session JSONL files. The system must use a temporary directory that is removed after agent completion.

3. **R3 — Protect extractJson from hook stdout pollution.** Even if hook isolation fails, `extractJson()` must be hardened to skip known hook output patterns before attempting JSON extraction.

4. **R4 — Prevent concurrent writes to shared files.** The SessionEnd hook runs intelligence consolidation. With 8 concurrent agents, this means 8 parallel writes. R1 eliminates this, but as defense-in-depth, extractJson hardening serves as a safety net.

5. **R5 — Document ghost hooks.** Identify user-level hooks in `~/.claude/settings.json` that reference nonexistent paths. Document as known operational issue.

### Acceptance Criteria

- AC1: A `claude --print -` process spawned by `task-executor.ts` produces zero hook-related output in stdout.
- AC2: After running 8 concurrent agents, zero new session JSONL files exist in the project directory.
- AC3: `extractJson('{"valid": true}\n[hook: session-end] consolidating...')` returns `'{"valid": true}'`.
- AC4: Running 8 concurrent agents does not produce file corruption in `.claude/` helper outputs.
- AC5: Ghost hook paths are documented.

### Constraints

- Must not modify `.claude/settings.json` — hooks are needed for the interactive orchestrator session.
- Must not require changes to Claude CLI — we control only spawn arguments and environment.
- Must work on macOS and Linux.
- Must preserve the ability for agents to access project files via absolute paths in prompts.

### Edge Cases

- Claude CLI may use `$HOME/.claude/settings.json` as fallback — user-level hooks still fire.
- Agent needs project file access — cwd isolation must not prevent this (absolute paths in prompts).
- Temporary directory cleanup must handle process crashes (`os.tmpdir()` with cleanup-on-exit).
- Future Claude CLI versions may skip hooks in `--print` mode natively — solution must be compatible.

---

## P — Pseudocode

### P1 — Hook Isolation via Clean CWD

```
function createAgentSandbox():
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-'))
  return {
    cwd: tmpDir,
    cleanup():
      try: fs.rmSync(tmpDir, { recursive: true, force: true })
      catch: // Best-effort; OS handles tmpdir eventually
  }
```

### P2 — Hardened extractJson

```
function extractJson(text):
  // Step 1: Strip known hook output patterns
  cleaned = text
    .split('\n')
    .filter(line => !isHookOutput(line))
    .join('\n')

  // Step 2: Existing extraction logic on cleaned text
  return extractJsonFromClean(cleaned)

function isHookOutput(line):
  return line.startsWith('[hook:')
    || line.startsWith('Session restored')
    || line.startsWith('Memory imported')
    || line.match(/^\[.*hook.*\]/i)
    || line.startsWith('Intelligence consolidated')
    || line.startsWith('Auto-memory synced')
```

### P3 — Session File Cleanup

```
function createAgentCleaner(tmpDirs: Set<string>):
  process.on('exit', () => {
    for dir of tmpDirs:
      try: fs.rmSync(dir, { recursive: true, force: true })
      catch: pass
  })

  return {
    register(dir): tmpDirs.add(dir)
    cleanup(dir):
      fs.rmSync(dir, { recursive: true, force: true })
      tmpDirs.delete(dir)
  }
```

### Complexity Analysis

- CWD isolation: O(1) per spawn (mkdir + cleanup). Minimal overhead.
- extractJson hardening: O(n) where n = lines in output. Filter pass adds negligible overhead.
- Session cleanup: O(k) where k = number of agents spawned. Bounded by maxAgents.

---

## A — Architecture

### Approach Selection

| Approach | Pros | Cons | Selected |
|----------|------|------|----------|
| Change cwd to tmpdir | Simple, works today, no CLI flags needed | Agent cannot use relative paths | **YES** |
| `--no-hooks` CLI flag | Clean, intentional | May not exist in current CLI | NO |
| Empty `.claude/settings.json` in tmpdir | Overrides project hooks | CLI may walk up directory tree | NO |
| Modify `env.HOME` | Prevents user-level hooks too | Breaks other HOME-dependent behavior | NO |
| Strip hook output post-hoc | No spawn changes | Race conditions/file writes still happen | Defense-in-depth only |

### New Components

```
src/execution/agent-sandbox.ts  — createAgentSandbox() factory: mkdtemp + cleanup
```

### Modified Components

```
src/execution/task-executor.ts  — Use sandbox cwd in spawn opts; harden extractJson
```

### Integration

- `createClaudeTaskExecutor` calls `createAgentSandbox()` before spawn
- Uses `sandbox.cwd` in spawn options
- Calls `sandbox.cleanup()` in `finally` block after process exit
- `extractJson()` gains a pre-filter step (backward-compatible)

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude CLI needs cwd for internal ops | LOW | `--print` mode is stdin-only, no cwd dependency |
| Temp dir creation fails (disk full) | LOW | Fall back to project cwd with warning log |
| User-level hooks still fire | LOW | Document as known limitation |

---

## R — Refinement (TDD Implementation Order)

### Step 1: agent-sandbox.ts + tests (0 dependencies)

Tests:
- `createAgentSandbox()` creates a temporary directory that exists
- Temporary directory contains no `.claude` subdirectory
- `cleanup()` removes the directory
- `cleanup()` on already-removed directory does not throw
- Directory is created under `os.tmpdir()`

### Step 2: extractJson hardening + tests (0 dependencies)

Tests:
- Existing behavior preserved for clean JSON input
- JSON extracted correctly when preceded by hook output lines
- JSON extracted correctly when followed by hook output lines
- JSON extracted correctly when interleaved with hook output
- Hook output patterns correctly identified (each pattern)
- Legitimate JSON containing the word "hook" is NOT stripped

### Step 3: task-executor.ts integration + tests (depends on 1, 2)

Tests:
- Spawned process uses a cwd that is NOT the project directory
- After execution completes, temporary directory is cleaned up
- After execution fails, temporary directory is still cleaned up
- `extractJson` with hook-polluted output still extracts valid JSON

### Step 4: Process exit cleanup (defense-in-depth)

Tests:
- On process exit signal, remaining temp directories are cleaned

### Quality Gates

- All existing tests pass (zero regressions)
- New tests achieve 100% branch coverage on new modules
- `npm run build` succeeds
- `npm test` passes

---

## C — Completion

1. **Integration test:** Full pipeline E2E with sandbox isolation. Verify no hook output in stdout.
2. **Concurrency test:** 8 agents concurrently (stub mode with sandbox). No file conflicts, no orphaned temp dirs.
3. **Manual verification:** Real `claude --print -` with sandbox. Compare stdout with/without sandbox.
4. **Operational notes:** Document ghost hooks (5 user-level Dorothy hooks referencing nonexistent paths).
5. **Monitoring:** Structured logs for `agent.sandbox.created` and `agent.sandbox.cleaned`.

---

## Cross-Plan Dependencies

- **No dependency** on Plan 1 (Dorothy Improvements)
- **Must execute before** Plan 1's Refinement phase
- Plan 1's `StreamingTaskExecutor` will inherit sandbox isolation from this fix

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/execution/agent-sandbox.ts` | NEW |
| `src/execution/task-executor.ts` | MODIFIED |
| `tests/execution/agent-sandbox.test.ts` | NEW |
| `tests/execution/task-executor.test.ts` | MODIFIED |
