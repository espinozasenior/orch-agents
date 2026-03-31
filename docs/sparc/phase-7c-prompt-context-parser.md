# Phase 7C: promptContext Parser

## Goal
Parse Linear's `promptContext` XML payload from `AgentSessionEvent` webhooks into a typed structure that feeds into the workflow prompt template, replacing the current issue-metadata-only approach with richer context including comment threads and team guidance rules.

## Specification

### Problem Statement
When Linear sends an `AgentSessionEvent` with action `created`, it includes a `promptContext` field — a rich XML string containing issue details, comment threads (primary directive and others), and guidance rules (workspace/team/parent-team level instructions). The current webhook handler only processes flat JSON Issue payloads. The `promptContext` XML has a known, constrained schema that must be parsed to extract structured data for prompt rendering.

### Functional Requirements
- FR-7C.01: Parse `<issue>` element — extract identifier, title, description, team, labels, parent issue
- FR-7C.02: Parse `<primary-directive-thread>` — extract the comment that triggered the session
- FR-7C.03: Parse `<other-thread>` elements — extract additional context threads
- FR-7C.04: Parse `<guidance>` element — extract `<guidance-rule>` entries with origin and team-name
- FR-7C.05: Return a typed `PromptContext` interface
- FR-7C.06: Graceful fallback on malformed XML — return partial data, log warning, never throw
- FR-7C.07: Parse `<project>` element for project context

### Non-Functional Requirements
- No external XML parser dependency — use regex/string parsing for the known schema
- Parsing must be deterministic and O(n) in input length
- Sanitize all extracted text to prevent prompt injection

### Acceptance Criteria
- Valid promptContext with all fields parses to a complete `PromptContext` object
- Minimal promptContext (just issue, no guidance) parses with empty optional fields
- Malformed XML returns partial data with `parseErrors` array populated
- Empty/null input returns a default empty `PromptContext`
- Guidance rules are extracted with correct origin (workspace/team/parent-team)
- Comment threads are ordered by `created-at` timestamp

## Pseudocode

```text
TYPE PromptContext = {
  issue: {
    identifier: string
    title: string
    description: string
    team: string
    labels: string[]
    parentIssue?: { identifier: string; title: string; description: string }
    project?: { name: string; description: string }
  }
  primaryDirective: {
    commentId: string
    author: string
    body: string
    createdAt: string
    mentionedUserId?: string
  } | null
  otherThreads: Array<{
    commentId: string
    comments: Array<{ author: string; body: string; createdAt: string }>
  }>
  guidance: Array<{
    origin: 'workspace' | 'team' | 'parent-team'
    teamName?: string
    content: string
  }>
  parseErrors: string[]
}

FUNCTION parsePromptContext(xml: string | null): PromptContext
  IF xml is null or empty:
    RETURN defaultEmptyContext()

  result = defaultEmptyContext()

  TRY extract <issue identifier="..." > block:
    result.issue.identifier = attribute 'identifier'
    result.issue.title = inner <title> text
    result.issue.description = inner <description> text
    result.issue.team = inner <team name="..."> attribute
    result.issue.labels = all inner <label> texts
    IF <parent-issue> exists:
      result.issue.parentIssue = parse same fields
    IF <project> exists:
      result.issue.project = { name, description }
  CATCH: push to parseErrors

  TRY extract <primary-directive-thread comment-id="...">:
    result.primaryDirective = {
      commentId: attribute 'comment-id'
      author: first <comment author="..."> attribute
      body: sanitize(inner text of first <comment>)
      createdAt: attribute 'created-at'
      mentionedUserId: <user id="..."> attribute if present
    }
  CATCH: push to parseErrors

  TRY extract all <other-thread comment-id="..."> blocks:
    FOR EACH thread:
      comments = parse all <comment> children
      result.otherThreads.push({ commentId, comments })
  CATCH: push to parseErrors

  TRY extract <guidance> block:
    FOR EACH <guidance-rule origin="..." team-name="...">:
      result.guidance.push({ origin, teamName, content: inner text })
  CATCH: push to parseErrors

  RETURN result
```

## Architecture

### Primary Components
- `src/integration/linear/prompt-context-parser.ts` (NEW) — Standalone pure-function parser
- `src/integration/linear/linear-webhook-handler.ts` — Calls parser on AgentSessionEvent payloads
- `src/integration/linear/workflow-prompt.ts` — Consumes `PromptContext` to enrich template variables

### Design Decisions
- Pure function, no dependencies — easy to test, no side effects
- Regex-based extraction, not DOM parsing — the XML schema is constrained and well-known
- Partial parse on error — never throw, always return what was extracted, collect errors in `parseErrors`
- Sanitize all extracted text via the existing `sanitize()` from `input-sanitizer.ts`

## Refinement

### File Targets
- `src/integration/linear/prompt-context-parser.ts` (NEW)
- `src/integration/linear/linear-webhook-handler.ts`
- `src/integration/linear/workflow-prompt.ts`

### Exact Tests
- `tests/integration/linear/prompt-context-parser.test.ts`
  - Parse complete promptContext with all fields
  - Parse minimal promptContext (issue only)
  - Parse promptContext with multiple labels
  - Parse promptContext with parent issue
  - Parse promptContext with multiple other-threads
  - Parse promptContext with guidance rules from different origins
  - Graceful handling of malformed XML (partial result + parseErrors)
  - Null/empty input returns default empty context
  - HTML entities in text are decoded correctly

### Risks
- Linear may change the promptContext XML schema — keep the parser tolerant of unknown elements
- Regex-based parsing can be fragile for nested structures — keep patterns simple, test thoroughly
- Large promptContext payloads (many threads) could slow parsing — bound the extraction (first 20 threads)
