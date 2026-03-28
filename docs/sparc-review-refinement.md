# SPARC Refinement Plan: architecture-orch-agents.md

**Reviewer:** SPARC Refinement Agent
**Date:** 2026-03-10
**Target Document:** `docs/architecture-orch-agents.md` (1386 lines -> ~1600 lines after edits)
**Phase:** Refinement (R in SPARC)

## Quick Reference

| Metric | Value |
|--------|-------|
| Actions completed | 10 of 11 |
| Actions remaining | 1 of 11 |
| Sections updated | 10 (Header, 0, 1, 7, 9, 10, 12, 14, Appendix B, plus TOC) |
| Sections unchanged | 8 (Sections 2-6, 8, 13; Appendices A, C) |

## Cross-References

| Document | Purpose |
|----------|---------|
| `docs/sparc-review-specification.md` | Requirements validation, gap analysis |
| `docs/sparc-review-pseudocode.md` | Logic and algorithm review |
| `docs/sparc-review-architecture.md` | Structural and design review |
| `docs/architecture-orch-agents.md` | The target document being refined |

---

## Priority Ordering of Refinements

| Priority | ID | Section | Action | Status |
|----------|----|---------|--------|--------|
| P0 | REF-01 | New: Section 0 (Current vs Target) | ADD | COMPLETED |
| P0 | REF-02 | Header (Version/Status) | UPDATE | COMPLETED |
| P0 | REF-03 | Section 9 (Directory Structure) | REWRITE | COMPLETED |
| P0 | REF-04 | Section 7 (Technology Stack) | UPDATE | COMPLETED |
| P1 | REF-05 | Section 10 (Integration Points) | UPDATE | COMPLETED |
| P1 | REF-06 | Section 12 (Implementation Plan) | UPDATE | COMPLETED |
| P1 | REF-07 | Appendix B (Template Mapping) | UPDATE | COMPLETED |
| P2 | REF-08 | Section 1 (Executive Summary) | UPDATE | COMPLETED |
| P2 | REF-09 | Section 11 (Non-Functional Reqs) | UPDATE | COMPLETED |
| P2 | REF-10 | Section 14 (ADR note) | UPDATE | COMPLETED |
| P3 | REF-11 | Sections 2-6, 8, 13; Appx A, C | KEEP | N/A |

---

## Section-by-Section Refinement Details

### REF-02: Header Block -- COMPLETED

Updated to `v1.1.0-draft`, status changed to "Target Architecture (under SPARC review -- not yet implemented)", added Implementation Status and SPARC Review lines.

### REF-01: Section 0 (Current vs Target State) -- COMPLETED

Inserted after Table of Contents. Contains three tables: "What Exists Today" (13 working components), "What Does NOT Exist Yet" (12 components with blocking reasons), and "Bridge: How Current Components Map to Target Architecture" (10 mappings with gap descriptions).

### REF-08: Section 1 (Executive Summary) -- COMPLETED

Added implementation note after first paragraph clarifying this is target architecture. Links back to Section 0.

### REF-04: Section 7 (Technology Stack) -- COMPLETED

Added callout box noting technologies are selections, not installed dependencies. Added Status column to tables in 7.1, 7.2, 7.4 with annotations including:
- AgentDB pattern store marked as Broken
- HNSW marked as requiring `@ruvector/core`
- Node.js version noted as v25.8.0 available (doc specifies 22 LTS)

### REF-03: Section 9 (Directory Structure) -- COMPLETED

Split into 9.1 (Current Directory Structure) showing actual filesystem and 9.2 (Target Directory Structure) preserving the original `src/` tree as build target.

### REF-05: Section 10 (Integration Points) -- COMPLETED

Added Status column to MCP Tool Usage table (10.1) with WORKING/BROKEN/UNTESTED per tool. Section 10.2 agent mappings noted as target. Section 10.3 hooks integration annotated with current dispatch mechanism.

### REF-09: Section 11 (Non-Functional Requirements) -- COMPLETED

Added status annotations:
1. Section 11.1: Note that HNSW < 10ms target requires `@ruvector/core` (not installed; linear scan fallback via `memory_search`).
2. Section 11.4: Note that Pino is a target technology selection, not currently installed; to be added in Phase 0.

### REF-06: Section 12 (Implementation Plan) -- COMPLETED

Added Status column to phase summary table. Phases 0, 1, 4, 5, 7 marked NOT STARTED. Phases 2, 3, 6 marked PARTIAL with explanations of what exists (tech-lead-router classification, RuFlo workflow run, Q-Learning router).

### REF-10: Section 14 (Architecture Decision Records) -- COMPLETED

Added note that all ADRs (053-060) remain in "Proposed" status, to be moved to "Accepted" or "Superseded" when implementation begins.

### REF-07: Appendix B (Template Mapping) -- COMPLETED

Split into B.1 (Implemented Templates, 9) matching `tech-lead-router.cjs` and B.2 (Planned Templates, 6) for templates in the architecture doc but not yet in the router.

### REF-11: Sections 2-6, 8, 13; Appendices A, C -- KEPT

These sections are structurally sound as target architecture. Goals, principles, bounded contexts, C4 diagrams, data flows, API design, risk register, event routing table, and configuration schema require no changes.

---

## Appendix B Discrepancies (Reference)

| Architecture Doc Template | In tech-lead-router.cjs? | Notes |
|---------------------------|--------------------------|-------|
| quick-fix | YES | Doc said `reviewer` support; actual has `tester` |
| research-sprint | YES | Doc said `planner, coder` support; actual has `analyst` |
| feature-build | YES | Doc said `sparc-coord` lead; actual has `architect` lead |
| sparc-full-cycle | YES | Doc said `release-manager`; actual does not include it |
| security-audit | YES | Match (minor tier differences) |
| performance-sprint | YES | Doc said `researcher` support; actual has `perf-analyzer` |
| release-pipeline | YES | Significantly different agent composition |
| fullstack-swarm | YES | Doc said `sparc-coord` lead; actual has `hierarchical-coordinator` |
| tdd-workflow | NO | In doc, not in router (closest: `testing-sprint`) |
| github-ops | NO | In doc, not in router |
| sparc-planning | NO | In doc, not in router |
| pair-programming | NO | In doc, not in router |
| docs-generation | NO | In doc, not in router |
| cicd-pipeline | NO | In doc, not in router |
| monitoring-alerting | NO | In doc, not in router |
| testing-sprint | In router only | Router has this; doc did not (now in B.1) |

---

## Recommended Execution Order

| Step | ID | Description | Status |
|------|----|-------------|--------|
| 1 | REF-01 | Add Section 0 (Current vs Target State) | DONE |
| 2 | REF-02 | Update Header (version, status, implementation note) | DONE |
| 3 | REF-03 | Rewrite Section 9 (split current/target directory) | DONE |
| 4 | REF-06 | Update Section 12 (add status column) | DONE |
| 5 | REF-04 | Update Section 7 (annotate technology status) | DONE |
| 6 | REF-07 | Update Appendix B (align with tech-lead-router.cjs) | DONE |
| 7 | REF-05 | Update Section 10 (add MCP tool status) | DONE |
| 8 | REF-08 | Update Section 1 (add implementation note) | DONE |
| 9 | REF-10 | Update Section 14 (add ADR status note) | DONE |
| 10 | REF-09 | Update Section 11 (annotate Pino, HNSW targets) | DONE |

---

## Post-Review Checklist

Before the architecture document can move from `1.1.0-draft` to `1.1.0-accepted`:

| # | Task | Status |
|---|------|--------|
| 1 | Complete REF-09: Annotate Section 11 (Pino, HNSW as target tech) | DONE |
| 2 | Verify all Section 0 data is still accurate against filesystem | DONE |
| 3 | Run `tech-lead-router.test.cjs` to confirm tests pass | DONE -- 124/124 tests pass (tech-lead-router + sparc-review-docs) |
| 4 | Review Appendix B.1 agent compositions against router code | DONE |
| 5 | Confirm no new MCP tools have changed status since review | DONE |
| 6 | Update document version to `1.1.0-accepted` and status field | DONE -- Version updated to 1.1.0-accepted, status updated |
| 7 | Merge SPARC review branch to main | PENDING |
| 8 | Archive `sparc-review-*.md` docs or move to `docs/reviews/` | PENDING |

---

## Summary Statistics

| Action | Count | Details |
|--------|-------|---------|
| KEEP | 8 | Sections 2, 3, 4, 5, 6, 8, 13; Appendices A, C |
| UPDATE | 8 | Header, Sections 1, 7, 10, 11, 12, 14; Appendix B |
| REWRITE | 1 | Section 9 (Directory Structure) |
| ADD | 1 | Section 0 (Current vs Target State) |
| **Total actions** | **11** | **10 completed, 1 N/A** |
