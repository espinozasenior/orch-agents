# SPARC Spec: P21 — Linear Skill-Based Routing (State Updates Only)

**Phase:** P21 (Medium)
**Priority:** Medium
**Estimated Effort:** 0.5 day
**Dependencies:** P20 (must be merged first — reuses skill-resolver, frontmatter-parser, and execution-engine handler)
**Source Blueprint:** P20 — same routing-in-config / behavior-in-content pattern, applied to Linear webhooks.

---

## S — Specification

### 1. Problem Statement

After P20 (PR #18), GitHub webhooks route via `WORKFLOW.md github.events` paths to skill files. The Linear webhook path was deliberately left untouched (NFR-P20-003) to keep P20 scoped. As a result, Linear `Issue` events still flow through the legacy `findTemplateByLabels` → label-name string path in `src/integration/linear/linear-normalizer.ts:185–193`, which produces a `template` string consumed by the legacy template-mode dispatcher.

The legacy path:
- Matches issue labels against `agents.routing` to pick a template name
- Stamps that template name on `IntakeEvent.sourceMetadata.template`
- Cannot be changed without a code deploy
- Cannot run pre-dispatch context fetchers
- Has no skill body to drive the coordinator's behavior — coordinator runs the generic prompt

We want Linear issue *state* changes to route through the same skill-based pipeline as GitHub:
- Operator declares routes in `WORKFLOW.md linear.events`
- Each route points at a relative path to a skill file
- Linear normalizer stamps `sourceMetadata.skillPath` when a state change matches a route
- IntakeCompleted handler resolves the skill body and dispatches the enriched intake

### 2. Scope (deliberate)

**In scope:**
- Linear `Issue` webhook events where `state` (or `stateId`) is in `payload.updatedFrom`
- Routing keys: `state.<state-name-lowercased>` (e.g. `state.in-review`, `state.in-progress`, `state.todo`)
- A new `linear.events` block in `WORKFLOW.md` mirroring `github.events`
- Reuse of P20's `resolveByPath` for file loading (path-based, no I/O in normalizer)
- Optional Linear-specific context fetchers (`linear-issue-view`, `linear-comments`) — declarable in skill frontmatter, runnable in parallel

**Out of scope (deferred to follow-up):**
- Comment-related Linear events (`Comment` payload type) — explicitly deferred per scope discussion. Comments are higher-volume and noisier; state updates are the cleaner first migration.
- Label-change events → skill routing — stays on the legacy `findTemplateByLabels` path
- Assignee / priority change events → skill routing
- Touching the `AgentSessionEvent` / `AgentPrompted` path that runs through `runIssueWorkerLifecycle`. That path already has rich `promptContext` XML and is intentionally separate.
- Symphony mode (`linearExecutionMode === 'symphony'`) — Linear intakes still bypass IntakeCompleted entirely when symphony is on; the new state-routing path only fires when symphony is OFF.

### 3. Functional Requirements

```yaml
functional_requirements:
  - id: "FR-P21-001"
    description: "WorkflowConfig gains an optional linear.events: Record<string, string> map parsed from WORKFLOW.md"
    priority: "critical"
    acceptance_criteria:
      - "src/integration/linear/workflow-parser.ts adds optional linear.events parsing"
      - "Schema mirrors github.events exactly (Record<string, string>, kebab-case keys)"
      - "Empty / missing linear.events is valid (returns undefined)"
      - "Existing workflow-parser tests still pass"

  - id: "FR-P21-002"
    description: "src/intake/skill-resolver.ts gains a Linear-aware path lookup"
    priority: "critical"
    acceptance_criteria:
      - "Exports resolveLinearStatePath(stateName, config): {relPath, ruleKey} | null"
      - "Lookup key format: state.<lowercased-state-name>"
      - "Returns null when no match (explicit-only — no default fallback, same as github)"
      - "Reuses the existing resolveByPath for file loading — no new I/O code"

  - id: "FR-P21-003"
    description: "linear-normalizer stamps sourceMetadata.skillPath + ruleKey when a state change matches"
    priority: "critical"
    acceptance_criteria:
      - "When stateChanged is true AND linear.events has a matching rule, stamp skillPath + ruleKey"
      - "When no rule matches, leave skillPath/ruleKey undefined and fall through to the existing template-based path (backward compatible — does not break existing label-routing consumers)"
      - "Comment events (Comment payload type) are NOT touched"
      - "Label / assignee / priority changes are NOT touched"

  - id: "FR-P21-004"
    description: "execution-engine.ts IntakeCompleted handler runs the skill resolution branch for Linear-source events that have skillPath set"
    priority: "critical"
    acceptance_criteria:
      - "Current `if (intakeEvent.source === 'github')` gate becomes `if (intakeEvent.sourceMetadata?.skillPath)` so it fires for github AND linear when a path is stamped"
      - "Linear intakes without skillPath continue through the legacy template path UNCHANGED"
      - "Linear intakes with skillPath skip the github-specific context-fetcher block (only runs when sourceMetadata.parsed is set, which is github-only)"
      - "OPTIONAL: declare linear-specific fetchers in context-fetchers.ts (linear-issue-view, linear-comments) for skills that want them"

  - id: "FR-P21-005"
    description: "Optional Linear context fetchers added to context-fetchers.ts"
    priority: "low"
    acceptance_criteria:
      - "linear-issue-view fetcher fetches issue body + state + labels via LinearClient"
      - "Wired into CONTEXT_FETCHERS registry by name"
      - "If implemented, requires a LinearClient injection path through fetchContextForSkill (separate from the GitHubClient path)"
      - "Can be deferred to a sub-PR if scope creeps"

  - id: "FR-P21-006"
    description: "One example skill file lands with this PR + WORKFLOW.md updated"
    priority: "high"
    acceptance_criteria:
      - "WORKFLOW.md gains a linear.events block with at least one entry, e.g. state.in-review: .claude/skills/linear-review-handoff/SKILL.md"
      - "Either author a new minimal skill file OR reuse an existing skill from .claude/skills/ via path"
      - "Spec must demonstrate the operator-only-edits-WORKFLOW.md story"
```

### 4. Non-Functional Requirements

```yaml
non_functional_requirements:
  - id: "NFR-P21-001"
    category: "isolation"
    description: "AgentSessionEvent / runIssueWorkerLifecycle path UNCHANGED"
    measurement: "Grep shows no edits to issue-worker-runner.ts beyond linting; symphony mode still bypasses IntakeCompleted"

  - id: "NFR-P21-002"
    category: "backward-compatibility"
    description: "Existing label-routing tests still pass"
    measurement: "tests/integration/linear/linear-normalizer.test.ts unchanged in semantic; only adds new state-routing assertions"

  - id: "NFR-P21-003"
    category: "scope"
    description: "PR scope cap ~400 LOC including tests"
    measurement: "git diff --stat shows under 400 lines"
```

### 5. Constraints

```yaml
constraints:
  explicit_user_rejections:
    - "NO comment routing — state changes only"
    - "NO label / assignee / priority routing — state changes only"
    - "NO touching the AgentSessionEvent path"
    - "NO default fallback (mirrors P20 explicit-only routing)"

  scope:
    - "Reuse P20 primitives (resolveByPath, parseSkillFile, IntakeSourceMetadata) — do not duplicate"
    - "Linear context fetchers are optional in this PR — can ship later"
    - "One example WORKFLOW.md entry is enough; more skills land as follow-up PRs"
```

### 6. Use Cases

```yaml
use_cases:
  - id: "UC-P21-001"
    title: "Issue moves to In Review → triggers review-handoff skill"
    flow:
      - "Linear webhook: Issue updated, state changes to 'In Review'"
      - "linear-normalizer detects stateChanged + matching rule state.in-review"
      - "IntakeEvent.sourceMetadata.skillPath = .claude/skills/linear-review-handoff/SKILL.md, ruleKey = state.in-review"
      - "execution-engine IntakeCompleted handler resolves the skill body and dispatches the enriched intake (no github fetchers run)"

  - id: "UC-P21-002"
    title: "Issue moves to a state with no rule → falls through to legacy template path"
    flow:
      - "Linear webhook: Issue moves to 'Backlog'"
      - "linear-normalizer's state lookup returns null"
      - "skillPath stays undefined; sourceMetadata.template = (whatever findTemplateByLabels returned)"
      - "execution-engine handler sees no skillPath, runs legacy dispatch"
      - "Backward compatible — no behavior change for unmapped states"
```

### 7. Acceptance Criteria (Gherkin)

```gherkin
Feature: Linear Skill-Based Routing for Issue State Updates

  Scenario: State change matches linear.events rule
    Given WORKFLOW.md maps state.in-review to .claude/skills/linear-review-handoff/SKILL.md
    When a Linear Issue webhook arrives with stateChanged = true and current state = "In Review"
    Then linear-normalizer stamps sourceMetadata.skillPath = .claude/skills/linear-review-handoff/SKILL.md
    And sourceMetadata.ruleKey = state.in-review
    And the IntakeCompleted handler resolves the skill body
    And dispatches the enriched intake

  Scenario: State change with no matching rule
    Given WORKFLOW.md has no entry for state.backlog
    When a Linear Issue webhook arrives with stateChanged = true and current state = "Backlog"
    Then linear-normalizer leaves skillPath undefined
    And the existing template-based path runs unchanged

  Scenario: Comment events are ignored
    Given a Linear Comment webhook arrives
    Then linear-normalizer skips skill resolution entirely
    And no skillPath is stamped

  Scenario: Label change with no state change does not trigger skill routing
    Given a Linear Issue update with labelIds in updatedFrom but no state change
    Then linear-normalizer leaves skillPath undefined
    And the legacy label-routing path runs
```

---

## P — Pseudocode

### skill-resolver.ts (extension)

```
resolveLinearStatePath(stateName, config):
  IF !stateName: RETURN null
  IF !config.linear?.events: RETURN null
  ruleKey = `state.${stateName.toLowerCase().replace(/\s+/g, '-')}`
  relPath = config.linear.events[ruleKey]
  IF relPath: RETURN { relPath, ruleKey }
  RETURN null
```

### linear-normalizer.ts (new branch)

```
normalizeLinearEvent(payload, updatedFrom, config):
  // ...existing bot loop, terminal state, active state checks unchanged...

  // P21: skill-based routing for state updates only
  let skillPath, ruleKey
  IF stateChanged AND issue.state?.name:
    lookup = skillResolver.resolveLinearStatePath(issue.state.name, _workflowConfig)
    IF lookup:
      skillPath = lookup.relPath
      ruleKey = lookup.ruleKey

  RETURN {
    ...existing IntakeEvent shape,
    sourceMetadata: {
      ...existing fields,
      skillPath,    // optional — undefined when no match
      ruleKey,      // optional
    },
  }
```

### execution-engine.ts (handler gate change)

```
// Before:
IF intakeEvent.source === 'github':
  // skill resolution + context fetchers + dispatch

// After:
IF intakeEvent.sourceMetadata?.skillPath:
  skill = skillResolver.resolveByPath(skillPath, repoRoot)
  IF !skill: warn + skip
  // Run github fetchers ONLY if parsed (= github source) is set
  fetchedContext = ''
  IF intakeEvent.sourceMetadata.parsed AND deps.githubClient:
    fetchedContext = await fetchContextForSkill(skill, parsed, deps.githubClient, logger)
  enrichedIntake = { ...intakeEvent, rawText: `${skill.body}\n\n## Trigger Context\n\n${fetchedContext}` }
  log resolved skill
```

---

## A — Architecture

### File changes

```
src/intake/
  skill-resolver.ts              (EXTEND, +20 LOC — resolveLinearStatePath)

src/integration/linear/
  linear-normalizer.ts           (EXTEND, +15 LOC — call resolver, stamp skillPath)
  workflow-parser.ts             (EXTEND, +10 LOC — parse linear.events)

src/execution/orchestrator/
  execution-engine.ts            (MODIFY — change gate from `source === 'github'` to `sourceMetadata?.skillPath`, guard github-specific fetchers)

src/types.ts                     (NO CHANGE — IntakeSourceMetadata already has skillPath/ruleKey)

WORKFLOW.md                      (MODIFY — add linear.events block with one example route)
```

### File changes (out of scope, deferred)

```
src/intake/context-fetchers.ts   (NOT TOUCHED — Linear fetchers ship later)
src/integration/linear/issue-worker-runner.ts  (NOT TOUCHED — symphony path stays separate)
```

---

## R — Refinement

### Test Plan

| FR | Test file | Key assertions |
|----|-----------|----------------|
| FR-P21-001 | `tests/integration/linear/workflow-parser.test.ts` | linear.events parsed; absent block returns undefined; existing tests still pass |
| FR-P21-002 | `tests/intake/skill-resolver.test.ts` | resolveLinearStatePath: hit, miss, normalization (state name case + spaces), null on missing config |
| FR-P21-003 | `tests/integration/linear/linear-normalizer.test.ts` | state change + matching rule stamps skillPath; no rule leaves it undefined; comment events ignored; label-only change unchanged |
| FR-P21-004 | `tests/execution-engine.test.ts` | linear intake with skillPath dispatches via skill body; linear intake without skillPath uses legacy path; github fetchers not run for linear |
| FR-P21-006 | smoke | manual: trigger a real Linear state change to "In Review" on a tracked issue |

### Migration Strategy

```yaml
migration:
  phase_1: "workflow-parser: add linear.events parsing (tsc + tests)"
  phase_2: "skill-resolver: add resolveLinearStatePath (tsc + tests)"
  phase_3: "linear-normalizer: stamp skillPath when state changes match (tsc + tests)"
  phase_4: "execution-engine: change gate to source-agnostic (tsc + tests)"
  phase_5: "WORKFLOW.md: add linear.events block + at least one route"
  phase_6: "Manual smoke test"
```

---

## C — Completion

### Definition of Done

```yaml
completion:
  code_deliverables:
    - "src/intake/skill-resolver.ts — resolveLinearStatePath"
    - "src/integration/linear/workflow-parser.ts — linear.events parsing"
    - "src/integration/linear/linear-normalizer.ts — skillPath stamping for state changes"
    - "src/execution/orchestrator/execution-engine.ts — source-agnostic IntakeCompleted gate"
    - "WORKFLOW.md — linear.events block with at least one example route"

  test_deliverables:
    - "tests/intake/skill-resolver.test.ts — resolveLinearStatePath cases"
    - "tests/integration/linear/workflow-parser.test.ts — linear.events parsing"
    - "tests/integration/linear/linear-normalizer.test.ts — state-routing assertions"
    - "tests/execution-engine.test.ts — linear-with-skillPath dispatch"

  verification_checklist:
    - "npm run build succeeds"
    - "npm test passes (baseline ~1599 ± 15)"
    - "npx tsc --noEmit clean"
    - "Comment events grep shows zero new code paths added for them"
    - "Label / assignee / priority change tests still pass unchanged"
```

---

## Honest Scope Notes

- **Comments deliberately deferred.** Comment events are higher-volume, noisier, and have a different shape (they include `body`, `userId`, etc.). Routing them would also need to handle bot-loop prevention against the bot's own comments. Scoped out for a future P22.
- **State name normalization is a footgun.** Linear state names can contain spaces ("In Review"), special characters, and emoji. The lookup key normalization (`toLowerCase().replace(/\s+/g, '-')`) is the simplest scheme but worth documenting in the operator-facing comment in WORKFLOW.md.
- **Source-agnostic gate is the riskiest change.** Changing `if (source === 'github')` → `if (sourceMetadata?.skillPath)` widens the code path that handles dispatch composition. The github-specific fetcher block is gated separately on `sourceMetadata.parsed && deps.githubClient` so Linear intakes never accidentally trigger gh CLI calls.
- **No Linear context fetchers in this PR.** Skills routed from Linear get the bare skill body + the existing `rawText` (issue description sanitized). Adding `linear-issue-view` / `linear-comments` fetchers requires plumbing a `LinearClient` through `fetchContextForSkill`, which is a separate concern. Ship later.
- **Symphony mode is not affected.** When `linearExecutionMode === 'symphony'`, the IntakeCompleted handler skips Linear intakes entirely (`execution-engine.ts:85`). The new skill-routing branch never runs in that mode. Operators using symphony continue to use the AgentSessionEvent path.
