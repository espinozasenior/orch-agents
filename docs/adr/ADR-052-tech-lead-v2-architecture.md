# ADR-052: Tech Lead Orchestrator v2 Architecture

## Status

Proposed

## Context

### Why v1 Is Insufficient

Tech Lead Orchestrator v1 (`tech-lead-router.cjs`, 672 lines) is a single-file decision engine that accepts user text input and returns an agent team configuration. It was designed as a local classification tool, not a production orchestrator. Its limitations are structural:

**Single input channel.** V1 accepts only human-written task descriptions via CLI. It has no mechanism to receive GitHub webhooks, scheduled events, CI failure alerts, deployment status callbacks, or any machine-originated signal. Every workflow must begin with a person typing a sentence.

**Regex-only classification with narrow fallback.** The decision engine uses regex pattern matching across four dimensions (domain, complexity, scope, risk) with a Haiku AI fallback only for the moderate-ambiguity band (scores 30-49). There is no semantic understanding of intent, no multi-signal fusion, and no way to classify structured event payloads (e.g., a GitHub `pull_request.opened` webhook).

**Static template library.** V1 offers 8 team templates: quick-fix, research-sprint, feature-build, sparc-full-cycle, security-audit, performance-sprint, release-pipeline, fullstack-swarm. These cover common development tasks but miss entire workflow categories: TDD-specific flows, GitHub operations (PR review, issue triage, release automation), SPARC partial cycles (planning-only), pair programming, documentation generation, CI/CD pipeline management, and monitoring/alerting.

**No lifecycle management.** V1 produces a one-shot decision -- it emits swarm-init and agent-spawn commands, then terminates. It does not track whether agents complete their work, whether the resulting code passes review, whether the deployment succeeds, or whether the decision itself was good. There is no concept of workflow phases, state transitions, or outcome feedback.

**No learning.** Every decision is made from scratch. V1 does not store decisions in AgentDB, does not track outcomes, does not adjust routing weights, and does not learn which team compositions succeed or fail for specific task types.

**No GitHub integration.** The most common trigger for development work -- a PR opened, an issue filed, a CI run failing, a deployment failing -- cannot reach v1 at all. Engineers must manually translate GitHub events into natural language descriptions for the router.

The system we need is not an improved classifier. It is a production-grade development orchestrator that serves as the central nervous system for a company's development workflow, ingesting events from multiple sources, managing the full software development lifecycle, learning from outcomes, and routing across the full breadth of 51 agent types, 31 skills, 85+ slash commands, and 140+ MCP tools.

### V1 Architecture Summary (for reference)

```
User text input
    |
    v
Regex classification (domain, complexity, scope, risk)
    |
    v
Ambiguity detection (score 0-100)
    |
    +-- score < 30: proceed
    +-- score 30-49: Haiku AI check (~500ms)
    +-- score >= 50: ask user for clarification
    |
    v
Template selection (8 static templates)
    |
    v
Agent team + swarm config output (one-shot)
```

## Decision

Redesign Tech Lead Orchestrator as an event-driven, multi-phase workflow engine organized into seven bounded contexts, backed by AgentDB for persistent memory and learning. The system replaces v1's single-file regex classifier with a multi-stage decision pipeline capable of ingesting events from any source, orchestrating the full SDLC, and improving its routing accuracy over time.

### Core Architecture Principles

1. **Event-sourced state.** Every workflow progresses through phases via domain events. State is reconstructable from the event log. No mutable shared state between bounded contexts.
2. **Bounded contexts with clear contracts.** Seven contexts communicate through typed events on an internal event bus. Each context owns its own data and decision logic.
3. **Multi-input, single pipeline.** GitHub webhooks, user commands, scheduled events, and system alerts all normalize into a common `IntakeEvent` before entering the pipeline.
4. **Decision engine v2 with learning.** Classification uses regex as a fast first pass, semantic analysis as a second pass, and historical pattern matching as a third pass. Routing weights adjust based on measured outcomes.
5. **Phased lifecycle.** Every piece of work moves through Intake, Triage, Plan, Execute, Review, Deploy, Monitor. Phases can be skipped when inappropriate (a research task skips Deploy).

### Bounded Contexts

#### 1. Intake Context

**Responsibility:** Normalize all input sources into a canonical `IntakeEvent`.

**Input sources:**

| Source | Handler | Normalization |
|--------|---------|---------------|
| GitHub webhook | `WebhookHandler` | Parse event type, extract repo/PR/issue metadata, map action to intent |
| User command | `CommandHandler` | Parse natural language or slash command, extract intent |
| Scheduled event | `ScheduleHandler` | Map cron job to predefined workflow template |
| System alert | `AlertHandler` | Parse CI/deployment/security alert, extract severity and context |

**Canonical event schema:**

```typescript
interface IntakeEvent {
  id: string;                    // UUID
  timestamp: string;             // ISO 8601
  source: 'github' | 'user' | 'schedule' | 'system';
  sourceMetadata: Record<string, unknown>;  // Raw payload reference
  intent: string;                // Normalized intent (e.g., "review-pr", "fix-bug", "deploy")
  entities: {                    // Extracted structured data
    repo?: string;
    branch?: string;
    prNumber?: number;
    issueNumber?: number;
    files?: string[];
    labels?: string[];
    author?: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
  };
  rawText?: string;              // Original user text if from user/command source
}
```

**GitHub webhook event mapping:**

| GitHub Event | Action | Normalized Intent | Downstream Workflow |
|-------------|--------|------------------|-------------------|
| `pull_request` | `opened` | `review-pr` | Code review swarm + security scan + coverage check |
| `pull_request` | `synchronize` | `re-review-pr` | Incremental review on changed files |
| `pull_request` | `merged` | `post-merge` | Release pipeline (if main), project board update |
| `issues` | `opened` | `triage-issue` | Classify, label, estimate, sprint assignment |
| `issues` | `labeled` (bug) | `fix-bug` | Researcher -> coder -> tester pipeline |
| `push` | (to main) | `validate-main` | Full test suite, security scan, deploy pipeline |
| `workflow_run` | `completed` (fail) | `debug-ci` | Failure analysis, fix suggestion |
| `release` | `published` | `deploy-release` | Deploy, monitor, generate changelog |
| `deployment_status` | `failure` | `incident-response` | Rollback, incident response team |
| `dependabot` | alert | `security-alert` | Security audit team |

#### 2. Triage Context

**Responsibility:** Assess urgency, priority, and complexity. Determine whether the work should be queued, started immediately, or escalated.

**Triage dimensions:**

| Dimension | Assessment Method | Output |
|-----------|------------------|--------|
| Urgency | Source type + severity + labels | `P0-immediate` / `P1-high` / `P2-standard` / `P3-backlog` |
| Complexity | Decision Engine v2 classification | `low` / `medium` / `high` with percentage |
| Impact | Files changed + dependency graph + blast radius | `isolated` / `module` / `cross-cutting` / `system-wide` |
| Risk | Production exposure + data sensitivity + reversibility | `low` / `medium` / `high` / `critical` |

**Triage rules (examples):**

- `deployment_status.failure` -> always P0, skip triage queue
- `dependabot` critical -> P1, auto-assign security team
- `issues.opened` with no labels -> P2, queue for human review or AI triage
- `schedule` nightly build -> P3, run in off-hours window

**Output:** `TriagedEvent` containing priority, estimated complexity, recommended phase sequence, and whether human approval is required before execution.

#### 3. Planning Context

**Responsibility:** Decompose triaged work into a plan: select methodology, identify tasks, assign dependencies, choose team template.

**Planning activities:**

1. **Methodology selection.** Based on complexity and type:
   - SPARC full cycle: complexity > 70%, greenfield features
   - SPARC partial (spec + arch only): design-phase work, ADRs
   - TDD London school: bug fixes, well-scoped features
   - Ad-hoc: quick fixes, config changes, documentation

2. **Task decomposition.** Break the work into ordered tasks with dependencies. Each task maps to an execution phase.

3. **Team template selection.** Use Decision Engine v2 (see below) to select from the expanded template library.

4. **Resource estimation.** Estimate agent count, expected duration, model tier costs.

**Output:** `WorkflowPlan` containing ordered task list, selected template, agent team composition, dependency graph, and phase sequence.

#### 4. Execution Context

**Responsibility:** Orchestrate the actual agent swarm to execute the plan. Manage swarm lifecycle, agent health, task assignment, and intermediate checkpoints.

**Execution phases (selected per plan):**

| Phase | Agents Involved | Entry Condition | Exit Condition |
|-------|----------------|-----------------|----------------|
| Design | architect, system-architect | Plan approved | Design artifacts produced |
| Implement | coder, backend-dev, frontend-dev, sparc-coder | Design complete | Code changes committed |
| Test | tester, tdd-london-swarm, production-validator | Implementation complete | All tests pass |
| Integrate | cicd-engineer, tester | Tests pass | CI pipeline green |

**Swarm topology selection algorithm:**

```
if agentCount <= 2:        mesh (peer collaboration)
elif agentCount <= 5:      hierarchical (tight control)
elif agentCount <= 8:      hierarchical (with sub-teams)
elif agentCount <= 15:     hierarchical-mesh (domain sub-meshes under coordinator)
elif sequential pipeline:  ring (ordered handoff)
elif central validation:   star (hub-and-spoke)
elif variable workload:    adaptive (dynamic reshaping)
```

**Checkpoint protocol:** After each phase, the execution context emits a `PhaseCompleted` event with artifacts, metrics, and status. The workflow advances only on success; failures trigger retry or escalation.

#### 5. Review Context

**Responsibility:** Quality gates between execution and deployment. Code review, security audit, compliance checks, test coverage validation.

**Review pipeline:**

1. **Automated checks.** Lint, type check, test coverage threshold, dependency audit.
2. **Code review swarm.** `code-review-swarm` agents review changes against coding standards, architecture constraints (ADRs), and domain conventions.
3. **Security scan.** `security-auditor` checks for vulnerabilities, secret leaks, injection vectors.
4. **Quality gate evaluation.** Aggregate all review signals into a pass/fail/conditional decision.

**Output:** `ReviewVerdict` -- pass (proceed to deploy), fail (return to execution with feedback), conditional (proceed with noted risks).

#### 6. Deployment Context

**Responsibility:** Manage the deployment pipeline from staging through production, including rollback.

**Deployment stages:**

1. **Staging deployment.** Deploy to staging environment, run smoke tests.
2. **Staging validation.** `production-validator` agent confirms expected behavior.
3. **Production deployment.** Progressive rollout (canary or blue-green).
4. **Post-deploy verification.** Health checks, error rate monitoring, latency checks.
5. **Rollback.** If verification fails, automated rollback with incident event emission.

**Agents:** `cicd-engineer`, `release-manager`, `production-validator`.

#### 7. Learning Context

**Responsibility:** Observe outcomes across all contexts and update routing intelligence.

**Learning loop:**

```
Decision made (template, agents, topology)
    |
    v
Execution observed (duration, success/failure, agent utilization)
    |
    v
Outcome recorded in AgentDB
    |
    v
Pattern weights updated
    |
    v
Future decisions use updated weights
```

**What gets stored per decision:**

| Field | Type | Purpose |
|-------|------|---------|
| `decisionId` | UUID | Unique identifier |
| `inputSignature` | hash | Normalized representation of input signals for similarity matching |
| `classification` | object | Domain, complexity, scope, risk as classified |
| `templateSelected` | string | Which template was chosen |
| `agentTeam` | array | Agents spawned with roles and tiers |
| `topology` | string | Swarm topology used |
| `outcome` | enum | `success` / `partial` / `failure` / `timeout` |
| `duration` | number | Wall-clock time from start to completion |
| `phaseMetrics` | object | Per-phase timing and success rates |
| `humanOverrides` | array | Any manual corrections to the plan |
| `timestamp` | ISO 8601 | When the decision was made |

**Weight adjustment algorithm:**

```
For each completed workflow:
  1. Compute input similarity to all stored patterns (HNSW nearest-neighbor)
  2. For the top-K similar patterns:
     a. If same template was used and outcome was success: increase weight
     b. If same template was used and outcome was failure: decrease weight
     c. If different template was used and outcome was success: note as alternative
  3. Store updated pattern with new weight
  4. On future routing, bias template selection toward higher-weighted patterns
```

**ReasoningBank integration:** Use `agentdb_hierarchical-store` to store decision trajectories and `agentdb_pattern-search` to retrieve similar past decisions during the Planning phase. Use `hooks_intelligence_trajectory-start/step/end` to track the full lifecycle of each decision for trajectory-based learning.

### Decision Engine v2

The v2 decision engine replaces v1's flat regex classifier with a three-stage pipeline.

#### Stage 1: Signal Extraction (< 5ms)

Retain v1's regex patterns for fast keyword extraction, extended with:
- GitHub event type patterns (structured, not regex -- direct field matching)
- Slash command parsing (`/sparc`, `/review`, `/deploy`, etc.)
- Cron job identifier matching
- CI/CD system alert parsing

Output: raw signal vector with domain matches, complexity signals, scope signals, risk signals, and source metadata.

#### Stage 2: Semantic Classification (0-500ms, conditional)

Activated when Stage 1 ambiguity score >= 30 or when input is from a new/unrecognized source.

- For user text: Haiku semantic classification (as in v1, but with expanded schema)
- For GitHub events: deterministic mapping (no AI needed -- event types are unambiguous)
- For system alerts: rule-based severity mapping

Output: classified intent with confidence score.

#### Stage 3: Pattern Matching (< 10ms with HNSW)

Query AgentDB for historically similar inputs using HNSW vector search.

- If a high-confidence match exists (similarity > 0.85, outcome = success): use the stored template with its proven agent composition.
- If a moderate match exists (similarity 0.6-0.85): use it as a starting point, allow Stage 2 to override specific dimensions.
- If no match: fall through to rule-based template selection.

Output: final classification with template selection, optionally weighted by historical performance.

#### Template Library v2 (15 templates)

**Retained from v1 (8):**

| Key | Name | Topology | Agents | Use Case |
|-----|------|----------|--------|----------|
| `quick-fix` | Quick Fix | mesh | 1-2 | Bug fix, small refactor, config change |
| `research-sprint` | Research Sprint | mesh | 1-3 | Exploration, documentation, codebase analysis |
| `feature-build` | Feature Build | hierarchical | 4-5 | New feature, API endpoint, enhancement |
| `sparc-full-cycle` | SPARC Full Cycle | hierarchical | 5-8 | Complex feature, full spec-to-completion |
| `security-audit` | Security Audit | hierarchical | 3-5 | Vulnerability assessment, compliance review |
| `performance-sprint` | Performance Sprint | hierarchical | 3-4 | Optimization, benchmarking, profiling |
| `release-pipeline` | Release Pipeline | hierarchical-mesh | 4-6 | Release preparation, multi-repo sync |
| `fullstack-swarm` | Full Stack Swarm | hierarchical-mesh | 6-8 | Large cross-cutting change, major refactor |

**New in v2 (7):**

| Key | Name | Topology | Agents | Use Case |
|-----|------|----------|--------|----------|
| `tdd-workflow` | TDD Workflow | hierarchical | 3-5 | Test-first development, London school mocking |
| `github-ops` | GitHub Operations | star | 3-5 | PR review, issue triage, release automation |
| `sparc-planning` | SPARC Planning | hierarchical | 2-3 | Spec + architecture only, no implementation |
| `pair-programming` | Pair Programming | mesh | 2 | Collaborative coding, driver/navigator pattern |
| `docs-generation` | Documentation | mesh | 2-3 | API docs, guides, changelogs, ADRs |
| `cicd-pipeline` | CI/CD Pipeline | ring | 3-5 | Build, test, deploy sequential pipeline |
| `monitoring-alerting` | Monitoring & Alerting | star | 2-4 | Post-deploy health, incident response, SLA tracking |

**Template agent definitions (new templates):**

`tdd-workflow`:
- Lead: `tester` (tier 3) -- writes test specifications first
- `coder` (tier 3) -- implements to pass tests
- `reviewer` (tier 2) -- validates test quality and coverage
- Optional: `security-auditor` (tier 2) -- security test cases

`github-ops`:
- Lead: `pr-manager` (tier 2) -- coordinates GitHub operations
- `code-review-swarm` (tier 2) -- reviews code changes
- `issue-tracker` (tier 2) -- manages issue lifecycle
- Optional: `release-manager` (tier 2) -- release coordination
- Optional: `project-board-sync` (tier 2) -- board updates

`sparc-planning`:
- Lead: `sparc-coord` (tier 3) -- orchestrates planning
- `specification` (tier 3) -- writes specifications
- `architecture` (tier 3) -- designs architecture

`pair-programming`:
- `coder` (tier 3, role: driver) -- writes code
- `reviewer` (tier 3, role: navigator) -- guides and reviews in real-time

`docs-generation`:
- Lead: `researcher` (tier 2) -- analyzes code for documentation
- `api-docs` (tier 2) -- generates API documentation
- Optional: `coder` (tier 2) -- generates code examples

`cicd-pipeline`:
- Lead: `cicd-engineer` (tier 2) -- orchestrates pipeline
- `tester` (tier 2) -- runs test suites
- `security-auditor` (tier 2) -- security scanning stage
- Optional: `production-validator` (tier 2) -- staging validation

`monitoring-alerting`:
- Lead: `performance-engineer` (tier 2) -- monitors health metrics
- `production-validator` (tier 2) -- validates deployment health
- Optional: `coder` (tier 2) -- hot-fix patches if regressions found

#### Routing Algorithm v2

```
function routeV2(intakeEvent: IntakeEvent): WorkflowPlan {

  // 1. Source-specific fast path
  if (intakeEvent.source === 'github') {
    return routeGitHubEvent(intakeEvent);
  }
  if (intakeEvent.source === 'schedule') {
    return routeScheduledEvent(intakeEvent);
  }
  if (intakeEvent.source === 'system') {
    return routeSystemAlert(intakeEvent);
  }

  // 2. User input: three-stage classification
  const signals = extractSignals(intakeEvent.rawText);         // Stage 1: regex
  let classification = classifyFromSignals(signals);

  if (signals.ambiguityScore >= 30) {
    classification = await semanticClassify(intakeEvent);       // Stage 2: Haiku
  }

  const historicalMatch = await patternSearch(classification);  // Stage 3: HNSW
  if (historicalMatch && historicalMatch.similarity > 0.85) {
    return applyHistoricalPattern(historicalMatch, classification);
  }

  // 3. Template selection (extended from v1)
  const template = selectTemplateV2(classification);

  // 4. Topology selection
  const topology = selectTopology(template.agents.length, classification);

  // 5. Phase sequence determination
  const phases = determinePhasesForTemplate(template, classification);

  return buildWorkflowPlan(template, topology, phases, classification);
}

function routeGitHubEvent(event: IntakeEvent): WorkflowPlan {
  // Deterministic routing -- no AI needed
  const mapping = GITHUB_EVENT_ROUTING[event.intent];
  if (!mapping) throw new UnknownEventError(event);

  return {
    template: mapping.template,
    phases: mapping.phases,
    agents: mapping.agents,
    priority: mapping.defaultPriority,
    skipTriage: mapping.skipTriage || false,
  };
}
```

#### GitHub Event Routing Table

```typescript
const GITHUB_EVENT_ROUTING = {
  'review-pr': {
    template: 'github-ops',
    phases: ['review'],
    agents: ['code-review-swarm', 'security-auditor', 'tester'],
    defaultPriority: 'P2-standard',
  },
  're-review-pr': {
    template: 'github-ops',
    phases: ['review'],
    agents: ['code-review-swarm'],  // Only review changed files
    defaultPriority: 'P2-standard',
  },
  'post-merge': {
    template: 'release-pipeline',
    phases: ['integrate', 'deploy', 'monitor'],
    agents: ['release-manager', 'cicd-engineer', 'production-validator'],
    defaultPriority: 'P1-high',
  },
  'triage-issue': {
    template: 'github-ops',
    phases: ['triage'],
    agents: ['issue-tracker'],
    defaultPriority: 'P2-standard',
  },
  'fix-bug': {
    template: 'tdd-workflow',
    phases: ['plan', 'implement', 'test', 'review'],
    agents: ['researcher', 'coder', 'tester', 'reviewer'],
    defaultPriority: 'P2-standard',
  },
  'validate-main': {
    template: 'cicd-pipeline',
    phases: ['test', 'integrate', 'deploy'],
    agents: ['tester', 'security-auditor', 'cicd-engineer'],
    defaultPriority: 'P1-high',
  },
  'debug-ci': {
    template: 'quick-fix',
    phases: ['plan', 'implement', 'test'],
    agents: ['researcher', 'coder'],
    defaultPriority: 'P1-high',
  },
  'deploy-release': {
    template: 'release-pipeline',
    phases: ['deploy', 'monitor'],
    agents: ['release-manager', 'cicd-engineer', 'production-validator'],
    defaultPriority: 'P0-immediate',
  },
  'incident-response': {
    template: 'monitoring-alerting',
    phases: ['deploy', 'monitor'],  // Rollback is a deploy action
    agents: ['cicd-engineer', 'production-validator', 'performance-engineer'],
    defaultPriority: 'P0-immediate',
    skipTriage: true,
  },
  'security-alert': {
    template: 'security-audit',
    phases: ['triage', 'plan', 'implement', 'review'],
    agents: ['security-architect', 'security-auditor', 'coder', 'reviewer'],
    defaultPriority: 'P1-high',
  },
};
```

### Event Flow

```
                                  +------------------+
    GitHub Webhooks ------------> |                  |
    User Commands --------------> |  Intake Context  | ---> IntakeEvent
    Scheduled Events ------------> |                  |
    System Alerts --------------> +------------------+
                                          |
                                          v
                                  +------------------+
                                  | Triage Context   | ---> TriagedEvent
                                  +------------------+
                                          |
                                          v
                                  +------------------+
                                  | Planning Context | ---> WorkflowPlan
                                  +------------------+
                                          |
                                          v
                                  +------------------+
                                  | Execution Context| ---> PhaseCompleted (per phase)
                                  | (Swarm mgmt)     |
                                  +------------------+
                                          |
                                          v
                                  +------------------+
                                  | Review Context   | ---> ReviewVerdict
                                  +------------------+
                                          |
                                   pass   |   fail
                                  +-------+-------+
                                  |               |
                                  v               v
                          +-------------+   (back to Execution
                          |  Deployment |    with feedback)
                          |  Context    |
                          +-------------+
                                  |
                                  v
                          +------------------+
                          | Learning Context | ---> PatternStored
                          | (observes all    |     WeightsUpdated
                          |  contexts)       |
                          +------------------+
```

**Event types on the internal bus:**

| Event | Producer | Consumer(s) |
|-------|----------|-------------|
| `IntakeEvent` | Intake | Triage |
| `TriagedEvent` | Triage | Planning |
| `WorkflowPlan` | Planning | Execution |
| `PhaseStarted` | Execution | Learning |
| `PhaseCompleted` | Execution | Review or Deployment |
| `ReviewVerdict` | Review | Execution (fail) or Deployment (pass) |
| `DeploymentStatus` | Deployment | Learning, Monitoring |
| `OutcomeRecorded` | Learning | (stored in AgentDB) |
| `WeightsUpdated` | Learning | Planning (next decision) |

### Memory Architecture

All persistent state uses AgentDB with the following namespace structure:

| Namespace | Key Pattern | Content |
|-----------|------------|---------|
| `decisions` | `decision:{id}` | Full decision record with outcome |
| `patterns` | `pattern:{inputHash}` | Routing pattern with weight and success rate |
| `workflows` | `workflow:{id}` | Active workflow state and phase progress |
| `templates` | `template:{key}` | Template definitions (allows runtime extension) |
| `metrics` | `metric:{context}:{date}` | Daily aggregated metrics per context |
| `events` | `event:{source}:{id}` | Raw intake events for audit trail |

**HNSW index usage:** Pattern search during Stage 3 of the decision engine uses HNSW nearest-neighbor search over input signal vectors. This enables sub-10ms similarity lookup across thousands of stored patterns, compared to the linear scan that would be required without the index.

### File Structure

All source code goes under `/src/tech-lead-v2/` following DDD bounded context organization:

```
src/tech-lead-v2/
  index.ts                          # Public API entry point
  types.ts                          # Shared type definitions

  intake/
    intake-handler.ts               # Main intake coordinator
    webhook-handler.ts              # GitHub webhook normalization
    command-handler.ts              # User command parsing
    schedule-handler.ts             # Cron event handling
    alert-handler.ts                # System alert handling
    intake-event.ts                 # IntakeEvent type and factory

  triage/
    triage-engine.ts                # Priority and complexity assessment
    urgency-rules.ts                # Urgency determination rules
    triage-event.ts                 # TriagedEvent type and factory

  planning/
    planning-engine.ts              # Workflow plan generation
    decision-engine-v2.ts           # Three-stage classification pipeline
    template-library.ts             # All 15 templates + runtime extension
    topology-selector.ts            # Swarm topology selection
    phase-sequencer.ts              # Phase ordering and skip logic
    methodology-selector.ts         # SPARC/TDD/ad-hoc selection

  execution/
    execution-coordinator.ts        # Swarm lifecycle management
    swarm-manager.ts                # Swarm init, health, teardown
    agent-orchestrator.ts           # Agent spawn, assign, monitor
    checkpoint-manager.ts           # Phase checkpoints and artifacts

  review/
    review-pipeline.ts              # Automated checks + code review
    quality-gate.ts                 # Pass/fail/conditional evaluation
    review-verdict.ts               # ReviewVerdict type and factory

  deployment/
    deployment-manager.ts           # Deploy pipeline orchestration
    rollback-handler.ts             # Automated rollback on failure
    health-checker.ts               # Post-deploy verification

  learning/
    outcome-tracker.ts              # Record decision outcomes
    pattern-store.ts                # HNSW pattern storage and retrieval
    weight-adjuster.ts              # Routing weight updates
    trajectory-recorder.ts          # ReasoningBank trajectory integration

  shared/
    event-bus.ts                    # Internal event bus
    event-types.ts                  # All domain event definitions
    validation.ts                   # Input validation utilities
    errors.ts                       # Domain error types
```

Each file should remain under 500 lines per project constraints. The bounded context directories enforce separation of concerns and prevent cross-context coupling.

## Consequences

### Positive

- **Full SDLC coverage.** The system can manage work from initial trigger through deployment and post-deploy monitoring, eliminating manual handoffs between phases.
- **Multi-source intake.** GitHub webhooks, user commands, scheduled events, and system alerts all enter the same pipeline, enabling consistent handling regardless of trigger source.
- **Learning feedback loop.** Every decision is tracked and its outcome recorded. Over time, routing accuracy improves as the pattern store accumulates proven team compositions for recurring task types.
- **Expanded template coverage.** Seven new templates fill the gaps identified in v1: TDD, GitHub ops, SPARC planning-only, pair programming, documentation, CI/CD, and monitoring.
- **Deterministic GitHub routing.** GitHub events are structurally unambiguous -- the event type and action fields directly determine the workflow, eliminating classification uncertainty for the most common trigger source.
- **Observability.** Event sourcing provides a complete audit trail of every decision, phase transition, and outcome. Debugging a bad decision means replaying its event stream.
- **Extensibility.** New templates can be added to the template library without modifying the decision engine. New event sources require only a new handler in the Intake context.

### Negative

- **Increased complexity.** Seven bounded contexts, an event bus, and a three-stage decision pipeline are substantially more complex than v1's single function call. This increases the surface area for bugs and the learning curve for contributors.
- **Latency for user inputs.** The three-stage decision pipeline (regex + semantic + pattern search) adds up to ~510ms for ambiguous user inputs, compared to v1's ~5ms for unambiguous inputs. GitHub events and scheduled events remain fast (deterministic routing).
- **Memory dependency.** The learning system requires AgentDB to be available and healthy. If AgentDB is down, Stage 3 (pattern matching) degrades to Stage 2 (semantic) or Stage 1 (regex), losing the benefit of historical patterns.
- **Migration effort.** V1's `tech-lead-router.cjs` must be preserved for backward compatibility during transition. The v2 system must coexist with v1 until all consumers are migrated.

### Risks

- **Cold start problem.** On initial deployment, the pattern store is empty. The system operates in "v1 mode" (regex + Haiku) until enough decisions accumulate to provide meaningful pattern matches. Mitigation: seed the pattern store with synthetic patterns derived from v1's 8 templates and their expected inputs.
- **Feedback loop bias.** If early decisions happen to favor certain templates, the learning system may reinforce those choices even when alternatives would be better. Mitigation: implement exploration rate (10% of decisions use a randomly varied template) and track counterfactual outcomes.
- **Swarm resource exhaustion.** With GitHub webhooks potentially triggering many concurrent workflows, the system could exhaust the 15-agent maximum. Mitigation: the Triage context implements queuing with priority-based admission control.
- **Webhook volume spikes.** A force-push or mass-label operation on GitHub could generate dozens of webhook events in seconds. Mitigation: implement deduplication (same PR within 30s window) and rate limiting in the Intake context.

### Neutral

- V1's regex classification engine is retained as Stage 1 of the v2 pipeline. No regression in classification capability for user text inputs.
- The 8 existing team templates are preserved unchanged. Existing workflows that depend on v1's output format continue to work.
- The clarification protocol (ADR-051) remains in effect for user text inputs. GitHub events and system alerts bypass clarification entirely.

## Options Considered

### Option 1: Incremental v1 Extension

Add GitHub webhook handling and new templates directly to `tech-lead-router.cjs`.

- **Pros**: Minimal migration effort. Single file remains simple to understand. No new infrastructure.
- **Cons**: The file would exceed 1500+ lines (violating the 500-line constraint). No lifecycle management. No learning. Mixing GitHub event handling with regex classification creates incoherent abstractions. Cannot support phased workflows.

### Option 2: Microservice Architecture

Deploy each bounded context as a separate service communicating over HTTP/gRPC.

- **Pros**: True independence between contexts. Each service can scale independently. Technology diversity possible.
- **Cons**: Massive operational overhead for an agent orchestrator that runs locally. Network latency between services. Service discovery complexity. Overkill for the problem size -- this is not a distributed system serving millions of users, it is a development workflow tool.

### Option 3: Event-Driven Modular Monolith (Selected)

Implement all seven bounded contexts as modules within a single process, communicating through an in-process event bus. Deploy as a single package.

- **Pros**: Bounded context separation without network overhead. Single deployment unit. Event sourcing provides the audit trail and replay capability of a distributed system without the operational cost. Can extract to microservices later if needed. Fits the project constraint of files under 500 lines (each context is multiple small files).
- **Cons**: All contexts share a process -- a crash in one affects all. Cannot scale contexts independently. Must be disciplined about not taking cross-context shortcuts through direct imports.

## Implementation Plan

### Phase 1: Foundation (Week 1-2)

**Goal:** Establish the module structure, shared types, and event bus. Migrate v1 decision engine into the new structure.

**Files:**
- `src/tech-lead-v2/types.ts` -- shared type definitions
- `src/tech-lead-v2/shared/event-bus.ts` -- in-process event bus
- `src/tech-lead-v2/shared/event-types.ts` -- domain event definitions
- `src/tech-lead-v2/shared/validation.ts` -- input validation
- `src/tech-lead-v2/planning/decision-engine-v2.ts` -- port v1 regex engine as Stage 1
- `src/tech-lead-v2/planning/template-library.ts` -- all 15 templates

**Tests:**
- `tests/tech-lead-v2/decision-engine-v2.test.ts` -- regression tests against v1 behavior
- `tests/tech-lead-v2/template-library.test.ts` -- template selection tests

**Exit criteria:** All v1 test cases pass through the v2 decision engine. Template library returns correct compositions for all 15 templates.

### Phase 2: Intake and Triage (Week 3-4)

**Goal:** Implement multi-source intake with GitHub webhook support and triage logic.

**Files:**
- `src/tech-lead-v2/intake/` -- all intake handlers
- `src/tech-lead-v2/triage/` -- triage engine and rules

**Tests:**
- `tests/tech-lead-v2/intake/webhook-handler.test.ts` -- GitHub event parsing
- `tests/tech-lead-v2/triage/triage-engine.test.ts` -- priority assignment

**Exit criteria:** GitHub webhook payloads correctly normalize to IntakeEvents. Triage correctly assigns priority for all 10 GitHub event types.

### Phase 3: Planning and Execution (Week 5-6)

**Goal:** Implement workflow planning, topology selection, and swarm execution coordination.

**Files:**
- `src/tech-lead-v2/planning/` -- remaining planning files
- `src/tech-lead-v2/execution/` -- execution coordinator and swarm management

**Tests:**
- `tests/tech-lead-v2/planning/` -- methodology selection, phase sequencing
- `tests/tech-lead-v2/execution/` -- swarm lifecycle, checkpoint management

**Exit criteria:** A user text input or GitHub event produces a complete WorkflowPlan. The execution coordinator can initialize a swarm and manage agent lifecycle through phase transitions.

### Phase 4: Review, Deployment, and Learning (Week 7-8)

**Goal:** Complete the pipeline with review gates, deployment management, and learning feedback.

**Files:**
- `src/tech-lead-v2/review/` -- review pipeline and quality gates
- `src/tech-lead-v2/deployment/` -- deployment management and rollback
- `src/tech-lead-v2/learning/` -- outcome tracking, pattern storage, weight adjustment

**Tests:**
- `tests/tech-lead-v2/review/` -- quality gate evaluation
- `tests/tech-lead-v2/deployment/` -- deployment stages, rollback scenarios
- `tests/tech-lead-v2/learning/` -- pattern storage, weight adjustment, cold start

**Exit criteria:** End-to-end flow from IntakeEvent through deployment and outcome recording. Learning system stores patterns and adjusts weights based on simulated outcomes.

### Phase 5: Integration and Migration (Week 9-10)

**Goal:** Wire v2 into the existing skill system. Provide backward-compatible v1 interface. Update SKILL.md.

**Files:**
- `src/tech-lead-v2/index.ts` -- public API
- `.claude/skills/tech-lead/SKILL.md` -- updated skill definition
- `.claude/helpers/tech-lead-router.cjs` -- thin wrapper delegating to v2

**Exit criteria:** Existing v1 consumers (SKILL.md, CLI) work unchanged. New consumers can use v2's full API. GitHub webhook endpoint is documented and testable.

## Related Decisions

- **ADR-001**: Deep agentic-flow integration -- v2 uses the full MCP tool surface
- **ADR-002**: Modular DDD Architecture -- v2 follows bounded context organization
- **ADR-003**: Security-First Design -- webhook handler validates signatures, alert handler sanitizes paths
- **ADR-004**: MCP Transport Optimization -- execution context uses optimized MCP transport
- **ADR-005**: Swarm Coordination Patterns -- topology selector implements all patterns from ADR-005
- **ADR-006**: Unified Memory Service -- learning context uses unified memory API
- **ADR-008**: Neural Learning Integration -- pattern matching uses neural embeddings
- **ADR-009**: Hybrid Memory Backend -- pattern store uses HNSW-backed hybrid memory
- **ADR-010**: Claims-Based Authorization -- controls who can approve deployments
- **ADR-026**: 3-Tier Model Routing -- decision engine respects tier routing for agent spawning
- **ADR-051**: Clarification Protocol -- retained for user text inputs, bypassed for machine events

## References

- V1 source: `.claude/helpers/tech-lead-router.cjs`
- V1 skill definition: `.claude/skills/tech-lead/SKILL.md`
- MADR format: https://adr.github.io/madr/
- GitHub webhook events: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- HNSW algorithm: https://arxiv.org/abs/1603.09320
- Event sourcing pattern: https://martinfowler.com/eaaDev/EventSourcing.html
