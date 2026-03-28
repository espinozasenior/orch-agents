# SPARC Gap 1: Claude-Powered DiffReviewer

## Replace Stub DiffReviewer with Real Claude-Powered Implementation

## Priority: P0 — Critical Path for Review Pipeline
## Estimated Effort: 5-7 days
## Status: Planning

---

## Problem Statement

The `DiffReviewer` in `src/review/review-gate.ts` is currently a stub (`createStubDiffReviewer`) that always returns an empty findings array. This means the ReviewGate's 3-checker parallel pipeline (diff review + test runner + security scanner) is running with only 2 of 3 checkers actually functional. Code quality issues, logic errors, and style problems pass through undetected. The FixItLoop (`fix-it-loop.ts`) orchestrates review-fix-re-review cycles but has nothing meaningful from the diff reviewer to act on.

The system already has all the infrastructure to support a real implementation:
- `StreamingTaskExecutor` spawns Claude CLI processes with real-time streaming
- `buildReviewPrompt()` in `prompt-builder.ts` constructs review prompts from diffs
- `ReviewGate` runs all checkers via `Promise.allSettled` so a slow or failed reviewer does not block others
- The `TaskExecutor` interface provides a reusable execution pattern

---

## S -- Specification

### Requirements

1. **R1 -- Claude-powered diff review.** Create `createClaudeDiffReviewer(opts)` that implements the `DiffReviewer` interface (`review(diff, context) -> Promise<Finding[]>`). Sends the diff to Claude with a structured review prompt and parses the response into typed `Finding[]`.

2. **R2 -- 3-tier model routing.** Small diffs (<500 lines) route to Haiku (Tier 2, ~500ms, $0.0002). Large or complex diffs (>=500 lines) route to Sonnet (Tier 3, 2-5s, $0.003-0.015). Line count is computed from the diff string.

3. **R3 -- Confidence filtering via Haiku classification.** Before returning findings, send each finding to Haiku for confidence classification. Filter out findings with confidence below 0.7 threshold. This reduces noise and false positives, adopting the pattern from claude-code-action.

4. **R4 -- Structured response parsing.** Parse Claude's response to extract `Finding[]`. Support both JSON output (`{"findings": [...]}`) and markdown output (lines matching `[SEVERITY] category: message`). Fall back gracefully if neither format is detected.

5. **R5 -- Timeout enforcement.** 60s timeout for Haiku invocations, 120s for Sonnet invocations. Timeout produces an error-severity finding rather than throwing.

6. **R6 -- Factory-DI pattern.** Follow the existing codebase pattern: `createClaudeDiffReviewer(opts: ClaudeDiffReviewerOpts): DiffReviewer`. Options include logger, CLI binary path, model overrides, confidence threshold.

7. **R7 -- Pipeline integration.** Wire into `src/index.ts` where `createStubDiffReviewer()` is currently called (line 104). Use environment variable `ENABLE_CLAUDE_DIFF_REVIEW=true` to opt in; default to stub for backward compatibility.

8. **R8 -- Large diff handling.** Empty diffs return `[]` immediately. Binary diffs (detected by `\x00` bytes or `Binary files differ`) return an info finding and skip review. Diffs >10K lines are chunked into segments of ~2000 lines at file boundaries, reviewed independently, and findings are merged.

9. **R9 -- Review prompt coverage.** The review prompt must instruct Claude to check for: logic errors, security issues (injection, auth bypass, data exposure), style problems, performance concerns, and test coverage gaps.

10. **R10 -- Safe environment.** Use `buildSafeEnv()` from `cli-client.ts` to strip sensitive environment variables from the Claude process. Use `createAgentSandbox()` for process isolation.

### Acceptance Criteria

- AC1: `createClaudeDiffReviewer()` implements `DiffReviewer` interface and compiles without type errors.
- AC2: A diff containing an obvious SQL injection (`query = "SELECT * FROM users WHERE id = " + userId`) produces at least one finding with severity `error` or `critical` and category containing `security`.
- AC3: A diff of 100 lines uses Haiku (Tier 2). A diff of 1000 lines uses Sonnet (Tier 3).
- AC4: Findings with confidence < 0.7 from Haiku classification are filtered out of the final result.
- AC5: A diff exceeding 10K lines is chunked and all chunks are reviewed. Findings from all chunks are merged into the result.
- AC6: Empty diff input returns `[]` without invoking Claude.
- AC7: A timeout produces an error finding with message containing "timeout", not an unhandled rejection.
- AC8: `ENABLE_CLAUDE_DIFF_REVIEW=true` in `src/index.ts` selects the real reviewer; unset selects the stub.
- AC9: Response parsing handles both `{"findings": [...]}` JSON and markdown `[ERROR] security: SQL injection` format.
- AC10: Binary diff returns an info finding and does not invoke Claude.

### Constraints

- Must not change the `DiffReviewer` interface -- callers see no difference.
- Must not change the `Finding` interface (`id, severity, category, message, location?`).
- Must preserve `Promise.allSettled` behavior in `ReviewGate` -- a slow diff review must not block test runner or security scanner.
- Must not introduce new npm dependencies.
- Must use `buildSafeEnv()` for all Claude process spawns.
- Claude CLI binary path must be configurable (default: `'claude'`).

### Edge Cases

- Claude returns malformed JSON -- fall back to markdown parsing, then to a single error finding.
- Claude returns zero findings for a clearly buggy diff -- accept (no false positive injection).
- Network timeout mid-response -- treat as timeout, return error finding.
- Diff contains prompt injection attempts in code comments -- the review prompt must use boundary markers to separate instructions from user content.
- Concurrent reviews (Promise.allSettled) -- each invocation is independent, no shared state.
- Diff with only deletions (all `-` lines) -- still review for context (removing security checks, etc.).
- Confidence filter removes ALL findings -- return empty array (correct behavior: nothing is high-confidence).

---

## P -- Pseudocode

### P1 -- Core Review Algorithm

```
function createClaudeDiffReviewer(opts):
  { logger, cliBin, cliArgs, confidenceThreshold, modelOverrides } = opts

  return {
    async review(diff, context):
      // Guard: empty diff
      if diff.trim() === '': return []

      // Guard: binary diff
      if isBinaryDiff(diff):
        return [infoFinding('Binary diff detected, skipping AI review')]

      // Step 1: Determine model tier
      lineCount = diff.split('\n').length
      model = lineCount < 500 ? 'haiku' : 'sonnet'
      timeout = model === 'haiku' ? 60_000 : 120_000

      // Step 2: Chunk if needed
      chunks = lineCount > 10_000
        ? splitAtFileBoundaries(diff, 2000)
        : [diff]

      // Step 3: Review each chunk
      allFindings = []
      for chunk of chunks:
        prompt = buildDiffReviewPrompt(chunk, context, model)
        rawOutput = await invokeClaude(prompt, model, timeout)
        findings = parseFindings(rawOutput)
        allFindings.push(...findings)

      // Step 4: Confidence filtering
      filtered = await filterByConfidence(allFindings, confidenceThreshold)

      // Step 5: Deduplicate
      return deduplicateFindings(filtered)
  }
```

### P2 -- Model Routing

```
function selectModel(diff):
  lineCount = diff.split('\n').length
  if lineCount < 500:
    return { model: 'haiku', timeout: 60_000 }
  else:
    return { model: 'sonnet', timeout: 120_000 }
```

### P3 -- Diff Chunking

```
function splitAtFileBoundaries(diff, targetChunkSize):
  files = splitByFileHeader(diff)   // split on 'diff --git' markers
  chunks = []
  currentChunk = ''
  currentLines = 0

  for file of files:
    fileLines = file.split('\n').length
    if currentLines + fileLines > targetChunkSize and currentChunk !== '':
      chunks.push(currentChunk)
      currentChunk = file
      currentLines = fileLines
    else:
      currentChunk += file
      currentLines += fileLines

  if currentChunk !== '':
    chunks.push(currentChunk)

  return chunks
```

### P4 -- Response Parsing

```
function parseFindings(rawOutput):
  // Attempt 1: JSON parsing
  json = tryExtractJson(rawOutput)
  if json?.findings and Array.isArray(json.findings):
    return json.findings.map(f => toFinding(f))

  // Attempt 2: Markdown parsing
  lines = rawOutput.split('\n')
  findings = []
  for line of lines:
    match = line.match(/\[(INFO|WARNING|ERROR|CRITICAL)\]\s*(\w[\w-]*):\s*(.+)/)
    if match:
      findings.push({
        id: randomUUID(),
        severity: match[1].toLowerCase(),
        category: match[2],
        message: match[3],
      })

  if findings.length > 0: return findings

  // Attempt 3: Unstructured fallback
  return [{
    id: randomUUID(),
    severity: 'info',
    category: 'diff-review',
    message: 'Review completed but output could not be parsed into structured findings',
  }]
```

### P5 -- Confidence Filtering

```
function filterByConfidence(findings, threshold):
  if findings.length === 0: return []

  // Batch: send all findings to Haiku for confidence scoring
  prompt = buildConfidencePrompt(findings)
  rawOutput = await invokeClaude(prompt, 'haiku', 60_000)
  scores = parseConfidenceScores(rawOutput)

  return findings.filter((f, i) =>
    scores[i] === undefined || scores[i] >= threshold
  )
```

### P6 -- Binary Diff Detection

```
function isBinaryDiff(diff):
  if diff.includes('\x00'): return true
  if diff.includes('Binary files') and diff.includes('differ'): return true
  if diff.includes('GIT binary patch'): return true
  return false
```

### Complexity Analysis

- Model routing: O(n) where n = lines in diff (single pass to count)
- Chunking: O(n) single pass splitting on file headers
- Review invocation: O(k) where k = number of chunks, each is a Claude call
- Response parsing: O(m) where m = lines in Claude output
- Confidence filtering: O(f) where f = number of findings (single batch Haiku call)
- Total: O(n + k * Claude_latency + f * Haiku_latency)

---

## A -- Architecture

### New Components

```
src/review/claude-diff-reviewer.ts  -- createClaudeDiffReviewer() factory
```

### Modified Components

```
src/index.ts                        -- Wire real reviewer when ENABLE_CLAUDE_DIFF_REVIEW=true
src/shared/config.ts                -- Add ENABLE_CLAUDE_DIFF_REVIEW to AppConfig
```

### Component Interactions

```
                                   +---------------------------+
                                   |      ReviewGate           |
                                   | (Promise.allSettled)      |
                                   +---------------------------+
                                     |          |           |
                            +--------+    +-----+-----+  +--+--+
                            |             |           |  |     |
                    ClaudeDiffReviewer  TestRunner  SecurityScanner
                            |
                     +------+------+
                     |             |
               selectModel    splitChunks
                     |             |
               invokeClaude   invokeClaude (per chunk)
                     |
              parseFindings
                     |
            filterByConfidence
                     |
               invokeClaude (Haiku batch)
                     |
              deduplicateFindings
                     |
                 Finding[]
```

### Integration Points

1. **ReviewGate** (`review-gate.ts:97-101`): `diffReviewer.review(request.diff, request.context)` -- no change to call site. The new reviewer is injected via DI.

2. **Pipeline wiring** (`index.ts:103-104`): Replace `createStubDiffReviewer()` with `createClaudeDiffReviewer(opts)` when env var is set.

3. **Claude CLI invocation**: Reuses `buildSafeEnv()` from `cli-client.ts` and `createAgentSandbox()` from `agent-sandbox.ts` for process isolation.

4. **Prompt construction**: Uses `buildReviewPrompt()` from `prompt-builder.ts` as a reference but builds its own specialized diff-review prompt with coverage categories.

### Key Design Decisions

- **Separate file, not extending review-gate.ts.** The review gate is already 420+ lines. The Claude diff reviewer has enough complexity (model routing, chunking, parsing, confidence filtering) to warrant its own module.
- **Direct CLI spawn, not TaskExecutor.** The diff reviewer needs fine-grained control over model selection and timeout that the generic TaskExecutor does not provide. Uses `spawn` directly with `buildSafeEnv()` and sandbox isolation.
- **Confidence filtering as optional enhancement.** If confidence filtering fails (Haiku timeout), all findings pass through unfiltered. This is defense-in-depth, not a gate.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude response format changes | MEDIUM | Multi-format parser (JSON + markdown + fallback) |
| Haiku confidence scoring unreliable | LOW | Threshold is configurable; fallback passes all findings |
| Large diff chunking loses cross-file context | MEDIUM | Chunk at file boundaries; include file headers in each chunk |
| Review prompt injection via diff content | HIGH | Boundary markers separate instructions from diff content |
| Cost accumulation from confidence filtering | LOW | Haiku is $0.0002/call; batch all findings in one call |
| Concurrent reviews exhaust Claude rate limits | MEDIUM | ReviewGate already runs checkers via Promise.allSettled; failures produce error findings, not crashes |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: Response parsing -- pure functions, 0 dependencies

**File:** `src/review/claude-diff-reviewer.ts` (parsing functions only)
**Test file:** `tests/review/claude-diff-reviewer.test.ts`

Tests (London School -- mock-first):
- `parseFindings` extracts findings from valid JSON `{"findings": [...]}`
- `parseFindings` extracts findings from markdown `[ERROR] security: SQL injection in query`
- `parseFindings` returns fallback info finding for unstructured text
- `parseFindings` handles empty string
- `parseFindings` handles malformed JSON with valid markdown fallback
- `isBinaryDiff` detects null bytes
- `isBinaryDiff` detects "Binary files differ" marker
- `isBinaryDiff` detects "GIT binary patch" marker
- `isBinaryDiff` returns false for normal text diff
- `toFinding` maps raw JSON object to typed `Finding` with generated `id`
- `toFinding` normalizes severity strings to lowercase

### Step 2: Diff chunking -- pure functions, 0 dependencies

Tests:
- `splitAtFileBoundaries` returns single chunk for diff under target size
- `splitAtFileBoundaries` splits at `diff --git` markers
- `splitAtFileBoundaries` does not produce empty chunks
- `splitAtFileBoundaries` handles diff with single file
- `splitAtFileBoundaries` handles diff with no file headers (raw patch)
- `deduplicateFindings` removes findings with identical message + location
- `deduplicateFindings` preserves order (first occurrence wins)

### Step 3: Model routing + invocation -- mock child_process

Tests:
- `selectModel` returns haiku for diff with 100 lines
- `selectModel` returns sonnet for diff with 1000 lines
- `selectModel` returns sonnet for diff with exactly 500 lines
- `invokeClaude` spawns process with correct model args and `buildSafeEnv()`
- `invokeClaude` uses `createAgentSandbox()` for cwd isolation
- `invokeClaude` returns stdout on exit code 0
- `invokeClaude` returns error finding on timeout (does not throw)
- `invokeClaude` returns error finding on exit code !== 0
- `invokeClaude` cleans up sandbox in finally block

### Step 4: Confidence filtering -- mock Claude invocation

Tests:
- `filterByConfidence` removes findings below threshold
- `filterByConfidence` keeps findings at or above threshold
- `filterByConfidence` returns empty array when input is empty
- `filterByConfidence` passes all findings through when Haiku call fails (timeout/error)
- `filterByConfidence` handles mismatched score count (fewer scores than findings)
- `buildConfidencePrompt` includes all finding messages in prompt

### Step 5: Full `createClaudeDiffReviewer` integration -- mock invokeClaude

Tests:
- Empty diff returns `[]` without invoking Claude
- Binary diff returns info finding without invoking Claude
- Small diff (<500 lines) invokes Haiku
- Large diff (>=500 lines) invokes Sonnet
- Diff >10K lines is chunked and all chunks reviewed
- Findings from multiple chunks are merged
- Confidence filtering is applied to merged findings
- Timeout produces error finding in result
- Context (repo, branch, prNumber, commitSha, attempt) is included in review prompt
- Review prompt contains all 5 coverage categories

### Step 6: Pipeline wiring

Tests:
- `ENABLE_CLAUDE_DIFF_REVIEW=true` creates `ClaudeDiffReviewer` in pipeline
- Without env var, `createStubDiffReviewer()` is used (backward compatible)
- `ReviewGate` with real diff reviewer still runs all 3 checkers in parallel

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on new modules
- `npm run build` succeeds
- `npm run lint` passes
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] `createClaudeDiffReviewer` implements `DiffReviewer` interface (type check)
- [ ] All 10 acceptance criteria validated with automated tests
- [ ] Manual test: run against a real PR diff with known issues, verify findings
- [ ] Manual test: run against a clean diff, verify no false positives
- [ ] Manual test: run against a 15K-line diff, verify chunking works
- [ ] Cost analysis: verify Haiku calls for small diffs, Sonnet for large
- [ ] Security: verify `buildSafeEnv()` strips secrets from Claude process
- [ ] Security: verify boundary markers in review prompt prevent injection
- [ ] Performance: measure end-to-end review time for typical diffs (target: <30s for <500 lines)

### Deployment Steps

1. Merge code with `ENABLE_CLAUDE_DIFF_REVIEW` defaulting to `false` (stub remains active)
2. Deploy to staging environment
3. Set `ENABLE_CLAUDE_DIFF_REVIEW=true` in staging
4. Run 10 real PR reviews in staging, validate findings quality
5. Tune confidence threshold if needed (default: 0.7)
6. Enable in production via environment variable

### Rollback Plan

1. Set `ENABLE_CLAUDE_DIFF_REVIEW=false` (or unset) -- immediately falls back to stub
2. No data migration needed -- findings are ephemeral within the review pipeline
3. No interface changes -- callers are unaffected by rollback

---

## Cross-Plan Dependencies

- **Depends on Plan 2** (Hook Pollution Fix) -- uses `createAgentSandbox()` for process isolation.
- **Depends on Plan 1** (Dorothy Improvements) -- uses `buildSafeEnv()` from `cli-client.ts`.
- **No blockers** -- both Plan 1 and Plan 2 are already merged.
- **Enables Gap 2** (Prompt Injection Defense) -- the review prompt must use boundary markers, which aligns with the sanitization work in Gap 2.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/review/claude-diff-reviewer.ts` | NEW |
| `src/index.ts` | MODIFIED (wire reviewer) |
| `src/shared/config.ts` | MODIFIED (add env var) |
| `tests/review/claude-diff-reviewer.test.ts` | NEW |
