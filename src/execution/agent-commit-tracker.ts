/**
 * In-memory tracker for agent-originated commit SHAs.
 *
 * When agents push commits, the resulting GitHub webhooks (push,
 * pull_request.synchronize) would otherwise be treated as new work items,
 * creating a feedback loop. This module tracks which SHAs were produced
 * by agents so the normalizer can skip them.
 *
 * Uses a Map<sha, timestamp> with TTL-based expiry (1 hour).
 */

const TTL_MS = 3_600_000; // 1 hour

const tracked = new Map<string, number>();

/**
 * Prune entries older than TTL_MS from the tracked set.
 */
function prune(): void {
  const now = Date.now();
  for (const [sha, ts] of tracked) {
    if (now - ts > TTL_MS) {
      tracked.delete(sha);
    }
  }
}

/**
 * Record a commit SHA as agent-originated.
 * Prunes stale entries on each call.
 */
export function trackAgentCommit(sha: string): void {
  prune();
  tracked.set(sha, Date.now());
}

/**
 * Check whether a commit SHA was produced by an agent.
 * Returns false for unknown or expired SHAs.
 */
export function isAgentCommit(sha: string): boolean {
  const ts = tracked.get(sha);
  if (ts === undefined) return false;
  if (Date.now() - ts > TTL_MS) {
    tracked.delete(sha);
    return false;
  }
  return true;
}

/**
 * Clear all tracked commits. Intended for testing only.
 */
export function clearTrackedCommits(): void {
  tracked.clear();
}

// ---------------------------------------------------------------------------
// Agent-originated PR tracking
// ---------------------------------------------------------------------------

const trackedPRs = new Map<string, number>();

/**
 * Record a PR as agent-originated.
 * Key is "owner/repo#number" to avoid collisions across repos.
 */
export function trackAgentPR(repo: string, prNumber: number): void {
  const now = Date.now();
  // Prune stale PR entries
  for (const [key, ts] of trackedPRs) {
    if (now - ts > TTL_MS) trackedPRs.delete(key);
  }
  trackedPRs.set(`${repo}#${prNumber}`, now);
}

/**
 * Check whether a PR was created by an agent.
 */
export function isAgentPR(repo: string, prNumber: number): boolean {
  const key = `${repo}#${prNumber}`;
  const ts = trackedPRs.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > TTL_MS) {
    trackedPRs.delete(key);
    return false;
  }
  return true;
}

/**
 * Clear all tracked PRs. Intended for testing only.
 */
export function clearTrackedPRs(): void {
  trackedPRs.clear();
}
