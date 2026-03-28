# Domain-Driven Design Analysis: orch-agents

**Date:** 2026-03-26
**Scope:** Full codebase (~14K LOC TypeScript, 80+ source files)
**Analyst:** DDD Domain Expert Agent

---

## Table of Contents

1. [Bounded Context Map](#1-bounded-context-map)
2. [Aggregate Analysis](#2-aggregate-analysis)
3. [Domain Events Audit](#3-domain-events-audit)
4. [Ubiquitous Language Assessment](#4-ubiquitous-language-assessment)
5. [Anti-Pattern Detection](#5-anti-pattern-detection)
6. [Recommendations](#6-recommendations)

---

## 1. Bounded Context Map

### 1.1 Identified Bounded Contexts

| # | Context | Directory | Responsibility | Type |
|---|---------|-----------|----------------|------|
| 1 | **Webhook Gateway** | `src/webhook-gateway/` | HTTP ingestion, HMAC verification, deduplication, rate limiting | Generic/Infrastructure |
| 2 | **Intake** | `src/intake/` | Event normalization (GitHub + Linear -> IntakeEvent), bot loop prevention, routing rule matching | Supporting |
| 3 | **Triage** | `src/triage/` | Urgency scoring (P0-P3), complexity assessment, impact/risk evaluation, SPARC phase recommendation | Core |
| 4 | **Planning** | `src/planning/` | Decision engine, SPARC decomposition, topology selection, template library, agent team composition | Core |
| 5 | **Execution** | `src/execution/` | Phase execution (4 strategies), worktree management, artifact application, FixItLoop, agent tracking, streaming, cancellation | Core |
| 6 | **Review** | `src/review/` | Composable review gate (diff review + test runner + security scanner), Claude-powered AI review | Core |
| 7 | **Integration** | `src/integration/` | GitHub CLI adapter, Linear API adapter, WORKFLOW.md parser, polling loop, stall detection, workpad reporter | Supporting |
| 8 | **Agent Registry** | `src/agent-registry/` | Agent definition scanning, frontmatter parsing, lookup/filtering | Supporting |
| 9 | **Shared Kernel** | `src/shared/` | Event bus, event types, config, errors, logger, input sanitizer, constants | Shared Kernel |
| 10 | **Setup** | `src/setup/` | CLI wizard, config writer, presets, renderer | Generic |

### 1.2 Context Map Diagram

```
                              UPSTREAM
                    +--------------------------+
                    |   External Systems       |
                    | (GitHub API, Linear API,  |
                    |  Claude CLI)             |
                    +---------+----------------+
                              |
                    +---------v----------------+
                    |   WEBHOOK GATEWAY        |
                    | (signature-verifier,     |  OHS (Open Host
                    |  event-buffer,           |   Service)
                    |  event-parser,           |
                    |  webhook-router)         |
                    +---------+----------------+
                              |
            +-----------------v-----------------+
            |            INTAKE                 |
            | (github-normalizer,               |  ACL
            |  github-workflow-normalizer,       |  (Anti-Corruption
            |  linear-normalizer)               |   Layer)
            +-----------------+-----------------+
                              |
                    IntakeCompleted event
                              |
            +-----------------v-----------------+
            |            TRIAGE                 |
            | (triage-engine, urgency-rules)    |  Customer
            +-----------------+-----------------+
                              |
                    WorkTriaged event
                              |
            +-----------------v-----------------+
            |           PLANNING                |
            | (decision-engine, sparc-decomposer|  Partnership
            |  topology-selector,               |  with Execution
            |  template-library)                |
            +-----------------+-----------------+
                              |
                    PlanCreated event
                              |
   +-------+------------------v-----------------+-------+
   |       |           EXECUTION                |       |
   |       | (execution-engine, phase-runner,   |       |
   |       |  strategies/*, worktree-manager,   |       |
   |       |  artifact-applier, fix-it-loop,    |       |
   |       |  streaming-executor, agent-tracker,|       |
   |       |  cancellation-controller,          |       |
   |       |  work-tracker, prompt-builder)     |       |
   |       +--+----+--------+--+--------+-------+       |
   |          |    |        |  |        |               |
   |          |    |  WorkCompleted     |               |
   |          |    |        |  |        |               |
   |          |    v        v  |        v               |
   |  +-------+--+ +-------+--+  +-----+--------+     |
   |  |INTEGRATION| | REVIEW   |  |AGENT REGISTRY|     |
   |  |(github-   | |(review-  |  |(directory-   |     |
   |  | client,   | | gate,    |  | scanner,     |     |
   |  | linear-*) | | claude-  |  | frontmatter- |     |
   |  |           | | diff-    |  | parser)      |     |
   |  |           | | reviewer)|  |              |     |
   |  +-----------+ +----------+  +--------------+     |
   |                                                    |
   +------ all contexts depend on SHARED KERNEL --------+
              (event-bus, event-types, types.ts,
               config, errors, logger, constants,
               input-sanitizer)
```

### 1.3 Context Mapping Patterns

| Upstream | Downstream | Pattern | Evidence |
|----------|------------|---------|----------|
| GitHub/Linear APIs | Webhook Gateway | **Open Host Service** | Fastify routes expose standard POST endpoints for webhook delivery |
| Webhook Gateway | Intake | **Conformist** | Intake normalizers conform to the `ParsedGitHubEvent` structure produced by the gateway's event-parser |
| Intake | Triage | **Published Language** | Connected via `IntakeCompletedEvent` through the event bus |
| Triage | Planning | **Published Language** | Connected via `WorkTriagedEvent` through the event bus |
| Planning | Execution | **Partnership** | Tightly coupled; `WorkflowPlan` type is shared and both contexts deeply understand it |
| Execution | Review | **Customer-Supplier** | Execution produces `WorkCompleted`; Review defines its own `ReviewGate` interface that Execution must call |
| Execution | Integration (GitHub) | **Anti-Corruption Layer** | `GitHubClient` adapter wraps the `gh` CLI, insulating Execution from GitHub API specifics |
| Integration (Linear) | Intake | **Anti-Corruption Layer** | `linear-normalizer.ts` translates Linear's `LinearWebhookPayload` into the canonical `IntakeEvent` |
| All contexts | Shared Kernel | **Shared Kernel** | `src/shared/` and `src/types.ts` are shared by all contexts |

### 1.4 Context Size Assessment

| Context | Files | Approx LOC | Assessment |
|---------|-------|------------|------------|
| Execution | 21 | ~4,500 | **TOO LARGE** -- Contains 4 execution strategies, worktree management, artifact handling, fix-it loop, agent tracking, streaming, cancellation, prompt building, output parsing, and work tracking. This is the system's God Context. |
| Integration | 10 | ~2,200 | **Borderline** -- Mixes GitHub and Linear concerns. Could be split into two sub-contexts. |
| Review | 5 | ~1,200 | Right-sized |
| Planning | 5 | ~700 | Right-sized |
| Triage | 1 | ~340 | Right-sized (lean) |
| Webhook Gateway | 4 | ~600 | Right-sized |
| Intake | 2 | ~550 | Right-sized |
| Shared Kernel | 8 | ~1,100 | Right-sized |
| Agent Registry | 4 | ~450 | Right-sized |
| Setup | 7 | ~900 | Right-sized |

---

## 2. Aggregate Analysis

### 2.1 Identified Aggregates

The codebase does not use classical aggregate classes. Instead, it uses a functional-factory pattern where domain logic operates on plain data interfaces. This section maps the effective aggregates:

| Aggregate | Root Entity | Value Objects | Bounded Context | File(s) |
|-----------|-------------|---------------|-----------------|---------|
| **IntakeEvent** | `IntakeEvent` | `WorkIntent`, entities map | Intake | `src/types.ts:44-63` |
| **TriageResult** | `TriageResult` | Priority, Complexity, Impact, Risk | Triage | `src/types.ts:69-79` |
| **WorkflowPlan** | `WorkflowPlan` | `PlannedPhase`, `PlannedAgent`, Topology | Planning | `src/types.ts:85-104` |
| **PhaseResult** | `PhaseResult` | `Artifact`, Metrics | Execution | `src/types.ts:110-121` |
| **ReviewVerdict** | `ReviewVerdict` | `Finding` | Review | `src/types.ts:127-135` |
| **WorkItemState** | `WorkItemState` | Status, Timing | Execution | `src/execution/work-tracker.ts:15-24` |
| **AgentExecState** | `AgentExecState` | ParsedSignals, TokenUsage | Execution | `src/execution/agent-tracker.ts:17-35` |
| **WorktreeHandle** | `WorktreeHandle` | Status | Execution | `src/types.ts:201-207` |
| **SwarmHandle** | `SwarmHandle` | Topology, Status | Execution | `src/execution/swarm-manager.ts:20-25` |
| **FixItResult** | `FixItResult` | `FixItAttemptRecord`, History | Execution | `src/execution/fix-it-loop.ts:72-78` |
| **WorkflowConfig** | `WorkflowConfig` | TrackerConfig, AgentsConfig, PollingConfig | Integration | `src/integration/linear/workflow-parser.ts:23-47` |
| **RoutingRule** | `RoutingRule` | Condition, Intent | Intake | `src/intake/github-normalizer.ts:20-29` |

### 2.2 Aggregate Boundary Evaluation

**Well-sized aggregates:**

- **IntakeEvent** -- Small, well-defined. Contains only what the pipeline needs. No cross-context references.
- **TriageResult** -- Clean value-object-like structure. References `intakeEventId` as a foreign key, not the full object.
- **ReviewVerdict** -- Self-contained. Contains `Finding[]` inline, which is correct since findings have no independent identity.

**Oversized aggregates:**

- **WorkflowPlan** (`src/types.ts:85-104`) -- Contains `PlannedPhase[]` and `PlannedAgent[]` inline. These are entities that the Execution context creates, tracks, and mutates (e.g., agent assignment, gate checking). The Plan aggregate is doing double duty: it is both the Planning output and the Execution input. The `topology`, `swarmStrategy`, `consensus`, and `maxAgents` fields are Execution concerns that have leaked into the Planning output.

**Missing consistency boundaries:**

- **WorkItem** -- There is no aggregate that represents the full lifecycle of a work item. `WorkItemState` in `work-tracker.ts` is the closest, but it is a tracking projection, not a domain aggregate. The pipeline passes `IntakeEvent -> TriageResult -> WorkflowPlan -> PhaseResult[]` as separate objects with only `correlationId` tying them together. A `WorkItem` aggregate root could enforce invariants like "a work item cannot be triaged twice" or "a plan cannot be created for a cancelled work item."

### 2.3 Cross-Aggregate Reference Violations

| Location | Violation | Severity |
|----------|-----------|----------|
| `src/types.ts:64-67` `PlanCreatedEvent` | Carries full `intakeEvent?: IntakeEvent` inside the event payload. Events should carry IDs, not full entities. | Medium |
| `src/types.ts:59-62` `WorkTriagedEvent` | Carries full `intakeEvent: IntakeEvent` and `triageResult: TriageResult` together. | Medium |
| `src/execution/fix-it-loop.ts:131` | `FixReviewer.review()` takes a `FixReviewRequest` that duplicates most of `ReviewRequest` from `review-gate.ts`. | Low |
| `src/index.ts:120-175` | The main wiring in `index.ts` manually adapts `FixExecutor`, `FixReviewer`, `FixCommitter`, and `FixPromptBuilder` interfaces by inlining adapter logic. These adapters should live in their own anti-corruption module. | Medium |

### 2.4 Mutable Handle Anti-Pattern

Both `WorktreeHandle` and `SwarmHandle` are mutable value objects that get their `status` field mutated by the manager that created them:

- `src/execution/worktree-manager.ts:179` -- `handle.status = 'committed'`
- `src/execution/worktree-manager.ts:199` -- `handle.status = 'pushed'`
- `src/execution/worktree-manager.ts:271` -- `handle.status = 'disposed'`
- `src/execution/swarm-manager.ts:103` -- `handle.status = 'shutdown'`

This is a DDD anti-pattern. Handles should be immutable; state changes should produce new handle instances or be tracked internally by the manager.

---

## 3. Domain Events Audit

### 3.1 Event Naming Assessment

All 29 events in `src/shared/event-types.ts` follow the past-tense naming convention correctly:

| Event | Past Tense? | Naming Quality |
|-------|-------------|----------------|
| `WebhookReceived` | Yes | Good |
| `RequirementSubmitted` | Yes | Good -- but unused in codebase (no publisher) |
| `RequirementRefined` | Yes | Good -- but unused in codebase (no publisher) |
| `IntakeCompleted` | Yes | Good |
| `WorkTriaged` | Yes | Good |
| `PlanCreated` | Yes | Good |
| `PhaseStarted` | Yes | Good |
| `PhaseCompleted` | Yes | Good |
| `ReviewCompleted` | Yes | Good |
| `DeploymentCompleted` | Yes | Good -- but unused (no deployment context yet) |
| `OutcomeRecorded` | Yes | Good -- but unused |
| `WeightsUpdated` | Yes | Good -- but unused |
| `ClientNotified` | Yes | Good -- but unused |
| `PhaseRetried` | Yes | Good |
| `WorkFailed` | Yes | Good |
| `WorkCancelled` | Yes | Good -- but unused (no publisher) |
| `SwarmInitialized` | Yes | Good -- but unused |
| `WorkPaused` | Yes | Good |
| `WorkCompleted` | Yes | Good |
| `ArtifactsApplied` | Yes | Good |
| `ReviewRequested` | Yes | Good -- but unused |
| `ReviewRejected` | Yes | Good -- but unused |
| `FixRequested` | Yes | Good -- but unused |
| `CommitCreated` | Yes | Good |
| `RollbackTriggered` | Yes | Good -- but unused |
| `AgentSpawned` | Yes | Good |
| `AgentChunk` | **No** | **"AgentChunk" is not past tense. Should be "AgentChunkReceived" or "AgentOutputStreamed".** |
| `AgentCompleted` | Yes | Good |
| `AgentFailed` | Yes | Good |
| `AgentCancelled` | Yes | Good |

### 3.2 Unused Events (Defined But Never Published)

These events are defined in `event-types.ts` and present in `DomainEventMap` and `AnyDomainEvent`, but no code anywhere publishes them:

| Event | Intended Use | Status |
|-------|-------------|--------|
| `WebhookReceived` | Pre-intake raw event | Never published |
| `RequirementSubmitted` | Client-initiated requirement | Never published (no client intake path) |
| `RequirementRefined` | Clarification cycle | Never published |
| `DeploymentCompleted` | Post-review deployment | Never published (no deployment context) |
| `OutcomeRecorded` | Learning feedback | Never published |
| `WeightsUpdated` | Neural weight adjustment | Never published |
| `ClientNotified` | User notification | Never published |
| `WorkCancelled` | Manual cancellation | Never published |
| `SwarmInitialized` | Swarm lifecycle | Never published (SwarmManager does not emit events) |
| `ReviewRequested` | Explicit review request | Never published |
| `ReviewRejected` | Review failure signal | Never published |
| `FixRequested` | Fix loop trigger | Never published |
| `RollbackTriggered` | Rollback notification | Never published |

**11 of 29 events (38%) are phantom events** -- defined but never emitted. This is significant dead code in the event schema.

### 3.3 Missing Events

| Missing Event | Where It Should Be Published | Why |
|---------------|------------------------------|-----|
| `TriageFailed` | `src/triage/triage-engine.ts:329` | Currently publishes generic `WorkFailed`. A specific `TriageFailed` event would let downstream contexts distinguish triage failures from execution failures. |
| `PlanningFailed` | `src/planning/planning-engine.ts:130` | Same issue -- generic `WorkFailed` used instead of specific planning failure event. |
| `WorktreeCreated` | `src/execution/worktree-manager.ts:169` | Worktree lifecycle is invisible to the event bus. Other contexts (e.g., Integration/GitHub for PR creation) need to know when worktrees are ready. |
| `WorktreeDisposed` | `src/execution/worktree-manager.ts:272` | Cleanup lifecycle event for observability. |
| `FixAttemptCompleted` | `src/execution/fix-it-loop.ts` | The fix-it loop runs silently. Each attempt should emit an event for observability. |
| `AgentTimedOut` | `src/execution/agent-tracker.ts:136` | The tracker has a `timeout()` method but no corresponding domain event. |

### 3.4 Event Payload Coupling Issues

| Event | Issue | File:Line |
|-------|-------|-----------|
| `PlanCreatedEvent` | Payload carries `intakeEvent?: IntakeEvent` -- a full aggregate from a different context. This forces the Execution context to understand Intake's internal model. Should carry `intakeEventId: string` and let Execution look it up if needed. | `src/shared/event-types.ts:64-67` |
| `WorkTriagedEvent` | Same issue -- carries both `intakeEvent: IntakeEvent` and `triageResult: TriageResult` as full objects rather than references. | `src/shared/event-types.ts:59-62` |
| `AgentChunkEvent` | Carries raw `chunk: string` which is an implementation detail of the streaming transport. Other contexts should not need to know about individual chunks. | `src/shared/event-types.ts:181-184` |

---

## 4. Ubiquitous Language Assessment

### 4.1 Consistent Naming

The codebase generally maintains good naming consistency:

- **"IntakeEvent"** is used consistently across Intake, Triage, and Planning.
- **"WorkflowPlan"** is used consistently from Planning through Execution.
- **"PhaseResult"** is used consistently in Execution and Review.
- **"Finding"** is used consistently in Review context.
- **"SPARCPhase"** type is used consistently for phase identification.

### 4.2 Terminology Conflicts

| Term | Context A | Context B | Conflict |
|------|-----------|-----------|----------|
| **"template"** | In Intake (`github-normalizer.ts:128`), means a routing template key like `"quick-fix"` or `"tdd-workflow"` that maps webhooks to execution paths. | In Planning (`template-library.ts`), means a `WorkflowTemplate` data structure with phases, agents, and duration estimates. | **Same word, different meaning.** Intake's "template" is a routing key; Planning's "template" is a full execution blueprint. Recommendation: Intake should use "routingTemplate" or "workflowKey". |
| **"agent"** | In Execution (`agent-tracker.ts`), means a running process executing a Claude prompt (identified by `execId`). | In Planning (`sparc-decomposer.ts`), means a `PlannedAgent` -- a role/type/tier specification. | In Agent Registry (`agent-registry.ts`), means an `AgentDefinition` -- a markdown file defining capabilities. | **Three different meanings.** A PlannedAgent is a specification; an AgentExecState is a runtime instance; an AgentDefinition is a catalog entry. |
| **"artifact"** | In Execution (`artifact-applier.ts`), means code changes written to a worktree that need validation and commit. | In `src/types.ts:173-179`, means a generic output object with `id`, `type`, `url`, and `metadata`. | **Overlapping but distinct.** The type system `Artifact` is abstract; the applier works with concrete file changes. |
| **"review"** | In Review (`review-gate.ts`), means the composable review gate (diff + test + security). | In Integration (`claude-diff-reviewer.ts`), means specifically AI-powered code review. | In `ReviewVerdict`, means the aggregated pass/fail outcome. | **Overloaded term.** "Review" as a noun means the verdict; as a verb means the act of reviewing; as a context means the bounded context. |
| **"status"** | `AgentExecStatus`: `'spawned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out'` | `WorktreeHandle.status`: `'active' | 'committed' | 'pushed' | 'disposed'` | `WorkItemState.status`: `'running' | 'completed' | 'failed'` | `SwarmHandle.status`: `'active' | 'shutdown'` | **Four different status enumerations with inconsistent naming.** No two use the same vocabulary. |

### 4.3 Naming Inconsistencies

| Issue | Location | Details |
|-------|----------|---------|
| `WorkIntent` vs `intent` field | `src/types.ts:23-38` | The type is `WorkIntent`, but it is stored in `IntakeEvent.intent`. The "Work" prefix is redundant when the field is already on a work-related object. Should be `Intent` or the field should be `workIntent`. |
| `PlannedPhase` vs `SPARCPhase` | `src/types.ts:155-160` | A `PlannedPhase` has a `type: SPARCPhase`. The field name `type` is generic and conflicts with TypeScript's discriminator convention. Should be `phaseType` for clarity. |
| `phaseResultId` | `src/types.ts:128` | `ReviewVerdict.phaseResultId` -- actually stores `workItemId` in practice (`review-pipeline.ts:43`, `fix-it-loop.ts:148`). The name is misleading. |
| Bot identity state | `github-normalizer.ts:64-82`, `github-workflow-normalizer.ts:24-39`, `linear-normalizer.ts:79-87` | Three separate module-level `_botUserId`/`_botUsername` variables with setter functions. Each file acknowledges this as a TODO. |
| `CliClient` vs `GitHubClient` | `src/execution/cli-client.ts`, `src/integration/github-client.ts` | `CliClient` wraps the `claude-flow` CLI; `GitHubClient` wraps the `gh` CLI. Both are CLI wrappers but use inconsistent naming conventions. |

---

## 5. Anti-Pattern Detection

### 5.1 Anemic Domain Models

**Severity: Moderate**

All domain types in `src/types.ts` are pure data interfaces with no behavior. The system uses a functional style (factory functions that operate on these data structures), which is an acceptable alternative to OO aggregates. However, several invariants are enforced procedurally and could be better co-located:

| Type | Missing Behavior | Current Enforcement |
|------|-------------------|---------------------|
| `IntakeEvent` | No validation that `intent` matches `source` | Spread across normalizers |
| `TriageResult` | No invariant that `requiresApproval` is true when `risk === 'critical'` | Enforced in `triage-engine.ts:105` but not on the type |
| `WorkflowPlan` | No validation that `phases` is non-empty, or that `maxAgents >= agentTeam.length` | Not enforced anywhere |
| `WorktreeHandle` | Status transitions (`active -> committed -> pushed -> disposed`) are not enforced | Mutations scattered across `worktree-manager.ts` |

### 5.2 God Object: Execution Context

**Severity: High**

The `src/execution/` directory is a **God Context** with 21 files and ~4,500 LOC that handles:

1. Phase orchestration (`phase-runner.ts`, `execution-engine.ts`)
2. Four execution strategies (`strategies/*.ts`)
3. Worktree lifecycle (`worktree-manager.ts`)
4. Artifact validation and commit (`artifact-applier.ts`)
5. Review-fix loop (`fix-it-loop.ts`)
6. Agent lifecycle tracking (`agent-tracker.ts`)
7. Streaming output processing (`streaming-executor.ts`, `output-parser.ts`)
8. Cancellation (`cancellation-controller.ts`)
9. Work item state tracking (`work-tracker.ts`)
10. Prompt construction (`prompt-builder.ts`)
11. Swarm management (`swarm-manager.ts`)
12. Agent orchestration (`agent-orchestrator.ts`)
13. Task delegation (`task-delegator.ts`)
14. Artifact collection (`artifact-collector.ts`)
15. Retry handling (`retry-handler.ts`)
16. CLI interaction (`cli-client.ts`)
17. Agent sandboxing (`agent-sandbox.ts`)

This violates the Single Responsibility Principle at the context level. The `PhaseRunnerDeps` interface (`phase-runner.ts:58-78`) accepts **14 optional dependencies**, which is a code smell indicating too many responsibilities.

### 5.3 Feature Envy

| Location | Envied Context | Details |
|----------|----------------|---------|
| `src/index.ts:120-175` | Execution, Review | The main entry point manually wires `FixExecutor`, `FixReviewer`, `FixCommitter`, and `FixPromptBuilder` adapters inline. This adapter logic uses internals of both Execution and Review contexts. It should live in a dedicated adapter module. |
| `src/execution/strategies/interactive-strategy.ts` | Review | The interactive strategy calls `reviewGate.review()` and `fixItLoop.run()` directly, reaching across context boundaries within a single strategy method. |
| `src/review/review-pipeline.ts:81-83` | Execution | `WorkCompletedEvent` payload is cast to `Record<string, unknown>` to extract `diff`, `worktreePath`, and `artifacts` -- fields that are not part of the event's typed payload. This is a leaky abstraction from Execution into Review. |

### 5.4 Shared Mutable State (Module-Level Singletons)

**Severity: Medium**

Multiple modules use module-level mutable state with setter/reset functions, creating hidden coupling:

| File | Mutable State | Setter |
|------|---------------|--------|
| `src/intake/github-normalizer.ts:35` | `_routingTable` | `setRoutingTable()` |
| `src/intake/github-normalizer.ts:64-65` | `_botUserId`, `_botUsername` | `setBotUserId()`, `setBotUsername()` |
| `src/intake/github-workflow-normalizer.ts:24-25` | `_botUserId`, `_botUsername` | `setBotUserId()`, `setBotUsername()` |
| `src/integration/linear/linear-normalizer.ts:47,79` | `_workflowConfig`, `_botUserId` | `setWorkflowConfig()`, `setLinearBotUserId()` |
| `src/triage/triage-engine.ts:42` | `_rules` | `setUrgencyRules()` |
| `src/router-bridge.ts:65` | `_router` | Lazy-loaded singleton |
| `src/agent-registry/agent-registry.ts:113` | `_defaultRegistry` | `getDefaultRegistry()` |

This pattern makes testing easier (via setters) but creates invisible dependencies between contexts. The normalizers' bot identity state is duplicated three times.

### 5.5 Shared Database / Shared Kernel Violations

**Severity: Low-Medium**

The `src/types.ts` file at the root of `src/` is a **de facto shared kernel** containing types used by every context. This is acceptable for a monolith of this size, but it creates tight coupling:

- `IntakeEvent` is defined once and used in Intake, Triage, Planning, Execution, and Review.
- `WorkflowPlan` is defined once and used in Planning and Execution.
- `Artifact` and `Finding` are defined once and used across Execution and Review.

The risk: any change to `src/types.ts` can affect all contexts. This would become a problem if the system were to be split into separately deployable services.

### 5.6 Leaky Abstractions Between Contexts

| Location | Leak | Impact |
|----------|------|--------|
| `src/review/review-pipeline.ts:81-84` | Review casts `WorkCompletedEvent.payload` to `Record<string, unknown>` to access `diff`, `worktreePath`, `artifacts` which are not in the typed event. Execution is smuggling data through untyped payload fields. | Review depends on undocumented Execution internals. |
| `src/review/claude-diff-reviewer.ts:19` | Review imports `buildSafeEnv` from `src/execution/cli-client.ts`. The Review context depends on an Execution implementation detail for environment construction. | Cross-context import dependency. |
| `src/review/claude-diff-reviewer.ts:19` | Review imports `createAgentSandbox` from `src/execution/agent-sandbox.ts`. Same issue. | Cross-context import dependency. |
| `src/integration/github-client.ts:16` | Integration imports `buildSafeEnv` from `src/execution/cli-client.ts`. | Cross-context import dependency. |
| `src/index.ts:170-171` | Main entry builds fake `IntakeEvent` and `WorkflowPlan` objects to satisfy `buildFixPrompt()` signature, with placeholder values. The prompt builder's interface forces callers to construct domain objects they do not own. | Interface over-specification. |

---

## 6. Recommendations

### 6.1 Context Boundary Adjustments

#### R1: Extract "Agent Runtime" from Execution (Priority: High)

Split the Execution God Context into two:

**Execution** (orchestration):
- `execution-engine.ts`
- `phase-runner.ts`
- `strategies/*.ts`
- `work-tracker.ts`
- `retry-handler.ts`

**Agent Runtime** (agent lifecycle):
- `agent-tracker.ts`
- `streaming-executor.ts`
- `task-executor.ts`
- `interactive-executor.ts`
- `cli-client.ts`
- `agent-orchestrator.ts`
- `agent-sandbox.ts`
- `cancellation-controller.ts`
- `output-parser.ts`

#### R2: Extract "Worktree" from Execution (Priority: Medium)

The worktree management + artifact application + fix-it loop forms a cohesive sub-domain:

**Worktree Context:**
- `worktree-manager.ts`
- `artifact-applier.ts`
- `artifact-collector.ts`
- `fix-it-loop.ts`

#### R3: Move `prompt-builder.ts` to Shared Kernel (Priority: Low)

The prompt builder is a pure function module used by both Execution strategies and the fix-it loop. It has no Execution-specific dependencies. Moving it to Shared would make the dependency direction cleaner.

#### R4: Move `buildSafeEnv` and `createAgentSandbox` to Shared (Priority: Medium)

These utilities are used by Execution, Review (claude-diff-reviewer), and Integration (github-client). They belong in Shared Kernel since they are cross-context infrastructure.

### 6.2 Aggregate Improvements

#### R5: Introduce a `WorkItem` Aggregate (Priority: High)

Create a `WorkItem` aggregate root that tracks the full lifecycle:

```typescript
// src/types.ts (or new src/work-item/work-item.ts)
interface WorkItem {
  id: string;
  status: 'intake' | 'triaged' | 'planned' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
  intakeEventId: string;
  triageResultId?: string;
  planId?: string;
  correlationId: string;
  createdAt: string;
  completedAt?: string;
}
```

This would replace the current pattern where work item identity is tracked only via `correlationId` on events.

#### R6: Make Handles Immutable (Priority: Low)

Replace mutable `WorktreeHandle` and `SwarmHandle` with immutable snapshots. State transitions should return new handle instances:

```typescript
// Instead of: handle.status = 'committed';
// Use: const committedHandle = { ...handle, status: 'committed' as const };
```

### 6.3 Event Improvements

#### R7: Remove or Implement Phantom Events (Priority: Medium)

The 11 unused events should be either:
- **Implemented** if they represent real domain transitions that are currently invisible.
- **Removed** if they were speculative and are not needed.

Recommended actions:
- **Keep and implement:** `WebhookReceived` (publish in `webhook-router.ts` before intake), `SwarmInitialized` (publish in `swarm-manager.ts`), `RollbackTriggered` (publish in `artifact-applier.ts`).
- **Remove:** `RequirementSubmitted`, `RequirementRefined`, `ClientNotified` (no corresponding feature exists).
- **Keep as future placeholders:** `DeploymentCompleted`, `OutcomeRecorded`, `WeightsUpdated` (planned for future phases).
- **Implement:** `WorkCancelled` (needed for cancellation flow), `ReviewRequested`, `ReviewRejected`, `FixRequested` (needed for fix-it loop observability).

#### R8: Rename `AgentChunk` to `AgentChunkReceived` (Priority: Low)

Follow the past-tense event naming convention.

#### R9: Stop Carrying Full Aggregates in Events (Priority: Medium)

Change `PlanCreatedEvent` and `WorkTriagedEvent` to carry IDs instead of full objects:

```typescript
// Before:
type WorkTriagedEvent = DomainEvent<'WorkTriaged', { intakeEvent: IntakeEvent; triageResult: TriageResult }>;

// After:
type WorkTriagedEvent = DomainEvent<'WorkTriaged', { intakeEventId: string; triageResult: TriageResult }>;
```

This requires a lookup mechanism (in-memory cache or store) for downstream consumers that need the full `IntakeEvent`. Since the system is currently in-process with an EventEmitter bus, the full-object approach works, but it will cause problems when migrating to NATS JetStream (mentioned in `event-bus.ts:6`).

#### R10: Type the `WorkCompleted` Event Payload Properly (Priority: High)

Currently, `review-pipeline.ts:81-84` accesses `diff`, `worktreePath`, and `artifacts` via unsafe `Record<string, unknown>` casts. These fields should be added to the `WorkCompletedEvent` payload type:

```typescript
// src/shared/event-types.ts
export type WorkCompletedEvent = DomainEvent<
  'WorkCompleted',
  {
    workItemId: string;
    planId: string;
    phaseCount: number;
    totalDuration: number;
    // Add these:
    diff?: string;
    worktreePath?: string;
    commitSha?: string;
    branch?: string;
    artifacts?: Artifact[];
  }
>;
```

### 6.4 Ubiquitous Language Fixes

#### R11: Rename "template" in Intake to "routingTemplate" (Priority: Low)

In `github-normalizer.ts` and `github-workflow-normalizer.ts`, rename `rule.template` references in `IntakeEvent.sourceMetadata` to `routingTemplate` to distinguish from Planning's `WorkflowTemplate`.

#### R12: Consolidate Bot Identity State (Priority: Medium)

Replace the three module-level `_botUserId`/`_botUsername` singletons with a single injected `BotIdentity` value object:

```typescript
interface BotIdentity {
  userId?: number;      // GitHub numeric ID
  username?: string;    // GitHub login
  linearUserId?: string; // Linear actor ID
}
```

Pass this into each normalizer function as a parameter rather than relying on module-level state.

#### R13: Fix `ReviewVerdict.phaseResultId` Naming (Priority: Low)

Rename `phaseResultId` to `workItemId` since that is what it actually stores in all call sites (`review-pipeline.ts:43`, `fix-it-loop.ts:148`).

### 6.5 Architecture Improvements

#### R14: Reduce `PhaseRunnerDeps` Coupling (Priority: High)

The `PhaseRunnerDeps` interface with 14 optional dependencies should be split. Each strategy should declare its own deps interface:

```typescript
// Instead of PhaseRunnerDeps with everything optional:
interface InteractiveStrategyDeps {
  interactiveExecutor: InteractiveTaskExecutor;
  worktreeManager: WorktreeManager;
  artifactApplier: ArtifactApplier;
  fixItLoop: FixItLoop;
  reviewGate: ReviewGate;
  githubClient?: GitHubClient;
}
```

The `PhaseRunner` would then accept a union of strategy-specific dep bundles.

#### R15: Extract Adapter Module from index.ts (Priority: Medium)

Move the inline adapter wiring from `src/index.ts:120-175` into a dedicated `src/execution/fix-it-adapters.ts` module. This adapter module would live at the Execution/Review context boundary and translate between the two contexts' interfaces.

#### R16: Introduce an Event Store (Priority: Low, Future)

The comment in `event-bus.ts:6` mentions migration to NATS JetStream. Before that migration, introduce an in-memory event store that retains recent events by `correlationId`. This would enable:
- Removing full aggregates from event payloads (R9).
- Auditing and replay capabilities.
- Debugging production issues by correlating all events for a work item.

---

## Summary

### Strengths

1. **Clean event-sourced pipeline.** The IntakeCompleted -> WorkTriaged -> PlanCreated -> WorkCompleted -> ReviewCompleted event chain is well-designed and follows DDD event-driven architecture.
2. **Good use of factory-DI pattern.** Every module exposes a `createX(deps)` factory, enabling London School TDD. Dependencies are explicit.
3. **Strong anti-corruption layers.** The normalizers (GitHub, Linear) cleanly translate external payloads into the canonical `IntakeEvent`.
4. **Well-typed domain event envelope.** The `DomainEvent<T, P>` generic with `DomainEventMap` provides compile-time safety for event subscriptions.
5. **Defense-in-depth security.** Input sanitization, HMAC verification, path traversal prevention, secret scanning, and agent sandboxing are all present.

### Key Issues

1. **Execution is a God Context** (21 files, ~4,500 LOC, 14 optional dependencies). Must be decomposed.
2. **38% of domain events are phantoms** (defined but never published). Creates false confidence in coverage.
3. **Leaky abstractions** between Review and Execution (untyped payload fields, cross-context imports of `buildSafeEnv` and `createAgentSandbox`).
4. **No WorkItem aggregate** to track full lifecycle and enforce invariants.
5. **Three separate bot identity singletons** with acknowledged TODO to consolidate.
6. **"Template" has conflicting meanings** across Intake and Planning contexts.

### Priority Matrix

| Priority | Recommendation | Impact | Effort |
|----------|---------------|--------|--------|
| **P0** | R10: Type WorkCompleted payload | Fixes runtime casting bugs | Low |
| **P1** | R1: Extract Agent Runtime context | Reduces God Context | Medium |
| **P1** | R14: Split PhaseRunnerDeps | Reduces coupling | Medium |
| **P2** | R5: Introduce WorkItem aggregate | Enables lifecycle invariants | Medium |
| **P2** | R7: Remove/implement phantom events | Reduces dead code | Low |
| **P2** | R12: Consolidate bot identity | Eliminates duplicated state | Low |
| **P2** | R4: Move shared utils to Shared Kernel | Fixes cross-context imports | Low |
| **P3** | R2: Extract Worktree context | Further decomposition | Medium |
| **P3** | R9: Stop carrying full aggregates in events | Prepares for NATS migration | Medium |
| **P3** | R15: Extract adapter module | Cleans up index.ts | Low |
| **P3** | R11, R13: Naming fixes | Ubiquitous language | Low |
| **P4** | R6: Immutable handles | Code quality | Low |
| **P4** | R8: Rename AgentChunk | Naming convention | Trivial |
| **P4** | R16: Event store | Future architecture | High |
