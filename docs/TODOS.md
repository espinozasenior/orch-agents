# TODOS

## Sub-task Spawning Capability

**What**: Add `spawn-task` capability so the coordinator can decompose work into parallel agents in separate worktrees.

**Why**: Single-agent execution limits throughput on complex issues. Ramp's background-agents (Open-Inspect) spawns child sessions in separate sandboxes with depth limits and guardrails.

**Pros**: Enables parallel work decomposition, faster complex issue resolution, closer to Open-Inspect architecture.

**Cons**: Requires changes to coordinator-session, worktree management, and task tracking. Needs depth limits and resource guards.

**Context**: The `src/agents/fork/` directory has `forkSubagent.ts` with placeholder-based cache sharing and depth=1 restriction. This could be the foundation for a proper sub-task system. Open-Inspect uses `spawn-task` / `get-task-status` / `cancel-task` primitives with separate sandbox per child.

**Depends on**: GitHub automation PR (createPR, PostExecutionActions) should land first.

**Added**: 2026-04-21 via /plan-eng-review gap analysis against background-agents.

---

## Session State Durability via SQLite

**What**: Persist orchestrator state (running workers, task queue, retry state) to SQLite so it survives process crashes.

**Why**: Currently, in-memory `state.running` map in SymphonyOrchestrator is lost on crash. Background-agents uses Cloudflare Durable Objects for guaranteed state recovery. As usage grows, crash recovery becomes critical.

**Pros**: Crash recovery, ability to resume in-flight work after restart, foundation for multi-process scaling.

**Cons**: Requires serialization of worker state, migration path for existing in-memory state, careful handling of stale entries.

**Context**: OAuth token persistence (`data/oauth-tokens.db`) already uses SQLite via `src/integration/linear/oauth-token-persistence.ts`. Same pattern could extend to orchestrator state. The task backbone (`src/execution/task/`) already tracks task lifecycle — persisting TaskRegistry to SQLite is the natural next step.

**Depends on**: Independent of the GitHub automation PR.

**Added**: 2026-04-21 via /plan-eng-review gap analysis against background-agents.
