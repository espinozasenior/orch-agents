import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompositeAgentRegistry,
  getDefaultProgrammaticAgents,
  getForkAgentDefinition,
  shouldUseFork,
  buildForkMessages,
  type AgentEntry,
} from '../../../src/agents/fork/forkRegistry.js';
import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
} from '../../../src/agents/fork/forkSubagent.js';
import type { ForkMessage } from '../../../src/agents/fork/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(text: string, uuid = 'msg-1'): ForkMessage {
  return {
    uuid,
    type: 'user',
    content: [{ type: 'text', text }],
  };
}

function makeForkChildMessage(uuid = 'fork-msg'): ForkMessage {
  return {
    uuid,
    type: 'user',
    content: [
      { type: 'text', text: `<${FORK_BOILERPLATE_TAG}>Context inherited</${FORK_BOILERPLATE_TAG}>` },
      { type: 'text', text: 'Do something' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('forkRegistry', () => {
  describe('createCompositeAgentRegistry', () => {
    it('merges disk agents and programmatic agents', () => {
      const disk = new Map<string, AgentEntry>([
        ['review', { agentType: 'review', whenToUse: 'Code review', source: 'disk' }],
        ['test', { agentType: 'test', whenToUse: 'Run tests', source: 'disk' }],
      ]);
      const programmatic = getDefaultProgrammaticAgents();

      const registry = createCompositeAgentRegistry(disk, programmatic);

      assert.equal(registry.size, 3); // review + test + fork
      assert.ok(registry.has('review'));
      assert.ok(registry.has('test'));
      assert.ok(registry.has('fork'));
    });

    it('programmatic agents override disk agents with same type', () => {
      const disk = new Map<string, AgentEntry>([
        ['fork', { agentType: 'fork', whenToUse: 'Old fork', source: 'disk' }],
      ]);
      const programmatic = getDefaultProgrammaticAgents();

      const registry = createCompositeAgentRegistry(disk, programmatic);

      const fork = registry.get('fork');
      assert.ok(fork);
      assert.equal(fork.source, 'built-in'); // Programmatic wins
    });

    it('handles empty disk agents', () => {
      const disk = new Map<string, AgentEntry>();
      const programmatic = getDefaultProgrammaticAgents();

      const registry = createCompositeAgentRegistry(disk, programmatic);

      assert.equal(registry.size, 1);
      assert.ok(registry.has('fork'));
    });

    it('handles empty programmatic agents', () => {
      const disk = new Map<string, AgentEntry>([
        ['review', { agentType: 'review', whenToUse: 'Review', source: 'disk' }],
      ]);
      const programmatic = new Map<string, AgentEntry>();

      const registry = createCompositeAgentRegistry(disk, programmatic);

      assert.equal(registry.size, 1);
      assert.ok(registry.has('review'));
    });
  });

  describe('getDefaultProgrammaticAgents', () => {
    it('includes the fork agent', () => {
      const agents = getDefaultProgrammaticAgents();
      assert.ok(agents.has('fork'));
      assert.equal(agents.get('fork')?.agentType, 'fork');
    });
  });

  describe('getForkAgentDefinition', () => {
    it('returns the FORK_AGENT definition', () => {
      const def = getForkAgentDefinition();
      assert.equal(def.agentType, 'fork');
      assert.equal(def.model, 'inherit');
      assert.equal(def.permissionMode, 'bubble');
      assert.equal(def.maxTurns, 200);
      assert.deepEqual(def.tools, ['*']);
      assert.equal(def.source, 'built-in');
      assert.equal(def.getSystemPrompt(), '');
    });
  });

  describe('shouldUseFork', () => {
    it('returns true when all conditions met', () => {
      const messages = [makeUserMessage('Hello')];
      assert.equal(shouldUseFork(false, false, messages), true);
    });

    it('returns false when in coordinator mode', () => {
      const messages = [makeUserMessage('Hello')];
      assert.equal(shouldUseFork(true, false, messages), false);
    });

    it('returns false when non-interactive', () => {
      const messages = [makeUserMessage('Hello')];
      assert.equal(shouldUseFork(false, true, messages), false);
    });

    it('returns false when in fork child', () => {
      const messages = [makeForkChildMessage()];
      assert.equal(shouldUseFork(false, false, messages), false);
    });

    it('returns false when coordinator AND fork child', () => {
      const messages = [makeForkChildMessage()];
      assert.equal(shouldUseFork(true, false, messages), false);
    });
  });

  describe('buildForkMessages', () => {
    it('replaces tool_result content with placeholder', () => {
      const parentMessages: ForkMessage[] = [
        {
          uuid: 'msg-1',
          type: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/foo' } }],
        },
        {
          uuid: 'msg-2',
          type: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'real file contents' }],
        },
      ];

      const result = buildForkMessages(parentMessages, 'Check the tests');

      // Tool result should be replaced
      const toolResultMsg = result[1];
      const toolResultBlock = toolResultMsg.content[0];
      assert.equal(toolResultBlock.type, 'tool_result');
      if (toolResultBlock.type === 'tool_result') {
        assert.equal(toolResultBlock.content, FORK_PLACEHOLDER_RESULT);
      }
    });

    it('appends boilerplate tag and directive', () => {
      const parentMessages: ForkMessage[] = [
        makeUserMessage('Hello'),
      ];

      const result = buildForkMessages(parentMessages, 'Audit the codebase');

      const lastMsg = result[result.length - 1];
      assert.equal(lastMsg.type, 'user');
      assert.equal(lastMsg.content.length, 2);

      const tagBlock = lastMsg.content[0];
      assert.equal(tagBlock.type, 'text');
      if (tagBlock.type === 'text') {
        assert.ok(tagBlock.text.includes(FORK_BOILERPLATE_TAG));
      }

      const directiveBlock = lastMsg.content[1];
      assert.equal(directiveBlock.type, 'text');
      if (directiveBlock.type === 'text') {
        assert.equal(directiveBlock.text, 'Audit the codebase');
      }
    });

    it('produces identical prefixes for different directives', () => {
      const parentMessages: ForkMessage[] = [
        makeUserMessage('Hello'),
        {
          uuid: 'msg-2',
          type: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
      ];

      const fork1 = buildForkMessages(parentMessages, 'Task A');
      const fork2 = buildForkMessages(parentMessages, 'Task B');

      // All messages except the last should be identical
      assert.deepEqual(fork1.slice(0, -1), fork2.slice(0, -1));
      // Last messages differ in directive
      assert.notDeepEqual(fork1[fork1.length - 1], fork2[fork2.length - 1]);
    });
  });
});
