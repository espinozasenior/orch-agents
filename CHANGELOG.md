# Changelog

All notable changes to this project will be documented in this file.

## [0.0.1.0] - 2026-04-22

### Added

- **Post-Execution Actions Module** — Extracted push, PR creation, review submission, PR comment, and Linear response from `coordinator-dispatcher.ts` into `post-execution-actions.ts`. Each action is independent and failure-isolated.
- **Agent PR Creation** — Agents can now create PRs via `GitHubClient.createPR()` when they push a branch without an existing PR. Includes idempotency handling for already-existing PRs.
- **GitHub Issue Creation** — `GitHubClient.createIssue()` for agents to open issues with labels.
- **Inline Review Comments** — `Finding` type now carries `filePath`, `lineNumber`, and `commitSha` for structured PR review submissions. `diff-review-parser` extracts these from both explicit fields and `path:line` location strings.
- **Agent Depth Limiting** — Maximum agent depth of 3 levels. Workers at max depth have `Agent`/`AgentTool` removed from their allowed tools.
- **Concurrent Worker Cap** — Coordinator injects a capacity warning when the active worker count reaches the configurable max (default 8).
- **Agent Spawn Observability** — `sdk-executor` emits `agentSpawn` events with child prompt preview and subagent type.
- **Agent PR Tracking** — `trackAgentPR()`/`isAgentPR()` for feedback loop prevention on agent-created PRs.
- **Bot PR Skip** — Webhook router skips `pull_request.opened/reopened` events from bot senders to prevent feedback loops.
- **Worktree Isolation Guidance** — Coordinator prompt now instructs write-heavy workers to use `isolation: "worktree"`.

### Changed

- **Coordinator Dispatcher** — Simplified from ~450 LOC to ~400 LOC by delegating post-execution side effects to the new module.
- **ReviewGate Integration** — Coordinator dispatcher now accepts an optional `ReviewGate` dependency and runs it before post-execution actions.
- **Coordinator Session** — Exposes `registerWorker()` for external worker state seeding and accepts `maxChildAgents` config.

## [0.4.0] - 2026-04-12

### Added

- **Public Library Entry Point (#20)** — `src/lib/index.ts` exposes logger, branded IDs, curated domain types, and error types as a zero-side-effect library surface. `package.json` gains an `exports` map with subpath entries (`./compact`, `./review`, `./worktree`, `./github-auth`, `./errors`). Importing orch-agents no longer boots the Fastify server — `main()` is gated behind `require.main === module`.
- **DDD Branded Types + Security Hardening** — Compile-time-safe branded types (`PlanId`, `WorkItemId`, `ExecId`, `LinearIssueId`, `AgentSessionId`, `PhaseId`, `CorrelationId`) with security findings from the CC-approach audit applied.
- **Skill-Based Event Routing — P20 (#18)** — Replaces hardcoded event-type→handler branching with a skill registry that dispatches on skill frontmatter. Spec and implementation in one PR.
- **Deferred Tool Loading — P12 (#15)** — CC-aligned tool registry with `ToolSearch` for just-in-time schema fetching. Matches Claude Code's progressive disclosure pattern.
- **LocalShellTask Executor — P13 (#14)** — Coordinator-direct shell dispatch, no main-thread detour.
- **Query Loop Activation — P11 (#9)** — Overload retry, graceful stop, observability hooks around the Claude Agent SDK query loop.
- **Compaction Integration — P10 (#8)** — Wires CC-style conversation compaction into the agent loop. Also fixes the `npm test` glob to include integration tests.
- **CC Patterns P6–P9 (#6)** — Task backbone, NDJSON permissions stream, fork runtime, coordinator promotion. Four harness primitives landed together.
- **Multi-Repo Workspace Resolution — Phase 8** — `workspace.repos` is now required in WORKFLOW.md; no env-var fallback. Workers resolve repo paths per task from the workspace manifest.
- **flow-nexus Skill Definitions (#21)** — Three project-scoped skills (platform, neural, swarm) for Flow Nexus integrations.

### Changed

- **Coordinator-Only Dispatch Migration (Option C, #10–#13, #17)** — Multi-PR refactor that extracted coordinator dispatch to `src/tasks/local-agent/`, deprecated the template path in the main-thread engine, migrated the worker thread to coordinator-only dispatch, deleted legacy dispatch code, and relocated the dispatcher alongside deletion of the dead `agent-registry`. Net: one dispatch path, zero dead code in the dispatch layer.

### Docs

- **Raw Executor Spike SPARC Spec — P19 (#16)** — Phase A of the agent-SDK migration.
- **Harness Gap Closure Roadmap — P10–P18 SPARC Specs (#7)** — The roadmap that drove most of this release.
- **Research + Article + Walkthrough Batch (#22)** — Claude Code original source deep dive, Hermes agent comparison, Linear weather bot comparison, agent-frameworks productization evaluation, "AI-native startup from day one" walkthrough, and a draft article on Linear's `createComment` vs `createAgentActivity` attribution pitfall.
- **Production Practices** — `CLAUDE.md` updated post-CC-leaks with production-grade behavioral rules.

## [0.3.0] - 2026-03-31

Native Linear Agent API — see [GitHub release](https://github.com/espinozasenior/orch-agents/releases/tag/v0.3.0) for full notes.

## [0.2.0] - 2026-03-26

Initial public structure with SPARC orchestration and Linear webhook integration.
