/**
 * Post-Compact Cleanup (FR-P10-005)
 *
 * Prunes per-session caches and resets summarization anchors after a
 * successful compaction (auto or reactive). Mirrors CC's
 * `postCompactCleanup.ts` but scoped to the data the orch-agents
 * harness actually maintains.
 *
 * State is held in module-level Maps keyed by sessionId so that the
 * query loop can call cleanup without owning the cache lifecycle.
 */

export type QuerySource = 'main' | 'subagent';

export interface SessionCompactState {
  /** Set when an autoCompact / reactiveCompact has just completed.
   *  The next API call should propagate the boundary flag downstream. */
  postCompactionPending: boolean;
  /** UUID of the last message that was already summarized — anchors
   *  the next compaction so we don't re-summarize old turns. */
  lastSummarizedMessageId: string | undefined;
  /** Microcompact (per-tool-result snip) bookkeeping. */
  microcompactSnippedIds: Set<string>;
  /** File state cache pruned only on the main thread. */
  fileStateCacheKeys: Set<string>;
  /** Memory file cache pruned only on the main thread. */
  memoryFileCacheKeys: Set<string>;
}

const SESSION_STATE = new Map<string, SessionCompactState>();

function getOrCreate(sessionId: string): SessionCompactState {
  let state = SESSION_STATE.get(sessionId);
  if (!state) {
    state = {
      postCompactionPending: false,
      lastSummarizedMessageId: undefined,
      microcompactSnippedIds: new Set(),
      fileStateCacheKeys: new Set(),
      memoryFileCacheKeys: new Set(),
    };
    SESSION_STATE.set(sessionId, state);
  }
  return state;
}

/** Read-only accessor — used by tests and the warning hook. */
export function getSessionCompactState(
  sessionId: string,
): Readonly<SessionCompactState> {
  return getOrCreate(sessionId);
}

/** Forcibly drop a session — used by long-session test teardown. */
export function dropSessionCompactState(sessionId: string): void {
  SESSION_STATE.delete(sessionId);
}

/**
 * Mark that a compaction just happened. The next API call carries
 * the post-compaction flag (FR-P10-005 — markPostCompaction).
 */
export function markPostCompaction(sessionId: string): void {
  const state = getOrCreate(sessionId);
  state.postCompactionPending = true;
}

/** Consume the pending flag — returns true once, then resets. */
export function consumePostCompactionFlag(sessionId: string): boolean {
  const state = getOrCreate(sessionId);
  const wasPending = state.postCompactionPending;
  state.postCompactionPending = false;
  return wasPending;
}

/** Track a microcompact snip so the next pass doesn't re-snip it. */
export function recordMicrocompactSnip(
  sessionId: string,
  messageId: string,
): void {
  getOrCreate(sessionId).microcompactSnippedIds.add(messageId);
}

export function isAlreadySnipped(
  sessionId: string,
  messageId: string,
): boolean {
  return getOrCreate(sessionId).microcompactSnippedIds.has(messageId);
}

/** Track a file-state cache key (test seam — real cache lives elsewhere). */
export function trackFileStateKey(sessionId: string, key: string): void {
  getOrCreate(sessionId).fileStateCacheKeys.add(key);
}

export function trackMemoryFileKey(sessionId: string, key: string): void {
  getOrCreate(sessionId).memoryFileCacheKeys.add(key);
}

/**
 * Run all post-compaction cleanup for a session. Subagent compactions
 * skip the main-thread caches per CC's grouping rules.
 */
export interface PostCompactCleanupResult {
  readonly microcompactReset: boolean;
  readonly fileCacheCleared: boolean;
  readonly memoryFileCacheCleared: boolean;
  readonly anchorReset: boolean;
  readonly markedPostCompaction: boolean;
}

export function runPostCompactCleanup(
  sessionId: string,
  querySource: QuerySource,
  newAnchorMessageId: string | undefined,
): PostCompactCleanupResult {
  const state = getOrCreate(sessionId);

  // Microcompact reset always runs (per-message bookkeeping).
  state.microcompactSnippedIds.clear();

  // Main-thread-only resets.
  let fileCleared = false;
  let memCleared = false;
  if (querySource === 'main') {
    state.fileStateCacheKeys.clear();
    state.memoryFileCacheKeys.clear();
    fileCleared = true;
    memCleared = true;
  }

  // Anchor reset — the new boundary becomes the next anchor.
  state.lastSummarizedMessageId = newAnchorMessageId;

  // Mark the next API call to carry the post-compaction flag.
  state.postCompactionPending = true;

  return Object.freeze({
    microcompactReset: true,
    fileCacheCleared: fileCleared,
    memoryFileCacheCleared: memCleared,
    anchorReset: true,
    markedPostCompaction: true,
  });
}
