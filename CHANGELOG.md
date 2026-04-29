# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1.0] - 2026-04-28 — Security Hardening

### Added

- **Admin surface isolation** — Admin routes (`/secrets`, `/automations`, `/children`, `/status`, `/webhooks/staging-validate`) now run on a separate Fastify instance bound to `127.0.0.1:3001`. Public routes (`/webhooks/{github,linear,slack}`, `/oauth/*`, `/health`) stay on the tunneled port. The Cloudflare Quick Tunnel can no longer expose admin endpoints. New `ADMIN_PORT` env var (default 3001).
- **ReviewGate verdict enforcement** — When a ReviewGate verdict returns `fail`, push and PR creation are now skipped; the agent's local commit dies with the worktree. Inline finding comments and Linear/PR summaries still post with a "BLOCKED BY REVIEW GATE" notice. New `REVIEW_GATE_ENFORCE` env var (default `true`; set `false` to fall back to advisory-only mode). ReviewGate is also now actually wired into the coordinator dispatcher path — previously the verdict-check code was dead.
- **`statusRoute` plugin** — `/status` endpoint extracted from the public webhook router into its own admin-only Fastify plugin.

### Changed

- **GitHub Actions pinned to commit SHAs** — `softprops/action-gh-release@v2` (third-party, has access to `NPM_TOKEN`), `actions/checkout@v4`, and `actions/setup-node@v4` are now pinned to specific commit SHAs in `.github/workflows/{ci,release}.yml`. Closes a supply-chain risk on the npm release flow.

### Fixed

- **fastify CVE GHSA-247c-9743-5963 (CVSS 7.5)** — Body-schema validation bypass via leading-space Content-Type header. Patched by lockfile bump 5.8.4 → 5.8.5 (constraint `^5.8.2` unchanged).
- **Transitive `hono` and `@hono/node-server` advisories** — Six advisories cleared via `npm audit fix`; `npm audit` now reports 0 vulnerabilities.

### Security

- Closes 7 of 9 findings from a /cso security audit. The remaining 2 (README rephrasing for ReviewGate semantics; expanded forbidden-pattern list in `artifact-applier.ts`) are deferred as separate scope.

## [0.1.0.1] - 2026-04-24

### Fixed

- **Cron Scheduler Double-Fire Guard** — `cron-scheduler.ts` now tracks the last-fired calendar minute per automation and skips duplicate dispatches within the same minute. Fixes #37 — under timer jitter (GC pause, event-loop stall, CI contention), the 60s tick loop could land in the same wall-clock minute twice and fire an automation twice.

## [0.1.0.0] - 2026-04-24 — Open-Inspect Parity Release

### Added

- **Automations System** — New `src/scheduling/` bounded context with cron scheduling (5-field expressions), generic inbound webhooks, Sentry alert triggers, auto-pause after 3 consecutive failures, manual trigger API, and SQLite run history. Configured via WORKFLOW.md `automations:` block.
- **Interactive Slack Bot** — New `src/integration/slack/` with bidirectional messaging: @mention to start sessions, in-thread replies with results, repo classification from message text, HMAC signature verification.
- **Encrypted Secrets Store** — New `src/security/` with AES-256-GCM encryption, per-repo and global scoping, SQLite persistence, HTTP management API (GET/PUT/DELETE /secrets).
- **Repo Lifecycle Scripts** — Two-layer resolution: WORKFLOW.md `lifecycle:` overrides, then `.orch-agents/setup.sh` and `start.sh` discovered in worktree. Setup failure aborts, start failure degrades gracefully.
- **Model Override** — `model:opus` labels on Linear issues set `intakeEvent.modelOverride` flowing through to the SDK executor.
- **GitHub Bot Parity** — Review on bot assignment (`review_requested`), eyes reaction on receipt, commit attribution (Author=user, Committer=bot), review thread context (file path, line, diff hunk).
- **Child Agent Status API** — `GET /children`, `GET /children/:id`, `POST /children/reset-pause` for programmatic child agent management.
- **Auto-Pause Circuit Breaker** — DirectSpawnStrategy pauses spawning after 3 consecutive failures. Manual reset via endpoint.
- **Automation HTTP Routes** — `GET /automations`, `POST /automations/:id/trigger`, `POST /automations/:id/resume`, `POST /webhooks/automation/:id`.

### Fixed

- **Bot Identity** — `GH_TOKEN` now passes through `buildSafeEnv()` to child agents so `gh` CLI authenticates as `automata-ai-bot[bot]`, not the ambient user.
- **Per-Repo Token Resolution** — `getGitHubToken(repo)` resolves the correct GitHub App installation token per-repo, fixing bot auth on org repos (somnio-projects).
- **Concurrency Safety** — GH_TOKEN and repo secrets are now collected into per-execution `extraEnv` records passed via `InteractiveExecutionRequest`, not mutated on global `process.env`. Prevents cross-repo token leakage.

### Changed

- **Event Type Cleanup** — Pruned 20 declared-but-never-published event types from the architecture doc. 28 live events remain.
- **Slack Notifier Retired** — `src/notification/slack-notifier.ts` deleted, superseded by `src/integration/slack/slack-responder.ts`.
- **Workflow Config Store Moved** — From `src/integration/linear/` to `src/config/` where it belongs.
- **buildSafeEnv() Gains extraAllowedKeys** — For injecting repo secrets into child process environments without modifying the global allowlist.
- **SQLite Stores Harden PRAGMAs** — All three SQLite stores (OAuth tokens, automation runs, encrypted secrets) now open via a shared `src/shared/sqlite.ts` helper that sets `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, and `foreign_keys=ON`. Readers no longer block the writer, and `SQLITE_BUSY` is handled internally by SQLite's sleep-and-retry before surfacing.

## [0.0.2.0] - 2026-04-22

### Added

- **Direct Sub-Agent Spawning** — `AGENT_SPAWN_MODE=direct` feature flag routes AgentTool calls through SwarmDaemon instead of the SDK's built-in handler. Gives full programmatic control: status queries, cancellation, hard worktree isolation, capacity enforcement.
- **DirectSpawnStrategy** — Core spawn logic with worktree creation, SwarmDaemon dispatch, block-until-complete pattern, and parent AbortSignal propagation for cancellation.
- **DirectSpawnToolDef** — Custom `Agent` tool definition that replaces the SDK's NOOP registration when direct mode is active.
- **Child Agent Domain Events** — `ChildAgentRequested`, `ChildAgentCompleted`, `ChildAgentFailed`, `ChildAgentCancelled` events for observability.
- **DeferredToolRegistry.override()** — Clean tool replacement method for swapping the Agent tool implementation at runtime.
- **TODOS.md** — Deferred items roadmap: sub-task spawning evolution, session state durability.

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
