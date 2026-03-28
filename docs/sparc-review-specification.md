# SPARC Specification Review: architecture-orch-agents.md

**Reviewer:** Specification Phase Agent
**Document Under Review:** `docs/architecture-orch-agents.md` (1597 lines, v1.0.0, dated 2026-03-09)
**Review Date:** 2026-03-10
**Status:** Initial Review Complete

---

## Quick Reference

| Category | Count | IDs |
|----------|------:|-----|
| Validated (confirmed by codebase) | 8 | SPEC-V-01 through SPEC-V-08 |
| Aspirational (described, not built) | 15 | SPEC-A-01 through SPEC-A-15 |
| Contradictions (conflicts with reality) | 6 | SPEC-C-01 through SPEC-C-06 |
| Missing (exists but undocumented) | 7 | SPEC-M-01 through SPEC-M-07 |

**Bottom line:** The architecture document is a design proposal, not a specification of existing capability. The `src/` directory does not exist. The only functional components are the routing and hook subsystem in `.claude/helpers/`. Several specifications contradict known broken infrastructure. The implementation plan (Section 12) should be treated as the actionable roadmap.

---

## 1. VALIDATED Specifications

### SPEC-V-01: Tech Lead Router as Central Classifier

- **Arch doc:** Section 5.3 "Decision Engine v2"; Section 10.2 agent types by SPARC phase
- **Evidence:** `.claude/helpers/tech-lead-router.cjs` (718 lines). 4-dimension classification, 8 team templates, ambiguity detection. 50 tests pass.
- **Discrepancy:** Arch doc describes a 3-stage pipeline (regex, semantic, pattern match). Only Stage 1 (regex/keyword) is implemented. Stages 2-3 do not exist.

### SPEC-V-02: Hook Handler Dispatch

- **Arch doc:** Section 10.3 Hooks Integration
- **Evidence:** `.claude/helpers/hook-handler.cjs` (321 lines). Dispatches route, pre-bash, post-edit, session-restore, session-end. Wired into `.claude/settings.json`.

### SPEC-V-03: SPARC Phase Model (Conceptual)

- **Arch doc:** Section 6.3 "SPARC Phase Flow"; AP-4; ADR-056
- **Evidence:** `tech-lead-router.cjs` includes `sparc-full-cycle` template. `ruflo workflow run -t sparc` works.
- **Limitation:** Phase sequencer, quality gates, retry logic, checkpoint manager do not exist as code.

### SPEC-V-04: Agent Configurations (5 of 60+)

- **Arch doc:** Section 7.3 "60+ agent types available"
- **Evidence:** 5 YAML configs in `agents/`: coder, architect, tester, security-architect, reviewer (~10 lines each).
- **Gap:** Arch doc references 15 templates with 20+ distinct agent types. Only 5 configs exist locally.

### SPEC-V-05: Memory and Session Subsystem

- **Arch doc:** Section 7.2 "AgentDB via RuFlo MCP"; Section 10.4 Memory Namespace Architecture
- **Evidence:** `.swarm/memory.db` (160KB) exists. MCP tools `memory_store`/`memory_search`/`session_save`/`session_restore` work.
- **Gap:** 10 specified namespaces not yet populated. Memory is flat key-value.

### SPEC-V-06: RuFlo/Claude Flow MCP Integration

- **Arch doc:** Section 10.1 "MCP Tool Usage by Context" (25+ tool mappings)
- **Evidence:** `.mcp.json` configured. Working tools: `memory_store`, `memory_search`, `session_save`, `session_restore`, `swarm_status`, `agent_status`, `swarm_init`, `agent_spawn`, `task_create`.
- **Gap:** Bounded context code that would call these tools does not exist.

### SPEC-V-07: Workflow Templates

- **Arch doc:** Appendix B: 15 templates
- **Evidence:** `tech-lead-router.cjs` defines 8: quick-fix, research-sprint, feature-build, sparc-full-cycle, testing-sprint, security-audit, performance-sprint, release-pipeline/fullstack-swarm.
- **Gap:** 7 missing: tdd-workflow, github-ops, sparc-planning, pair-programming, docs-generation, cicd-pipeline, monitoring-alerting.

### SPEC-V-08: Embedding Model

- **Arch doc:** Section 7.2 (HNSW vector search)
- **Evidence:** all-MiniLM-L6-v2 (384-dim ONNX) loaded and functional. `.swarm/hnsw.index` (1.5MB) exists.
- **Nuance:** HNSW index not loaded at query time (`@ruvector/core` missing). Falls back to non-vector scan.

---

## 2. ASPIRATIONAL Specifications

### SPEC-A-01: Entire src/ Directory Structure (P0)

No `src/` directory exists. Zero TypeScript source files, no `package.json`, `tsconfig.json`, `Dockerfile`, or `docker-compose.yml`. The architecture specifies 50+ files across 9 bounded contexts.

### SPEC-A-02: Webhook Gateway (P0)

No webhook server, no signature verification, no event buffer, no Fastify server, no HTTP endpoints.

### SPEC-A-03: Client Intake API (P1)

No client API, requirement handler, refinement engine, project manager, or notification sender.

### SPEC-A-04: Triage Context (P0)

No triage engine, urgency rules, or SLA evaluator. `tech-lead-router.cjs` does some classification but is a hook helper, not a standalone bounded context.

### SPEC-A-05: Planning Context (P0)

No planning engine, `WorkflowPlan` aggregate, SPARC decomposer, or topology selector module.

### SPEC-A-06: Execution Context (P1)

No execution coordinator, swarm manager wrapper, phase runner, checkpoint manager, or retry handler. Execution is manual via `ruflo workflow run`.

### SPEC-A-07: Review Context (P1)

No review pipeline, code review gate, security gate, test coverage gate, or quality aggregator.

### SPEC-A-08: Deployment Context (P1)

No deployment manager, GitHub Actions trigger, health checker, or rollback handler.

### SPEC-A-09: Learning Context (P2)

No outcome tracker, pattern store, or weight adjuster. Q-Learning training is manual via `ruflo route feedback`.

### SPEC-A-10: Event Bus -- NATS JetStream (P0)

No NATS server, event bus implementation, domain events, or message persistence.

### SPEC-A-11: Shared Kernel (P0)

None of `shared/event-bus.ts`, `event-types.ts`, `errors.ts`, `validation.ts`, `logger.ts`, `config.ts`, `agentdb-client.ts`, `ruflo-client.ts` exist. No Zod schemas, structured logging, or typed events.

### SPEC-A-12: Test Suite (P1)

Only 1 test file: `tests/tech-lead-router.test.cjs` (335 lines, 50 tests, all passing). Zero TypeScript tests, no integration or E2E tests.

### SPEC-A-13: Configuration Files (P1)

No `config/` directory. Template definitions hardcoded in `tech-lead-router.cjs`. No `templates.json`, `github-routing.json`, `triage-rules.json`, or `sparc-phases.json`.

### SPEC-A-14: Infrastructure Files (P2)

No Dockerfile, docker-compose.yml, docker-compose.prod.yml, or .env.example.

### SPEC-A-15: Domain Model Aggregates (P1)

No domain model implemented. ClientProject, Requirement, WorkItem, WorkflowPlan, Phase interfaces exist only in arch doc markdown.

---

## 3. CONTRADICTIONS with Current Reality

### SPEC-C-01: HNSW Pattern Search as Core Capability (HIGH)

- **Arch doc claims:** Sub-10ms similarity search (Section 7.2, 10.1, 11.1)
- **Reality:** `@ruvector/core` not available. Memory search falls back to non-vector scan.
- **Impact:** Decision Engine Stage 3 and Learning Context features depend on HNSW.

### SPEC-C-02: 3-Tier Model Routing (HIGH)

- **Arch doc claims:** AP-5 cost optimization; G4 avg cost < $0.05/task (Section 10.1)
- **Reality:** Agent Booster (WASM) not available. `hooks model-route` untested. Tier selection is manual.

### SPEC-C-03: AgentDB as Primary Store (MEDIUM)

- **Arch doc claims:** Section 7.2 "Primary Store: AgentDB" across all 9 contexts
- **Reality:** AgentDB controllers broken. Basic `memory_store`/`memory_search` MCP tools work; `pattern-search`, `hierarchical-store`, controllers do not.

### SPEC-C-04: Neural Learning Subsystem (MEDIUM)

- **Arch doc claims:** Section 10.1 uses `hooks_intelligence_learn`, trajectory recording
- **Reality:** `neural train/predict` broken (WASM missing). `intelligence.cjs` works but isolated, loses state between sessions.

### SPEC-C-05: Config Mismatch: neural.enabled (LOW)

- `.claude-flow/config.yaml` has `neural.enabled: true` but WASM modules are missing. Degrades silently.
- **Recommendation per `orchestration-strategy.md`:** Set to `false`.

### SPEC-C-06: Max Agents: 15 vs 8 (LOW)

- Arch doc and `config.yaml` say 15. `orchestration-strategy.md` recommends 8 for tight coordination. No code enforces either.

---

## 4. Missing Specifications (Exists but Undocumented)

### SPEC-M-01: Hook Handler Architecture

`hook-handler.cjs` (321 lines) implements hook dispatch with stdin JSON parsing, WORKFLOW_MAP, and command routing. Arch doc mentions hooks only as MCP tool calls, not as the actual Claude Code integration entry point.

### SPEC-M-02: Guidance Compilation and Retrieval

`ruflo guidance compile` and `ruflo guidance retrieve` compile CLAUDE.md into 50 rules (5 constitution + 45 shards). Not mentioned in arch doc.

### SPEC-M-03: Daemon Workers

Daemon manages 7 background workers (map, audit, optimize, consolidate, testgaps, predict, document). Not referenced in arch doc. Could serve as execution layer for bounded contexts.

### SPEC-M-04: Q-Learning Router Training Path

`orchestration-strategy.md` defines a 3-phase Q-Learning training roadmap. Arch doc Learning Context does not account for this existing infrastructure.

### SPEC-M-05: Intelligence Subsystem (PageRank)

`.claude/helpers/intelligence.cjs` (916 lines) implements a PageRank-based memory graph. Not referenced in arch doc.

### SPEC-M-06: Pretrain Pipeline

`ruflo hooks pretrain` runs a 6-step pipeline (RETRIEVE, JUDGE, DISTILL, CONSOLIDATE, EMBED, HYPERBOLIC). Working infrastructure for bootstrapping intelligence. Not documented.

### SPEC-M-07: Existing ADRs (051, 052)

ADR-051 (Tech Lead Clarification) and ADR-052 (Tech Lead v2 Architecture) exist in `docs/adr/`. Arch doc references ADR-052 as "incorporated" but does not document how `tech-lead-router.cjs` relates to the ADR-052 decision engine.

---

## 5. Priority Ranking with Resolutions

### P0 -- Critical (Must resolve before implementation starts)

| ID | Gap | Resolution |
|----|-----|------------|
| SPEC-C-01 | HNSW treated as core but broken | Edit `docs/architecture-orch-agents.md` Sections 7.2, 10.1, 11.1: mark HNSW as optional enhancement. Specify non-vector scan as default. |
| SPEC-C-02 | 3-tier model routing broken but treated as core | Edit arch doc AP-5 and Section 10.1: mark automated routing as Phase 6+. Specify manual Sonnet selection as default. |
| SPEC-A-01 | No src/ directory, no package.json | Create `src/` scaffold, `package.json`, `tsconfig.json` per arch doc Section 9. This is the implementation starting point. |
| SPEC-A-10 | No event bus (NATS) but all contexts depend on it | Edit arch doc Section 7.1: add in-process EventEmitter fallback for Phases 0-2, NATS as Phase 3+ upgrade. Write `src/shared/event-bus.ts`. |
| SPEC-A-11 | No shared kernel | Write `src/shared/` files: `errors.ts`, `validation.ts` (Zod schemas), `logger.ts`, `config.ts` as Phase 0 deliverables. |

### P1 -- High (Resolve during Phase 0-2)

| ID | Gap | Resolution |
|----|-----|------------|
| SPEC-V-07 | 8 templates vs 15 in arch doc | Add 7 missing templates to `tech-lead-router.cjs` or remove from arch doc Appendix B. |
| SPEC-C-03 | AgentDB controllers broken | Edit arch doc Section 7.2: specify MCP memory tools as primary store. Mark AgentDB pattern-search as Phase 6+. |
| SPEC-M-01 | Hook handler undocumented | Add Section 10.5 "Existing Infrastructure" to arch doc. Document hook-handler.cjs, tech-lead-router.cjs roles. |
| SPEC-V-04 | 5 agent configs vs 20+ referenced | Generate missing YAML configs via `hooks build-agents` with expanded type list, or prune arch doc Section 7.3. |
| SPEC-A-15 | No domain model | Write `src/shared/domain-types.ts` with TypeScript interfaces for ClientProject, Requirement, WorkItem, WorkflowPlan, Phase. |

### P2 -- Medium (Resolve before Phase 3+)

| ID | Gap | Resolution |
|----|-----|------------|
| SPEC-A-09 | No learning context | Incorporate Q-Learning roadmap from `orchestration-strategy.md` into arch doc Section 4.2 context #9. See SPEC-M-04. |
| SPEC-M-03 | Daemon workers undocumented | Add daemon worker architecture to arch doc Section 10.5. Map workers to bounded contexts. |
| SPEC-M-06 | Pretrain pipeline undocumented | Document in arch doc as bootstrap mechanism for Learning Context. |
| SPEC-A-13 | No config directory | Create `config/` with `templates.json`, `sparc-phases.json` extracted from hardcoded values in `tech-lead-router.cjs`. |
| SPEC-C-05 | neural.enabled mismatch | Edit `.claude-flow/config.yaml`: set `neural.enabled: false`. |
| SPEC-C-06 | maxAgents 15 vs 8 | Edit `.claude-flow/config.yaml`: set `maxAgents: 8` per `orchestration-strategy.md`. |

---

## 6. Recommendations

1. **Add a "Current State" preamble** to the architecture document distinguishing what exists (helpers, router, MCP integration, tests) from what is planned (all 9 bounded contexts, webhook server, client API, event bus, deployment pipeline).

2. **Update document status** from "Proposed" to "Proposed -- Pre-implementation".

3. **Revise technology dependencies** to account for broken WASM/HNSW/AgentDB. Mark HNSW, 3-tier routing, and AgentDB pattern-search as Phase 6+ capabilities with explicit fallback specifications.

4. **Specify in-process EventEmitter fallback** for Phase 0-2 before NATS is available.

5. **Formally specify existing working components** (hook-handler.cjs, tech-lead-router.cjs, guidance subsystem, pretrain pipeline, daemon workers) as Section 10.5 "Existing Infrastructure".

---

## Appendix: File Inventory

### Files That Exist and Are Relevant

| File | Lines | Status |
|------|------:|--------|
| `.claude/helpers/tech-lead-router.cjs` | 718 | Working, 50 tests pass |
| `.claude/helpers/hook-handler.cjs` | 321 | Working |
| `.claude/helpers/intelligence.cjs` | 916 | Working but isolated |
| `.claude/helpers/router.js` | 66 | Superseded, fallback only |
| `.claude/helpers/session.js` | 135 | Superseded by MCP |
| `.claude/helpers/memory.js` | 83 | Superseded by MCP |
| `tests/tech-lead-router.test.cjs` | 335 | 50 tests, all passing |
| `agents/*.yaml` (5 files) | ~10 each | Generated by build-agents |
| `.claude-flow/config.yaml` | 43 | Active |
| `.swarm/memory.db` | 160KB | Active |
| `.swarm/hnsw.index` | 1.5MB | Present, not loaded at query time |
| `docs/architecture-orch-agents.md` | 1597 | Under review |
| `docs/orchestration-strategy.md` | 516 | Ground truth for working/broken status |
| `docs/kickstart-guide.md` | 636 | Verified working commands |

### Files Specified in Arch Doc That Do NOT Exist

All 50+ files in `src/` (Section 9), all 20+ test files, all 4 config files, all infrastructure files (Dockerfile, docker-compose.yml, .env.example), and all scripts.

---

## SPARC Phase Gate: Specification Review

### Pass/Fail Criteria

| Criterion | Status | Notes |
|-----------|--------|-------|
| All architecture claims verified against codebase | PASS | 36 findings cataloged with tracking IDs |
| Contradictions between spec and reality identified | PASS | 6 contradictions documented (SPEC-C-01 through SPEC-C-06) |
| Aspirational items clearly separated from validated | PASS | 15 aspirational items flagged (SPEC-A-01 through SPEC-A-15) |
| Missing specifications for existing code identified | PASS | 7 undocumented components found (SPEC-M-01 through SPEC-M-07) |
| Priority ranking with actionable resolutions | PASS | 16 gaps ranked P0/P1/P2 with specific file-level resolutions |
| No P0 blockers left unaddressed | FAIL | 5 P0 gaps require resolution before implementation can start |

### Gate Decision: CONDITIONAL PASS

This review phase is complete. The specification review itself passes -- all findings are documented and actionable. However, the **architecture document under review** does not pass the specification gate. The 5 P0 gaps (SPEC-C-01, SPEC-C-02, SPEC-A-01, SPEC-A-10, SPEC-A-11) must be resolved in the architecture document before proceeding to the Pseudocode phase for bounded context implementation.

### Next Steps

1. Resolve P0 gaps by editing `docs/architecture-orch-agents.md`
2. Create `src/` scaffold with `package.json` and `tsconfig.json`
3. Write `src/shared/event-bus.ts` with EventEmitter fallback
4. Re-run this specification review to verify P0 resolution
