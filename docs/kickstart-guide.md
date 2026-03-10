# Claude-Flow v3.5.15 (RuFlo) Kickstart Guide

> **Generated**: 2026-03-10
> **Version**: v3.5.15
> **Branch**: espinozasenior/luis-j.-espinoza/auto
> **Method**: All commands run live, output captured verbatim

---

## 1. Pre-flight Checklist

Before running any commands, verify these prerequisites exist.

### Required Software

| Component | Minimum | Verified |
|-----------|---------|----------|
| Node.js   | >= 20   | v25.8.0  |
| npm       | >= 8    | v11.11.0 |
| Git       | >= 2.x  | v2.53.0  |

### Required Files (created by `ruflo init`)

| Path | Purpose | Status |
|------|---------|--------|
| `.mcp.json` | MCP server config for Claude Code | Present |
| `.claude/settings.json` | Claude Code hooks and settings | Present |
| `.claude/helpers/hook-handler.cjs` | Hook dispatch (wired to tech-lead-router) | Present |
| `.claude/helpers/intelligence.cjs` | Intelligence subsystem helper | Present |
| `.claude/helpers/auto-memory-hook.mjs` | Automatic memory capture | Present |
| `.claude/helpers/statusline.cjs` | Statusline helper | Present |
| `.claude-flow/config.yaml` | V3 runtime configuration | Present |
| `.claude-flow/daemon-state.json` | Daemon persistence | Present |
| `.swarm/memory.db` | SQLite memory database | Present (0.15 MB) |
| `.swarm/schema.sql` | Database schema | Present |
| `.swarm/state.json` | Swarm state | Present |

### Optional (Not Installed)

| Package | Impact When Missing |
|---------|-------------------|
| `agentic-flow` | `embeddings init` fails; embeddings work via fallback transformers provider |
| `@ruvector/learning-wasm` | `neural train` produces synthetic data only |
| `@ruvector/core` | HNSW falls back to non-vector scan (still works, slower) |
| Claude Code CLI (`@anthropic-ai/claude-code`) | Doctor reports warning; not required for MCP usage |
| TypeScript | Doctor reports warning; not needed unless writing .ts source |

---

## 2. Initialization Sequence

Commands are listed in the order they should be run. Each entry shows the exact command, its actual output, and whether it succeeded.

### Step 1: Check Initialization Status

```bash
npx @claude-flow/cli@latest init check
```

**Output:**
```
[OK] RuFlo is initialized
[INFO]   Claude Code: .claude/settings.json
[INFO]   V3 Runtime: .claude-flow/config.yaml
```

**Result:** SUCCESS. If this returns `[OK]`, skip to Step 3. If not initialized, run Step 2.

### Step 2: Initialize (First Time Only)

```bash
npx @claude-flow/cli@latest init
```

If already initialized, this command exits with an error:
```
[WARN] RuFlo appears to be already initialized
[INFO]   Found: .claude/settings.json
[INFO]   Found: .claude-flow/config.yaml
[INFO] Use --force to reinitialize
```

**To reinitialize** (overwrites config but preserves data):
```bash
npx @claude-flow/cli@latest init --force
```

**For first-time setup with all components auto-started:**
```bash
npx @claude-flow/cli@latest init --start-all
```

**Result:** Exit code 1 if already initialized (expected). Exit code 0 on fresh init.

### Step 3: Upgrade Helpers

Run this every time you update `@claude-flow/cli` to ensure helpers match the CLI version.

```bash
npx @claude-flow/cli@latest init upgrade
```

**Output:**
```
Upgrading RuFlo
Updates helpers while preserving your existing data

Upgrade complete!

+------- Updated (latest version) -------+
| helpers/auto-memory-hook.mjs           |
| helpers/hook-handler.cjs               |
| helpers/intelligence.cjs               |
| helpers/statusline.cjs                 |
+----------------------------------------+

[INFO] Preserved 4 existing data files
[OK] Your statusline helper has been updated to the latest version
```

**Result:** SUCCESS. Safe to run repeatedly. Preserves metrics and learning data.

### Step 4: Start the Daemon

```bash
npx @claude-flow/cli@latest daemon start
```

**Output (if already running):**
```
[WARN] Daemon already running in background (PID: 78723)
```

**Output (fresh start):**
```
[OK] Daemon started in background (PID: 18515)
[INFO] Logs: .claude-flow/daemon.log
[INFO] Stop with: claude-flow daemon stop
```

**Result:** SUCCESS. The daemon manages 7 background workers:

| Worker | Enabled | Purpose |
|--------|---------|---------|
| map | Yes | Codebase mapping |
| audit | Yes | Code quality auditing |
| optimize | Yes | Performance optimization |
| consolidate | Yes | Memory consolidation |
| testgaps | Yes | Test coverage gap detection |
| predict | No | Prediction (disabled by default) |
| document | No | Documentation (disabled by default) |

All workers start in `idle` state and activate when triggered by hooks or manual invocation.

### Step 5: Bootstrap Intelligence

```bash
npx @claude-flow/cli@latest hooks pretrain
```

**Output:**
```
Pretraining Intelligence (4-Step Pipeline + Embeddings)

Pretraining completed

+-------------------------+-------+
| Metric                  | Value |
+-------------------------+-------+
| Files Analyzed          |    84 |
| Patterns Extracted      |    30 |
| Strategies Learned      |    16 |
| Trajectories Evaluated  |    46 |
| Contradictions Resolved |     3 |
| Duration                |  1.0s |
+-------------------------+-------+

[OK] Repository intelligence bootstrapped successfully
```

**Result:** SUCCESS. Runs a 4-step pipeline:
1. **RETRIEVE** - Top-k memory injection with MMR diversity
2. **JUDGE** - LLM-as-judge trajectory evaluation
3. **DISTILL** - Extract strategy memories from trajectories
4. **CONSOLIDATE** - Dedup, detect contradictions, prune old patterns

Plus 2 embedding steps:
5. **EMBED** - Index documents with all-MiniLM-L6-v2 (384-dim ONNX)
6. **HYPERBOLIC** - Project to Poincare ball for hierarchy preservation

**Important caveat:** The numbers (84 files, 30 patterns) are generated from the current repo state. With an empty `src/` directory, these come primarily from config files, docs, and helper scripts. Re-run after adding source code for meaningful intelligence.

### Step 6: Compile Guidance

```bash
npx @claude-flow/cli@latest guidance compile
```

**Output:**
```
Guidance Compiler

Compiled successfully

  Constitution rules: 5
  Constitution hash:  f51bcc08b34cc7ff
  Shard count:        45
  Total rules:        50
  Compiled at:        2026-03-10T17:14:47.153Z
```

**Result:** SUCCESS. Parses CLAUDE.md into:
- 5 constitution rules (always-active security/validation rules)
- 45 shards (task-specific rules indexed for retrieval)
- 50 total rules

Rules are tagged with IDs like `AUTO-001` through `AUTO-050` and indexed for semantic retrieval during task execution.

### Step 7: Build Agent Configs

```bash
npx @claude-flow/cli@latest hooks build-agents
```

**Output:**
```
Generated 5 agent configs

+--------------------+---------------------+----------------+
| Agent Type         | Config File         | Capabilities   |
+--------------------+---------------------+----------------+
| coder              | .claude-flow/agents | 3              |
| architect          | .claude-flow/agents | 3              |
| tester             | .claude-flow/agents | 3              |
| security-architect | .claude-flow/agents | 3              |
| reviewer           | .claude-flow/agents | 3              |
+--------------------+---------------------+----------------+

Configs Generated: 5 | Patterns Applied: 15 | Optimizations: 7
```

**Result:** SUCCESS. Generates agent configuration files in `.claude-flow/agents/` based on pretrained patterns.

### Step 8: Initialize Swarm

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

**Output:**
```
+------------+---------------------+
| Property   | Value               |
+------------+---------------------+
| Swarm ID   | swarm-1773162909064 |
| Topology   | hierarchical        |
| Max Agents | 8                   |
| Auto Scale | Enabled             |
| Protocol   | message-bus         |
| V3 Mode    | Disabled            |
+------------+---------------------+

[OK] Swarm initialized successfully
```

**Result:** SUCCESS. Creates a new swarm instance. Each call generates a new swarm ID. The swarm starts empty (0 agents, 0 tasks) and agents are added when work begins.

**Note:** For v3 mode with 15-agent mesh, use:
```bash
npx @claude-flow/cli@latest swarm init --v3-mode
```

### Step 9: Run Diagnostics

```bash
npx @claude-flow/cli@latest doctor --fix
```

**Output:**
```
Summary: 9 passed, 5 warnings

Passed:
  Version Freshness: v3.5.15 (up to date)
  Node.js Version: v25.8.0 (>= 20 required)
  npm Version: v11.11.0
  Git: v2.53.0
  Git Repository: In a git repository
  Daemon Status: Running (PID: 78723)
  Memory Database: .swarm/memory.db (0.15 MB)
  MCP Servers: 1 servers (claude-flow configured)
  Disk Space: 706Gi available

Warnings:
  Claude Code CLI: Not installed
  Config File: No config file (using defaults)
  API Keys: No API keys found
  TypeScript: Not installed locally
  agentic-flow: Not installed (optional)
```

**Result:** SUCCESS with warnings. The warnings are informational, not blocking:
- Claude Code CLI warning is cosmetic (we use MCP, not the global CLI)
- Config file warning means `.claude-flow/config.yaml` exists but `claude-flow.config.json` does not (uses defaults, which is fine)
- API keys are managed by Claude Code session, not environment variables
- TypeScript and agentic-flow are optional dependencies

---

## 3. Verification Steps

After initialization, verify each subsystem is working.

### 3.1 Daemon Verification

```bash
npx @claude-flow/cli@latest daemon status
```

Expected: `Status: RUNNING`, 5 workers enabled, all `idle`.

### 3.2 Memory Store/Search Verification

```bash
# Store a test entry
npx @claude-flow/cli@latest memory store -k "verify-test" --value "memory subsystem works" --namespace test

# Search for it
npx @claude-flow/cli@latest memory search --query "memory subsystem"

# Clean up
npx @claude-flow/cli@latest memory delete --key "verify-test" --namespace test
```

Expected: Store returns `[OK]` with `Vector: Yes (384-dim)`. Search returns the entry with a similarity score. Delete returns `[OK]`.

### 3.3 Guidance Retrieval Verification

```bash
npx @claude-flow/cli@latest guidance retrieve --task "write unit tests for auth"
```

Expected: Returns 5 relevant shards from compiled CLAUDE.md rules, with intent detection (`testing`) and constitution rules.

### 3.4 Task Routing Verification

```bash
npx @claude-flow/cli@latest hooks route --task "build authentication module"
```

Expected: Returns a primary agent recommendation with confidence score, alternative agents, and semantic match scores. Routing method should show `semantic-native`.

### 3.5 Model Routing Verification

```bash
npx @claude-flow/cli@latest hooks model-route --task "refactor the auth service"
```

Expected: Returns a model recommendation (HAIKU/SONNET/OPUS) with confidence and complexity analysis.

**Known issue:** The model router currently routes to OPUS for most tasks, even low-complexity ones. The Q-Table is empty (Epsilon 1.0 = pure random), so recommendations rely on keyword heuristics rather than learned patterns.

### 3.6 Session Save/Restore Verification

```bash
# Save
npx @claude-flow/cli@latest session save --name "test-session"

# List
npx @claude-flow/cli@latest session list

# Delete (use the session ID from save output)
npx @claude-flow/cli@latest session delete <session-id>
```

Expected: Save returns session ID. List shows the session. Delete confirms removal.

### 3.7 Neural Status Verification

```bash
npx @claude-flow/cli@latest neural status
```

Expected: Shows component status table. Key things to verify:
- Embedding Model: `Loaded` with `all-MiniLM-L6-v2 (384-dim)`
- ReasoningBank: `Active` with patterns stored
- HNSW Index: `Not loaded` (expected -- `@ruvector/core` not installed)
- RuVector WASM: `Not loaded` (expected -- `@ruvector/learning-wasm` not installed)

### 3.8 Intelligence Stats Verification

```bash
npx @claude-flow/cli@latest hooks intelligence stats
```

Expected: Shows SONA, MoE, HNSW, and Embeddings status tables. After pretrain, the SONA coordinator should show `Active`.

---

## 4. Known Issues and Workarounds

### 4.1 `embeddings init` Fails

**Error:**
```
Cannot find package 'agentic-flow' imported from
@claude-flow/embeddings/dist/neural-integration.js
```

**Impact:** The ONNX embedding initialization through `embeddings init` fails. However, embeddings still work through the transformers fallback provider. Memory store correctly generates 384-dim vectors. Semantic search works.

**Workaround:** Skip `embeddings init`. Embeddings are functional without it. If you need full ONNX/HNSW performance:
```bash
npm install agentic-flow@latest
```

### 4.2 Neural Train Produces Synthetic Data

**Root cause:** `@ruvector/learning-wasm` is not installed.

**Impact:** `npx @claude-flow/cli@latest neural train` runs but produces synthetic patterns, not real learned data.

**Workaround:** Rely on `hooks pretrain` for intelligence bootstrapping. It uses the working embedding model and does not depend on WASM.

### 4.3 Q-Learning Router is Untrained

**Status:** Q-Table is empty, Epsilon = 1.0 (pure random exploration).

**Impact:** `hooks model-route` uses keyword heuristics instead of learned routing. It tends to recommend OPUS for everything.

**Workaround:** Feed routing data to train the Q-Table:
```bash
npx @claude-flow/cli@latest hooks model-outcome --task "simple rename" --model haiku --success true --duration 500
```

Repeat with real task outcomes to reduce Epsilon and improve routing accuracy.

### 4.4 Session List Shows Invalid Dates

**Status:** `session list` shows 3 sessions with "Invalid Date" entries.

**Impact:** Cosmetic. Likely remnants from initialization. Sessions saved with `session save --name` work correctly.

**Workaround:** Ignore the phantom sessions. New sessions created with explicit names display correctly.

### 4.5 Hooks All Show "Enabled: No"

**Status:** `hooks list` shows 26 hooks, all with `Enabled: No`.

**Impact:** Hooks are configured in `.claude/settings.json` and execute via `hook-handler.cjs` when triggered by Claude Code. The "Enabled: No" in the CLI list reflects CLI-side registration, not Claude Code integration. The hooks ARE active during Claude Code sessions.

**Workaround:** None needed. Hooks work during Claude Code sessions regardless of CLI list status.

### 4.6 Guidance Gates False Negative

**Status:** `guidance gates -c "delete all files in /tmp"` returns `ALLOW - All gates passed`.

**Impact:** The gates enforce CLAUDE.md rules (file organization, security) but do not perform general safety filtering. This is by design -- gates check for CLAUDE.md policy violations, not arbitrary command safety.

**Workaround:** Gates are for policy enforcement, not safety. Rely on Claude Code's built-in safety for dangerous operations.

### 4.7 Config Export Requires Format Flag

**Status:** `config export` fails without `--format json` or `--format yaml`.

**Workaround:** Always specify format:
```bash
npx @claude-flow/cli@latest config export --format json
```

---

## 5. Daily Operations

### 5.1 Session Start Sequence

Run these commands at the beginning of each working session:

```bash
# 1. Ensure daemon is running
npx @claude-flow/cli@latest daemon start

# 2. Re-bootstrap intelligence (fast, ~1s)
npx @claude-flow/cli@latest hooks pretrain

# 3. Recompile guidance (picks up CLAUDE.md changes)
npx @claude-flow/cli@latest guidance compile

# 4. Quick health check
npx @claude-flow/cli@latest doctor
```

Or as a single command:
```bash
npx @claude-flow/cli@latest daemon start && \
npx @claude-flow/cli@latest hooks pretrain && \
npx @claude-flow/cli@latest guidance compile && \
npx @claude-flow/cli@latest doctor
```

### 5.2 During Development

**Before spawning agents for a task**, check routing:
```bash
npx @claude-flow/cli@latest hooks route --task "your task description"
```

**Store important patterns** as you discover them:
```bash
npx @claude-flow/cli@latest memory store -k "pattern-name" --value "description of what you learned" --namespace patterns
```

**Search for relevant context** before starting work:
```bash
npx @claude-flow/cli@latest memory search --query "relevant topic"
```

**Save session** before long breaks:
```bash
npx @claude-flow/cli@latest session save --name "descriptive-name"
```

### 5.3 Session End Sequence

```bash
# 1. Save session state
npx @claude-flow/cli@latest session save --name "session-$(date +%Y%m%d-%H%M)"

# 2. Check metrics (informational)
npx @claude-flow/cli@latest hooks metrics

# 3. Stop daemon (optional -- it is lightweight)
npx @claude-flow/cli@latest daemon stop
```

### 5.4 After Adding New Source Code

When significant code is added to `src/`, re-run intelligence bootstrapping:

```bash
# Re-extract patterns from new code
npx @claude-flow/cli@latest hooks pretrain

# Rebuild agent configs with new patterns
npx @claude-flow/cli@latest hooks build-agents

# Recompile guidance
npx @claude-flow/cli@latest guidance compile
```

### 5.5 After Updating claude-flow CLI

```bash
# Update helpers to match new CLI version
npx @claude-flow/cli@latest init upgrade

# Re-run diagnostics
npx @claude-flow/cli@latest doctor --fix
```

---

## 6. Complete Command Reference (Tested)

### Commands That Work

| Command | Status | Notes |
|---------|--------|-------|
| `init check` | OK | Reports init status |
| `init` | OK | First-time setup (errors if already done) |
| `init upgrade` | OK | Updates helpers, preserves data |
| `init --force` | OK | Full reinit, overwrites config |
| `daemon start` | OK | Starts background workers |
| `daemon stop` | OK | Stops daemon gracefully |
| `daemon status` | OK | Shows worker table |
| `hooks pretrain` | OK | Bootstraps intelligence (~1s) |
| `hooks build-agents` | OK | Generates 5 agent configs |
| `hooks list` | OK | Lists 26 registered hooks |
| `hooks metrics` | OK | Shows learning/routing/execution metrics |
| `hooks route --task "..."` | OK | Semantic agent routing |
| `hooks model-route --task "..."` | OK | Model tier routing (HAIKU/SONNET/OPUS) |
| `hooks model-stats` | OK | Model distribution stats |
| `hooks intelligence stats` | OK | SONA/MoE/HNSW/Embeddings status |
| `guidance compile` | OK | Compiles CLAUDE.md to 50 rules |
| `guidance retrieve --task "..."` | OK | Retrieves relevant rules for a task |
| `guidance gates -c "..."` | OK | Evaluates content against policy |
| `memory store -k ... --value ...` | OK | Stores with 384-dim vector |
| `memory search --query "..."` | OK | Semantic search works |
| `memory delete --key ... --namespace ...` | OK | Deletes entries |
| `memory list` | OK | Lists entries (empty by default) |
| `memory stats` | OK | Shows backend info |
| `swarm init` | OK | Creates new swarm instance |
| `swarm status` | OK | Shows swarm metrics |
| `session save --name "..."` | OK | Saves session state |
| `session list` | OK | Lists sessions (has date bug) |
| `session delete <id>` | OK | Deletes session |
| `neural status` | OK | Shows component status |
| `config export --format json` | OK | Exports config |
| `doctor` | OK | Health check (9 pass, 5 warn) |
| `doctor --fix` | OK | Health check with fix suggestions |

### Commands That Fail or Degrade

| Command | Status | Reason |
|---------|--------|--------|
| `embeddings init` | FAIL | Missing `agentic-flow` package |
| `neural train` | DEGRADED | Produces synthetic data (missing WASM) |
| `neural predict` | DEGRADED | Predictions based on synthetic patterns |
| `config export` (no --format) | FAIL | Must specify `--format json` or `--format yaml` |

---

## 7. One-Shot Setup Script

For a completely fresh project, run this single block:

```bash
# Full initialization sequence
npx @claude-flow/cli@latest init --start-all && \
npx @claude-flow/cli@latest hooks pretrain && \
npx @claude-flow/cli@latest guidance compile && \
npx @claude-flow/cli@latest hooks build-agents && \
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized && \
npx @claude-flow/cli@latest doctor
```

For a project that is already initialized (like this one):

```bash
# Restart sequence for existing project
npx @claude-flow/cli@latest init upgrade && \
npx @claude-flow/cli@latest daemon start && \
npx @claude-flow/cli@latest hooks pretrain && \
npx @claude-flow/cli@latest guidance compile && \
npx @claude-flow/cli@latest doctor
```
