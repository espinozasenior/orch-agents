# SPARC Gap 8: Output Suppression and Secret Sanitization

## Priority: P2
## Estimated Effort: 1-2 days
## Status: Planning

---

## Problem Statement

Agent outputs are logged and posted to GitHub at full fidelity with no sanitization. When an agent reviews a PR that modifies `.env` files, config files, or any file containing secrets, those secrets can appear in:

1. **PR comments** posted by `GitHubClient.postPRComment()` -- publicly visible.
2. **Structured log output** via the console-based logger -- visible in log aggregation systems.
3. **Dorothy AgentChunk events** published through the EventBus -- consumed by any subscriber.

The system already has secret detection patterns in `review-gate.ts` (`DEFAULT_SECRET_PATTERNS`) for scanning diffs, but these patterns are not applied to output sanitization. There is no defense-in-depth for the output path.

---

## S -- Specification

### Functional Requirements

- **FR-001**: Create `src/shared/output-sanitizer.ts` with a `sanitizeOutput(text: string): string` function that replaces detected secrets with `[REDACTED]`.
- **FR-002**: Create a `shouldSuppress(text: string): boolean` function that returns true when text contains high-confidence secret patterns (AWS keys, GitHub PATs, private key headers).
- **FR-003**: Reuse the secret patterns from `review-gate.ts` (`DEFAULT_SECRET_PATTERNS`) as the canonical pattern list. Import or share them to avoid duplication.
- **FR-004**: Apply `sanitizeOutput()` to PR comment bodies before posting via `GitHubClient.postPRComment()`.
- **FR-005**: Apply `sanitizeOutput()` to structured log payloads. Add a custom serializer to the logger that sanitizes string values in log context objects.
- **FR-006**: Apply `sanitizeOutput()` to Dorothy `AgentChunk` event payloads before EventBus publish in `streaming-executor.ts`.
- **FR-007**: Support `SUPPRESS_OUTPUT=true` (default in production) and `SUPPRESS_OUTPUT=false` (for development debugging) via environment variable.
- **FR-008**: Never redact content within code diffs being actively reviewed by the security scanner. Sanitization applies only to output paths (logs, comments, events), not to input paths (diff text passed to scanners).

### Non-Functional Requirements

- **NFR-001** (performance): `sanitizeOutput()` must process a 100KB string in under 5ms. Agent outputs can be large.
- **NFR-002** (no false negatives): High-confidence patterns (AWS AKIA keys, GitHub PATs, private key headers) must always be caught. False positives on low-confidence patterns are acceptable.
- **NFR-003** (observability): When suppression occurs, log a structured event `{ event: 'output_redacted', redactionCount: N }` so operators know sanitization happened.

### Acceptance Criteria

- AC1: `sanitizeOutput('Key is AKIAIOSFODNN7EXAMPLE')` returns `'Key is [REDACTED]'`.
- AC2: `sanitizeOutput('Token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890')` returns `'Token: [REDACTED]'`.
- AC3: `sanitizeOutput('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')` returns `'[REDACTED]\nMIIE...'`.
- AC4: `sanitizeOutput('Normal output with no secrets')` returns the string unchanged.
- AC5: `shouldSuppress('AKIAIOSFODNN7EXAMPLE')` returns `true`.
- AC6: `shouldSuppress('Normal text')` returns `false`.
- AC7: With `SUPPRESS_OUTPUT=true`, PR comments posted via GitHubClient have secrets redacted.
- AC8: With `SUPPRESS_OUTPUT=false`, PR comments are posted as-is (development mode).
- AC9: AgentChunk events have their `chunk` field sanitized before publish.

### Constraints

- Must not modify the `review-gate.ts` security scanner behavior. Sanitization is output-only.
- Must not alter the `DomainEvent` type definitions. Sanitization happens before event construction.
- Must not add external dependencies (no npm packages for secret detection).
- Pattern list must be shared (single source of truth) between `review-gate.ts` and `output-sanitizer.ts`.

### Edge Cases

- Output contains a partial secret split across two AgentChunk events -- each chunk is sanitized independently. A partial AKIA prefix in one chunk may not be caught; this is acceptable since the full key spans chunks.
- Output contains legitimate text that matches a pattern (e.g., documentation about AWS key formats) -- false positive redaction is acceptable; security over convenience.
- Output is empty string -- return empty string, no error.
- Output is binary data (non-UTF8) -- sanitize after toString(); patterns won't match binary so no redaction occurs.
- `SUPPRESS_OUTPUT` not set -- default to `true` in production (`NODE_ENV=production`), `false` otherwise.

---

## P -- Pseudocode

### P1 -- Secret Pattern Registry (Shared)

```
// Extract from review-gate.ts into a shared module, or re-export

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string; confidence: 'high' | 'medium' }> = [
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS Access Key', confidence: 'high' },
  { pattern: /ghp_[A-Za-z0-9_]{36}/, label: 'GitHub PAT', confidence: 'high' },
  { pattern: /gho_[A-Za-z0-9_]{36}/, label: 'GitHub OAuth', confidence: 'high' },
  { pattern: /ghs_[A-Za-z0-9_]{36}/, label: 'GitHub Server', confidence: 'high' },
  { pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/,
    label: 'Private Key', confidence: 'high' },
  { pattern: /(?:secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    label: 'Quoted Secret', confidence: 'medium' },
  { pattern: /(?:secret|password|api[_-]?key)\s*[:=]\s*\S{8,}/i,
    label: 'Unquoted Secret', confidence: 'medium' },
]
```

### P2 -- sanitizeOutput

```
function sanitizeOutput(text: string): { sanitized: string; redactionCount: number }:
  if !text: return { sanitized: '', redactionCount: 0 }

  result = text
  count = 0

  for each { pattern } of SECRET_PATTERNS:
    globalPattern = new RegExp(pattern.source, pattern.flags + 'g')
    matches = result.matchAll(globalPattern)
    for each match of matches:
      count++
    result = result.replaceAll(globalPattern, '[REDACTED]')

  return { sanitized: result, redactionCount: count }
```

### P3 -- shouldSuppress

```
function shouldSuppress(text: string): boolean:
  for each { pattern, confidence } of SECRET_PATTERNS:
    if confidence === 'high' && pattern.test(text):
      return true
  return false
```

### P4 -- Logger Serializer

```
function createSanitizingLogger(baseLogger, suppressEnabled):
  if !suppressEnabled: return baseLogger

  return {
    ...baseLogger,
    info(msg, context):
      baseLogger.info(msg, sanitizeContext(context))
    warn(msg, context):
      baseLogger.warn(msg, sanitizeContext(context))
    error(msg, context):
      baseLogger.error(msg, sanitizeContext(context))
    // ... other levels
  }

function sanitizeContext(context):
  if !context: return context
  sanitized = {}
  for each [key, value] of Object.entries(context):
    if typeof value === 'string':
      { sanitized: cleaned } = sanitizeOutput(value)
      sanitized[key] = cleaned
    else:
      sanitized[key] = value
  return sanitized
```

### P5 -- GitHubClient Integration

```
// In github-client.ts postPRComment:
async postPRComment(repo, prNumber, body):
  validateRepo(repo)
  validatePRNumber(prNumber)
  validateBody(body)

  sanitizedBody = suppressEnabled ? sanitizeOutput(body).sanitized : body
  if sanitizedBody !== body:
    log.info('Output redacted before PR comment', { redactionCount })

  await run('gh', ['pr', 'comment', ...], sanitizedBody)
```

### P6 -- StreamingExecutor Integration

```
// In streaming-executor.ts, before publishing AgentChunk:
child.stdout.on('data', chunk):
  chunkStr = chunk.toString()
  sanitizedChunk = suppressEnabled ? sanitizeOutput(chunkStr).sanitized : chunkStr

  // Publish sanitized chunk
  eventBus.publish(createDomainEvent('AgentChunk', {
    execId, planId, agentRole,
    chunk: sanitizedChunk,   // sanitized
    timestamp: new Date().toISOString()
  }))

  // But accumulate raw output for JSON extraction (internal use)
  stdout += chunkStr  // raw, not sanitized -- needed for extractJson
```

### Complexity Analysis

- `sanitizeOutput`: O(n * p) where n = text length, p = number of patterns (7). For 100KB text, this is 7 regex passes.
- `shouldSuppress`: O(p) worst case, O(1) best case (short-circuit on first high-confidence match).
- Logger serializer: O(k * n * p) where k = number of string fields in context. Typically k < 5.

---

## A -- Architecture

### New Components

```
src/shared/secret-patterns.ts    -- Shared secret pattern registry (extracted from review-gate.ts)
src/shared/output-sanitizer.ts   -- sanitizeOutput(), shouldSuppress(), createSanitizingLogger()
```

### Modified Components

```
src/review/review-gate.ts              -- Import patterns from shared/secret-patterns.ts
src/integration/github-client.ts       -- Sanitize PR comment bodies before posting
src/execution/streaming-executor.ts    -- Sanitize AgentChunk payloads before publish
src/index.ts                           -- Read SUPPRESS_OUTPUT, create sanitizing logger wrapper
```

### Data Flow

```
Agent stdout (raw)
    |
    +---> [internal buffer for extractJson] -- NOT sanitized (needs raw JSON)
    |
    +---> sanitizeOutput()
              |
              +---> AgentChunk event (sanitized chunk)
              |
              +---> Logger (sanitized context)
              |
              +---> GitHubClient.postPRComment (sanitized body)
```

### Key Design Decisions

- **Shared pattern module**: Extract `DEFAULT_SECRET_PATTERNS` from `review-gate.ts` into `src/shared/secret-patterns.ts`. Both `review-gate.ts` (for diff scanning) and `output-sanitizer.ts` (for output sanitization) import from this shared source. This eliminates pattern duplication and ensures consistency.

- **Sanitize at output boundaries, not in EventBus**: Sanitization happens before event construction (in `streaming-executor.ts`) and before HTTP calls (in `github-client.ts`), not as a generic EventBus middleware. This is simpler, testable, and avoids sanitizing events that internal subscribers may need raw.

- **Raw buffer for extractJson**: The streaming executor accumulates raw (unsanitized) stdout for JSON extraction. Sanitization would break JSON parsing. Only the published event chunk is sanitized.

- **Feature flag via environment**: `SUPPRESS_OUTPUT` defaults to enabled in production. Development mode can disable it for debugging agent output.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| False positive redaction of legitimate text | LOW | Only high-confidence patterns used for suppression; medium-confidence for redaction is acceptable |
| Performance degradation on large outputs | LOW | 7 regex passes on 100KB is sub-millisecond on modern hardware |
| Partial secrets across chunk boundaries | MEDIUM | Acceptable trade-off; full secret in single chunk is the common case |
| Pattern list diverges from review-gate | ELIMINATED | Shared module is single source of truth |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: secret-patterns.ts (extract from review-gate.ts)

Tests:
- Exported `SECRET_PATTERNS` array has expected length (7 patterns)
- Each pattern has `pattern`, `label`, `confidence` fields
- AWS key pattern matches `AKIAIOSFODNN7EXAMPLE`
- GitHub PAT pattern matches `ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890`
- Private key pattern matches `-----BEGIN RSA PRIVATE KEY-----`

### Step 2: output-sanitizer.ts -- sanitizeOutput + tests

Tests:
- Returns empty string unchanged, redactionCount 0
- Returns text with no secrets unchanged, redactionCount 0
- Redacts AWS access key, redactionCount 1
- Redacts GitHub PAT, redactionCount 1
- Redacts private key header, redactionCount 1
- Redacts multiple secrets in one string, redactionCount equals count
- Redacts quoted secret assignment (`api_key: "abc12345678"`)
- Does not modify text that merely mentions "password" without assignment
- Handles text with overlapping pattern matches without corruption

### Step 3: output-sanitizer.ts -- shouldSuppress + tests

Tests:
- Returns true for high-confidence pattern (AWS key)
- Returns true for high-confidence pattern (GitHub PAT)
- Returns true for high-confidence pattern (private key)
- Returns false for medium-confidence pattern only (quoted secret)
- Returns false for text with no secrets
- Returns false for empty string

### Step 4: createSanitizingLogger wrapper + tests

Tests (mock base logger):
- When suppress enabled, string values in context are sanitized
- When suppress disabled, context passed through unchanged
- Non-string values in context are not modified
- `child()` method returns a sanitizing logger
- Message string itself is NOT sanitized (messages are developer-authored)

### Step 5: github-client.ts integration + tests

Tests (mock exec):
- With suppress enabled, PR comment body has secrets redacted before `gh` call
- With suppress disabled, PR comment body passed through as-is
- Inline comments also sanitized
- submitReview body also sanitized
- Redaction count logged as structured event

### Step 6: streaming-executor.ts integration + tests

Tests (mock child process, mock EventBus):
- AgentChunk event has sanitized chunk when suppress enabled
- Raw stdout buffer is NOT sanitized (extractJson receives raw output)
- When suppress disabled, chunk passed through as-is

### Step 7: review-gate.ts refactor + tests

Tests:
- `createPatternSecurityScanner` uses patterns from `secret-patterns.ts`
- All existing review-gate tests pass unchanged
- Scanner behavior identical after refactor

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on `output-sanitizer.ts`
- `npm run build` succeeds
- `npm test` passes
- Performance: `sanitizeOutput` processes 100KB in under 5ms (add benchmark test)

---

## C -- Completion

### Verification Checklist

- [ ] `SECRET_PATTERNS` extracted to shared module
- [ ] `review-gate.ts` imports from shared module (no pattern duplication)
- [ ] `sanitizeOutput()` correctly redacts all 7 pattern types
- [ ] `shouldSuppress()` correctly identifies high-confidence secrets
- [ ] `GitHubClient` sanitizes PR comment bodies before posting
- [ ] `StreamingExecutor` sanitizes AgentChunk payloads before EventBus publish
- [ ] Raw stdout buffer preserved for extractJson (not sanitized)
- [ ] Logger wrapper sanitizes string context values
- [ ] `SUPPRESS_OUTPUT` defaults to true in production, false in development
- [ ] Redaction events logged for observability
- [ ] All existing tests pass

### Deployment Steps

1. Merge to main after all tests pass.
2. `SUPPRESS_OUTPUT=true` is the default in production -- no env var change needed.
3. For debugging agent output in staging, set `SUPPRESS_OUTPUT=false`.
4. Monitor logs for `output_redacted` events to verify sanitization is working.
5. No database migration required.

### Rollback Plan

- Revert the merge commit. All sanitization is additive; removing it restores previous behavior (full-fidelity output).
- If only the logger or GitHub integration causes issues, revert individual integration points while keeping the core `output-sanitizer.ts` module.
- No state is modified by this change; rollback is code-only.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/shared/secret-patterns.ts` | NEW |
| `src/shared/output-sanitizer.ts` | NEW |
| `src/review/review-gate.ts` | MODIFIED (import patterns from shared) |
| `src/integration/github-client.ts` | MODIFIED (sanitize before posting) |
| `src/execution/streaming-executor.ts` | MODIFIED (sanitize AgentChunk) |
| `src/index.ts` | MODIFIED (read SUPPRESS_OUTPUT, wire sanitizer) |
| `tests/shared/output-sanitizer.test.ts` | NEW |
| `tests/shared/secret-patterns.test.ts` | NEW |
| `tests/integration/github-client.test.ts` | MODIFIED |
| `tests/execution/streaming-executor.test.ts` | MODIFIED |
