import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordForkHistory, serializeForkContext } from '../../src/execution/fork-context';
import type { ForkMessage } from '../../src/agents/fork/types';
import { FORK_BOILERPLATE_TAG, FORK_PLACEHOLDER_RESULT } from '../../src/agents/fork/forkSubagent';
import { buildForkMessages, shouldUseFork } from '../../src/agents/fork/index';

// ---------------------------------------------------------------------------
// recordForkHistory
// ---------------------------------------------------------------------------

describe('recordForkHistory', () => {
  it('appends user + assistant messages for prompt/response pair', () => {
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'Fix the bug', 'I fixed it');
    assert.equal(history.length, 2);
    assert.equal(history[0].type, 'user');
    assert.equal(history[1].type, 'assistant');
    assert.equal(history[0].content[0].type, 'text');
    if (history[0].content[0].type === 'text') {
      assert.equal(history[0].content[0].text, 'Fix the bug');
    }
    if (history[1].content[0].type === 'text') {
      assert.equal(history[1].content[0].text, 'I fixed it');
    }
  });

  it('generates unique UUIDs for each message', () => {
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'A', 'B');
    assert.notEqual(history[0].uuid, history[1].uuid);
  });

  it('skips assistant message when response is empty', () => {
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'Run task', '');
    assert.equal(history.length, 1);
    assert.equal(history[0].type, 'user');
  });

  it('accumulates multiple agent pairs', () => {
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'Agent 1 prompt', 'Agent 1 response');
    recordForkHistory(history, 'Agent 2 prompt', 'Agent 2 response');
    assert.equal(history.length, 4);
    assert.equal(history[0].type, 'user');
    assert.equal(history[1].type, 'assistant');
    assert.equal(history[2].type, 'user');
    assert.equal(history[3].type, 'assistant');
  });
});

// ---------------------------------------------------------------------------
// serializeForkContext
// ---------------------------------------------------------------------------

describe('serializeForkContext', () => {
  it('serializes user and assistant messages with role labels', () => {
    const messages: ForkMessage[] = [
      {
        uuid: 'u1',
        type: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        uuid: 'a1',
        type: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      },
    ];
    const result = serializeForkContext(messages);
    assert.ok(result.includes('Human: Hello'));
    assert.ok(result.includes('Assistant: Hi there'));
  });

  it('serializes tool_result blocks with bracket notation', () => {
    const messages: ForkMessage[] = [
      {
        uuid: 'u1',
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: FORK_PLACEHOLDER_RESULT },
        ],
      },
    ];
    const result = serializeForkContext(messages);
    assert.ok(result.includes(`[Tool Result: ${FORK_PLACEHOLDER_RESULT}]`));
  });

  it('serializes tool_use blocks with bracket notation', () => {
    const messages: ForkMessage[] = [
      {
        uuid: 'a1',
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/foo' } },
        ],
      },
    ];
    const result = serializeForkContext(messages);
    assert.ok(result.includes('[Tool Use: Read]'));
  });

  it('returns empty string for empty messages', () => {
    const result = serializeForkContext([]);
    assert.equal(result, '');
  });

  it('separates messages with double newlines', () => {
    const messages: ForkMessage[] = [
      { uuid: 'u1', type: 'user', content: [{ type: 'text', text: 'One' }] },
      { uuid: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Two' }] },
    ];
    const result = serializeForkContext(messages);
    assert.ok(result.includes('\n\n'));
  });

  it('handles system messages with System role label', () => {
    const messages: ForkMessage[] = [
      { uuid: 's1', type: 'system', content: [{ type: 'text', text: 'Context' }] },
    ];
    const result = serializeForkContext(messages);
    assert.ok(result.includes('System: Context'));
  });
});

// ---------------------------------------------------------------------------
// Integration: fork pipeline (record -> build -> serialize)
// ---------------------------------------------------------------------------

describe('fork pipeline integration', () => {
  it('records history, builds fork messages, serializes context', () => {
    // Simulate 2 agents running sequentially
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'Fix lint errors', 'Fixed 5 lint errors in src/');
    recordForkHistory(history, 'Add unit tests', 'Added 3 test files');

    // Check fork eligibility
    assert.equal(shouldUseFork(false, false, history), true);

    // Build fork messages for next agent
    const forked = buildForkMessages(history, 'Deploy the changes');
    assert.ok(forked.length > history.length); // history + directive

    // Last message should contain fork boilerplate tag
    const lastMsg = forked[forked.length - 1];
    assert.equal(lastMsg.type, 'user');
    assert.ok(
      lastMsg.content.some(
        (b) => b.type === 'text' && 'text' in b && b.text.includes(FORK_BOILERPLATE_TAG),
      ),
    );

    // Serialize for SDK executor
    const prefix = serializeForkContext(forked);
    assert.ok(prefix.length > 0);
    assert.ok(prefix.includes(FORK_BOILERPLATE_TAG));
  });

  it('fork is blocked when history already contains fork tag', () => {
    const history: ForkMessage[] = [
      {
        uuid: 'f1',
        type: 'user',
        content: [
          { type: 'text', text: `<${FORK_BOILERPLATE_TAG}>inherited</${FORK_BOILERPLATE_TAG}>` },
        ],
      },
    ];
    // Already in fork child — shouldUseFork returns false (depth = 1)
    assert.equal(shouldUseFork(false, false, history), false);
  });

  it('fork is blocked in coordinator mode', () => {
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'Prompt', 'Response');
    assert.equal(shouldUseFork(true, false, history), false);
  });

  it('fork is blocked in non-interactive mode', () => {
    const history: ForkMessage[] = [];
    recordForkHistory(history, 'Prompt', 'Response');
    assert.equal(shouldUseFork(false, true, history), false);
  });
});
