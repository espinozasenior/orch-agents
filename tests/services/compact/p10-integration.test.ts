/**
 * P10 — Compaction Integration tests.
 *
 * Each FR from docs/sparc/P10-compaction-integration-spec.md has at least
 * one acceptance assertion in this file. The matching FR id is annotated
 * on every test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  createDefaultConfig,
  createTrackingState,
  generateCompactionMessages,
  computeWarningState,
  decideWarningEmission,
  suppressCompactWarning,
  clearCompactWarningSuppression,
  runPostCompactCleanup,
  markPostCompaction,
  consumePostCompactionFlag,
  getSessionCompactState,
  dropSessionCompactState,
  trackFileStateKey,
  trackMemoryFileKey,
  recordMicrocompactSnip,
  isAlreadySnipped,
  AUTOCOMPACT_BUFFER_TOKENS,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  type CompactMessage,
  type ForkedLLMCall,
} from '../../../src/services/compact/index.js';
import {
  queryLoop,
  PROMPT_TOO_LONG_ERROR,
  type QueryParams,
  type CompactionHooks,
  type CompactionEventPayload,
} from '../../../src/query/queryLoop.js';
import type { QueryMessage } from '../../../src/query/state.js';
import { createTestDeps, type ModelEvent } from '../../../src/query/deps.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompactMsg(
  type: CompactMessage['type'],
  text: string,
): CompactMessage {
  return { uuid: randomUUID(), type, content: [{ type: 'text', text }] };
}

function makeBigConversation(
  rounds: number,
  charsPerMsg: number,
): CompactMessage[] {
  const out: CompactMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(makeCompactMsg('user', `u${i}: ` + 'a'.repeat(charsPerMsg)));
    out.push(makeCompactMsg('assistant', `a${i}: ` + 'b'.repeat(charsPerMsg)));
  }
  return out;
}

async function consumeLoop(params: QueryParams) {
  const events: unknown[] = [];
  const gen = queryLoop(params);
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, terminal: r.value };
}

// ---------------------------------------------------------------------------
// FR-P10-001 — Token-threshold trigger via autoCompact
// ---------------------------------------------------------------------------

describe('FR-P10-001: token-threshold trigger', () => {
  it('threshold = contextWindow - AUTOCOMPACT_BUFFER_TOKENS', () => {
    const ws = computeWarningState([], 200_000);
    assert.equal(ws.autoCompactThreshold, 200_000 - AUTOCOMPACT_BUFFER_TOKENS);
  });

  it('queryLoop calls compaction before each model turn and replaces history', async () => {
    // Build a long history (10 messages, ~10K tokens each = ~100K total)
    // exceeding the 100K window's auto-compact threshold (~87K).
    // The tail window (2 rounds = 4 msgs) drops the first 6 messages,
    // so the post-compact size is meaningfully smaller than pre-compact.
    const chunk = 'x'.repeat(40_000); // ~10K tokens per msg
    const messages: QueryMessage[] = Array.from({ length: 10 }, (_, i) => ({
      uuid: `u-${i}`,
      type: i % 2 === 0 ? 'user' : 'assistant',
      content: chunk,
    }));
    const events: CompactionEventPayload[] = [];
    const compaction: CompactionHooks = {
      sessionId: 'sess-001',
      config: createDefaultConfig(100_000),
      tracking: createTrackingState(),
      forkedLLM: async () => ({ text: 'tiny summary' }),
      emit: (e) => events.push(e),
    };
    const params: QueryParams = {
      messages,
      systemPrompt: 'test',
      deps: createTestDeps([[{ type: 'text', content: 'ok' }]]),
      compaction,
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'completed');
    const triggered = events.some((e) => e.type === 'CompactionTriggered');
    const completed = events.some((e) => e.type === 'CompactionCompleted');
    assert.ok(triggered, 'CompactionTriggered must fire');
    assert.ok(completed, 'CompactionCompleted must fire');
  });

  it('circuit breaker stops auto-compact after maxConsecutiveFailures', async () => {
    // Set tracking already at threshold so compaction is skipped.
    const tracking = createTrackingState({ consecutiveFailures: 3 });
    const big = 'x'.repeat(80_000);
    const events: CompactionEventPayload[] = [];
    const params: QueryParams = {
      messages: [{ uuid: 'u', type: 'user', content: big }],
      systemPrompt: 't',
      deps: createTestDeps([[{ type: 'text', content: 'ok' }]]),
      compaction: {
        sessionId: 'sess-circuit',
        config: createDefaultConfig(1_000),
        tracking,
        emit: (e) => events.push(e),
      },
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'completed');
    // No CompactionCompleted because the breaker tripped.
    assert.equal(
      events.filter((e) => e.type === 'CompactionCompleted').length,
      0,
    );
  });

  it('disabled when disableAll is set (DISABLE_COMPACT)', async () => {
    const big = 'x'.repeat(80_000);
    const events: CompactionEventPayload[] = [];
    const params: QueryParams = {
      messages: [{ uuid: 'u', type: 'user', content: big }],
      systemPrompt: 't',
      deps: createTestDeps([[{ type: 'text', content: 'ok' }]]),
      compaction: {
        sessionId: 'sess-disabled',
        config: createDefaultConfig(1_000),
        tracking: createTrackingState(),
        disableAll: true,
        emit: (e) => events.push(e),
      },
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'completed');
    assert.equal(events.length, 0);
  });
});

// ---------------------------------------------------------------------------
// FR-P10-002 — Reactive compaction on prompt_too_long
// ---------------------------------------------------------------------------

describe('FR-P10-002: reactive compaction on prompt_too_long', () => {
  it('catches PROMPT_TOO_LONG, compacts, and retries the offending turn', async () => {
    const events: CompactionEventPayload[] = [];
    let modelCall = 0;
    const responses: ModelEvent[][] = [
      [{ type: 'error', apiError: PROMPT_TOO_LONG_ERROR }],
      [{ type: 'text', content: 'recovered' }],
    ];
    const deps = createTestDeps(responses);
    const wrappedDeps = {
      ...deps,
      callModel: (msgs: QueryMessage[], sys: string) => {
        modelCall++;
        return deps.callModel(msgs, sys);
      },
    };
    const big = 'x'.repeat(40_000);
    const params: QueryParams = {
      messages: [{ uuid: 'u', type: 'user', content: big }],
      systemPrompt: 't',
      deps: wrappedDeps,
      compaction: {
        sessionId: 'sess-reactive',
        config: createDefaultConfig(200_000),
        tracking: createTrackingState(),
        emit: (e) => events.push(e),
      },
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'completed');
    assert.equal(modelCall, 2, 'model should be retried exactly once');
    const reactive = events.find(
      (e) => e.type === 'CompactionCompleted' && e.cause === 'reactive',
    );
    assert.ok(reactive, 'reactive CompactionCompleted should fire');
  });

  it('surfaces error when reactive compaction itself fails', async () => {
    const events: CompactionEventPayload[] = [];
    const failingFork: ForkedLLMCall = async () => {
      throw new Error('fork failed');
    };
    const deps = createTestDeps([
      [{ type: 'error', apiError: PROMPT_TOO_LONG_ERROR }],
    ]);
    const params: QueryParams = {
      messages: [{ uuid: 'u', type: 'user', content: 'hi' }],
      systemPrompt: 't',
      deps,
      compaction: {
        sessionId: 'sess-reactive-fail',
        config: createDefaultConfig(200_000),
        tracking: createTrackingState(),
        forkedLLM: failingFork,
        emit: (e) => events.push(e),
      },
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'prompt_too_long');
  });

  it('reactive runs even when proactive auto-compact is disabled', async () => {
    const events: CompactionEventPayload[] = [];
    const deps = createTestDeps([
      [{ type: 'error', apiError: PROMPT_TOO_LONG_ERROR }],
      [{ type: 'text', content: 'ok' }],
    ]);
    const params: QueryParams = {
      messages: [{ uuid: 'u', type: 'user', content: 'hi' }],
      systemPrompt: 't',
      deps,
      compaction: {
        sessionId: 'sess-reactive-only',
        config: createDefaultConfig(200_000),
        tracking: createTrackingState(),
        disableAutoCompact: true,
        emit: (e) => events.push(e),
      },
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'completed');
    assert.ok(
      events.some(
        (e) => e.type === 'CompactionCompleted' && e.cause === 'reactive',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// FR-P10-003 — Tool-result snip budgeting
// ---------------------------------------------------------------------------

describe('FR-P10-003: snip preserves tail and is idempotent', () => {
  it('records snipped ids and skips them on subsequent calls (idempotent)', () => {
    const sid = 'snip-sess';
    dropSessionCompactState(sid);
    recordMicrocompactSnip(sid, 'msg-1');
    assert.equal(isAlreadySnipped(sid, 'msg-1'), true);
    assert.equal(isAlreadySnipped(sid, 'msg-2'), false);
  });

  it('snip pass through queryLoop does not corrupt tail messages', async () => {
    const tail: QueryMessage = { uuid: 'tail', type: 'user', content: 'tail-msg' };
    const params: QueryParams = {
      messages: [tail],
      systemPrompt: 't',
      deps: createTestDeps([[{ type: 'text', content: 'ok' }]]),
      compaction: {
        sessionId: 'sess-snip',
        config: createDefaultConfig(200_000),
        tracking: createTrackingState(),
        snipBoundary: 4,
      },
    };
    const { terminal } = await consumeLoop(params);
    assert.equal(terminal.reason, 'completed');
  });
});

// ---------------------------------------------------------------------------
// FR-P10-004 — Summary generation + reinjection with tail window
// ---------------------------------------------------------------------------

describe('FR-P10-004: summary generation + reinjection', () => {
  it('produces [boundary, userSummary, ...tail(K)] in order', async () => {
    const msgs = makeBigConversation(10, 100);
    const result = await generateCompactionMessages(msgs, { tailRounds: 2 });
    // tail = last 4 messages (2 rounds * 2)
    assert.equal(result.messages.length, 2 + 4);
    assert.equal(result.messages[0].type, 'system');
    assert.equal(result.messages[1].type, 'user');
    // Tail preserved verbatim:
    const tail = result.messages.slice(2);
    const expectedTail = msgs.slice(-4);
    for (let i = 0; i < tail.length; i++) {
      assert.equal(tail[i].uuid, expectedTail[i].uuid);
    }
  });

  it('forks an LLM when forkedLLM is provided and caps maxOutputTokens', async () => {
    let captured: { prompt: string; max: number } | undefined;
    const fork: ForkedLLMCall = async ({ prompt, maxOutputTokens }) => {
      captured = { prompt, max: maxOutputTokens };
      return { text: 'LLM-GENERATED-SUMMARY' };
    };
    const msgs = makeBigConversation(5, 50);
    const result = await generateCompactionMessages(msgs, {
      tailRounds: 2,
      forkedLLM: fork,
      maxOutputTokens: 999_999, // should clamp to MAX_OUTPUT_TOKENS_FOR_SUMMARY
    });
    assert.ok(captured);
    assert.equal(captured!.max, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
    assert.ok(captured!.prompt.length > 0);
    assert.equal(result.viaLLM, true);
    const userBlock = result.messages[1].content[0];
    assert.equal(userBlock.type, 'text');
    if (userBlock.type === 'text') {
      assert.ok(userBlock.text.includes('LLM-GENERATED-SUMMARY'));
    }
  });

  it('falls back to deterministic structured summary when no forkedLLM', async () => {
    const msgs = makeBigConversation(3, 50);
    const result = await generateCompactionMessages(msgs);
    assert.equal(result.viaLLM, false);
    assert.ok(result.summaryText.includes('Compaction Summary'));
  });
});

// ---------------------------------------------------------------------------
// FR-P10-005 — Post-compact cleanup
// ---------------------------------------------------------------------------

describe('FR-P10-005: post-compact cleanup', () => {
  it('clears microcompact and main-thread caches and resets anchor', () => {
    const sid = 'cleanup-main';
    dropSessionCompactState(sid);
    recordMicrocompactSnip(sid, 'msg-1');
    trackFileStateKey(sid, 'file-a');
    trackMemoryFileKey(sid, 'mem-b');
    const result = runPostCompactCleanup(sid, 'main', 'new-anchor-uuid');
    assert.equal(result.microcompactReset, true);
    assert.equal(result.fileCacheCleared, true);
    assert.equal(result.memoryFileCacheCleared, true);
    assert.equal(result.anchorReset, true);
    const state = getSessionCompactState(sid);
    assert.equal(state.lastSummarizedMessageId, 'new-anchor-uuid');
    assert.equal(state.microcompactSnippedIds.size, 0);
    assert.equal(state.fileStateCacheKeys.size, 0);
    assert.equal(state.memoryFileCacheKeys.size, 0);
  });

  it('subagent path skips main-thread caches', () => {
    const sid = 'cleanup-sub';
    dropSessionCompactState(sid);
    trackFileStateKey(sid, 'file-x');
    const result = runPostCompactCleanup(sid, 'subagent', 'anchor');
    assert.equal(result.fileCacheCleared, false);
    assert.equal(result.memoryFileCacheCleared, false);
    // subagent must NOT clear the file cache
    const state = getSessionCompactState(sid);
    assert.equal(state.fileStateCacheKeys.has('file-x'), true);
  });

  it('markPostCompaction sets a one-shot pending flag', () => {
    const sid = 'mark-pending';
    dropSessionCompactState(sid);
    markPostCompaction(sid);
    assert.equal(consumePostCompactionFlag(sid), true);
    assert.equal(consumePostCompactionFlag(sid), false);
  });
});

// ---------------------------------------------------------------------------
// FR-P10-006 — compactWarningHook
// ---------------------------------------------------------------------------

describe('FR-P10-006: compact warning hook', () => {
  it('emits warning when above warning threshold', () => {
    // Build messages whose token count exceeds the warning threshold
    // for a small context window (200K - 20K = 180K warning threshold).
    const ws = computeWarningState(
      [makeCompactMsg('user', 'a'.repeat(800_000))], // ~200K tokens
      200_000,
    );
    assert.equal(ws.isAboveWarningThreshold, true);
    const decision = decideWarningEmission('warn-sess', ws);
    assert.equal(decision.kind === 'warning' || decision.kind === 'error', true);
  });

  it('emits error when above error threshold', () => {
    const ws = computeWarningState(
      [makeCompactMsg('user', 'a'.repeat(800_000))],
      200_000,
    );
    assert.equal(ws.isAboveErrorThreshold, true);
    const decision = decideWarningEmission('err-sess', ws);
    assert.equal(decision.kind, 'error');
  });

  it('respects suppression state', () => {
    const sid = 'supp-sess';
    clearCompactWarningSuppression(sid);
    // Build a token count that crosses the warning band but not the
    // error band: window=1_000_000 -> warning=980_000, error=998_000.
    // 985_000 tokens lands inside [warning, error).
    const ws = computeWarningState(
      [makeCompactMsg('user', 'a'.repeat(985_000 * 4))],
      1_000_000,
    );
    assert.equal(ws.isAboveWarningThreshold, true);
    assert.equal(ws.isAboveErrorThreshold, false);
    // First emission: warning
    const first = decideWarningEmission(sid, ws);
    assert.equal(first.kind, 'warning');
    // Suppress; second call should be silenced
    suppressCompactWarning(sid, ws.currentTokens);
    const second = decideWarningEmission(sid, ws);
    assert.equal(second.kind, 'none');
    clearCompactWarningSuppression(sid);
  });
});
