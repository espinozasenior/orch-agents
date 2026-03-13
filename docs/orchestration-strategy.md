# Orchestration Strategy: One Way to Do Each Thing

**Version:** 3.0.0
**Date:** 2026-03-10
**Status:** Adopted
**Audience:** Any developer working in this repo
**Runtime:** claude-flow v3.5.15 (RuFlo)

---

## 0. Reality Check: What Works vs What Doesn't

Before any strategy, here is the honest status of every orchestration component as of v3.5.15.

### Functional (use these)

| Component | Status | Evidence |
|-----------|--------|----------|
| `tech-lead-router.cjs` | **Works** | 4-dimension classification, 8 team templates, correct routing for all tested task types. Now wired into `hook-handler.cjs` route handler. |
| `hook-handler.cjs` | **Works** | Dispatches Claude Code hooks (UserPromptSubmit, PreToolUse, PostToolUse, SessionStart, SessionEnd). Successfully calls tech-lead-router when prompt is non-empty. |
| `ruflo workflow run -t <template>` | **Works** | 8 built-in templates (development, research, testing, security-audit, code-review, refactoring, sparc, custom). Encapsulates swarm + agents + tasks. |
| `ruflo route` (Q-Learning) | **Works but useless** | Runs, returns results, accepts feedback. BUT: Q-Table Size = 0, Epsilon = 1.0 (pure random). Routes JWT auth task to "Documenter" at 12.5% confidence. Needs ~50+ feedback cycles to produce better-than-random results. |
| `ruflo route feedback` | **Works** | Accepts task/agent/outcome. Needed to train the Q-Learning router. |
| `ruflo route stats/export/import` | **Works** | Q-table persistence across sessions. |
| `memory_store` / `memory_search` (MCP) | **Works** | SQLite-backed with namespace support. |
| `session_save` / `session_restore` (MCP) | **Works** | Durable session state. |
| `swarm_status` / `agent_status` (MCP) | **Works** | Health monitoring. |
| `ruflo guidance compile/retrieve/gates` | **Works** | Compiles CLAUDE.md into policy bundle with enforcement gates. |
| `ruflo hooks pretrain` | **Works** | 4-step bootstrap pipeline: file scan, pattern extraction, embedding generation, agent config. |
| Embedding Model (all-MiniLM-L6-v2) | **Works** | 384-dim embeddings loaded and functional. |

### Broken or Aspirational (do NOT depend on these)

| Component | Status | Evidence |
|-----------|--------|----------|
| `ruflo neural train` | **Broken** | WASM module `@ruvector/learning-wasm` not found. Falls back to JS simulation. Produces 50 synthetic patterns in 0.0s that are random embeddings, not learned patterns. |
| `ruflo neural predict` | **Broken** | Returns "No similar patterns found" even after training, because the synthetic embeddings don't match real task descriptions. |
| HNSW Index | **Not loaded** | `@ruvector/core` not available. Memory search falls back to non-vector scan. |
| RuVector WASM | **Not loaded** | WASM init fails. All WASM-accelerated features (Flash Attention, SIMD, MicroLoRA) are unavailable. |
| AgentDB controllers | **Broken** | Controller index not found at expected path. The agentdb integration doesn't resolve. |
| `ruflo hooks model-route` | **Untested** | Depends on same infrastructure as neural. May work for basic complexity routing but WASM acceleration is not available. |
| Agent Booster (Tier 1 WASM) | **Not available** | Part of RuVector WASM which is not loaded. The `[AGENT_BOOSTER_AVAILABLE]` signal never fires. |
| `ruflo hooks route` (pattern-based) | **Depends on pretrain** | Works only after `hooks pretrain` has run and generated valid embeddings. Without pretrain, has no patterns to match against. |
| `router.js` (keyword matcher) | **Works but superseded** | Now only used as fallback when tech-lead-router fails to load or prompt is empty. All output was previously hardcoded/fake. |
| `intelligence.cjs` (PageRank) | **Works but isolated** | Runs in-process, persists to JSON. Not connected to any durable storage. Loses graph state between sessions unless explicitly consolidated. |
| `session.js` / `memory.js` | **Works but superseded** | JSON file persistence. MCP tools provide better alternatives. |

### Summary

**3 things actually drive routing today:**
1. `tech-lead-router.cjs` — classifies tasks (works)
2. `ruflo workflow run` — executes workflows (works)
3. `memory_search` MCP — retrieves context (works)

Everything else is either training infrastructure (Q-Learning), broken dependencies (WASM/HNSW/AgentDB), or fallback code.

---

## 1. The Problem in One Sentence

There are 4 routing mechanisms, 3 orchestration methods, and a neural subsystem with broken WASM dependencies. This document picks ONE working path for each concern and marks everything else as what it is: training infrastructure, future capability, or dead code.

---

## 2. Decision Matrix

| Concern | USE THIS | Status | DO NOT USE |
|---------|----------|--------|------------|
| **Task routing** | `tech-lead-router.cjs` via `hook-handler.cjs` | **Working** | `router.js` (fallback only), `ruflo route` (untrained), `hooks route` (needs pretrain), `neural predict` (broken) |
| **Orchestration** | `ruflo workflow run -t <template>` | **Working** | Manual MCP calls (too many steps), `swarm start` (less control) |
| **Memory** | `memory_store` + `memory_search` MCP tools | **Working** | `memory.js` (JSON files), `intelligence.cjs` (PageRank graph) |
| **Sessions** | `hook-handler.cjs` hooks + `session_save`/`session_restore` MCP | **Working** | `session.js` (JSON files) |
| **Policy enforcement** | `ruflo guidance compile` + `guidance retrieve` | **Working** | Manual CLAUDE.md reading |
| **Model tier selection** | Hardcode sonnet as default; use haiku for low-complexity tasks manually | **Workaround** | `hooks model-route` (untested), Agent Booster (WASM broken) |
| **Q-Learning training** | `ruflo route feedback` after each task | **Training** | Relying on Q-Learning for decisions (not ready) |
| **Bootstrap** | `ruflo hooks pretrain` (run once) | **Working** | Skipping bootstrap and hoping things converge |
| **Neural patterns** | Skip entirely | **Broken** | `neural train/predict` (WASM not loaded, synthetic patterns) |
| **Monitoring** | `swarm_status` + `agent_status` MCP tools | **Working** | Polling in loops |

### Fallback Chain

```
ruflo workflow run (primary, working)
    |-- fails? --> MCP tools manually: swarm_init + agent_spawn + task_create (working)
        |-- fails? --> hook-handler.cjs helpers (working, degraded)
            |-- fails? --> hardcoded defaults (always works)
```

---

## 3. The Recommended Workflow

What actually happens today, step by step, with no aspirational features.

```
USER PROMPT
    |
    v
[1] UserPromptSubmit hook fires
    hook-handler.cjs "route" command runs:
      a. tech-lead-router.cjs classifies the task:
         - Domain (backend, frontend, security, research, etc.)
         - Complexity (low/medium/high with percentage)
         - Scope (single-file to cross-repo)
         - Risk (low/medium/high)
      b. Selects one of 8 team templates
      c. Maps template to a ruflo workflow template
      d. If ambiguity > 50%, flags clarification questions
      e. Output: classification, template, topology, agent team, workflow command
    |
    v
[2] Claude reads routing output and picks ONE of:

    Option A (workflow command):
      ruflo workflow run -t <template> --task "<description>"

    Option B (manual MCP, if workflow not suitable):
      swarm_init + agent_spawn (x N) + task_create
    |
    v
[3] Claude supplements with context (parallel, ONE message):
      a. memory_search --> retrieve relevant patterns
      b. ruflo guidance retrieve -t "<task>" --> get CLAUDE.md policies
    |
    v
[4] Agents execute work
    |
    v
[5] On completion:
      a. memory_store --> persist decision record + outcome
      b. ruflo route feedback --> feed outcome to Q-Learning (training, not deciding)
    |
    v
[6] SessionEnd hook fires
    hook-handler.cjs "session-end" runs
```

### What's NOT in this workflow (and why)

| Omitted | Why |
|---------|-----|
| `ruflo route` shadow routing | Adds latency to every hook call for no immediate benefit. Run manually when you want to compare. |
| `hooks model-route` | WASM dependency broken. Hardcode model choice: sonnet for most tasks, haiku for trivial ones. |
| `hooks model-outcome` | No point recording outcomes if model-route isn't making decisions. |
| `neural predict/train` | WASM not loaded. Synthetic patterns. Produces no useful output. |
| `ruflo route export/import` in hooks | Q-table is empty. Add this to hooks when Q-Table Size > 20. |

---

## 4. The Q-Learning Training Path

The Q-Learning router is real infrastructure with a real training loop. It just needs data. Here is the honest timeline.

### Phase 1: Collecting Data (NOW)

**Goal:** Build the Q-table from zero. Do NOT use Q-Learning for decisions.

After each completed task, manually run:
```bash
ruflo route feedback --task "Build REST API" --agent coder --outcome 0.85
```

Check progress:
```bash
ruflo route stats
# Look for: Q-Table Size, Epsilon, Avg TD Error
```

**Milestone:** Q-Table Size > 20, Epsilon < 0.5

### Phase 2: Shadow Comparison (after ~50 tasks)

**Goal:** Compare Q-Learning decisions to tech-lead-router decisions.

```bash
# See what Q-Learning would decide
ruflo route "Implement JWT authentication"

# Compare to tech-lead-router
node .claude/helpers/tech-lead-router.cjs --json "Implement JWT authentication"
```

When Q-Learning agrees with tech-lead-router > 70% of the time, consider wiring shadow routing into the hook.

**Milestone:** Q-Table Size > 50, Epsilon < 0.3, Agreement > 70%

### Phase 3: Q-Learning Primary (after ~200 tasks)

**Goal:** Q-Learning makes routing decisions. Tech-lead-router becomes fallback.

**Prerequisites before switching:**
- Q-Table Size > 200
- Epsilon < 0.1
- Validated on 20+ held-out tasks that Q-Learning picks the correct template

**Milestone:** This is months away at current task volume. Do not rush it.

### Persisting the Q-Table

```bash
# Export (run periodically, not on every session end)
ruflo route export --file .claude-flow/data/q-table.json

# Import (run on session start, only when file exists)
ruflo route import --file .claude-flow/data/q-table.json
```

Add to SessionEnd/SessionStart hooks ONLY when Q-Table Size > 20.

---

## 5. The Agent Type Mismatch

The Q-Learning router knows 8 agent types. The tech-lead-router uses 15+. This affects Q-Learning training only.

### Core 8 (Q-Learning)

| Agent | Role |
|-------|------|
| `coder` | Implementation |
| `tester` | Testing, validation |
| `reviewer` | Code review, quality |
| `architect` | System design |
| `researcher` | Research, analysis |
| `optimizer` | Performance |
| `debugger` | Bug investigation |
| `documenter` | Documentation |

### Mapping Extended to Core 8

| Tech-Lead Type | Maps to Core | Why |
|---------------|-------------|-----|
| `sparc-coord` | `architect` | Coordination = architecture |
| `specification` | `documenter` | Specs = documentation |
| `pseudocode` | `coder` | Pre-implementation |
| `architecture` | `architect` | Direct match |
| `sparc-coder` | `coder` | Implementation variant |
| `security-architect` | `architect` | Security design |
| `security-auditor` | `reviewer` | Auditing = review |
| `performance-engineer` | `optimizer` | Direct match |
| `perf-analyzer` | `optimizer` | Analysis for optimization |
| `release-manager` | `architect` | Release coordination |
| `pr-manager` | `reviewer` | PR = review workflow |
| `code-review-swarm` | `reviewer` | Direct match |
| `backend-dev` | `coder` | Specialized coder |
| `hierarchical-coordinator` | `architect` | Coordination = architecture |
| `cicd-engineer` | `coder` | Pipeline code |

**Rule:** Use core 8 types for `route feedback`. Use extended types for actual agent spawning.

---

## 6. Template Mapping: Tech-Lead to Workflow

| Tech-Lead Template | Workflow Template | Notes |
|-------------------|------------------|-------|
| `quick-fix` | `development` | Minimal agents |
| `research-sprint` | `research` | Research + analysis |
| `feature-build` | `development` | Standard build |
| `sparc-full-cycle` | `sparc` | Full SPARC phases |
| `security-audit` | `security-audit` | Security agents |
| `performance-sprint` | `development` | + optimizer focus |
| `release-pipeline` | `custom` | Needs custom config |
| `fullstack-swarm` | `development` | Max agents |

### Simplified Decision Tree

```
Security review?     --> ruflo workflow run -t security-audit --task "..."
Research/analysis?   --> ruflo workflow run -t research --task "..."
SPARC methodology?   --> ruflo workflow run -t sparc --task "..."
Code review?         --> ruflo workflow run -t code-review --task "..."
Everything else?     --> ruflo workflow run -t development --task "..."
```

---

## 7. Bootstrap and Configuration

### 7.1 One-Time Bootstrap

```bash
# 1. Compile CLAUDE.md into policy bundle
ruflo guidance compile

# 2. Pretrain intelligence from repo (seeds embeddings, NOT neural)
ruflo hooks pretrain

# 3. Verify system health
ruflo doctor --fix
```

### 7.2 `.claude-flow/config.yaml`

```yaml
version: "3.5.15"

swarm:
  topology: hierarchical
  maxAgents: 8
  autoScale: false

memory:
  backend: hybrid
  enableHNSW: true             # Note: HNSW falls back to non-vector scan if @ruvector/core unavailable
  persistPath: .claude-flow/data
  cacheSize: 100

neural:
  enabled: false               # WASM dependencies broken. Enable when @ruvector/learning-wasm is installed.

hooks:
  enabled: true
  autoExecute: true

mcp:
  autoStart: false
  port: 3000
```

### 7.3 `.claude/settings.json` hooks

The current hooks config is correct. No changes needed. The `route` handler in `hook-handler.cjs` now calls `tech-lead-router.cjs` as primary with `router.js` as fallback.

### 7.4 hook-handler.cjs (already applied)

The route handler was updated to:
1. Call `tech-lead-router.cjs` `makeDecision()` as primary
2. Output real classification data (domain, complexity, scope, risk, template, agents)
3. Show ambiguity warnings when score > 50
4. Fall back to `router.js` keyword matcher only when tech-lead-router unavailable or prompt is empty

**Not included (deferred until functional):**
- Shadow Q-Learning routing (adds ~500ms latency per hook call for untrained router)
- Model tier selection via `hooks model-route` (WASM dependency)

---

## 8. Five-Command Cheat Sheet

These are the 5 commands that work TODAY.

```
1. ruflo workflow run -t <template> --task "<description>"
   Templates: development, research, sparc, security-audit, code-review, testing, custom
   When: Starting any work.

2. memory_search (MCP tool)
   Args: query, namespace, limit
   When: Before starting work (find prior patterns) or when stuck.

3. ruflo route feedback --task "<task>" --agent <type> --outcome <0.0-1.0>
   When: After every completed task. Trains Q-Learning for the future.

4. ruflo guidance retrieve -t "<task>"
   When: Get relevant CLAUDE.md policies for the current task.

5. ruflo doctor --fix
   When: Something isn't working. Diagnoses and fixes common issues.
```

### Quick Reference Card

```
"I need to start work"       --> ruflo workflow run -t development --task "..."
"This is a security review"  --> ruflo workflow run -t security-audit --task "..."
"Use SPARC methodology"      --> ruflo workflow run -t sparc --task "..."
"I need context"             --> memory_search (MCP)
"Work is done"               --> ruflo route feedback --task "..." --agent coder --outcome 0.9
"Something is broken"        --> ruflo doctor --fix
"Bootstrap new repo"         --> ruflo guidance compile && ruflo hooks pretrain
```

---

## Architecture Summary

```
+------------------------------------------------------------------------+
|                       Claude Code Session                               |
|                                                                         |
|  [UserPromptSubmit Hook]                                               |
|       |                                                                 |
|       v                                                                 |
|  hook-handler.cjs                                                      |
|       |                                                                 |
|       v                                                                 |
|  tech-lead-router.cjs -----> WORKS: 4-dimension classification         |
|       |                      Domain, Complexity, Scope, Risk            |
|       |                      8 team templates, ambiguity detection      |
|       |                      Maps to ruflo workflow templates           |
|       |                                                                 |
|       v                                                                 |
|  Claude reads output and executes:                                     |
|                                                                         |
|    ruflo workflow run -t <template> --task "<description>"   [WORKS]   |
|    + memory_search for context                               [WORKS]   |
|    + guidance retrieve for policies                          [WORKS]   |
|       |                                                                 |
|       v                                                                 |
|  Agents execute work                                                   |
|       |                                                                 |
|       v                                                                 |
|  On completion:                                                        |
|    memory_store (persist outcome)                            [WORKS]   |
|    ruflo route feedback (train Q-Learning)                   [TRAINING]|
|                                                                         |
|  NOT IN USE (broken/untrained):                                        |
|    ruflo route (Q-table empty)                               [FUTURE] |
|    hooks model-route (WASM broken)                           [BROKEN] |
|    neural predict (synthetic patterns)                       [BROKEN] |
|    HNSW vector search (@ruvector/core missing)               [BROKEN] |
|    Agent Booster (WASM not loaded)                           [BROKEN] |
|                                                                         |
|  [SessionEnd Hook]                                                     |
|    session_save                                              [WORKS]   |
+------------------------------------------------------------------------+
```

### What Changed from v2

| v2 (Strategy 2.0) | v3 (Strategy 3.0) |
|--------------------|---------------------|
| Listed `hooks model-route` as decision matrix item | Marked as untested/broken (WASM dependency) |
| Shadow Q-Learning in hook-handler | Deferred until Q-table has data |
| Neural patterns mentioned as future | Marked as broken with evidence |
| HNSW assumed working | Marked as fallback (non-vector scan) |
| Agent Booster as Tier 1 | Marked as not available |
| 3-tier model routing as feature | Marked as aspirational until WASM fixed |
| `hooks model-outcome` in completion step | Removed (no model routing to record) |
| `route export/import` in session hooks | Deferred until Q-Table > 20 |
| 5 commands (3 CLI + 1 MCP + 1 CLI) | 5 commands (2 CLI + 2 MCP + 1 CLI), all verified working |

---

## Appendix A: Workflow Template Details

### development (covers: quick-fix, feature-build, performance-sprint, fullstack-swarm)

```bash
ruflo workflow run -t development --task "Fix typo in auth.ts line 42"
ruflo workflow run -t development --task "Add pagination to user list API"
ruflo workflow run -t development --task "Build real-time notification system"
```

### research

```bash
ruflo workflow run -t research --task "Compare auth libraries: passport vs clerk vs auth0"
```

### sparc

```bash
ruflo workflow run -t sparc --task "Implement event-sourced order management system"
# Phases: Specification -> Pseudocode -> Architecture -> Refinement -> Completion
```

### security-audit

```bash
ruflo workflow run -t security-audit --task "Review auth module for OWASP Top 10"
```

### code-review

```bash
ruflo workflow run -t code-review --task "Review PR #42: Add rate limiting"
```

### custom (for release-pipeline)

```bash
ruflo workflow run -t custom --task "Release v2.1.0" --config .claude-flow/workflows/release.yaml
```

---

## Appendix B: What Needs Fixing for Full Capability

These are the blockers preventing full use of v3.5.15 features.

| Blocker | Impact | Fix |
|---------|--------|-----|
| `@ruvector/learning-wasm` not installed | Neural train produces synthetic data, no WASM acceleration | Install the WASM module or wait for ruflo to bundle it |
| `@ruvector/core` not installed | HNSW index not loaded, memory_search falls back to non-vector scan | Install the module |
| AgentDB controller path wrong | AgentDB integration broken, pattern persistence degraded | Fix the module resolution path in agentic-flow |
| Q-Table empty (Epsilon 1.0) | Q-Learning router is pure random | Feed 50+ tasks via `route feedback` |
| `hooks model-route` untested | No automated model tier selection | Test manually, verify it works without WASM |

When these are fixed:
- `neural train/predict` becomes useful for pattern-based routing
- HNSW enables true semantic search in `memory_search`
- Q-Learning router can start making real decisions
- Model routing can optimize cost automatically
- Agent Booster can skip LLM calls for simple transforms

---

## Appendix C: MCP Tool Quick Reference

8 tools for daily use (all verified working):

| Tool | When |
|------|------|
| `memory_store` | Persist decision records after task completion |
| `memory_search` | Retrieve prior patterns before starting work |
| `session_save` | Automated by SessionEnd hook |
| `session_restore` | Automated by SessionStart hook |
| `swarm_status` | Manual health check |
| `agent_status` | Debug specific agent issues |
| `task_complete` | Mark task done |
| `swarm_init` + `agent_spawn` | Manual orchestration when `workflow run` isn't suitable |

Tools absorbed by `ruflo workflow run` (don't call directly unless manual mode):
- `swarm_init`, `agent_spawn`, `task_create`, `task_assign`

---

## Phase Execution Flow

  PlanCreated event arrives
    → Execution Engine starts phase loop
      → PhaseRunner (lazy-inits swarm on first call)
        → spawnAgents() for this phase's roles
        → createAndAssign() tasks to agents
        → waitForAgents() with exponential backoff + timeout
        → collectResults() from completed tasks
        → collect() artifacts and storeCheckpoint()
        → gateChecker() runs quality gate
        → return PhaseResult with real artifacts
      → RetryHandler retries if failed
    → Execution Engine calls phaseRunner.dispose() to shutdown swarm
    → Publishes WorkCompleted/WorkFailed

### Key Design Decisions

  - McpClient adapter — only component touching MCP tools; everything else mocks it for TDD
  - Lazy swarm init — swarm created on first phase, reused across phases, disposed at end
  - Backward compatible — when no mcpClient provided, stub behavior preserved (all 309 tests pass)
  - Optional dispose() on PhaseRunner interface for swarm cleanup

### Parallelization (4 agents)

  - Agent 1: mcp-client.ts + error types + tests
  - Agent 2: swarm-manager.ts + tests
  - Agent 3: agent-orchestrator.ts + task-delegator.ts + tests
  - Agent 4: artifact-collector.ts + tests
  - Then Agent 5-6: phase-runner modification + pipeline wiring + E2E tests

## Full Pipeline Execution
Webhook → Triage (P2-standard) → Plan (cicd-pipeline, 2 phases, 5 agents)
    → Phase 1: refinement
      → Swarm init (swarm-1773348896292, star topology)
      → Spawn 2 agents (tester lead + implementer)
      → Create & assign 2 tasks
      → Collect results (2/2 completed)
      → Phase completed (13s)
    → Phase 2: completion
      → Spawn 1 agent
      → Create & assign 1 task
      → Collect results (1/1 completed)
      → Phase completed (6s)
    → Plan execution completed
    → Swarm shutdown
    → Review: PASS, approved
