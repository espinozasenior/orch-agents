import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  type CompactMessage,
  type CompactionConfig,
  createDefaultConfig,
  createTrackingState,
  estimateTokens,
  tokenCountWithEstimation,
  applyToolResultBudget,
  snipCompactIfNeeded,
  extractFilePaths,
  extractPendingWork,
  extractDecisions,
  buildStructuredSummary,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  autoCompactIfNeeded,
  tryReactiveCompact,
  runCompactionPipeline,
  AUTOCOMPACT_BUFFER_TOKENS,
  DEFAULT_TOOL_RESULT_BUDGET_CHARS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from '../../../src/services/compact/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  type: CompactMessage['type'],
  text: string,
  overrides: Partial<CompactMessage> = {},
): CompactMessage {
  return {
    uuid: randomUUID(),
    type,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeToolResultMessage(
  contentSize: number,
  toolUseId: string = randomUUID(),
): CompactMessage {
  return {
    uuid: randomUUID(),
    type: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'x'.repeat(contentSize),
      },
    ],
    timestamp: Date.now(),
  };
}

function makeMessagesWithTokens(
  targetTokens: number,
  count: number = 20,
): CompactMessage[] {
  // Each message needs ~(targetTokens / count) tokens
  // tokens = ceil(chars / 4) + 4 overhead  =>  chars ~ (tokens - 4) * 4
  const tokensPerMsg = Math.floor(targetTokens / count);
  const charsPerMsg = Math.max(0, (tokensPerMsg - 4) * 4);
  const messages: CompactMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      makeMessage(i % 2 === 0 ? 'user' : 'assistant', 'a'.repeat(charsPerMsg)),
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Token Estimator
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('should approximate chars/4', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
    assert.equal(estimateTokens('a'.repeat(100)), 25);
  });
});

describe('tokenCountWithEstimation', () => {
  it('should return 0 for empty array', () => {
    assert.equal(tokenCountWithEstimation([]), 0);
  });

  it('should sum estimated tokens across messages', () => {
    const msgs = [
      makeMessage('user', 'a'.repeat(40)),   // ceil(40/4) + 4 = 14
      makeMessage('assistant', 'b'.repeat(40)), // 14
    ];
    assert.equal(tokenCountWithEstimation(msgs), 28);
  });

  it('should prefer usage.input_tokens from last message if available', () => {
    const msgs = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'world', {
        usage: { input_tokens: 999, output_tokens: 50 },
      }),
    ];
    assert.equal(tokenCountWithEstimation(msgs), 999);
  });
});

// ---------------------------------------------------------------------------
// Tier 1: Tool Result Budget
// ---------------------------------------------------------------------------

describe('applyToolResultBudget', () => {
  it('should replace tool results over the budget', () => {
    const msg = makeToolResultMessage(100_000);
    const { messages, replacements } = applyToolResultBudget([msg], 50_000);
    const block = messages[0].content[0];
    assert.equal(block.type, 'tool_result');
    if (block.type === 'tool_result') {
      assert.ok(block.content.includes('[Content replaced'));
      assert.ok(block.content.includes('100000 chars'));
    }
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].originalSize, 100_000);
  });

  it('should leave tool results under budget unchanged', () => {
    const msg = makeToolResultMessage(1_000);
    const { messages, replacements } = applyToolResultBudget([msg], 50_000);
    const block = messages[0].content[0];
    if (block.type === 'tool_result') {
      assert.equal(block.content.length, 1_000);
    }
    assert.equal(replacements.length, 0);
  });

  it('should preserve tool_use blocks unchanged', () => {
    const toolUseId = randomUUID();
    const msg: CompactMessage = {
      uuid: randomUUID(),
      type: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'x'.repeat(100_000),
        },
      ],
    };
    const assistantMsg: CompactMessage = {
      uuid: randomUUID(),
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Read',
          input: { path: '/foo' },
        },
      ],
    };
    const { messages } = applyToolResultBudget(
      [assistantMsg, msg],
      50_000,
    );
    // tool_use block should be untouched
    const toolUseBlock = messages[0].content[0];
    assert.equal(toolUseBlock.type, 'tool_use');
    if (toolUseBlock.type === 'tool_use') {
      assert.equal(toolUseBlock.id, toolUseId);
      assert.equal(toolUseBlock.name, 'Read');
    }
  });

  it('should use default budget of 50K chars', () => {
    const msg = makeToolResultMessage(DEFAULT_TOOL_RESULT_BUDGET_CHARS + 1);
    const { replacements } = applyToolResultBudget([msg]);
    assert.equal(replacements.length, 1);
  });

  it('should not mutate the original messages array', () => {
    const msg = makeToolResultMessage(100_000);
    const original = [msg];
    applyToolResultBudget(original, 50_000);
    const block = original[0].content[0];
    if (block.type === 'tool_result') {
      assert.equal(block.content.length, 100_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Snip Compact
// ---------------------------------------------------------------------------

describe('snipCompactIfNeeded', () => {
  it('should return messages unchanged if under snip boundary', () => {
    const msgs = [makeMessage('user', 'hi'), makeMessage('assistant', 'hey')];
    const result = snipCompactIfNeeded(msgs, 10);
    assert.equal(result.messages.length, 2);
    assert.equal(result.tokensFreed, 0);
    assert.equal(result.boundaryMessage, undefined);
  });

  it('should remove messages beyond snip boundary', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`),
    );
    const result = snipCompactIfNeeded(msgs, 4);
    // 6 removed + boundary message + 4 kept = 5 total
    assert.equal(result.messages.length, 5); // boundary + 4 kept
    assert.ok(result.tokensFreed > 0);
    assert.ok(result.boundaryMessage);
  });

  it('should include boundary marker with removal count', () => {
    const msgs = Array.from({ length: 8 }, (_, i) =>
      makeMessage('user', `message ${i}`),
    );
    const result = snipCompactIfNeeded(msgs, 3);
    assert.ok(result.boundaryMessage);
    const text = result.boundaryMessage.content[0];
    if (text.type === 'text') {
      assert.ok(text.text.includes('5 older messages removed'));
    }
  });

  it('should report correct tokensFreed', () => {
    // Each message: 4 overhead + ceil(4/4) = 5 tokens
    const msgs = Array.from({ length: 6 }, () =>
      makeMessage('user', 'test'),
    );
    const result = snipCompactIfNeeded(msgs, 2);
    // 4 messages removed, each ~5 tokens
    assert.equal(result.tokensFreed, 4 * 5);
  });
});

// ---------------------------------------------------------------------------
// Summary Generator
// ---------------------------------------------------------------------------

describe('extractFilePaths', () => {
  it('should extract file paths with known extensions', () => {
    const msgs = [
      makeMessage('assistant', 'Modified src/index.ts and src/types.ts'),
      makeMessage('assistant', 'Also changed README.md'),
    ];
    const paths = extractFilePaths(msgs);
    assert.ok(paths.includes('src/index.ts'));
    assert.ok(paths.includes('src/types.ts'));
    assert.ok(paths.includes('README.md'));
  });

  it('should deduplicate paths', () => {
    const msgs = [
      makeMessage('user', 'Edit src/foo.ts'),
      makeMessage('assistant', 'Done with src/foo.ts'),
    ];
    const paths = extractFilePaths(msgs);
    const fooCount = paths.filter((p) => p === 'src/foo.ts').length;
    assert.equal(fooCount, 1);
  });
});

describe('extractPendingWork', () => {
  it('should extract sentences with todo/next keywords', () => {
    const msgs = [
      makeMessage('assistant', 'The next step is to add validation.'),
      makeMessage('user', 'Also todo: write tests for the parser.'),
    ];
    const pending = extractPendingWork(msgs);
    assert.ok(pending.length >= 2);
    assert.ok(pending.some((s) => s.toLowerCase().includes('next')));
    assert.ok(pending.some((s) => s.toLowerCase().includes('todo')));
  });
});

describe('extractDecisions', () => {
  it('should extract sentences containing decision keywords', () => {
    const msgs = [
      makeMessage('assistant', 'We decided to use CommonJS for compatibility.'),
    ];
    const decisions = extractDecisions(msgs);
    assert.ok(decisions.length >= 1);
    assert.ok(decisions[0].includes('decided'));
  });
});

describe('buildStructuredSummary', () => {
  it('should build a markdown summary', () => {
    const summary = buildStructuredSummary({
      messageCount: 42,
      filesModified: ['src/index.ts'],
      pendingWork: ['Write unit tests'],
      keyDecisions: ['Use CommonJS'],
    });
    assert.ok(summary.includes('42'));
    assert.ok(summary.includes('src/index.ts'));
    assert.ok(summary.includes('Write unit tests'));
    assert.ok(summary.includes('Use CommonJS'));
    assert.ok(summary.includes('## Compaction Summary'));
  });

  it('should omit empty sections', () => {
    const summary = buildStructuredSummary({
      messageCount: 5,
      filesModified: [],
      pendingWork: [],
      keyDecisions: [],
    });
    assert.ok(!summary.includes('### Files Referenced'));
    assert.ok(!summary.includes('### Key Decisions'));
    assert.ok(!summary.includes('### Pending Work'));
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Auto Compact
// ---------------------------------------------------------------------------

describe('getAutoCompactThreshold', () => {
  it('should subtract buffer from context window', () => {
    assert.equal(
      getAutoCompactThreshold(200_000),
      200_000 - AUTOCOMPACT_BUFFER_TOKENS,
    );
  });
});

describe('calculateTokenWarningState', () => {
  it('should report exceeded when tokens pass threshold', () => {
    // Build messages that exceed the threshold
    const msgs = makeMessagesWithTokens(190_000, 20);
    const state = calculateTokenWarningState(msgs, 200_000);
    assert.equal(state.exceeded, true);
    assert.ok(state.buffer < 0);
  });

  it('should report not exceeded for small conversations', () => {
    const msgs = [makeMessage('user', 'hi')];
    const state = calculateTokenWarningState(msgs, 200_000);
    assert.equal(state.exceeded, false);
    assert.ok(state.buffer > 0);
  });
});

describe('autoCompactIfNeeded', () => {
  it('should skip compaction when under threshold', () => {
    const msgs = [makeMessage('user', 'hello')];
    const config = createDefaultConfig(200_000);
    const tracking = createTrackingState();
    const result = autoCompactIfNeeded(msgs, config, tracking, 0);
    assert.equal(result.compactionResult, undefined);
    assert.equal(result.consecutiveFailures, undefined);
  });

  it('should trigger compaction when over threshold', () => {
    const config = createDefaultConfig(1_000); // small window
    const msgs = makeMessagesWithTokens(2_000, 10);
    const tracking = createTrackingState();
    const result = autoCompactIfNeeded(msgs, config, tracking, 0);
    // Either compacts or increments failures (post-compact may still be large)
    assert.ok(
      result.compactionResult !== undefined ||
        result.consecutiveFailures !== undefined,
    );
  });

  it('should circuit-break after max consecutive failures', () => {
    const config = createDefaultConfig(200_000);
    const tracking = createTrackingState({
      consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    });
    const msgs = makeMessagesWithTokens(300_000, 20);
    const result = autoCompactIfNeeded(msgs, config, tracking, 0);
    assert.equal(result.compactionResult, undefined);
    assert.equal(
      result.consecutiveFailures,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    );
  });

  it('should not trigger when snipTokensFreed brings total under threshold', () => {
    // Create messages that are just barely over threshold
    const config = createDefaultConfig(1_000);
    const threshold = 1_000 - AUTOCOMPACT_BUFFER_TOKENS; // negative, but that's OK for test
    const msgs = makeMessagesWithTokens(500, 5);
    const tracking = createTrackingState();
    // Large snipTokensFreed should prevent trigger
    const result = autoCompactIfNeeded(msgs, config, tracking, 100_000);
    assert.equal(result.compactionResult, undefined);
    assert.equal(result.consecutiveFailures, undefined);
  });

  it('should preserve recent messages in compaction result', () => {
    // Use a very small context window to force compaction
    const config: CompactionConfig = {
      preserveRecent: 4,
      autoCompactBufferTokens: 10,
      maxOutputForSummary: 20_000,
      maxConsecutiveFailures: 3,
      microcompactBudgetChars: 50_000,
      contextWindowTokens: 100, // Very small to force compaction
    };
    const msgs = makeMessagesWithTokens(2_000, 20);
    const last4 = msgs.slice(-4);
    const tracking = createTrackingState();
    const result = autoCompactIfNeeded(msgs, config, tracking, 0);
    if (result.compactionResult) {
      const postMsgs = result.compactionResult.summaryMessages;
      // Last 4 messages should be preserved
      const preserved = postMsgs.slice(-4);
      for (let i = 0; i < 4; i++) {
        assert.equal(preserved[i].uuid, last4[i].uuid);
      }
    }
  });

  it('should increment failures when post-compact still exceeds threshold', () => {
    // Edge case: if all content is in the last 4 messages, summary won't help
    const config: CompactionConfig = {
      preserveRecent: 4,
      autoCompactBufferTokens: 10,
      maxOutputForSummary: 20_000,
      maxConsecutiveFailures: 3,
      microcompactBudgetChars: 50_000,
      contextWindowTokens: 50, // Extremely small
    };
    // Put all tokens in last 4 messages
    const msgs = makeMessagesWithTokens(2_000, 4);
    const tracking = createTrackingState();
    const result = autoCompactIfNeeded(msgs, config, tracking, 0);
    assert.equal(result.consecutiveFailures, 1);
  });
});

// ---------------------------------------------------------------------------
// Tier 4: Reactive Compact
// ---------------------------------------------------------------------------

describe('tryReactiveCompact', () => {
  it('should return null when hasAttempted is true (single-shot guard)', () => {
    const msgs = makeMessagesWithTokens(10_000, 10);
    const result = tryReactiveCompact(true, msgs);
    assert.equal(result, null);
  });

  it('should compact when hasAttempted is false', () => {
    const msgs = makeMessagesWithTokens(10_000, 10);
    const result = tryReactiveCompact(false, msgs);
    assert.notEqual(result, null);
    assert.ok(result!.summaryMessages.length > 0);
    assert.ok(result!.postCompactTokenCount < result!.preCompactTokenCount);
  });

  it('should preserve recent 4 messages by default', () => {
    const msgs = makeMessagesWithTokens(10_000, 10);
    const last4 = msgs.slice(-4);
    const result = tryReactiveCompact(false, msgs);
    assert.notEqual(result, null);
    const preserved = result!.summaryMessages.slice(-4);
    for (let i = 0; i < 4; i++) {
      assert.equal(preserved[i].uuid, last4[i].uuid);
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('runCompactionPipeline', () => {
  it('should chain all tiers and return aggregated result', () => {
    const msgs: CompactMessage[] = [
      makeToolResultMessage(100_000), // Over budget
      ...makeMessagesWithTokens(500, 5),
    ];
    const config = createDefaultConfig(200_000);
    const tracking = createTrackingState();
    const result = runCompactionPipeline({
      messages: msgs,
      config,
      tracking,
    });
    // Tier 1 should have replaced the oversized tool result
    assert.ok(result.toolResultReplacements.length >= 1);
    // Under threshold so no auto-compact
    assert.equal(result.compactionResult, undefined);
  });

  it('should apply snip boundary when provided', () => {
    const msgs = makeMessagesWithTokens(500, 10);
    const config = createDefaultConfig(200_000);
    const tracking = createTrackingState();
    const result = runCompactionPipeline({
      messages: msgs,
      config,
      tracking,
      snipBoundary: 4,
    });
    assert.ok(result.snipTokensFreed > 0);
  });

  it('should use default config when none provided', () => {
    const msgs = [makeMessage('user', 'hello')];
    const tracking = createTrackingState();
    const result = runCompactionPipeline({ messages: msgs, tracking });
    assert.equal(result.toolResultReplacements.length, 0);
    assert.equal(result.snipTokensFreed, 0);
  });
});

// ---------------------------------------------------------------------------
// Config & State factories
// ---------------------------------------------------------------------------

describe('createDefaultConfig', () => {
  it('should create frozen config with correct defaults', () => {
    const config = createDefaultConfig();
    assert.equal(config.preserveRecent, 4);
    assert.equal(config.autoCompactBufferTokens, 13_000);
    assert.equal(config.maxConsecutiveFailures, 3);
    assert.equal(config.microcompactBudgetChars, 50_000);
    assert.equal(config.contextWindowTokens, 200_000);
    assert.ok(Object.isFrozen(config));
  });

  it('should accept custom context window', () => {
    const config = createDefaultConfig(128_000);
    assert.equal(config.contextWindowTokens, 128_000);
  });
});

describe('createTrackingState', () => {
  it('should create state with defaults', () => {
    const state = createTrackingState();
    assert.equal(state.compacted, false);
    assert.equal(state.turnCounter, 0);
    assert.equal(state.consecutiveFailures, 0);
  });

  it('should accept overrides', () => {
    const state = createTrackingState({ consecutiveFailures: 2, compacted: true });
    assert.equal(state.consecutiveFailures, 2);
    assert.equal(state.compacted, true);
  });
});
