# SPARC Specification: Break Agent Feedback Loop

## Problem

When an agent pushes a commit to the PR branch, GitHub fires `push` and
`pull_request.synchronize` webhooks. The server treats these as new work items,
spawning fresh agents. Those agents may push commits, restarting the cycle.

**Observed behavior** (2026-03-28): A single Linear webhook triggered 15+ work
items across ~22 minutes, spawning agents that cascaded into further webhook
events. The loop only stops when agents produce no changes or hit the 15-minute
timeout.

**Root cause**: Two gaps in the webhook filter:

1. `push` events on non-default branches fall through to the default template
   (`quick-fix`) instead of being ignored.
2. `pull_request.synchronize` events triggered by agent commits are
   indistinguishable from human pushes.

## Solution: Commit Marker + Push Filter

### Fix 1: Skip `push` on non-default branches

**Where**: `src/intake/github-workflow-normalizer.ts`, `normalizeGitHubEventFromWorkflow()`

WORKFLOW.md only defines `push.default_branch: cicd-pipeline`. A `push` to any
other branch should match no rule and return `null` (skip), but the normalizer
falls through to `agents.defaultTemplate` (line 287).

**Change**: After `matchGitHubEventRule()` returns `null`, check if the event is a
`push` to a non-default branch. If so, return `null` instead of falling through.

```
if template === null AND parsed.eventType === 'push'
  AND parsed.branch !== parsed.defaultBranch:
    return null   // No matching rule, not default branch → skip
```

This eliminates half the cascade (the `push` webhook). Only
`pull_request.synchronize` remains.

### Fix 2: Commit marker for `pull_request.synchronize`

**Concept**: The `artifact-applier.ts` creates all agent commits. Tag them with a
marker trailer so the normalizer can detect agent-originated pushes.

**Marker**: `Automated-By: orch-agents` as a git trailer in the commit message.

**Where the marker is added**: `src/execution/workspace/artifact-applier.ts`

The `apply()` method builds the commit message at:
```ts
commitMessage: `${agent.role}: ${agent.type} work on ${plan.workItemId}`
```

Append the trailer:
```
${commitMessage}\n\nAutomated-By: orch-agents
```

**Where the marker is checked**: `src/intake/github-workflow-normalizer.ts`

For `pull_request.synchronize` events, GitHub includes the HEAD commit SHA in the
payload (`pull_request.head.sha`). The normalizer cannot read git history, but the
`push` event payload includes the `head_commit.message` field.

For `pull_request` events, the HEAD commit message is NOT in the payload. Two
options:

**Option A — Check in webhook-router (preferred)**:

The `push` payload includes `head_commit.message`. For `pull_request.synchronize`,
the payload includes `after` (the new HEAD SHA) but not the commit message.

Since `push` and `pull_request.synchronize` fire together for the same git push,
and Fix 1 already skips the `push` event for non-default branches, the
`synchronize` event is what needs the marker check.

Add `headCommitMessage` to `ParsedGitHubEvent` (extracted from `push` payloads'
`head_commit.message` field, and from `pull_request` payloads by fetching the
commit via `gh api`).

Actually simpler: the `push` payload's `head_commit.message` is available. But we
need it on the `pull_request.synchronize` event.

**Option B — Check in webhook-router before normalizing (simplest)**:

In `webhook-router.ts`, after parsing the event, before normalizing:

```ts
// For pull_request.synchronize, check if the after-SHA commit
// was made by an agent by looking at the push event that
// always accompanies it. Use the event buffer to correlate.
```

This is complex. Simpler approach:

**Option C — Track pushed SHAs in-process (chosen)**:

The `simple-executor.ts` already has `applyResult.commitSha` after a successful
agent commit. Before pushing, record the SHA in a module-level `Set<string>`.

In the normalizer, for `pull_request.synchronize` events, check if
`parsed.rawPayload.after` (the new HEAD SHA) is in the tracked set.

```
Module: src/shared/agent-commit-tracker.ts (new)

  const agentSHAs = new Set<string>()

  export function trackAgentCommit(sha: string): void
  export function isAgentCommit(sha: string): boolean
  export function clearTrackedCommits(): void  // for testing
```

**Where SHAs are tracked**: `src/execution/simple-executor.ts`, after
`applyResult.commitSha` is available and before push:

```ts
if (applyResult.commitSha) {
  trackAgentCommit(applyResult.commitSha);
  lastCommitRef = applyResult.commitSha;
}
```

**Where SHAs are checked**: `src/intake/github-workflow-normalizer.ts`,
at the top of `normalizeGitHubEventFromWorkflow()`:

```ts
if (parsed.eventType === 'pull_request' && parsed.action === 'synchronize') {
  const afterSha = (parsed.rawPayload as any).after;
  if (afterSha && isAgentCommit(afterSha)) {
    return null;  // Skip — this synchronize was triggered by our own push
  }
}
```

**For `push` events**: Also check `head_commit` SHA from the payload:

```ts
if (parsed.eventType === 'push') {
  const headCommit = (parsed.rawPayload as any).head_commit;
  if (headCommit?.id && isAgentCommit(headCommit.id)) {
    return null;  // Skip — this push was our own agent commit
  }
}
```

### Memory management

The SHA set grows unboundedly if not cleaned. Options:

- **TTL-based**: Delete entries older than 1 hour (agent commits are processed
  within seconds).
- **Size-based**: Cap at 1000 entries, evict oldest.
- **Simplest**: Use a `Map<string, number>` (sha → timestamp). On each
  `trackAgentCommit`, prune entries older than 1 hour.

For MVP, a simple TTL of 1 hour with pruning on insert is sufficient.

## Architecture

```
                     GitHub Webhook
                          │
                          ▼
                   webhook-router.ts
                          │
                          ▼
               github-workflow-normalizer.ts
                          │
              ┌───────────┼───────────┐
              │           │           │
          push event  synchronize   other
              │           │           │
              ▼           ▼           ▼
         is non-default  is agent   normal
         branch?         commit?    processing
              │           │
           yes│        yes│
              ▼           ▼
         return null  return null
         (skip)       (skip)
```

## Files Changed

| File | Change |
|------|--------|
| `src/shared/agent-commit-tracker.ts` | **NEW** — SHA tracking module |
| `src/intake/github-workflow-normalizer.ts` | Skip push on non-default branch; skip agent-originated synchronize |
| `src/execution/simple-executor.ts` | Track agent commit SHAs before push |
| `tests/intake/github-workflow-normalizer.test.ts` | Tests for both skip conditions |
| `tests/shared/agent-commit-tracker.test.ts` | **NEW** — Unit tests for tracker |
| `tests/execution/simple-executor.test.ts` | Verify SHA tracking call |

## Pseudocode

### agent-commit-tracker.ts

```
const tracked: Map<sha, timestamp> = new Map()
const TTL_MS = 3_600_000  // 1 hour

function trackAgentCommit(sha):
  prune entries where now - timestamp > TTL_MS
  tracked.set(sha, Date.now())

function isAgentCommit(sha):
  entry = tracked.get(sha)
  if not entry: return false
  if now - entry > TTL_MS: tracked.delete(sha); return false
  return true

function clearTrackedCommits():  // testing
  tracked.clear()
```

### normalizer changes

```
function normalizeGitHubEventFromWorkflow(parsed, config):
  // Existing bot loop prevention...

  // NEW: Skip agent-originated push events
  if parsed.eventType === 'push':
    headCommitId = parsed.rawPayload.head_commit?.id
    if headCommitId AND isAgentCommit(headCommitId):
      return null

  // NEW: Skip agent-originated synchronize events
  if parsed.eventType === 'pull_request' AND parsed.action === 'synchronize':
    afterSha = parsed.rawPayload.after
    if afterSha AND isAgentCommit(afterSha):
      return null

  // Existing rule matching...
  template = matchGitHubEventRule(parsed, githubEvents)

  // NEW: Push to non-default branch with no matching rule → skip
  if template === null AND parsed.eventType === 'push':
    if parsed.branch !== parsed.defaultBranch:
      return null

  // Rest unchanged (label fallback, default template fallback)...
```

### simple-executor changes

```
import { trackAgentCommit } from '../shared/agent-commit-tracker'

// After successful artifact apply, before push:
if applyResult.commitSha:
  trackAgentCommit(applyResult.commitSha)
  lastCommitRef = applyResult.commitSha
```

## Test Plan

### agent-commit-tracker.test.ts

1. `trackAgentCommit` + `isAgentCommit` returns true for tracked SHA
2. `isAgentCommit` returns false for unknown SHA
3. Entries expire after TTL
4. `clearTrackedCommits` resets state

### normalizer tests

5. `push` to non-default branch with no matching rule → returns null
6. `push` to default branch → still matches `cicd-pipeline` rule
7. `push` with agent commit SHA in `head_commit.id` → returns null
8. `pull_request.synchronize` with agent SHA in `after` → returns null
9. `pull_request.synchronize` with human SHA → processes normally
10. `pull_request.opened` (not synchronize) → unaffected by tracker

### simple-executor tests

11. Verify `trackAgentCommit` called with `applyResult.commitSha`

## Failure Modes

| Scenario | Behavior | Acceptable? |
|----------|----------|-------------|
| Server restart clears SHA set | Next agent push triggers one extra cycle, then stabilizes | Yes — bounded to 1 extra cycle |
| SHA collision | Astronomically unlikely (SHA-1) | Yes |
| Push from a different server instance | Not tracked — will process | Yes — cluster mode is out of scope |
| Agent commit with no push (push fails) | SHA tracked but never matched | Yes — TTL cleans up |

## Refinement Notes

- The `push.other` route in WORKFLOW.md (`push.other: quick-fix`) was removed in
  a previous commit, but the normalizer still falls through to defaultTemplate
  for non-matching pushes. Fix 1 addresses this.
- The commit marker approach (Option A in the analysis) is cleaner long-term but
  requires parsing commit messages from payloads that may not include them. The
  SHA tracking approach (Option C, chosen) is simpler and works with existing
  payload data.
- If orch-agents is later deployed as multiple instances, the SHA tracker would
  need to be backed by Redis/shared state. For single-instance, in-memory is fine.
