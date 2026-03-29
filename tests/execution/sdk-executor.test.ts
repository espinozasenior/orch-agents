import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSdkExecutor } from '../../src/execution/runtime/sdk-executor';
import { createLinearToolBridge } from '../../src/integration/linear/linear-client';

const BASE_REQUEST = {
  prompt: 'say hello',
  agentRole: 'coder',
  agentType: '.claude/agents/core/coder.md',
  tier: 2 as const,
  phaseType: 'refinement',
  timeout: 1000,
  metadata: {},
  worktreePath: '/tmp/orch-agents/test-plan',
};

describe('SdkExecutor', () => {
  it('combines multiple assistant text events into one final output and emits normalized progress', async () => {
    const events: Array<Record<string, unknown>> = [];
    const executor = createSdkExecutor({
      eventSink: (payload) => events.push(payload),
      queryFactory: async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello world' }],
          },
        };
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: ' and goodbye' }],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'session-123',
          usage: { input_tokens: 10, output_tokens: 4 },
          is_error: false,
        };
      },
    });

    const result = await executor.execute(BASE_REQUEST);

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'Hello world and goodbye');
    assert.deepEqual(result.tokenUsage, { input: 10, output: 4 });
    assert.equal(result.sessionId, 'session-123');
    assert.match(result.lastActivityAt ?? '', /\d{4}-\d{2}-\d{2}T/);
    assert.ok(events.some((event) => event.type === 'progress'));
    assert.ok(events.some((event) => event.type === 'tokenUsage'));
    assert.ok(events.some((event) => event.type === 'result'));
  });

  it('rejects worktree paths outside allowed temp directories', async () => {
    const executor = createSdkExecutor({
      queryFactory: async function* () {
        yield { type: 'result', subtype: 'success', result: 'ignored', usage: { input_tokens: 1, output_tokens: 1 }, is_error: false };
      },
    });

    const result = await executor.execute({
      ...BASE_REQUEST,
      prompt: 'noop',
      worktreePath: '/Users/not-allowed/project',
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /not within allowed directories/);
  });

  it('normalizes token usage from alternate SDK key names', async () => {
    const executor = createSdkExecutor({
      queryFactory: async function* () {
        yield {
          type: 'assistant',
          text: 'alt usage',
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'alt usage',
          usage: { prompt_tokens: 7, completionTokens: 3 },
          is_error: false,
        };
      },
    });

    const result = await executor.execute(BASE_REQUEST);

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.tokenUsage, { input: 7, output: 3 });
  });

  it('returns failed when the SDK emits an error result', async () => {
    const executor = createSdkExecutor({
      queryFactory: async function* () {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['permission denied'],
          usage: { input_tokens: 2, output_tokens: 0 },
          is_error: true,
          stop_reason: 'error',
        };
      },
    });

    const result = await executor.execute({
      ...BASE_REQUEST,
      prompt: 'noop',
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /permission denied/);
  });

  it('returns resumable continuation metadata when the session ends cleanly but needs another turn', async () => {
    const executor = createSdkExecutor({
      queryFactory: async function* () {
        yield {
          type: 'assistant',
          text: 'partial answer',
          sessionId: 'session-continue',
        };
        yield {
          type: 'result',
          subtype: 'success',
          sessionId: 'session-continue',
          stop_reason: 'max_turns',
          result: 'partial answer',
          is_error: false,
        };
      },
    });

    const result = await executor.execute(BASE_REQUEST);

    assert.equal(result.status, 'completed');
    assert.equal(result.sessionId, 'session-continue');
    assert.deepEqual(result.continuationState, {
      resumable: true,
      sessionId: 'session-continue',
      reason: 'max_turns',
    });
  });

  it('passes an explicit workspace safety policy and executor-owned Linear bridge into the SDK boundary', async () => {
    const toolCalls: Array<{ issueId: string; body: string }> = [];
    let capturedPolicy: Record<string, unknown> | undefined;
    let capturedToolBridge: { invoke(operation: unknown): Promise<unknown> } | undefined;

    const executor = createSdkExecutor({
      linearToolBridge: createLinearToolBridge({
        createComment: async (issueId, body) => {
          toolCalls.push({ issueId, body });
          return 'comment-1';
        },
        updateComment: async () => {},
        updateIssueState: async () => {},
      }),
      queryFactory: async function* (params) {
        capturedPolicy = params.permissionPolicy as Record<string, unknown>;
        capturedToolBridge = params.linearToolBridge;

        yield {
          type: 'tool_call',
          tool: 'linear.createComment',
          arguments: {
            issueId: 'issue-1',
            body: 'Bridge update',
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          is_error: false,
        };
      },
    });

    const result = await executor.execute(BASE_REQUEST);

    assert.equal(result.status, 'completed');
    assert.equal(capturedPolicy?.permissionMode, 'default');
    assert.equal(capturedPolicy?.allowDangerouslySkipPermissions, false);
    assert.ok(capturedToolBridge);
    assert.deepEqual(toolCalls, [{ issueId: 'issue-1', body: 'Bridge update' }]);
  });
});
