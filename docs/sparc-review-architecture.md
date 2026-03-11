# SPARC Architecture Review: docs/architecture-orch-agents.md

**Reviewer:** SPARC Architecture Phase Agent
**Date:** 2026-03-10
**Document Under Review:** `docs/architecture-orch-agents.md` (v1.1.0-draft, 1597 lines)
**Cross-referenced Against:** Actual codebase, `docs/orchestration-strategy.md` (v3.0.0), ADR-051, ADR-052, `.mcp.json`, `.claude-flow/config.yaml`, `.claude/settings.json`

---

## Quick Reference

| Metric | Value |
|--------|-------|
| **Architecture Integrity Score** | 15 / 100 (pre-update); estimated 35 / 100 (post-update with Section 0 and status annotations) |
| **Accurate findings (validated by codebase)** | 6 (ARCH-A-01 through ARCH-A-06) |
| **Forward-looking findings (planned, not built)** | 7 (ARCH-F-01 through ARCH-F-07) |
| **Misleading findings (described as existing, do not exist)** | 14 (ARCH-M-01 through ARCH-M-14) |
| **Contradictions with orchestration-strategy.md** | 11 (all resolved: 5 in v1.1.0-draft, 6 in v1.1.0-accepted) |
| **Recommended corrections** | 10 (all completed: 4 in v1.1.0-draft, 6 in v1.1.0-accepted) |

---

## 1. Sections That Are ACCURATE (Validated by Codebase)

### ARCH-A-01: Tech Lead Router Classification (Section 4, partial)

The architecture describes a "Decision Engine" with multi-dimensional classification (domain, complexity, scope, risk). This maps to `tech-lead-router.cjs` (718 lines, `.claude/helpers/`), which performs 4-dimension classification and selects from 8 team templates. Confirmed by 50-test suite in `tests/tech-lead-router.test.cjs`.

**Accuracy:** The concept is correct. The architecture inflates this into a "3-stage classification pipeline" (regex, semantic via Haiku, HNSW pattern match) when only Stage 1 (regex) exists today.

*Cross-ref: sparc-review-specification.md Section 1.1; sparc-review-pseudocode.md Section 4.1*

### ARCH-A-02: Hook Handler Integration (Section 10.3, partial)

The architecture describes hooks at session start, session end, pre-tool, post-tool, and user prompt. The actual `.claude/settings.json` confirms these hooks are configured and call `hook-handler.cjs`. The route handler wires into `tech-lead-router.cjs` as described.

*Cross-ref: sparc-review-specification.md Section 1.2; sparc-review-pseudocode.md Section 4.2*

### ARCH-A-03: MCP Server Configuration (Section 10, partial)

The `.mcp.json` confirms a single `claude-flow` MCP server configured with `@claude-flow/cli@latest`. The MCP tools `memory_store`, `memory_search`, `session_save`, `session_restore`, `swarm_status`, `agent_status` are confirmed working. However, `agentdb_pattern-search`, `hooks_model-route`, and `agentdb_hierarchical-recall` are broken or untested per `orchestration-strategy.md`.

*Cross-ref: sparc-review-specification.md Section 1.6*

### ARCH-A-04: Agent YAML Configurations (Section 10.2, partial)

The `agents/` directory contains exactly 5 YAML configs: `architect.yaml`, `coder.yaml`, `reviewer.yaml`, `security-architect.yaml`, `tester.yaml`. These are minimal (10-11 lines each) declarative configs, far simpler than the architecture implies.

*Cross-ref: sparc-review-specification.md Section 1.4; sparc-review-pseudocode.md Section 4.3*

### ARCH-A-05: SPARC Methodology Concept (Sections 4.4, 6.3)

The SPARC phase model is a real methodology used in the project. SPARC skills exist in `.claude/skills/sparc-methodology/`. The `ruflo workflow run -t sparc` template is confirmed working.

*Cross-ref: sparc-review-specification.md Section 1.3*

### ARCH-A-06: Existing Directory Structure (Section 9, partial)

The architecture correctly identifies `.claude/`, `.claude/helpers/`, `.claude/skills/`, `.claude-flow/`, `.swarm/`, `agents/`, `docs/`, `docs/adr/`, `tests/`.

---

## 2. Sections That Are FORWARD-LOOKING (Planned but Not Built)

These describe future capabilities. They would be acceptable if clearly labeled as planned. The v1.1.0-draft update added Section 0 "Current vs Target State" and status annotations, which partially mitigates the issue. However, many sections still use present tense.

### ARCH-F-01: All 9 Bounded Contexts (Section 4)

The `src/` directory does not exist. Zero TypeScript source files. No `package.json`. No `tsconfig.json`. The entire application described in Sections 4-6 is unbuilt.

*Cross-ref: sparc-review-specification.md Section 2.1 (P0 Gap)*

### ARCH-F-02: The Entire src/ Directory Tree (Section 9)

55 source files listed across 9 bounded context directories; 0 exist. The v1.1.0-draft update split Section 9 into "9.1 Current" and "9.2 Target" sub-sections, which resolves the misleading presentation.

### ARCH-F-03: Test Files (Section 9)

20+ test files listed under `tests/`. Only 1 exists: `tech-lead-router.test.cjs`.

*Cross-ref: sparc-review-specification.md Section 2.12*

### ARCH-F-04: REST API Endpoints (Section 8)

7+ HTTP endpoints specified. No HTTP server exists. No Fastify application exists.

*Cross-ref: sparc-review-specification.md Sections 2.2, 2.3*

### ARCH-F-05: Client Intake System (Sections 4.2, 6.2, 8.2)

The entire client-facing REST API, AI-powered requirement refinement, and notification webhook system is unbuilt.

### ARCH-F-06: Configuration and Support Files (Section 9)

No `config/` directory, no `scripts/` directory, no `examples/` directory, no Docker files, no `package.json`, no `tsconfig.json`, no `vitest.config.ts`, no `.env.example`.

### ARCH-F-07: Implementation Plan (Section 12)

The 49-day, 7-phase implementation plan is legitimate forward-looking content. The v1.1.0-draft should add a "Status" column (all phases NOT STARTED, with partial notes for Phases 2, 3, 6).

*Cross-ref: sparc-review-refinement.md Section 12 refinement plan*

---

## 3. Sections That Are MISLEADING (Described as Existing but Don't Exist)

### ARCH-M-01: NATS JetStream Event Bus (Sections 5.2, 7.1, 7.4)

**Claim:** NATS JetStream for durable domain event routing.
**Reality:** No NATS server, no `nats.js` dependency, no Docker Compose. The v1.1.0-draft added "(Not installed)" annotation to Section 7.1, partially mitigating this.

### ARCH-M-02: Fastify HTTP Server (Sections 5.2, 7.1, 7.5)

**Claim:** Fastify for webhook server and client API.
**Reality:** No Fastify dependency, no HTTP server. Annotated as "(Not installed)" in v1.1.0-draft.

### ARCH-M-03: TypeScript 5.x Strict Mode (Section 7.1)

**Claim:** "TypeScript 5.x (strict mode)."
**Reality:** Codebase is CommonJS JavaScript (.cjs/.mjs). Annotated in v1.1.0-draft with migration note.

### ARCH-M-04: Vitest Test Framework (Section 7.1, 9)

**Claim:** `vitest.config.ts` and `.test.ts` files.
**Reality:** Single test file is `.test.cjs`. No test framework configuration.

### ARCH-M-05: Zod Validation (Section 7.1)

**Claim:** Zod for runtime type validation.
**Reality:** No Zod dependency. Annotated as "(Not installed)" in v1.1.0-draft.

*Cross-ref: sparc-review-specification.md Section 2.11 (Shared Kernel gap)*

### ARCH-M-06: Octokit GitHub API Client (Section 7.1)

**Claim:** Octokit for GitHub REST/GraphQL.
**Reality:** No Octokit dependency. Annotated as "(Not installed)" in v1.1.0-draft.

### ARCH-M-07: Event-Sourced State (Section 3, AP-1)

**Claim:** "Every state transition is a domain event. State is reconstructable from the event log."
**Reality:** State stored in SQLite (MCP `memory_store`), JSON files. No event log, no event store, no replay.

### ARCH-M-08: HNSW Vector Search Performance Claims (Section 11.1)

**Claim:** "Pattern search (HNSW): < 10ms."
**Reality:** HNSW not loaded; `@ruvector/core` not available. Falls back to non-vector scan. Annotated as "Broken" in v1.1.0-draft Section 7.2.

*Cross-ref: sparc-review-specification.md Section 3.1*

### ARCH-M-09: 3-Tier Model Routing (Section 3, AP-5; Section 10.1)

**Claim:** Automated WASM booster / Haiku / Sonnet routing.
**Reality:** Agent Booster not available. Strategy is "hardcode sonnet; use haiku manually." Annotated as "Untested" in v1.1.0-draft Section 10.1.

*Cross-ref: sparc-review-specification.md Section 3.2*

### ARCH-M-10: AgentDB Controllers and Pattern Storage (Section 10.1)

**Claim:** `agentdb_pattern-search`, `agentdb_hierarchical-recall`.
**Reality:** "Broken -- controller index not found." Annotated in v1.1.0-draft Section 10.1.

*Cross-ref: sparc-review-specification.md Section 3.3*

### ARCH-M-11: Neural Train/Predict (Section 10.1)

**Claim:** Learning context uses intelligence/trajectory hooks.
**Reality:** WASM module `@ruvector/learning-wasm` not found. Produces random synthetic patterns.

*Cross-ref: sparc-review-specification.md Section 3.4*

### ARCH-M-12: config.yaml Discrepancy

Architecture recommends `neural.enabled: false` but actual config has `neural.enabled: true`. Config does not match the document's own recommendation.

### ARCH-M-13: 215 MCP Tools Claim (Section 1)

**Claim:** "RuFlo's 215 MCP tools."
**Reality:** Plausible but unverifiable as an exact count.

### ARCH-M-14: Docker and Infrastructure (Sections 7.4)

**Claim:** Docker + Docker Compose multi-container deployment.
**Reality:** No Dockerfile, no docker-compose.yml. Annotated in v1.1.0-draft.

---

## 4. Contradictions Between Architecture and Orchestration Strategy

The `orchestration-strategy.md` (v3.0.0, adopted status) is the authoritative ground truth.

| Topic | Architecture Claims | Orchestration Strategy Says | Resolution Status |
|-------|--------------------|-----------------------------|-------------------|
| State management | Event-sourced via NATS | SQLite + JSON files | FIXED -- AP-1 annotated: "Phase 0-2: in-process EventEmitter. NATS upgrade at Phase 3+." |
| Event bus | NATS pub/sub between contexts | No event bus; hook-handler dispatches | FIXED -- Section 7.1 annotates NATS as "Not installed" |
| Task routing | 3-stage pipeline (regex + Haiku + HNSW) | tech-lead-router.cjs regex only | FIXED -- Section 0 Bridge table documents Stage 1 only |
| Model routing | Automated 3-tier (WASM/Haiku/Sonnet) | "Hardcode sonnet; use haiku manually" | FIXED -- Section 10.1 annotates as "Untested" |
| Neural patterns | Learning context trains and predicts | "Skip entirely -- Broken" | FIXED -- Phase 6 goal annotated: "Blocked by `@ruvector/learning-wasm`. Requires WASM fix before starting." |
| HNSW search | Sub-10ms pattern matching | "HNSW Index: Not loaded" | FIXED -- Section 7.2 annotates as "Broken" |
| Agent Booster | Tier 1 WASM skip-LLM transforms | "Not available" | FIXED -- AP-5 annotated: "Tier 1 (WASM booster) not available. Current default: Tier 2 (Haiku) minimum." |
| AgentDB controllers | Pattern storage and hierarchical recall | "Broken -- controller index not found" | FIXED -- Section 10.1 annotates as "Broken" |
| Q-Learning router | Part of routing pipeline | "Q-Table Size = 0, Epsilon = 1.0" | FIXED -- Section 0 Q-Learning row annotated: "Untrained (Q-Table=0, Epsilon=1.0). Functional but cold-start." |
| Primary orchestration | Custom TypeScript bounded contexts | `ruflo workflow run -t <template>` | FIXED -- Phase 0 retitled "Project Setup + Formalize Existing Infrastructure". Note acknowledges existing helpers. |
| Language | TypeScript 5.x strict | CommonJS JavaScript (.cjs/.mjs) | FIXED -- Migration path added after Phase 0 table: "CJS helpers unchanged during Phases 0-2. TS wrappers call CJS. Full migration deferred to Phase 7." |

---

## 5. Recommended Architectural Corrections

### 5.1 Immediate (Before Implementation)

| ID | Correction | Status |
|----|-----------|--------|
| C-01 | Add prominent "Implementation Status" section at top | COMPLETED -- Section 0 "Current vs Target State" added |
| C-02 | Reconcile with orchestration-strategy.md; note broken dependencies | COMPLETED -- Status annotations added to Sections 7, 10 |
| C-03 | Remove or label directory structure as target state | COMPLETED -- Section 9 split into 9.1 Current / 9.2 Target |
| C-04 | Correct technology stack to reflect JavaScript reality | COMPLETED -- Section 7.1 annotated with installation status |
| C-05 | Re-evaluate NATS JetStream; consider in-process EventEmitter for Phase 0-2 | COMPLETED -- Section 7.1 Event Bus row updated: "Phase 0-2: Node.js EventEmitter (in-process). Phase 3+: NATS JetStream." AP-1 also annotated. |
| C-06 | Address WASM dependency chain (HNSW, neural, Agent Booster fallbacks) | COMPLETED -- Section 7.2 fallback chain added: "HNSW -> linear scan. Neural -> skip. Agent Booster -> use Haiku." |

### 5.2 Architectural Design (Before Phase 2+)

| ID | Correction | Status |
|----|-----------|--------|
| C-07 | Simplify Decision Engine; show Stage 1 as current, Stages 2-3 as milestones | COMPLETED -- Section 5.3 Decision Engine component annotated: "Currently Stage 1 only. Stages 2-3 are Phase 6 milestones." |
| C-08 | Align ADR numbering; write ADR-053 through ADR-060 as actual files | COMPLETED -- Section 14 note updated: "ADRs 053-060 will be written as individual files in `docs/adr/` as implementation decisions are made during each phase." |
| C-09 | Start implementation plan from existing codebase, not greenfield | COMPLETED -- Phase 0 retitled "Project Setup + Formalize Existing Infrastructure". Existing note acknowledges helpers. |
| C-10 | Make Phase 0 = "Formalize existing infrastructure" + TypeScript migration | COMPLETED -- Migration path paragraph added after Phase 0 table. CJS unchanged Phases 0-2, TS wrappers, full migration Phase 7. |

*Cross-ref: sparc-review-refinement.md "Recommended Execution Order" for implementation sequence*

---

## 6. Risk Assessment

### Risk Level: MEDIUM-HIGH (downgraded from HIGH after v1.1.0-draft updates)

The addition of Section 0 "Current vs Target State" and status annotations in Sections 7, 9, 10, and Appendix B mitigates the most severe risks. Remaining risks:

| Risk | Severity | Likelihood | Mitigated? |
|------|----------|------------|------------|
| **Developer confusion:** New contributors expect `src/` with 55 TS files | High | Certain | PARTIALLY -- Section 0 and Section 9.1 clarify current state. Section 9.2 still lists target files without clear visual separation. |
| **Dependency on broken infra:** Implementation assumes NATS, HNSW, neural, WASM | High | High | PARTIALLY -- Sections 7.2 and 10.1 annotate broken status. No fallback architecture specified. |
| **Technology mismatch:** TS project vs existing CJS/MJS hooks | Medium | High | PARTIALLY -- Section 7.1 notes current codebase is CJS/MJS. No migration plan in Section 12. |
| **False confidence in capabilities:** Sub-10ms HNSW, 3-tier routing, event sourcing | Medium | Medium | MOSTLY MITIGATED -- Section 0 "What Does NOT Exist Yet" table and Section 7.2 "Broken" annotations address this. |
| **ADR ghost references:** ADR-053 through ADR-060 do not exist as files | Low | Certain | NOT MITIGATED -- no change made. |
| **Contradiction with authoritative doc:** Two conflicting sources of truth | Medium | Medium | PARTIALLY -- Section 0 cross-references orchestration-strategy.md. 6 of 11 contradictions remain unresolved in the document body. |

### Recommendation

The v1.1.0-draft updates are a significant improvement. The document is now usable as a target architecture reference with caveats. Before using it as an implementation guide, address the 6 pending corrections (C-05 through C-10), particularly:

1. Specify EventEmitter fallback for Phase 0-2 (C-05).
2. Describe the JavaScript-to-TypeScript migration path in Section 12 (C-09, C-10).
3. Write the 8 referenced ADRs as actual files (C-08).

*Cross-ref: sparc-review-refinement.md "Section-by-Section Refinement Plan" for the full update checklist*

---

## 7. Cross-Reference Index

| Topic | This Review | Specification Review | Pseudocode Review | Refinement Plan |
|-------|------------|---------------------|-------------------|-----------------|
| Tech lead router accuracy | ARCH-A-01 | Section 1.1 | Section 4.1 | -- |
| Hook handler | ARCH-A-02 | Section 1.2 | Section 4.2 | -- |
| MCP tool status | ARCH-A-03, ARCH-M-10 | Sections 1.6, 3.3 | -- | Section 10 plan |
| Missing src/ directory | ARCH-F-01 | Section 2.1 (P0 Gap) | -- | Section 9 rewrite |
| HNSW broken | ARCH-M-08 | Section 3.1 | -- | Section 7 update |
| 3-tier routing broken | ARCH-M-09 | Section 3.2 | -- | Section 10 update |
| NATS not installed | ARCH-M-01 | Section 2.10 | -- | Section 7 update |
| Template count mismatch | -- | Section 1.7 (8 vs 15) | Section 2.4 | Appendix B update |
| Missing interfaces | -- | -- | Section 1.6 (9 types) | -- |
| Missing domain events | -- | -- | Section 3.1 (4 events) | -- |
| Phase sequencer gap | -- | -- | Section 2.3 | -- |
| File inventory | -- | Appendix (full list) | -- | -- |

---

*Review conducted by SPARC Architecture Phase Agent. Findings based on filesystem verification, document cross-referencing, and alignment analysis against `orchestration-strategy.md` ground truth. Updated to reflect v1.1.0-draft architecture document changes.*
