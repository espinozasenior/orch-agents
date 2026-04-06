import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  FORK_AGENT,
  isForkSubagentEnabled,
  isInForkChild,
  buildForkConversationMessages,
} from '../../../src/agents/fork/forkSubagent';
import type { ForkMessage } from '../../../src/agents/fork/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMessage(content: ForkMessage['content']): ForkMessage {
  return { uuid: 'user-1', type: 'user', content };
}

function assistantMessage(content: ForkMessage['content']): ForkMessage {
  return { uuid: 'asst-1', type: 'assistant', content };
}

// ---------------------------------------------------------------------------
// FORK_AGENT constant
// ---------------------------------------------------------------------------

describe('FORK_AGENT', () => {
  it('has expected shape', () => {
    assert.equal(FORK_AGENT.agentType, 'fork');
    assert.deepStrictEqual(FORK_AGENT.tools, ['*']);
    assert.equal(FORK_AGENT.maxTurns, 200);
    assert.equal(FORK_AGENT.model, 'inherit');
    assert.equal(FORK_AGENT.permissionMode, 'bubble');
    assert.equal(FORK_AGENT.source, 'built-in');
    assert.equal(FORK_AGENT.getSystemPrompt(), '');
  });
});

// ---------------------------------------------------------------------------
// isForkSubagentEnabled
// ---------------------------------------------------------------------------

describe('isForkSubagentEnabled', () => {
  it('returns true in normal interactive mode', () => {
    assert.equal(isForkSubagentEnabled(false, false), true);
  });

  it('returns false in coordinator mode', () => {
    assert.equal(isForkSubagentEnabled(true, false), false);
  });

  it('returns false in non-interactive session', () => {
    assert.equal(isForkSubagentEnabled(false, true), false);
  });

  it('returns false when both coordinator and non-interactive', () => {
    assert.equal(isForkSubagentEnabled(true, true), false);
  });
});

// ---------------------------------------------------------------------------
// isInForkChild
// ---------------------------------------------------------------------------

describe('isInForkChild', () => {
  it('detects fork boilerplate tag in user messages', () => {
    const messages: ForkMessage[] = [
      userMessage([
        {
          type: 'text',
          text: `<${FORK_BOILERPLATE_TAG}>Context inherited from parent</${FORK_BOILERPLATE_TAG}>`,
        },
      ]),
    ];
    assert.equal(isInForkChild(messages), true);
  });

  it('returns false for normal user messages', () => {
    const messages: ForkMessage[] = [
      userMessage([{ type: 'text', text: 'Hello, please help me' }]),
    ];
    assert.equal(isInForkChild(messages), false);
  });

  it('ignores assistant messages even if they contain the tag', () => {
    const messages: ForkMessage[] = [
      assistantMessage([
        {
          type: 'text',
          text: `<${FORK_BOILERPLATE_TAG}>should be ignored</${FORK_BOILERPLATE_TAG}>`,
        },
      ]),
    ];
    assert.equal(isInForkChild(messages), false);
  });

  it('returns false for empty message list', () => {
    assert.equal(isInForkChild([]), false);
  });

  it('returns false when user messages contain only tool_result blocks', () => {
    const messages: ForkMessage[] = [
      userMessage([
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
      ]),
    ];
    assert.equal(isInForkChild(messages), false);
  });
});

// ---------------------------------------------------------------------------
// buildForkConversationMessages
// ---------------------------------------------------------------------------

describe('buildForkConversationMessages', () => {
  it('replaces all tool_result content with constant placeholder', () => {
    const parent: ForkMessage[] = [
      assistantMessage([
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'read_file',
          input: { path: '/foo' },
        },
      ]),
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'file contents here — very long output',
        },
      ]),
    ];

    const fork = buildForkConversationMessages(parent, 'Do X');
    const toolResultMsg = fork.find(
      (m) =>
        m.type === 'user' &&
        m.content.some((b) => b.type === 'tool_result'),
    );
    assert.ok(toolResultMsg);
    const resultBlock = toolResultMsg.content.find(
      (b) => b.type === 'tool_result',
    );
    assert.ok(resultBlock);
    assert.equal(
      resultBlock.type === 'tool_result' && resultBlock.content,
      FORK_PLACEHOLDER_RESULT,
    );
  });

  it('preserves tool_use blocks unchanged', () => {
    const toolUseBlock = {
      type: 'tool_use' as const,
      id: 'tool-1',
      name: 'read_file',
      input: { path: '/bar' },
    };
    const parent: ForkMessage[] = [
      assistantMessage([toolUseBlock]),
      userMessage([
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'data' },
      ]),
    ];

    const fork = buildForkConversationMessages(parent, 'Do Y');
    const assistantMsg = fork.find((m) => m.type === 'assistant');
    assert.ok(assistantMsg);
    assert.deepStrictEqual(assistantMsg.content[0], toolUseBlock);
  });

  it('preserves assistant messages unchanged', () => {
    const assistantContent = [
      { type: 'text' as const, text: 'Here is my analysis...' },
    ];
    const parent: ForkMessage[] = [
      assistantMessage(assistantContent),
    ];

    const fork = buildForkConversationMessages(parent, 'Continue');
    const assistantMsg = fork.find((m) => m.type === 'assistant');
    assert.ok(assistantMsg);
    assert.deepStrictEqual(assistantMsg.content, assistantContent);
  });

  it('produces identical prefixes for different directives', () => {
    const parent: ForkMessage[] = [
      assistantMessage([
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'bash',
          input: { command: 'ls' },
        },
      ]),
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'file1.ts\nfile2.ts',
        },
      ]),
      assistantMessage([
        { type: 'text', text: 'I found two files.' },
      ]),
    ];

    const fork1 = buildForkConversationMessages(parent, 'Task A');
    const fork2 = buildForkConversationMessages(parent, 'Task B');

    // All messages except the last (directive) should be identical
    const prefix1 = fork1.slice(0, -1);
    const prefix2 = fork2.slice(0, -1);
    assert.deepStrictEqual(prefix1, prefix2);
  });

  it('appends boilerplate tag and directive as last message', () => {
    const parent: ForkMessage[] = [
      userMessage([{ type: 'text', text: 'Hello' }]),
    ];

    const fork = buildForkConversationMessages(parent, 'Audit files');
    const lastMsg = fork.at(-1);
    assert.ok(lastMsg);
    assert.equal(lastMsg.type, 'user');
    assert.equal(lastMsg.content.length, 2);
    assert.ok(
      lastMsg.content[0].type === 'text' &&
        lastMsg.content[0].text.includes(FORK_BOILERPLATE_TAG),
    );
    assert.ok(
      lastMsg.content[1].type === 'text' &&
        lastMsg.content[1].text === 'Audit files',
    );
  });

  it('handles empty parent messages', () => {
    const fork = buildForkConversationMessages([], 'Do something');
    assert.equal(fork.length, 1);
    const lastMsg = fork[0];
    assert.equal(lastMsg.type, 'user');
    assert.ok(
      lastMsg.content[0].type === 'text' &&
        lastMsg.content[0].text.includes(FORK_BOILERPLATE_TAG),
    );
  });

  it('handles messages with no tool_results', () => {
    const parent: ForkMessage[] = [
      userMessage([{ type: 'text', text: 'Please help' }]),
      assistantMessage([{ type: 'text', text: 'Sure thing' }]),
    ];

    const fork = buildForkConversationMessages(parent, 'Next step');
    // 2 original + 1 directive
    assert.equal(fork.length, 3);
    // Text in user message should be preserved as-is
    const firstUserMsg = fork[0];
    assert.ok(
      firstUserMsg.content[0].type === 'text' &&
        firstUserMsg.content[0].text === 'Please help',
    );
  });

  it('replaces multiple tool_results in the same message', () => {
    const parent: ForkMessage[] = [
      userMessage([
        { type: 'tool_result', tool_use_id: 'a', content: 'result-a' },
        { type: 'tool_result', tool_use_id: 'b', content: 'result-b' },
      ]),
    ];

    const fork = buildForkConversationMessages(parent, 'Go');
    const userMsg = fork[0];
    for (const block of userMsg.content) {
      if (block.type === 'tool_result') {
        assert.equal(block.content, FORK_PLACEHOLDER_RESULT);
      }
    }
  });

  it('preserves tool_use_id on replaced tool_result blocks', () => {
    const parent: ForkMessage[] = [
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'specific-id-123',
          content: 'original',
        },
      ]),
    ];

    const fork = buildForkConversationMessages(parent, 'Check');
    const block = fork[0].content[0];
    assert.ok(block.type === 'tool_result');
    if (block.type === 'tool_result') {
      assert.equal(block.tool_use_id, 'specific-id-123');
    }
  });
});
