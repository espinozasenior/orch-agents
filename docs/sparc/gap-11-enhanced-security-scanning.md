# SPARC Gap 11: Enhanced Security Scanning

## Composable SAST, Vulnerability Pattern Detection, Dependency Scanning

## Priority: P2
## Estimated Effort: 7-10 days
## Status: Planning

---

## Problem Statement

Security scanning in ReviewGate is limited to regex pattern matching for known secret formats. `createPatternSecurityScanner()` in `review-gate.ts:373-422` scans diffs against 7 regex patterns (AWS keys, GitHub PATs, private keys, hardcoded secrets). There is no SAST capability, no vulnerability pattern detection for injection attacks, and no dependency scanning for known CVEs. This means code that introduces SQL injection, XSS, command injection, or path traversal passes review without any automated detection. Similarly, adding a dependency with a known critical vulnerability generates no warning.

---

## S -- Specification

### Requirements

1. **R1 -- Composable scanner module.** Create `src/review/security/` bounded context with a `CompositeSecurityScanner` that implements the existing `SecurityScanner` interface (`{ scan(diff: string): Promise<Finding[]> }`). It runs all sub-scanners in parallel via `Promise.allSettled` and aggregates findings.

2. **R2 -- Pattern scanner migration.** Move the existing regex-based secret detection from `review-gate.ts:373-422` into `src/review/security/pattern-scanner.ts` as `PatternScanner`. The `createPatternSecurityScanner()` in `review-gate.ts` becomes a thin wrapper that delegates to PatternScanner.

3. **R3 -- AST-aware injection scanner.** Create `ASTScanner` that performs language-aware scanning on added lines in diffs. Must detect:
   - SQL injection: string concatenation or template literal interpolation in query/execute calls
   - XSS: unsanitized user input in HTML rendering (innerHTML, dangerouslySetInnerHTML, template strings in response.send)
   - Command injection: user input flowing into exec/spawn/execSync calls
   - Path traversal: user input in fs.readFile/writeFile/path.join without sanitization

4. **R4 -- Dependency scanner.** Create `DependencyScanner` that detects `package.json` and `package-lock.json` changes in diffs, extracts added/modified dependencies, and queries the OSV API (`https://api.osv.dev/v1/query`) for known vulnerabilities.

5. **R5 -- Language detection.** Detect programming language from file extension in diff headers (`diff --git a/foo.ts b/foo.ts`). ASTScanner applies language-specific patterns only for recognized languages (TypeScript, JavaScript, Python initially).

6. **R6 -- Severity mapping.** Secrets: `critical`. Injection vulnerabilities: `error`. Vulnerable dependencies: `warning` (upgradeable) or `error` (no fix available).

7. **R7 -- Configurable scanners.** A `SecurityScannerConfig` type enables/disables individual sub-scanners. Default: all enabled.

8. **R8 -- Rate limiting for external APIs.** DependencyScanner rate-limits OSV API calls to max 10 requests per minute. Uses a simple token bucket.

### Acceptance Criteria

- AC1: `CompositeSecurityScanner.scan(diff)` returns findings from all enabled sub-scanners.
- AC2: A diff containing `AKIA` followed by 16 alphanumeric characters produces a `critical` finding from PatternScanner.
- AC3: A diff containing `db.query("SELECT * FROM users WHERE id=" + userId)` produces an `error` finding from ASTScanner with category `sql-injection`.
- AC4: A diff adding `"lodash": "4.17.20"` to package.json produces a `warning` finding from DependencyScanner (known prototype pollution CVE).
- AC5: A diff modifying only `.py` files does not trigger TypeScript-specific AST patterns.
- AC6: Disabling `ast` in config causes CompositeScanner to skip ASTScanner entirely.
- AC7: When OSV API is unreachable, DependencyScanner returns zero findings with a warning log, not an error.

### Constraints

- Must implement the existing `SecurityScanner` interface -- `{ scan(diff: string): Promise<Finding[]> }`.
- Must not add native dependencies (no tree-sitter native bindings). AST scanning uses pattern-based heuristics on added lines, not full AST parsing.
- OSV API is the only external dependency. No npm audit CLI dependency (requires npm installed on host).
- Finding type is fixed: `{ id, severity, category, message, location? }` from `src/types.ts:181`.
- All sub-scanners receive the raw diff string and are responsible for their own line filtering.

### Edge Cases

- Diff contains removed lines with secrets -- must not flag (only scan added lines).
- Diff modifies a file with no recognized extension -- ASTScanner skips silently.
- OSV API returns 429 (rate limited) -- retry once after 1 second, then skip with warning.
- Package.json diff adds 50+ dependencies -- batch OSV queries, respect rate limit.
- ASTScanner false positive: string concatenation in a comment or string literal -- accept as known limitation, document.
- Empty diff string -- all scanners return empty findings array immediately.
- Diff contains binary file markers -- scanners skip binary sections.

---

## P -- Pseudocode

### P1 -- CompositeSecurityScanner

```
interface ScannerEntry:
  name: string
  scanner: SecurityScanner
  enabled: boolean

class CompositeSecurityScanner implements SecurityScanner:
  constructor(scanners: ScannerEntry[], logger?)

  async scan(diff: string) -> Finding[]:
    enabled = scanners.filter(s => s.enabled)
    results = await Promise.allSettled(
      enabled.map(s => s.scanner.scan(diff))
    )

    findings = []
    for (i, result) in results:
      if result.status === 'fulfilled':
        findings.push(...result.value)
      else:
        logger?.warn('Scanner failed', { name: enabled[i].name, error: result.reason })

    return findings.sort(bySeverity)

function bySeverity(a, b):
  order = { critical: 0, error: 1, warning: 2, info: 3 }
  return order[a.severity] - order[b.severity]
```

### P2 -- PatternScanner (migrated)

```
class PatternScanner implements SecurityScanner:
  constructor(opts?: { extraPatterns?: RegExp[], logger? })

  async scan(diff: string) -> Finding[]:
    addedLines = filterAddedLines(diff)
    findings = []

    for pattern of compiledPatterns:
      pattern.lastIndex = 0
      matches = [...addedLines.matchAll(pattern)]
      for match of matches:
        findings.push({
          id: randomUUID(),
          severity: 'critical',
          category: 'secret-detection',
          message: `Potential secret detected: ${match[0].slice(0, 20)}...`
        })

    return findings
```

### P3 -- ASTScanner

```
class ASTScanner implements SecurityScanner:
  constructor(logger?)

  async scan(diff: string) -> Finding[]:
    fileSections = parseDiffSections(diff)
    findings = []

    for section of fileSections:
      lang = detectLanguage(section.filePath)
      if lang === null: continue

      addedLines = filterAddedLinesFromSection(section)
      patterns = getInjectionPatterns(lang)

      for line, lineNum of addedLines:
        for pattern of patterns:
          if pattern.regex.test(line):
            findings.push({
              id: randomUUID(),
              severity: 'error',
              category: pattern.category,
              message: pattern.message,
              location: { file: section.filePath, line: lineNum }
            })

    return findings

function detectLanguage(filePath: string) -> string | null:
  ext = path.extname(filePath).toLowerCase()
  langMap = { '.ts': 'typescript', '.js': 'javascript', '.tsx': 'typescript',
              '.jsx': 'javascript', '.py': 'python' }
  return langMap[ext] ?? null

function getInjectionPatterns(lang: string) -> InjectionPattern[]:
  common = [
    { regex: /exec\s*\(.*\+/, category: 'command-injection',
      message: 'Potential command injection: user input in exec()' },
    { regex: /spawn\s*\(.*\+/, category: 'command-injection',
      message: 'Potential command injection: user input in spawn()' },
  ]

  if lang in ['typescript', 'javascript']:
    return [...common,
      { regex: /\.query\s*\(\s*['"`].*\+/, category: 'sql-injection',
        message: 'Potential SQL injection: string concatenation in query call' },
      { regex: /\.query\s*\(\s*`[^`]*\$\{/, category: 'sql-injection',
        message: 'Potential SQL injection: template literal in query call' },
      { regex: /innerHTML\s*=/, category: 'xss',
        message: 'Potential XSS: direct innerHTML assignment' },
      { regex: /dangerouslySetInnerHTML/, category: 'xss',
        message: 'Potential XSS: dangerouslySetInnerHTML usage' },
      { regex: /readFile.*\+.*req\./, category: 'path-traversal',
        message: 'Potential path traversal: user input in file read' },
      { regex: /path\.join\s*\(.*req\./, category: 'path-traversal',
        message: 'Potential path traversal: user input in path.join' },
    ]

  if lang === 'python':
    return [...common,
      { regex: /execute\s*\(\s*f['"]/, category: 'sql-injection',
        message: 'Potential SQL injection: f-string in execute()' },
      { regex: /execute\s*\(\s*['"].*%/, category: 'sql-injection',
        message: 'Potential SQL injection: % formatting in execute()' },
      { regex: /open\s*\(.*\+.*request/, category: 'path-traversal',
        message: 'Potential path traversal: user input in open()' },
    ]

  return common

function parseDiffSections(diff: string) -> DiffSection[]:
  sections = []
  currentFile = null
  currentLines = []

  for line of diff.split('\n'):
    if line.startsWith('diff --git'):
      if currentFile: sections.push({ filePath: currentFile, lines: currentLines })
      currentFile = extractFilePath(line)
      currentLines = []
    else:
      currentLines.push(line)

  if currentFile: sections.push({ filePath: currentFile, lines: currentLines })
  return sections
```

### P4 -- DependencyScanner

```
class DependencyScanner implements SecurityScanner:
  constructor(rateLimiter: TokenBucket, logger?)

  async scan(diff: string) -> Finding[]:
    if !diffContainsPackageJson(diff): return []

    addedDeps = extractAddedDependencies(diff)
    if addedDeps.length === 0: return []

    findings = []
    for dep of addedDeps:
      if !rateLimiter.tryConsume(): break

      try:
        vulns = await queryOSV(dep.name, dep.version)
        for vuln of vulns:
          findings.push({
            id: randomUUID(),
            severity: vuln.fixAvailable ? 'warning' : 'error',
            category: 'vulnerable-dependency',
            message: `${dep.name}@${dep.version}: ${vuln.id} - ${vuln.summary}`
          })
      catch error:
        logger?.warn('OSV query failed', { dep: dep.name, error })

    return findings

function extractAddedDependencies(diff: string) -> Dependency[]:
  // Parse added lines in package.json sections
  // Match pattern: +"package-name": "version"
  deps = []
  inPackageJson = false

  for line of diff.split('\n'):
    if line.startsWith('diff --git') and line.includes('package.json'):
      inPackageJson = true
    else if line.startsWith('diff --git'):
      inPackageJson = false

    if inPackageJson and line.startsWith('+') and !line.startsWith('+++'):
      match = line.match(/^\+\s*"([^"]+)":\s*"([^"]+)"/)
      if match and !isMetadataKey(match[1]):
        deps.push({ name: match[1], version: match[2] })

  return deps

async function queryOSV(name: string, version: string) -> Vulnerability[]:
  response = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    body: JSON.stringify({
      package: { name, ecosystem: 'npm' },
      version
    })
  })

  if response.status === 429:
    await sleep(1000)
    response = await fetch(...)  // retry once
    if !response.ok: return []

  if !response.ok: return []
  data = await response.json()
  return data.vulns ?? []
```

### P5 -- TokenBucket Rate Limiter

```
class TokenBucket:
  constructor(maxTokens: number, refillPerSecond: number)
  tokens: number = maxTokens
  lastRefill: number = Date.now()

  tryConsume() -> boolean:
    refill()
    if tokens > 0:
      tokens -= 1
      return true
    return false

  refill():
    now = Date.now()
    elapsed = (now - lastRefill) / 1000
    tokens = min(maxTokens, tokens + elapsed * refillPerSecond)
    lastRefill = now
```

### Complexity Analysis

- CompositeScanner: O(S) where S = number of sub-scanners, all run in parallel
- PatternScanner: O(P * L) where P = patterns, L = added lines
- ASTScanner: O(F * L * P) where F = file sections, L = lines per section, P = patterns per language
- DependencyScanner: O(D) where D = added dependencies, bounded by rate limiter
- TokenBucket: O(1) per operation

---

## A -- Architecture

### New Components

```
src/review/security/
  index.ts                    -- Public API: createSecurityScanner(config)
  composite-scanner.ts        -- CompositeSecurityScanner
  pattern-scanner.ts          -- PatternScanner (migrated from review-gate.ts)
  ast-scanner.ts              -- ASTScanner (heuristic injection detection)
  dependency-scanner.ts       -- DependencyScanner (OSV API integration)
  injection-patterns.ts       -- Language-specific injection pattern definitions
  diff-parser.ts              -- parseDiffSections(), detectLanguage()
  rate-limiter.ts             -- TokenBucket implementation
  types.ts                    -- SecurityScannerConfig, InjectionPattern, DiffSection
```

### Modified Components

```
src/review/review-gate.ts     -- createPatternSecurityScanner() delegates to PatternScanner
                                 New createEnhancedSecurityScanner() uses CompositeScanner
src/index.ts                   -- Wire SecurityScannerConfig from env/config
```

### Component Diagram

```
                    SecurityScanner interface
                           |
                  CompositeSecurityScanner
                    /        |         \
           PatternScanner  ASTScanner  DependencyScanner
               |              |              |
          regex patterns  injection     OSV API
          (7+ patterns)   patterns      (rate-limited)
                              |
                       diff-parser.ts
                       (file sections,
                        lang detection)
```

### Integration Points

1. **ReviewGate** -- `createReviewGate()` accepts `SecurityScanner`. Replace default `createPatternSecurityScanner()` with `createEnhancedSecurityScanner()` when `ENHANCED_SECURITY_SCANNING=true`.
2. **Configuration** -- `SecurityScannerConfig` passed via environment or config object:
   ```
   SECURITY_SCANNER_PATTERN=true     (default: true)
   SECURITY_SCANNER_AST=true         (default: true)
   SECURITY_SCANNER_DEPS=true        (default: true)
   OSV_RATE_LIMIT_PER_MIN=10         (default: 10)
   ```
3. **Event Bus** -- No new events. Findings flow through existing `ReviewCompletedEvent` payload.

### Key Design Decisions

1. **Heuristic AST scanning, not real AST parsing.** Full AST parsing requires native tree-sitter bindings or language-specific parsers. Pattern-based heuristics on added lines provide 80% coverage with zero native dependencies. False positives are acceptable since findings are advisory (review gate does not auto-reject on injection findings alone).

2. **OSV API over npm audit.** npm audit requires npm CLI on host and `node_modules/`. OSV is a REST API with no host dependencies. Trade-off: OSV may have slightly different coverage than npm advisory database.

3. **CompositeScanner uses Promise.allSettled.** One scanner failure does not block others. Failed scanners log warnings but do not prevent review completion.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| ASTScanner false positives | MEDIUM | Findings are advisory; severity=error not critical. Patterns tuned for high-signal cases. |
| OSV API availability | LOW | Graceful degradation: returns empty on failure. Rate limiting prevents abuse. |
| Regex-based AST misses real vulnerabilities | MEDIUM | Document as heuristic scanner. Future: add tree-sitter-wasm for full AST. |
| DependencyScanner latency (external API) | LOW | Runs in parallel with other scanners. Rate-limited. Timeout per request = 5s. |
| Pattern Scanner migration breaks existing tests | LOW | PatternScanner preserves identical behavior. Existing tests adapted to import from new location. |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: rate-limiter.ts + tests (0 dependencies, pure logic)

Tests (London School -- mock time):
- `tryConsume()` returns true when tokens available
- `tryConsume()` returns false when bucket empty
- Tokens refill over time (mock `Date.now()`)
- Does not exceed maxTokens on refill
- Concurrent calls correctly decrement

### Step 2: diff-parser.ts + tests (0 dependencies, pure functions)

Tests:
- `parseDiffSections()` extracts file paths from `diff --git` headers
- `parseDiffSections()` groups lines by file section
- `detectLanguage('.ts')` returns `'typescript'`
- `detectLanguage('.py')` returns `'python'`
- `detectLanguage('.rs')` returns `null`
- `parseDiffSections()` on empty string returns empty array
- Binary file diff sections are identified

### Step 3: injection-patterns.ts + tests (0 dependencies, pattern definitions)

Tests:
- `getInjectionPatterns('typescript')` includes SQL injection patterns
- `getInjectionPatterns('typescript')` includes XSS patterns
- `getInjectionPatterns('python')` includes Python-specific SQL patterns
- `getInjectionPatterns('unknown')` returns only common patterns
- Each pattern regex matches its intended input
- Each pattern regex does NOT match safe code (e.g., parameterized queries)

### Step 4: pattern-scanner.ts + tests (migrated, 0 new dependencies)

Tests:
- Detects AWS access key pattern (`AKIA` + 16 chars)
- Detects GitHub PAT pattern
- Detects private key header
- Does NOT flag removed lines (only added lines)
- Returns empty array on clean diff
- Extra patterns can be injected via constructor
- All findings have severity `critical` and category `secret-detection`

### Step 5: ast-scanner.ts + tests (depends on 2, 3)

Tests (mock diff-parser):
- Detects `db.query("SELECT..." + userId)` as SQL injection
- Detects `db.query(\`SELECT...${id}\`)` as SQL injection
- Detects `innerHTML =` assignment as XSS
- Detects `exec(cmd + userInput)` as command injection
- Detects `fs.readFile(path + req.params.id)` as path traversal
- Skips files with unrecognized extensions
- Skips removed lines
- Returns empty findings for clean code diff
- Python-specific patterns applied only to `.py` files

### Step 6: dependency-scanner.ts + tests (depends on 1, mock fetch)

Tests (mock global fetch and rate limiter):
- Detects added dependencies in package.json diff
- Queries OSV API with correct payload
- Maps OSV response to Finding with correct severity
- Returns empty when diff has no package.json changes
- Handles OSV API 429 with retry
- Handles OSV API 500 gracefully (empty findings, warning log)
- Respects rate limiter (skips deps when bucket empty)
- Handles malformed package.json diff lines
- Metadata keys (`name`, `version`, `description`) are not treated as dependencies

### Step 7: composite-scanner.ts + tests (depends on 4, 5, 6)

Tests (mock all sub-scanners):
- Runs all enabled scanners in parallel
- Aggregates findings from all scanners
- Skips disabled scanners
- One scanner failure does not block others (Promise.allSettled)
- Failed scanner produces warning log
- Findings sorted by severity (critical first)
- Empty diff returns empty findings

### Step 8: index.ts + review-gate.ts integration + tests

Tests:
- `createSecurityScanner(config)` returns CompositeScanner with correct sub-scanners
- Disabling a scanner in config excludes it
- `createPatternSecurityScanner()` in review-gate.ts still works (backward compat)
- ReviewGate uses enhanced scanner when configured

### Quality Gates

- All existing `tests/review/review-gate.test.ts` tests pass (zero regressions)
- 100% branch coverage on new modules
- `npm run build` succeeds
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] CompositeSecurityScanner implements SecurityScanner interface exactly
- [ ] PatternScanner produces identical results to original createPatternSecurityScanner
- [ ] ASTScanner detects all 4 injection categories (SQL, XSS, command, path traversal)
- [ ] DependencyScanner queries OSV API and maps responses correctly
- [ ] Rate limiter prevents API abuse (max 10/min default)
- [ ] Language detection covers .ts, .tsx, .js, .jsx, .py
- [ ] All scanners handle empty diff input
- [ ] All scanners handle malformed diff input without throwing
- [ ] Configuration enables/disables individual scanners
- [ ] Backward compatibility: existing createPatternSecurityScanner unchanged
- [ ] All existing review-gate tests pass

### Deployment Steps

1. Merge `src/review/security/` module with all sub-scanners.
2. Update `review-gate.ts` to delegate to PatternScanner internally.
3. Set `ENHANCED_SECURITY_SCANNING=false` initially (opt-in).
4. Run full test suite: `npm test`.
5. Enable in staging: `ENHANCED_SECURITY_SCANNING=true`.
6. Monitor: check structured logs for scanner findings, OSV API latency, rate limiter drops.
7. Enable in production after 1 week of staging validation.

### Rollback Plan

1. Set `ENHANCED_SECURITY_SCANNING=false` -- immediately reverts to original PatternScanner behavior.
2. No data migration needed -- scanners are stateless.
3. If PatternScanner migration itself causes issues, revert the `review-gate.ts` change to restore inline implementation.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/review/security/index.ts` | NEW |
| `src/review/security/composite-scanner.ts` | NEW |
| `src/review/security/pattern-scanner.ts` | NEW |
| `src/review/security/ast-scanner.ts` | NEW |
| `src/review/security/dependency-scanner.ts` | NEW |
| `src/review/security/injection-patterns.ts` | NEW |
| `src/review/security/diff-parser.ts` | NEW |
| `src/review/security/rate-limiter.ts` | NEW |
| `src/review/security/types.ts` | NEW |
| `src/review/review-gate.ts` | MODIFIED |
| `src/index.ts` | MODIFIED |
| `tests/review/security/composite-scanner.test.ts` | NEW |
| `tests/review/security/pattern-scanner.test.ts` | NEW |
| `tests/review/security/ast-scanner.test.ts` | NEW |
| `tests/review/security/dependency-scanner.test.ts` | NEW |
| `tests/review/security/diff-parser.test.ts` | NEW |
| `tests/review/security/rate-limiter.test.ts` | NEW |
| `tests/review/security/injection-patterns.test.ts` | NEW |
| `tests/review/review-gate.test.ts` | MODIFIED |
