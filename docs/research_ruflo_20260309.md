# Research Report: RuFlo (ruvnet/ruflo)

**Date**: 2026-03-09
**Confidence Level**: High (90%+) — Official repo data, GitHub API, multiple corroborating sources
**Subject**: RuFlo v3.5 — Enterprise AI Agent Orchestration Platform

---

## Executive Summary

RuFlo (formerly Claude Flow) is the leading open-source agent orchestration platform for Claude, with **20,150 stars**, **2,236 forks**, and **~100K monthly active users** across 80+ countries. At v3.5.15, it provides **215 MCP tools**, **60+ specialized agents**, **8 AgentDB controllers**, and a **7-layer governance control plane** with WASM kernel. It's built in TypeScript (63%), JavaScript (22%), Python (8%), and Shell (3%), licensed under MIT.

### Key Metrics

| Metric | Value |
|--------|-------|
| Stars | 20,150 |
| Forks | 2,236 |
| Open Issues | 445 |
| Latest Version | v3.5.15 (2026-03-09) |
| Total Commits | 5,800+ |
| MCP Tools | 215 |
| Agent Types | 60+ |
| AgentDB Controllers | 8 |
| SWE-Bench Solve Rate | 84.8% |
| Speed Improvement | 2.8-4.4x |
| npm Packages | `ruflo`, `claude-flow`, `@claude-flow/cli` |

---

## Architecture Overview

### Core Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@claude-flow/cli` | `v3/@claude-flow/cli/` | CLI entry point (26 commands) |
| `@claude-flow/codex` | `v3/@claude-flow/codex/` | Dual-mode Claude + Codex collaboration |
| `@claude-flow/guidance` | `v3/@claude-flow/guidance/` | 7-layer governance control plane |
| `@claude-flow/hooks` | `v3/@claude-flow/hooks/` | 17 hooks + 12 workers |
| `@claude-flow/memory` | `v3/@claude-flow/memory/` | AgentDB + HNSW vector search |
| `@claude-flow/security` | `v3/@claude-flow/security/` | Input validation, CVE remediation |

### 7-Layer Governance Control Plane

| Layer | Name | Purpose |
|-------|------|---------|
| 0 | Proof Anchoring | SHA-256 hash-chained, HMAC-signed event envelopes |
| 1 | Policy Gates | Destructive ops, secrets, diff size, tool allowlist |
| 2 | Capability Algebra | Typed permissions, trust scores, authority gates |
| 3 | Meta-Governance | Constitutional invariants, amendment voting |
| 4 | Adversarial Resilience | BFT, prompt injection detection, collusion detection |
| 5 | Gateway & Routing | Idempotency cache, schema validation, budget metering |
| 6 | Step Control | Per-step autonomy: continue/checkpoint/throttle/pause/stop |
| WASM | Kernel | Rust→WebAssembly for hot paths (proof + gates + scoring) |

### 3-Tier Model Routing (ADR-026)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| 1 | Agent Booster (WASM) | <1ms | $0 | Simple transforms — skip LLM entirely |
| 2 | Haiku | ~500ms | $0.0002 | Simple tasks, low complexity (<30%) |
| 3 | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture (>30%) |

---

## Agent Ecosystem (60+ Types)

### Categories

- **Core Development**: coder, reviewer, tester, planner, researcher
- **Architecture**: system-architect, v3-integration-architect, repo-architect
- **Security**: security-architect, security-auditor, security-manager, pii-detector
- **Performance**: performance-engineer, performance-benchmarker, performance-monitor
- **Swarm Coordination**: hierarchical-coordinator, mesh-coordinator, adaptive-coordinator, queen-coordinator
- **GitHub Integration**: pr-manager, code-review-swarm, issue-tracker, release-manager, multi-repo-swarm
- **SPARC Methodology**: sparc-coord, sparc-coder, specification, pseudocode, architecture, refinement
- **Memory/Learning**: memory-specialist, sona-learning-optimizer, reasoningbank-learner
- **Consensus**: raft-manager, crdt-synchronizer, byzantine-coordinator, gossip-coordinator, quorum-manager

### Agent Spawning

```bash
# CLI spawning
npx ruflo@latest agent spawn -t coder --name my-coder

# Swarm initialization
npx ruflo@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized

# Via MCP tools
mcp__claude-flow__agent_spawn({ type: "coder", name: "my-coder" })
mcp__claude-flow__swarm_init({ topology: "hierarchical", maxAgents: 8 })
```

---

## MCP Tools (215 Total)

### Tool Categories

| Category | Count | Key Tools |
|----------|-------|-----------|
| Agent Management | 8 | spawn, list, status, health, terminate, update, pool |
| Swarm Coordination | 6 | init, status, health, shutdown |
| Memory (AgentDB) | 11+ | store, search, retrieve, list, delete, migrate, stats |
| Task Management | 6 | create, assign, list, status, complete, cancel |
| Session Management | 7 | save, restore, list, info, delete |
| Hooks System | 17+ | pre/post-task, pre/post-edit, session start/end, intelligence |
| Hive-Mind | 6 | init, join, leave, broadcast, consensus, memory |
| Workflow | 7 | create, execute, run, pause, resume, cancel, status |
| GitHub Integration | 5 | repo_analyze, pr_manage, issue_track, metrics, workflow |
| Coordination | 7 | sync, consensus, load_balance, metrics, node, topology |
| Neural | 6 | train, predict, patterns, optimize, compress, status |
| Performance | 6 | benchmark, profile, metrics, optimize, bottleneck, report |
| Browser Automation | 20+ | open, click, fill, type, screenshot, evaluate, etc. |
| AI Defense | 6 | scan, analyze, is_safe, has_pii, learn, stats |
| Claims/Auth | 10+ | claim, release, steal, handoff, rebalance, board |
| Transfer/Plugins | 10+ | plugin-search, store-search, ipfs-resolve, detect-pii |

---

## Hooks System (17 Hooks + 12 Workers)

The hooks system enables automated workflows triggered by Claude Code events:

- **Pre/Post Task**: Validate before, learn after
- **Pre/Post Edit**: Gate file modifications
- **Pre/Post Command**: Intercept shell commands
- **Session Start/End**: Initialize/cleanup context
- **Intelligence Pipeline**: Pattern learning, trajectory tracking, model routing
- **Worker System**: 12 background workers for async processing

---

## Dual-Mode Collaboration (Claude Code + Codex)

Pre-built collaboration templates:

| Template | Pipeline |
|----------|----------|
| `feature` | Architect → Coder → Tester → Reviewer |
| `security` | Analyst → Scanner → Reporter |
| `refactor` | Architect → Refactorer → Tester |
| `bugfix` | Researcher → Coder → Tester |

---

## CLI Commands Reference

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization (--wizard) |
| `agent` | 8 | Agent lifecycle management |
| `swarm` | 6 | Multi-agent swarm coordination |
| `memory` | 11 | AgentDB memory with HNSW search |
| `task` | 6 | Task creation and lifecycle |
| `session` | 7 | Session state management |
| `hooks` | 17 | Self-learning hooks + 12 workers |
| `hive-mind` | 6 | Byzantine fault-tolerant consensus |
| `workflow` | 7 | Workflow creation and execution |
| `doctor` | - | System diagnostics (--fix) |

---

## Key Design Principles

1. **DDD with Bounded Contexts** — Modular domain-driven design
2. **TDD London School** — Mock-first testing
3. **Event Sourcing** — State changes as events
4. **SPARC Methodology** — Specification, Pseudocode, Architecture, Refinement, Completion
5. **Anti-Drift Defaults** — Hierarchical topology, raft consensus, frequent checkpoints
6. **Concurrency Model** — 1 message = ALL related operations (parallel batching)

---

## Features We Can Leverage

### For Tech Lead Agent / Autonomous Dev System

1. **Swarm Orchestration** — Spawn specialized agent teams per task
2. **SPARC Methodology** — Structured development phases
3. **Memory System (AgentDB)** — Persistent context across sessions, HNSW vector search
4. **Hooks System** — Automated triggers on code events (pre/post edit, task, session)
5. **3-Tier Routing** — Cost-optimized model selection per task complexity
6. **GitHub Integration** — PR management, code review swarms, issue tracking
7. **Claims System** — Task ownership, handoffs, rebalancing
8. **Governance Control Plane** — Enforce coding standards, security policies
9. **Dual-Mode Collaboration** — Claude + Codex parallel execution
10. **Neural Intelligence** — Pattern learning, trajectory tracking, self-optimization
11. **Workflow Engine** — Create, execute, pause/resume complex pipelines
12. **Browser Automation** — 20+ tools for web interaction and testing

### For GitHub Webhook Integration

- `mcp__claude-flow__github_repo_analyze` — Analyze repo state
- `mcp__claude-flow__github_pr_manage` — PR lifecycle
- `mcp__claude-flow__github_issue_track` — Issue management
- `mcp__claude-flow__github_workflow` — CI/CD orchestration
- `mcp__claude-flow__github_metrics` — Repo metrics
- Hooks: `post-task`, `post-edit` can trigger GitHub operations

---

## Sources

- [GitHub: ruvnet/ruflo](https://github.com/ruvnet/ruflo)
- [RuFlo Wiki](https://github.com/ruvnet/ruflo/wiki)
- [Architecture Overview](https://github.com/ruvnet/ruflo/blob/HEAD/v3/@claude-flow/guidance/docs/guides/architecture-overview.md)
- [SitePoint: Developer's Guide to Autonomous Coding Agents](https://www.sitepoint.com/the-developers-guide-to-autonomous-coding-agents-orchestrating-claude-code-ruflo-and-deerflow/)
- [SkillsLLM: ruflo](https://skillsllm.com/skill/ruflo)
- [Claude Flow V3 Rebuild Issue #945](https://github.com/ruvnet/ruflo/issues/945)
