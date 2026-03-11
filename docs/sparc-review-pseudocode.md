# SPARC Pseudocode Phase Review: Interface & Data Flow Analysis

**Reviewer:** Pseudocode Phase Agent
**Date:** 2026-03-10
**Document Under Review:** `docs/architecture-orch-agents.md` (Sections 4.3, 6, 8.3)
**Cross-References:** `docs/orchestration-strategy.md`, `.claude/helpers/hook-handler.cjs`, `.claude/helpers/tech-lead-router.cjs`, `tests/tech-lead-router.test.cjs`, `agents/*.yaml`

---

## Quick Reference

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 2 | PSEUDO-C-01, PSEUDO-C-02 |
| High | 4 | PSEUDO-H-01 through PSEUDO-H-04 |
| Medium | 4 | PSEUDO-M-01 through PSEUDO-M-04 |
| Low | 3 | PSEUDO-L-01 through PSEUDO-L-03 |
| **Total** | **13** | |

---

## 1. Interface Completeness Check (Section 8.3)

### 1.1 IntakeEvent

**Missing fields:**

| Field | Justification | Evidence |
|-------|---------------|----------|
| `correlationId: string` | Section 11.4 requires correlation IDs per workflow. IntakeEvent is the origin point. | Section 11.4 |
| `idempotencyKey: string` | Section 11.2 requires idempotent handlers. Deduplication (30s window, Section 6.1) needs composite key. | Section 6.1, 11.2 |
| `receivedAt: string` | Distinct from `timestamp`. Needed to measure intake latency vs <30s target. | Section 11.1 |

**Type safety:** ~~`intent: string` should be a union type.~~ **RESOLVED:** `IntakeEvent.intent` now typed as `WorkIntent` (14 intents + `custom:${string}` escape hatch).

### 1.2 TriageResult

**Missing fields:**

| Field | Justification | Evidence |
|-------|---------------|----------|
| `estimatedEffort` | POST /api/v1/requirements response returns it, but no interface produces it. | Section 8.2 |
| `slaDeadline?` | Section 4.2 lists SLA definitions as owned by Triage. No SLA output field. | Section 4.2 |
| `sourceType` | Planning needs source to choose deterministic vs AI routing (Section 6.1 vs 6.2). | Section 6.1 |

**Consistency:** `complexity.score` (TriageResult) vs `complexity.percentage` (tech-lead-router.cjs) -- same concept, different field names. See PSEUDO-M-01.

### 1.3 WorkflowPlan

**Missing fields:**

| Field | Justification | Evidence |
|-------|---------------|----------|
| `methodology` enum incomplete | `testing-sprint` template implies methodology not in enum. | tech-lead-router.cjs |
| `maxRetries` | Section 6.3 hardcodes 3 retries. Should be configurable per plan. | Section 6.3 |
| `priority` | Not carried forward from TriageResult. Execution needs it for scheduling. | Section 4.2 |
| `clientProjectId?` | Needed to look up quality thresholds from ClientConfig during Review. | Section 8.2 |

**Type safety:** `template: string` should be a union of 9 known template keys. Section 5.3 claims 15 templates but only 9 exist in router. See PSEUDO-M-03.

### 1.4 PhaseResult

**Missing fields:**

| Field | Justification | Evidence |
|-------|---------------|----------|
| `retryCount` | Needed by retry-handler to enforce 3-retry limit. | Section 6.3 |
| `feedback?` | Section 6.3 says "retry with feedback". Feedback must flow back into re-execution. | Section 6.3 |
| `agentIds: string[]` | Agent IDs that executed the phase are lost, blocking post-hoc analysis. | Section 4.3 |

### 1.5 ReviewVerdict

Section 8.3 interface includes `codeReviewApproval` and `feedback` not in Section 4.3 value object table. The value object table should be updated to match.

**Missing:** `reviewedBy: string[]` -- needed for Learning context to evaluate reviewer effectiveness.

---

## 2. Data Flow Consistency

### 2.1 Planning Context Routing Mismatch

Section 6.1 states Planning uses a "deterministic routing table (no AI needed)" for GitHub events. Section 10.1 lists Planning as using `hooks_model-route`. These contradict. The orchestration-strategy.md marks `hooks_model-route` as untested/broken.

> Cross-ref: sparc-review-specification.md G4; sparc-review-architecture.md Section 3.9

### 2.2 Client Clarification Loop Untyped

The `RequirementRefined` event includes "clarification Q&A" but the question/answer structure is only defined in the API request body, not as a domain event payload. The tech-lead-router.cjs `CLARIFICATION_GENERATORS` already provides a structured model (`dimension`, `question`, `options`, `default`) that the architecture should adopt.

### 2.3 Phase Sequencer Not Formalized

No `PhaseSequencer` interface or state machine definition exists. The sequencing algorithm (skip rules, retry with feedback, escalation) should be formalized as pseudocode:

```
ALGORITHM: SequencePhases(plan, currentPhaseIndex)
  phases <- plan.phases (ordered: spec, pseudo, arch, refine, complete)
  current <- phases[currentPhaseIndex]

  IF current.status = 'completed' AND current.verdict.status = 'pass' THEN
    nextIndex <- currentPhaseIndex + 1
    SKIP while phases[nextIndex].status = 'skipped'
    IF nextIndex >= phases.length THEN RETURN DONE
    RETURN phases[nextIndex]
  ELSE IF current.status = 'failed' THEN
    IF current.retryCount < plan.maxRetries THEN RETURN current (retry)
    ELSE RETURN ESCALATE_TO_HUMAN
```

### 2.4 WORKFLOW_MAP Gaps

The `WORKFLOW_MAP` in hook-handler.cjs matches Section 6 of orchestration-strategy.md. However, `testing-sprint` template has no explicit mapping and silently falls through to `'development'`. See PSEUDO-H-03.

> Cross-ref: sparc-review-refinement.md Appendix B discrepancies

---

## 3. Domain Event Coverage

### 3.1 Missing Events for State Transitions

| State Transition | Expected Event | Defined? |
|-----------------|----------------|----------|
| submitted -> triaged | `WorkTriaged` | Yes |
| triaged -> planned | `PlanCreated` | Yes |
| planned -> executing | `PhaseStarted` | Yes |
| executing -> reviewing | `PhaseCompleted` | Yes |
| reviewing -> executing | `ReviewCompleted` | Yes |
| deploying -> completed | `DeploymentCompleted` | Yes |
| executing -> retrying | `PhaseRetried` | **ADDED** |
| * -> failed | `WorkFailed` | **ADDED** |
| * -> cancelled | `WorkCancelled` | **ADDED** |
| * -> paused | `WorkPaused` | **ADDED** |

> Cross-ref: sparc-review-specification.md G11

---

## 4. Alignment with Implementation

### 4.1 Router Output vs WorkflowPlan Gap

| Router Field | WorkflowPlan Field | Status |
|-------------|-------------------|--------|
| `swarm.topology` | `topology` | Aligned |
| `swarm.strategy` | `swarmStrategy` | RESOLVED -- added to WorkflowPlan interface (Section 8.3) |
| `swarm.consensus` | `consensus` | RESOLVED -- added to WorkflowPlan interface (Section 8.3) |
| `swarm.maxAgents` | `maxAgents` | RESOLVED -- added to WorkflowPlan interface (Section 8.3) |
| `agents[].tier` | `PlannedAgent.tier` | **RESOLVED** (PlannedAgent now defined) |
| `ambiguity` | `PlanningInput.ambiguity` | RESOLVED -- carried via PlanningInput bridge interface (Section 8.3) |
| (missing) | `estimatedDuration` | Router does not produce this |
| (missing) | `estimatedCost` | Router does not produce this |
| (missing) | `phases` | Router does not produce phase sequences |

The `PlanningInput` bridge interface was added to Section 8.3, partially closing the gap between router output and planner input.

> Cross-ref: sparc-review-architecture.md Section 2.1 (entire src/ is unbuilt)

### 4.2 Hook Handler Gaps

| Architecture Hook | hook-handler.cjs | Status |
|------------------|------------------|--------|
| `hooks_pre-task` | `pre-task` | Aligned |
| `hooks_post-task` | `post-task` | Aligned |
| `hooks_pre-edit` | `pre-edit` (hook-handler.cjs) | RESOLVED -- implemented as protected path validation in hook-handler.cjs |
| `hooks_post-edit` | `post-edit` | Aligned |
| `hooks_session-start` | `session-restore` | Naming mismatch |
| `hooks_intelligence_learn` | **Not implemented** | DEFERRED -- Phase 6 (Learning Context). Available via `ruflo hooks pretrain` for manual bootstrap. |
| `hooks_intelligence_trajectory-*` | **Not implemented** | DEFERRED -- Phase 6 (Learning Context). |

> Cross-ref: sparc-review-specification.md Section 1.2

### 4.3 Agent Config Coverage

5 YAML configs exist for 18+ agent types referenced in router. See PSEUDO-L-01.

### 4.4 Test Coverage Gaps

Tested: domain classification (9), complexity (16), template selection (7), E2E (5), ambiguity (1), risk (7).

**Not tested:** `classifyScope`, `buildAIClassificationPrompt`, `mergeAIClassification`, agent filtering logic, tier adjustment logic.

---

## 5. Type Safety Gaps

| Location | Current | Should Be |
|----------|---------|-----------|
| `IntakeEvent.intent` | `string` | `WorkIntent` union (14 intents + custom) |
| `WorkflowPlan.template` | `string` | Union of 9 template keys |
| `WorkflowPlan.methodology` | 4-value enum | Add `'testing'` |
| `Phase.status` | unspecified enum | `'pending' \| 'in-progress' \| 'completed' \| 'failed' \| 'skipped' \| 'retrying'` |
| `WorkItem.status` | unspecified enum | `'submitted' \| 'triaged' \| 'planned' \| 'executing' \| 'reviewing' \| 'deploying' \| 'completed' \| 'failed' \| 'cancelled'` |
| Router `agents[].type` | `string` | Union of known agent types |

---

## 6. Findings Tracker

### CRITICAL

| ID | Finding | Status | Next Action |
|----|---------|--------|-------------|
| PSEUDO-C-01 | Four referenced types undefined (`PlannedPhase`, `PlannedAgent`, `Artifact`, `Finding`). Section 8.3 interfaces cannot be implemented. | **RESOLVED** | Added to architecture doc Section 8.3. |
| PSEUDO-C-02 | No bridge interface between tech-lead-router output and WorkflowPlan input. Router produces classification + team; WorkflowPlan expects phases, methodology, cost. | **RESOLVED** | `PlanningInput` interface added to Section 8.3. `swarmStrategy`, `consensus`, and `maxAgents` fields added to `WorkflowPlan` interface. `methodology` enum extended with `'testing'`. |

### HIGH

| ID | Finding | Status | Next Action |
|----|---------|--------|-------------|
| PSEUDO-H-01 | Missing domain events for failure paths (retry, failure, cancellation, pause). | **RESOLVED** | `PhaseRetried`, `WorkFailed`, `WorkCancelled`, `SwarmInitialized`, and `WorkPaused` all added to Section 8.3 Missing Domain Events table. |
| PSEUDO-H-02 | `IntakeEvent.intent` is untyped despite 14 well-defined intents. | **RESOLVED** | `WorkIntent` union type added (14 intents + `custom:${string}`). `IntakeEvent.intent` field type updated from `string` to `WorkIntent` in Section 8.3. |
| PSEUDO-H-03 | `testing-sprint` template missing from WORKFLOW_MAP in hook-handler.cjs. | **RESOLVED** | Added `'testing-sprint': 'testing'` entry to WORKFLOW_MAP in hook-handler.cjs. |
| PSEUDO-H-04 | `pre-edit` hook specified but not implemented. Architecture constraints not validated before code modifications. | **RESOLVED** | Implemented `pre-edit` command in hook-handler.cjs (protected path validation). Section 10.3 updated with implementation status. |

### MEDIUM

| ID | Finding | Status | Next Action |
|----|---------|--------|-------------|
| PSEUDO-M-01 | Complexity score naming inconsistency (`score` in TriageResult vs `percentage` in router). | **RESOLVED** | Standardized on `percentage` in TriageResult and PlanningInput interfaces (Section 8.3). |
| PSEUDO-M-02 | `estimatedEffort` in API response has no source interface. | **RESOLVED** | Added `estimatedEffort: 'trivial' | 'small' | 'medium' | 'large' | 'epic'` to TriageResult interface (Section 8.3). |
| PSEUDO-M-03 | 9 templates in router vs 15 claimed in Section 5.3. | **RESOLVED** | Updated Section 12 template library task to "9 implemented + 6 planned". R3 risk register updated. Appendix B already split into B.1 (9) and B.2 (6). |
| PSEUDO-M-04 | Intelligence/trajectory hooks not implemented in hook-handler.cjs despite Section 10.3 spec. | **RESOLVED** | Deferred to Phase 6 (Learning Context). Section 10.3 annotated with "Deferred to Phase 6" status for all `hooks_intelligence_*` entries. |

### LOW

| ID | Finding | Status | Next Action |
|----|---------|--------|-------------|
| PSEUDO-L-01 | Agent YAML configs exist for only 5 of 18 referenced agent types. | **DEFERRED** | Most agent types are platform-provided by Claude Code (60+ built-in types). Only custom configs needed for project-specific roles. Generate via `ruflo hooks build-agents`. |
| PSEUDO-L-02 | Section 10.1 lists `hooks_model-route` as used by Planning without noting it is broken. | **RESOLVED** | Section 10.1 MCP tool table already has Status column with WORKING/BROKEN/UNTESTED annotations (added in REF-05). |
| PSEUDO-L-03 | Phase sequencing algorithm absent. Skip rules, retry logic, escalation described narratively only. | **RESOLVED** | Added `SequencePhases` algorithm pseudocode to architecture doc Section 6.3 with skip, retry, conditional pass, and escalation logic. |

---

## 7. Resolved Items Summary

The following items from the original review have been addressed in the architecture doc:

| Item | Resolution | Location |
|------|-----------|----------|
| `PlannedPhase` interface | Defined with `phase`, `agents[]`, `gate`, `skippable`, `maxDuration` | Section 8.3 |
| `PlannedAgent` interface | Defined with `role`, `type`, `tier`, `required`, `config?` | Section 8.3 |
| `Artifact` interface | Defined with `id`, `phaseId`, `type`, `path`, `metadata` | Section 8.3 |
| `Finding` interface | Defined with `id`, `severity`, `category`, `message`, `location?`, `autoFixable` | Section 8.3 |
| `PlanningInput` bridge | Defined carrying classification, ambiguity, template, swarm config, agent team | Section 8.3 |
| `DeploymentResult` interface | Defined with `status`, `environment`, `url?`, `healthChecks[]`, `rollbackTriggered` | Section 8.3 |
| `DecisionRecord` interface | Defined with `id`, `inputSignature`, `classification`, `templateSelected`, `agentTeam`, `outcome`, `duration` | Section 8.3 |
| `WorkIntent` union type | 14 intents + `custom:${string}` escape hatch | Section 8.3 |
| `PhaseRetried` event | Added with phase ID, retry count, feedback | Section 8.3 |
| `WorkFailed` event | Added with work item ID, failure reason, retry count | Section 8.3 |
| `WorkCancelled` event | Added with work item ID, cancellation reason | Section 8.3 |
| `SwarmInitialized` event | Added with swarm ID, topology, agent count | Section 8.3 |
