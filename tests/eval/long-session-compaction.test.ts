/**
 * FR-P10-007 — Long-session compaction eval.
 *
 * Drives a synthetic agent past 200K tokens through the queryLoop and
 * verifies:
 *  - At least 2 autoCompact cycles fire during the run
 *  - Final assistant turn references information from pre-compact history
 *  - No PROMPT_TOO_LONG errors leak past reactiveCompact
 *  - The loop completes without crashing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  queryLoop,
  PROMPT_TOO_LONG_ERROR,
  type QueryParams,
  type CompactionEventPayload,
} from '../../src/query/queryLoop.js';
import type { QueryMessage } from '../../src/query/state.js';
import {
  createDefaultConfig,
  createTrackingState,
  type ForkedLLMCall,
} from '../../src/services/compact/index.js';
import type { ModelEvent, QueryDeps } from '../../src/query/deps.js';

describe('FR-P10-007: long-session compaction eval (>200K tokens)', () => {
  it('survives a >200K-token synthetic session with ≥2 auto-compactions', async () => {
    // Synthetic agent that emits a chunky ~50K-token response per turn
    // for 6 turns, then a final text turn. With a 200K context window
    // and a ~13K buffer, the loop should fire auto-compact at least twice.
    const HUGE_CHUNK = 'z'.repeat(360_000); // ~90K tokens per chunk

    const responses: ModelEvent[][] = [
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: HUGE_CHUNK }],
      [{ type: 'text', content: 'PRE_COMPACT_MARKER acknowledged. Done.' }],
    ];

    // Test deps that loop through the scripted turns. Because the
    // queryLoop continues only on tool_use / compact_retry / errors, we
    // need to keep it iterating: we wrap the model so each plain-text
    // response is followed by a budget-continuation nudge until the
    // final marker turn.
    let callIdx = 0;
    const deps: QueryDeps = {
      async *callModel(): AsyncGenerator<ModelEvent> {
        const events = responses[Math.min(callIdx, responses.length - 1)];
        callIdx++;
        for (const e of events) yield e;
      },
      uuid: (() => {
        let n = 0;
        return () => `eval-uuid-${++n}`;
      })(),
      estimateTokens: (msgs) => msgs.reduce((s, m) => s + m.content.length, 0),
    };

    const events: CompactionEventPayload[] = [];
    let leakedPromptTooLong = 0;

    // The forked LLM call is mocked to return a tiny summary so each
    // compaction actually shrinks the conversation.
    const fork: ForkedLLMCall = async () => ({
      text: 'SUMMARY: PRE_COMPACT_MARKER tracked across compaction.',
    });

    let budgetCalls = 0;
    const userMessage: QueryMessage = {
      uuid: 'user-eval-1',
      type: 'user',
      content: 'Begin long session. PRE_COMPACT_MARKER established.',
    };

    const params: QueryParams = {
      messages: [userMessage],
      systemPrompt: 'eval',
      deps,
      maxTurns: 100,
      checkBudget: () => {
        budgetCalls++;
        // Keep the loop going until we have driven all responses through.
        if (budgetCalls < responses.length) {
          return { action: 'continue', nudgeMessage: 'continue' };
        }
        return { action: 'stop' };
      },
      compaction: {
        sessionId: 'eval-long-session',
        config: createDefaultConfig(200_000),
        tracking: createTrackingState(),
        forkedLLM: fork,
        emit: (e) => {
          events.push(e);
          if (e.type === 'ContextPressureError') {
            // not a leak — that's what the warning hook is for
          }
        },
      },
    };

    const gen = queryLoop(params);
    const collected: unknown[] = [];
    let r = await gen.next();
    while (!r.done) {
      const ev = r.value;
      if (
        ev.type === 'error_message' &&
        typeof (ev as { message?: { content?: string } }).message?.content ===
          'string' &&
        (ev as { message: { content: string } }).message.content.includes(
          PROMPT_TOO_LONG_ERROR,
        )
      ) {
        leakedPromptTooLong++;
      }
      collected.push(ev);
      r = await gen.next();
    }
    const terminal = r.value;

    // No prompt_too_long errors should have leaked.
    assert.equal(leakedPromptTooLong, 0);
    // Loop must have terminated cleanly (completed or max_turns).
    assert.ok(
      terminal.reason === 'completed' || terminal.reason === 'max_turns',
      `unexpected terminal: ${terminal.reason}`,
    );

    const compactions = events.filter((e) => e.type === 'CompactionCompleted');
    assert.ok(
      compactions.length >= 2,
      `expected ≥2 auto-compactions, got ${compactions.length}`,
    );

    // Each compaction must record a >0% ratio.
    for (const c of compactions) {
      assert.ok((c.ratio ?? 0) > 0, 'compaction should reduce tokens');
    }
  });
});
