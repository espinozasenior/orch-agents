# Phase 9H: LLM Auto-Approval for Tool Permissions

## Goal
Implement LLM-classified auto-approval for tool permissions in autonomous mode. Instead of blanket allow/deny, an AI classifier makes contextual approval decisions based on configurable rule categories. Rules follow per-section REPLACE semantics, a self-critique system validates rule quality, and every decision is audit-logged with the matched rule and confidence score.

## Specification

### Problem Statement
Autonomous agent execution requires a permission model for tool calls. The current system either blocks all dangerous operations (requiring human approval for every file write, bash command, and git operation) or allows everything (no safety net). Neither extreme works: blanket blocking destroys throughput, blanket allowing risks destructive operations. The Claude Code CLI solves this with a `yoloClassifier` -- an AI-based classifier that evaluates each tool call against configurable rules organized into `allow`, `soft_deny`, and `environment` categories. The classifier receives the tool call context plus the rules and returns an approve/deny/escalate decision. A separate `sideQuery()` mechanism critiques user-defined rules for clarity, conflicts, and gaps. Adopting this pattern gives autonomous agents intelligent, auditable permission decisions.

### Functional Requirements
- FR-9H.01: `AutoApprovalClassifier` class -- receives tool call context (tool name, parameters, conversation history summary), returns a decision: `approve`, `deny`, or `escalate`
- FR-9H.02: Three rule categories: `allow` (auto-approve matching calls), `soft_deny` (require confirmation or escalation), `environment` (contextual information for the classifier, not rules themselves)
- FR-9H.03: Per-section REPLACE semantics -- when a user provides a non-empty `allow` section, it replaces the default `allow` rules entirely; empty sections retain defaults
- FR-9H.04: `sideQuery()` for self-critique of user rules -- a separate LLM call that analyzes user-provided rules for clarity, contradictions, coverage gaps, and returns structured feedback
- FR-9H.05: Default rules for common patterns: file read (allow), file write to project dir (allow), file write outside project (soft_deny), bash non-destructive (allow), bash destructive (soft_deny), git commit (allow), git push (soft_deny), git force-push (soft_deny)
- FR-9H.06: Rule syntax: glob patterns for file paths (`src/**/*.ts`), regex for command patterns (`^rm\s+-rf`), tool name exact match (`Write`), tool name wildcard (`mcp__*`)
- FR-9H.07: Escalation path: classifier returns `escalate` -> user prompt with 60s timeout -> no response -> deny
- FR-9H.08: Audit log: every approval decision logged with `{ toolName, decision, matchedRule, confidence, timestamp, requestId }`
- FR-9H.09: Permission protocol: `sendPermissionRequest(toolCall)` returns `Promise<Decision>` resolved by matching `control_response` keyed by `requestId`
- FR-9H.10: `resolvedToolUseIds` dedup set capped at 1000 entries -- prevents duplicate processing of the same tool call; oldest entries evicted when cap reached

### Non-Functional Requirements
- Classification latency must be under 500ms (p95) for rule-matched decisions (no LLM call needed)
- Classification latency must be under 2s (p95) for LLM-classified decisions (ambiguous cases)
- Audit log writes must not block the tool execution path (async append)
- Rule evaluation must be deterministic for the same tool call and rule set
- Memory overhead of the dedup set must not exceed 200KB at cap (1000 entries)

### Acceptance Criteria
- Tool call `Read("src/index.ts")` is auto-approved by default allow rule without LLM call
- Tool call `Bash("rm -rf /")` is denied by default soft_deny regex pattern
- Tool call `Write("../outside-project/file.ts")` is soft_denied for path outside project
- User replaces `allow` section with custom rules; default allow rules no longer apply
- User leaves `soft_deny` section empty; default soft_deny rules remain active
- `sideQuery()` identifies contradiction when user allows and soft_denies the same pattern
- Escalated decision prompts user and resolves within 60s timeout
- Escalated decision with no user response within 60s defaults to deny
- Audit log contains entry for every decision with all required fields
- Duplicate tool call ID is skipped without re-classification
- Dedup set evicts oldest entry when 1001st entry is added

## Pseudocode

```text
TYPE Decision = "approve" | "deny" | "escalate"

TYPE ApprovalRule = {
  pattern: string              // glob, regex, or exact match
  patternType: "glob" | "regex" | "exact"
  target: "toolName" | "filePath" | "command"
  description?: string
}

TYPE RuleSet = {
  allow: ApprovalRule[]
  soft_deny: ApprovalRule[]
  environment: string[]        // context strings, not matchable rules
}

TYPE ApprovalDecision = {
  decision: Decision
  matchedRule?: ApprovalRule
  confidence: number           // 0.0 - 1.0
  requestId: string
  timestamp: number
}

TYPE ToolCallContext = {
  toolName: string
  parameters: Record<string, unknown>
  conversationSummary?: string
  toolUseId: string
}

CONST DEFAULT_RULES: RuleSet = {
  allow: [
    { pattern: "Read", patternType: "exact", target: "toolName" },
    { pattern: "Glob", patternType: "exact", target: "toolName" },
    { pattern: "Grep", patternType: "exact", target: "toolName" },
    { pattern: "src/**", patternType: "glob", target: "filePath",
      description: "Allow writes within project src" },
    { pattern: "tests/**", patternType: "glob", target: "filePath" },
  ],
  soft_deny: [
    { pattern: "^rm\\s+-rf", patternType: "regex", target: "command" },
    { pattern: "^git\\s+push", patternType: "regex", target: "command" },
    { pattern: "../**", patternType: "glob", target: "filePath",
      description: "Writes outside project directory" },
    { pattern: "^git\\s+push\\s+--force", patternType: "regex",
      target: "command", description: "Force push" },
  ],
  environment: [
    "Project root: {projectRoot}",
    "Current branch: {branch}",
    "Autonomous mode enabled"
  ]
}

CLASS RuleEngine:
  rules: RuleSet

  FUNCTION mergeWithDefaults(userRules: Partial<RuleSet>):
    // Per-section REPLACE semantics
    merged = { ...DEFAULT_RULES }
    IF userRules.allow AND userRules.allow.length > 0:
      merged.allow = userRules.allow        // replace entirely
    IF userRules.soft_deny AND userRules.soft_deny.length > 0:
      merged.soft_deny = userRules.soft_deny
    IF userRules.environment AND userRules.environment.length > 0:
      merged.environment = userRules.environment
    RETURN merged

  FUNCTION match(context: ToolCallContext): { rule?: ApprovalRule, category?: string }
    // Check allow rules first
    FOR EACH rule IN rules.allow:
      IF matchesPattern(rule, context):
        RETURN { rule, category: "allow" }

    // Check soft_deny rules
    FOR EACH rule IN rules.soft_deny:
      IF matchesPattern(rule, context):
        RETURN { rule, category: "soft_deny" }

    RETURN { rule: undefined, category: undefined }

  FUNCTION matchesPattern(rule: ApprovalRule, context: ToolCallContext): boolean
    value = extractTarget(rule.target, context)
    IF value IS null: RETURN false

    SWITCH rule.patternType:
      CASE "exact":   RETURN value == rule.pattern
      CASE "glob":    RETURN minimatch(value, rule.pattern)
      CASE "regex":   RETURN new RegExp(rule.pattern).test(value)

  FUNCTION extractTarget(target, context):
    SWITCH target:
      CASE "toolName":  RETURN context.toolName
      CASE "filePath":  RETURN context.parameters.file_path OR context.parameters.path
      CASE "command":   RETURN context.parameters.command

CLASS AutoApprovalClassifier:
  ruleEngine: RuleEngine
  llmClient: LLMClient
  auditLog: AuditLog
  resolvedIds: BoundedSet<string>   // cap 1000
  pendingEscalations: Map<string, { resolve, timer }>

  ASYNC FUNCTION classify(context: ToolCallContext): ApprovalDecision
    // 1. Dedup check
    IF resolvedIds.has(context.toolUseId):
      RETURN previousDecision(context.toolUseId)

    // 2. Rule matching (fast path, no LLM)
    { rule, category } = ruleEngine.match(context)

    IF category == "allow":
      decision = { decision: "approve", matchedRule: rule,
                   confidence: 1.0, requestId: uuid(), timestamp: now() }

    ELSE IF category == "soft_deny":
      decision = { decision: "escalate", matchedRule: rule,
                   confidence: 0.8, requestId: uuid(), timestamp: now() }

    ELSE:
      // 3. Ambiguous -- use LLM classifier
      decision = AWAIT classifyWithLLM(context)

    // 4. Handle escalation
    IF decision.decision == "escalate":
      decision = AWAIT escalateToUser(decision)

    // 5. Record and audit
    resolvedIds.add(context.toolUseId)
    auditLog.append(decision)

    RETURN decision

  ASYNC FUNCTION classifyWithLLM(context: ToolCallContext): ApprovalDecision
    prompt = buildClassifierPrompt(context, ruleEngine.rules.environment)
    response = AWAIT llmClient.complete(prompt, { maxTokens: 50 })
    parsed = parseClassifierResponse(response)
    RETURN {
      decision: parsed.decision,
      confidence: parsed.confidence,
      requestId: uuid(),
      timestamp: now()
    }

  ASYNC FUNCTION escalateToUser(decision: ApprovalDecision): ApprovalDecision
    requestId = decision.requestId
    promise = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ ...decision, decision: "deny", confidence: 1.0 })
      }, 60_000)
      pendingEscalations.set(requestId, { resolve, timer })
    })
    sendPermissionRequest(requestId, decision)
    RETURN AWAIT promise

  FUNCTION handleControlResponse(requestId, userDecision):
    IF pendingEscalations.has(requestId):
      { resolve, timer } = pendingEscalations.get(requestId)
      clearTimeout(timer)
      resolve({ decision: userDecision, confidence: 1.0,
                requestId, timestamp: now() })
      pendingEscalations.delete(requestId)

CLASS BoundedSet<T>:
  maxSize: number
  items: T[] = []
  index: Set<T> = new Set()

  FUNCTION add(item: T):
    IF index.has(item): RETURN
    IF items.length >= maxSize:
      evicted = items.shift()
      index.delete(evicted)
    items.push(item)
    index.add(item)

  FUNCTION has(item: T): boolean
    RETURN index.has(item)

ASYNC FUNCTION sideQueryCritique(userRules: RuleSet, llmClient): CritiqueResult
  prompt = buildCritiquePrompt(userRules)
  response = AWAIT llmClient.complete(prompt, { maxTokens: 500 })
  RETURN {
    clarity: response.clarityIssues,       // unclear rule descriptions
    conflicts: response.conflicts,          // allow + soft_deny same pattern
    gaps: response.coverageGaps,           // common patterns not covered
    suggestions: response.suggestions      // recommended rule additions
  }
```

### Complexity Analysis
- **Rule matching**: O(a + s) where a = allow rules count, s = soft_deny rules count (linear scan)
- **Glob matching**: O(p) where p = pattern length (per rule, via minimatch)
- **Regex matching**: O(v) where v = value length (per rule, compiled regex)
- **LLM classification**: O(1) from algorithm perspective; latency dominated by LLM round-trip
- **Dedup set add**: O(1) amortized; eviction is O(1) with array shift
- **Dedup set lookup**: O(1) via Set.has()
- **Audit log append**: O(1) async file append
- **sideQuery critique**: O(1) algorithmic; single LLM call

## Architecture

### Primary Components
- `src/permissions/auto-approval-classifier.ts` (NEW) -- Core classifier with rule matching, LLM fallback, and escalation
- `src/permissions/rule-engine.ts` (NEW) -- Rule parsing, merging, and pattern matching
- `src/permissions/audit-log.ts` (NEW) -- Append-only audit log for all approval decisions
- `src/permissions/side-query.ts` (NEW) -- Self-critique of user rules via separate LLM call
- `src/permissions/permission-protocol.ts` (NEW) -- Request/response protocol for escalation
- `src/permissions/bounded-set.ts` (NEW) -- Capped dedup set with FIFO eviction
- `src/permissions/types.ts` (NEW) -- Shared types: Decision, ApprovalRule, RuleSet, ToolCallContext
- `src/execution/agent/agent-runner.ts` (MODIFY) -- Integrate classifier before tool execution
- `src/config/settings.ts` (MODIFY) -- Add `autoMode.{allow, soft_deny, environment}` config

### Classifier Pipeline
```
Tool call arrives (e.g., Bash("git push origin main"))
  │
  ▼
BoundedSet.has(toolUseId)?
  ├─ YES → return cached decision (skip)
  │
  └─ NO
      │
      ▼
  RuleEngine.match(context)
  ┌─────────────────────────────────────┐
  │  allow rules      → approve (1.0)  │  ← fast path, no LLM
  │  soft_deny rules  → escalate (0.8) │  ← needs confirmation
  │  no match         → LLM classify   │  ← ambiguous
  └─────────────────────────────────────┘
      │           │            │
      ▼           ▼            ▼
   approve    escalate     LLM call
                 │            │
                 ▼            ▼
           ┌──────────┐   parse response
           │ User     │   → approve/deny/escalate
           │ prompt   │      │
           │ (60s)    │      │
           └──────────┘      │
                │            │
                ▼            ▼
           timeout?     ┌──────────┐
           → deny       │ Decision │
                        └──────────┘
                             │
                             ▼
                      ┌──────────────┐
                      │  Audit Log   │  ← every decision logged
                      │  BoundedSet  │  ← dedup recorded
                      └──────────────┘
```

### Integration with Phase 9A (Agent Runner)
The `AgentRunner` loop intercepts tool calls before execution. For each tool call, it invokes `classifier.classify(context)`. If approved, execution proceeds. If denied, the tool call is rejected with an error message to the LLM. If escalated and then denied, same rejection. This happens inside the `executeTask()` method, before the actual tool runs.

### Integration with Phase 9B (Session Runner)
The `SessionRunner` manages the control_request/control_response protocol for escalation. When the classifier escalates, `sendPermissionRequest()` writes a control_request to the session's output stream. The SessionRunner routes user responses back as control_response messages, which `handleControlResponse()` resolves.

### Design Decisions
- **Rule-first, LLM-second** -- deterministic rule matching handles the common cases (file reads, project writes) without LLM latency. The LLM classifier is only invoked for ambiguous cases not covered by rules. This keeps p95 latency under 500ms for most decisions.
- **Per-section REPLACE, not MERGE** -- merging user rules with defaults creates confusion about precedence. REPLACE semantics are simpler: if you provide allow rules, you own all allow rules. This matches the Claude Code CLI behavior.
- **sideQuery as separate LLM call** -- rule critique cannot be part of the main conversation because it would pollute context. A separate `sideQuery()` call analyzes rules in isolation and returns structured feedback.
- **BoundedSet over unbounded Set** -- long-running sessions could accumulate thousands of tool use IDs. The bounded set with FIFO eviction caps memory at 1000 entries (~200KB). Old entries evicted are unlikely to be re-encountered.
- **60s escalation timeout** -- balances responsiveness (agent does not hang indefinitely) with user reaction time. Timeout defaults to deny for safety.

## Refinement

### File Targets
- `src/permissions/auto-approval-classifier.ts` (NEW)
- `src/permissions/rule-engine.ts` (NEW)
- `src/permissions/audit-log.ts` (NEW)
- `src/permissions/side-query.ts` (NEW)
- `src/permissions/permission-protocol.ts` (NEW)
- `src/permissions/bounded-set.ts` (NEW)
- `src/permissions/types.ts` (NEW)
- `src/execution/agent/agent-runner.ts` (MODIFY)
- `src/config/settings.ts` (MODIFY)

### Exact Tests
- `tests/permissions/rule-engine.test.ts` (NEW)
  - Exact match rule matches tool name
  - Glob pattern matches file path within project
  - Glob pattern rejects file path outside project
  - Regex pattern matches destructive bash command
  - Regex pattern does not match safe bash command
  - mergeWithDefaults replaces non-empty user allow section
  - mergeWithDefaults retains default allow when user section is empty
  - mergeWithDefaults replaces non-empty user soft_deny section
  - extractTarget returns file_path from Write tool parameters
  - extractTarget returns command from Bash tool parameters
  - extractTarget returns null when target field is missing
- `tests/permissions/auto-approval-classifier.test.ts` (NEW)
  - classify() approves Read tool via default allow rule
  - classify() escalates git push via default soft_deny rule
  - classify() calls LLM for unmatched tool call
  - classify() skips duplicate toolUseId without re-classifying
  - classify() denies on escalation timeout (60s)
  - classify() approves on user response to escalation
  - handleControlResponse resolves pending escalation promise
  - handleControlResponse clears timeout on user response
  - Audit log entry written for every decision
- `tests/permissions/bounded-set.test.ts` (NEW)
  - add() inserts item and has() returns true
  - add() duplicate item is no-op
  - add() evicts oldest when cap reached
  - has() returns false for evicted item
  - Set stays at maxSize after many additions
- `tests/permissions/side-query.test.ts` (NEW)
  - Detects contradiction between allow and soft_deny for same pattern
  - Identifies unclear rule with missing description
  - Suggests rules for common uncovered patterns
  - Returns empty issues for well-formed rule set
- `tests/permissions/audit-log.test.ts` (NEW)
  - append() writes decision with all required fields
  - Log entries are ordered by timestamp
  - Async append does not block caller

### Performance Targets
| Metric | Target | Method |
|--------|--------|--------|
| Rule-matched decision latency (p95) | <500ms | Timer around `classify()` for rule-hit cases |
| LLM-classified decision latency (p95) | <2000ms | Timer around `classify()` for LLM-fallback cases |
| sideQuery critique latency | <5000ms | Timer around `sideQueryCritique()` |
| Audit log write latency | <5ms | Timer around `auditLog.append()` |
| BoundedSet memory at cap (1000) | <200KB | `sizeof` estimate: 1000 UUIDs at ~180 bytes each |
| Classification accuracy | >95% | Manual review of 100 random audit log entries |

### Mock Boundaries
- **LLM client (sideQuery)**: Mock `llmClient.complete()` to return controlled classification responses — tests classifier logic and critique without real LLM calls
- **Clock/timers**: Mock `setTimeout`/`clearTimeout` and `Date.now()` for deterministic escalation timeout testing and audit log timestamp verification

### Risks
- **LLM classifier hallucination** -- the classifier might approve a dangerous operation or deny a safe one. Mitigation: rule-based matching handles known patterns deterministically; LLM is only consulted for edge cases. Audit log enables post-hoc review.
- **Escalation timeout UX** -- 60s may be too short for async workflows (user away from desk). Mitigation: configurable timeout; log the timeout-deny so users can adjust rules to avoid future escalations.
- **Rule conflict resolution** -- if a tool call matches both an allow rule and a soft_deny rule, the system must have deterministic precedence. Mitigation: allow rules are checked first; first match wins. Document this precedence clearly.
- **sideQuery cost** -- each critique is a full LLM call. Mitigation: only run sideQuery when user rules change (not per-tool-call); cache the critique result until rules are modified.
- **Dedup set false negatives after eviction** -- if a tool call ID is evicted and then re-encountered, it will be re-classified. Mitigation: at 1000 cap with typical agent session sizes, eviction of still-relevant IDs is unlikely. If it occurs, re-classification is safe (idempotent decision).
