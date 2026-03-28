# SPARC Gap 4: Structured JSON Output

## Machine-Readable Output Format for Automation Consumers

## Priority: P1
## Estimated Effort: 2-3 days
## Status: Planning

---

## Problem Statement

All pipeline output is unstructured text. When external systems (CI/CD, dashboards, downstream automation) consume orch-agents results, they must parse free-form text to extract findings, changed files, cost estimates, and verdicts. The pipeline already produces rich structured data internally (PhaseResult, ReviewVerdict, Artifact, Finding), but this structure is lost at the output boundary. The `TaskExecutionResult` has `output: string` and `extractJson()` attempts to recover JSON from stdout, but there is no standardized output envelope that aggregates results across all phases into a single machine-readable document.

---

## S -- Specification

### Requirements

1. **R1 -- Define a StructuredOutput envelope type.** Create a typed interface that aggregates plan-level results: status, planId, phases with their results, findings across all phases, files changed, summary, agents used, cost estimate, duration, and token usage.

2. **R2 -- Create an OutputSerializer module.** Create `src/execution/output-serializer.ts` with a `serializeResult(plan, phaseResults, verdict): StructuredOutput` function that composes the envelope from existing domain types.

3. **R3 -- Attach structured output to WorkCompleted event payload.** When the execution engine finishes, the WorkCompleted event payload includes the StructuredOutput JSON alongside existing fields. This is backward-compatible: existing consumers that ignore the field are unaffected.

4. **R4 -- Post structured output as collapsible details block in PR comment.** The ReviewPipeline (or a new subscriber) posts a `<details><summary>Structured Output</summary>` block containing the JSON in the review comment. This gives both human-readable review and machine-readable output in the same PR.

5. **R5 -- Support optional Zod schema validation.** When a custom `outputSchema` is provided in the execution configuration, validate the StructuredOutput against it before publishing. If validation fails, include validation errors in the output but still publish.

6. **R6 -- Add outputSchema as optional field in execution configuration.** The field is optional and defaults to no custom validation. When provided, it defines the expected shape of phase-level agent outputs.

### Acceptance Criteria

- AC1: `serializeResult()` produces a JSON-serializable object that round-trips through `JSON.parse(JSON.stringify(output))` without data loss.
- AC2: StructuredOutput contains all findings from all phases, with severity preserved.
- AC3: WorkCompleted event payload includes `structuredOutput` field when serializer is available.
- AC4: PR comment contains a `<details>` block with pretty-printed JSON.
- AC5: When Zod schema is provided and output fails validation, the StructuredOutput includes a `validationErrors` array.
- AC6: When no Zod schema is provided, no validation is performed and no `validationErrors` field is present.
- AC7: `serializeResult()` with zero phases returns a valid StructuredOutput with empty arrays.

### Constraints

- StructuredOutput must be a strict superset of information already available in PhaseResult and ReviewVerdict -- no new data collection required.
- Must not add Zod as a required dependency. Zod support is optional: when `zod` is importable, use it; otherwise, skip validation.
- Must not change the TaskExecutor interface.
- Must preserve backward compatibility: existing WorkCompleted consumers must not break.
- JSON output must be deterministic (no random fields, stable key ordering).

### Edge Cases

- Phase produces no artifacts -- `phases[n].artifacts` is an empty array, not undefined.
- Agent produces no output (empty string) -- phase summary reflects "no output" rather than omitting the phase.
- ReviewVerdict is `conditional` -- StructuredOutput status maps to `completed-with-warnings`.
- Token usage unavailable -- `tokenUsage` field is `{ input: 0, output: 0 }` with a `tokenUsageEstimated: true` flag.
- Extremely large agent output -- StructuredOutput includes truncated summaries, not full stdout (cap at 10KB per phase).
- Concurrent phases -- phases array is ordered by execution order, not phase type.

---

## P -- Pseudocode

### P1 -- StructuredOutput Type

```
interface StructuredOutput:
  version: '1.0.0'
  status: 'completed' | 'failed' | 'completed-with-warnings'
  planId: string
  workItemId: string
  timestamp: string
  duration: number  // total ms
  phases: StructuredPhase[]
  findings: Finding[]  // aggregated from all phases
  filesChanged: string[]  // deduped across all phases
  summary: string
  agentsUsed: AgentSummary[]
  costEstimate: number
  tokenUsage: { input: number, output: number, estimated: boolean }
  validationErrors?: string[]  // present only when schema validation fails

interface StructuredPhase:
  phaseType: SPARCPhase
  status: 'completed' | 'failed' | 'skipped'
  duration: number
  artifacts: ArtifactSummary[]
  agentResults: AgentResultSummary[]

interface AgentSummary:
  role: string
  type: string
  tier: 1 | 2 | 3

interface ArtifactSummary:
  id: string
  type: string
  url: string

interface AgentResultSummary:
  role: string
  status: 'completed' | 'failed'
  duration: number
  outputPreview: string  // first 500 chars
```

### P2 -- serializeResult

```
function serializeResult(plan, phaseResults, verdict) -> StructuredOutput:
  allFindings = []
  allFiles = new Set()
  totalDuration = 0
  totalInputTokens = 0
  totalOutputTokens = 0
  tokensEstimated = true

  phases = phaseResults.map(pr => {
    totalDuration += pr.metrics.duration
    allFindings.push(...(verdict?.findings ?? []).filter(f => f matches pr))

    return {
      phaseType: pr.phaseType,
      status: pr.status,
      duration: pr.metrics.duration,
      artifacts: pr.artifacts.map(a => ({
        id: a.id, type: a.type, url: a.url
      })),
      agentResults: []  // populated from execution context if available
    }
  })

  status = mapVerdictToStatus(verdict)

  return {
    version: '1.0.0',
    status,
    planId: plan.id,
    workItemId: plan.workItemId,
    timestamp: new Date().toISOString(),
    duration: totalDuration,
    phases,
    findings: verdict?.findings ?? allFindings,
    filesChanged: Array.from(allFiles),
    summary: buildSummary(plan, phaseResults, verdict),
    agentsUsed: plan.agentTeam.map(a => ({ role: a.role, type: a.type, tier: a.tier })),
    costEstimate: plan.estimatedCost,
    tokenUsage: { input: totalInputTokens, output: totalOutputTokens, estimated: tokensEstimated }
  }

function mapVerdictToStatus(verdict) -> string:
  if !verdict: return 'completed'
  if verdict.status == 'pass': return 'completed'
  if verdict.status == 'conditional': return 'completed-with-warnings'
  return 'failed'

function buildSummary(plan, phaseResults, verdict) -> string:
  completedCount = phaseResults.filter(p => p.status == 'completed').length
  totalCount = phaseResults.length
  return `${plan.template}: ${completedCount}/${totalCount} phases completed. Verdict: ${verdict?.status ?? 'no-review'}.`
```

### P3 -- Optional Zod Validation

```
function validateOutput(output, schema) -> string[]:
  if !schema: return []
  try:
    zod = await import('zod')  // dynamic import, optional dep
  catch:
    return []  // zod not available, skip validation

  result = schema.safeParse(output)
  if result.success: return []
  return result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
```

### P4 -- PR Comment Formatting

```
function formatStructuredOutputComment(output: StructuredOutput) -> string:
  json = JSON.stringify(output, null, 2)
  if json.length > 60000:
    // Truncate phase details, keep summary
    output.phases = output.phases.map(p => ({
      ...p, agentResults: p.agentResults.map(a => ({ ...a, outputPreview: '[truncated]' }))
    }))
    json = JSON.stringify(output, null, 2)

  return [
    '<details>',
    '<summary>Structured Output (JSON)</summary>',
    '',
    '```json',
    json,
    '```',
    '',
    '</details>'
  ].join('\n')
```

### Complexity Analysis

- serializeResult: O(p * a) where p = phases, a = artifacts per phase
- Zod validation: O(n) where n = schema complexity (single pass)
- Comment formatting: O(j) where j = JSON string length
- Finding aggregation: O(f) where f = total findings

---

## A -- Architecture

### New Components

```
src/execution/output-serializer.ts     -- serializeResult(), formatStructuredOutputComment()
```

### New Types (in src/types.ts)

```
StructuredOutput, StructuredPhase, AgentSummary, ArtifactSummary, AgentResultSummary
```

### Modified Components

```
src/types.ts                           -- Add StructuredOutput types
src/execution/execution-engine.ts      -- Call serializeResult after phases complete, include in WorkCompleted payload
src/review/review-pipeline.ts          -- Include structured output in review comment (details block)
src/shared/event-types.ts              -- Extend WorkCompletedEvent payload with optional structuredOutput
```

### WorkCompleted Payload Extension

The existing `WorkCompletedEvent` payload `{ workItemId, planId, phaseCount, totalDuration }` gains an optional field:

```typescript
structuredOutput?: StructuredOutput
```

This is backward-compatible. Existing subscribers that destructure only known fields are unaffected. The `execution-engine.ts` populates this field when the output serializer is available.

### Data Flow

```
PhaseRunner.runPhase()
  -> PhaseResult[]
    -> OutputSerializer.serializeResult(plan, phaseResults, verdict)
      -> StructuredOutput
        -> WorkCompleted event (with structuredOutput in payload)
          -> ReviewPipeline (posts <details> block in PR comment)
          -> External consumers (read structuredOutput from event)
```

### Bounded Context

OutputSerializer lives in the `execution` bounded context. It is a pure function with no side effects -- it takes domain types in and produces a serialized envelope out. The formatting helper for PR comments is co-located since it transforms StructuredOutput to markdown.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| StructuredOutput schema changes break consumers | MEDIUM | Versioned with `version: '1.0.0'`; additive changes only |
| Zod import fails at runtime | LOW | Dynamic import with try/catch; graceful fallback |
| Large JSON payloads slow PR comments | LOW | Truncation at 60KB; summary always concise |
| Token usage always estimated | LOW | `estimated: true` flag explicitly signals approximation |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: StructuredOutput types (types.ts)

No tests needed -- type definitions only. Add to `src/types.ts`.

### Step 2: serializeResult + tests (pure function, 0 dependencies)

Tests (London School -- pure input/output, no mocks needed):
- Test: serializeResult with 2 completed phases produces correct structure
- Test: serializeResult with 1 failed phase sets status to 'failed' when verdict fails
- Test: serializeResult with conditional verdict produces 'completed-with-warnings'
- Test: serializeResult with no verdict produces 'completed'
- Test: serializeResult with zero phases returns valid output with empty arrays
- Test: serializeResult aggregates findings from verdict
- Test: serializeResult deduplicates filesChanged
- Test: serializeResult output is JSON-serializable (round-trip test)
- Test: serializeResult with missing tokenUsage uses estimated flag
- Test: buildSummary produces human-readable one-liner

### Step 3: formatStructuredOutputComment + tests (pure function)

Tests:
- Test: produces valid markdown with details/summary tags
- Test: includes JSON code block
- Test: truncates when output exceeds 60000 characters
- Test: truncated output is still valid JSON inside code block

### Step 4: Optional Zod validation + tests (mock dynamic import)

Tests (London School -- mock import('zod')):
- Test: validateOutput with no schema returns empty array
- Test: validateOutput with valid data and schema returns empty array
- Test: validateOutput with invalid data returns error messages
- Test: validateOutput when zod not importable returns empty array (graceful fallback)

### Step 5: execution-engine.ts integration + tests (mock OutputSerializer)

Tests (London School -- mock serializeResult):
- Test: WorkCompleted event includes structuredOutput when serializer succeeds
- Test: WorkCompleted event omits structuredOutput when serializer throws (graceful)
- Test: Existing WorkCompleted payload fields unchanged

### Step 6: review-pipeline.ts integration + tests (mock GitHubClient)

Tests:
- Test: ReviewCompleted handler posts details block when structuredOutput present
- Test: ReviewCompleted handler skips details block when no structuredOutput
- Test: Details block contains valid JSON matching StructuredOutput

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on output-serializer.ts
- `npm run build` succeeds
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] StructuredOutput types added to src/types.ts
- [ ] serializeResult produces valid JSON for all status combinations
- [ ] WorkCompleted event payload includes structuredOutput
- [ ] PR comment includes collapsible JSON block
- [ ] Zod validation works when zod is available
- [ ] Zod validation gracefully skips when zod is not installed
- [ ] Output version field is '1.0.0'
- [ ] Backward compatibility: existing WorkCompleted consumers unaffected
- [ ] Truncation handles oversized outputs

### Deployment Steps

1. `npm run build` -- verify compilation
2. `npm test` -- verify all tests pass
3. Deploy -- no new env vars required
4. Verify: trigger pipeline, inspect WorkCompleted event payload for structuredOutput
5. Verify: PR review comment contains `<details>` block with JSON

### Rollback Plan

1. StructuredOutput is an optional addition to WorkCompleted payload
2. To disable: remove `serializeResult` call from execution-engine.ts (one-line change)
3. PR comments will revert to plain text review format
4. No persistent state or database changes to roll back

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/execution/output-serializer.ts` | NEW |
| `src/types.ts` | MODIFIED (add StructuredOutput types) |
| `src/execution/execution-engine.ts` | MODIFIED (call serializeResult) |
| `src/shared/event-types.ts` | MODIFIED (extend WorkCompletedEvent payload) |
| `src/review/review-pipeline.ts` | MODIFIED (post details block) |
| `tests/execution/output-serializer.test.ts` | NEW |
| `tests/review/review-pipeline.test.ts` | MODIFIED |
