import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';

import { createSdkExecutor } from '../../../src/execution/runtime/sdk-executor.js';
import { createEventBus, createDomainEvent } from '../../../src/kernel/event-bus.js';
import type { InteractiveExecutionRequest } from '../../../src/execution/runtime/interactive-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktree(): string {
  // sdk-executor requires worktreePath under /tmp, /var/tmp, or /private/tmp.
  // On macOS os.tmpdir() returns /var/folders/... which is rejected, so we
  // use /tmp directly.
  return mkdtempSync('/tmp/sdk-exec-test-');
}

function makeRequest(
  worktreePath: string,
  metadata: Record<string, unknown> = {},
): InteractiveExecutionRequest {
  return {
    prompt: 'do work',
    agentRole: 'coder',
    agentType: 'coder',
    tier: 2,
    phaseType: 'refinement',
    timeout: 60_000,
    metadata,
    worktreePath,
  };
}

/** Async-iterable factory yielding a single result event. */
function makeOkStream() {
  return (async function* () {
    yield { type: 'text', text: 'hello' };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hello',
      session_id: 'sess-1',
    };
  })();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sdk-executor — P11 wiring', () => {
  describe('overload retry (FR-P11-004)', () => {
    it('retries 529 errors during query construction with exponential backoff', async () => {
      const wt = makeWorktree();
      let calls = 0;
      const delays: number[] = [];
      const exec = createSdkExecutor({
        queryFactory: async () => {
          calls++;
          if (calls < 3) {
            throw { status: 529, message: 'overloaded' };
          }
          return makeOkStream();
        },
        overloadRetry: {
          sleep: async (ms) => { delays.push(ms); },
          random: () => 0.5,
        },
      });
      const result = await exec.execute(makeRequest(wt));
      assert.equal(result.status, 'completed');
      assert.equal(calls, 3);
      assert.deepEqual(delays, [1000, 2000]);
    });

    it('returns failed with overloaded_exhausted after exhausting retries', async () => {
      const wt = makeWorktree();
      const exec = createSdkExecutor({
        queryFactory: async () => {
          throw { status: 529, message: 'still overloaded' };
        },
        overloadRetry: {
          sleep: async () => {},
          random: () => 0.5,
        },
      });
      const result = await exec.execute(makeRequest(wt));
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /overloaded_exhausted/);
    });

    it('does not retry non-overload errors', async () => {
      const wt = makeWorktree();
      let calls = 0;
      const exec = createSdkExecutor({
        queryFactory: async () => {
          calls++;
          throw new Error('500 internal server error');
        },
      });
      const result = await exec.execute(makeRequest(wt));
      assert.equal(result.status, 'failed');
      assert.equal(calls, 1);
    });

    it('emits OverloadRetry observability events when emitter is wired', async () => {
      const wt = makeWorktree();
      const events: Array<{ type: string }> = [];
      let calls = 0;
      const exec = createSdkExecutor({
        queryFactory: async () => {
          calls++;
          if (calls < 2) throw { status: 529 };
          return makeOkStream();
        },
        overloadRetry: { sleep: async () => {}, random: () => 0.5 },
        emitQueryEvent: (e) => events.push(e),
      });
      await exec.execute(makeRequest(wt, { taskId: 'task-77' }));
      assert.ok(events.some((e) => e.type === 'OverloadRetry'));
    });
  });

  describe('WorkCancelled abort propagation (FR-P11-006)', () => {
    it('aborts an in-flight execution when WorkCancelled fires for the workItemId', async () => {
      const wt = makeWorktree();
      const bus = createEventBus();

      // Stream that yields a few events with a small delay so we can
      // fire the cancellation mid-iteration.
      const slowStream = (async function* () {
        yield { type: 'text', text: 'partial-1' };
        await new Promise((r) => setTimeout(r, 10));
        // The cancellation should have flipped the abort controller by
        // now; the executor should break out before observing the
        // result event below.
        yield { type: 'text', text: 'partial-2' };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'should-not-reach',
        };
      })();

      const exec = createSdkExecutor({
        queryFactory: () => slowStream,
        eventBus: bus,
      });

      const promise = exec.execute(makeRequest(wt, { workItemId: 'WORK-1' }));
      // Fire cancellation on next tick.
      setTimeout(() => {
        bus.publish(createDomainEvent('WorkCancelled', {
          workItemId: 'WORK-1',
          cancellationReason: 'user',
        }));
      }, 1);

      const result = await promise;
      // The executor breaks out of the loop with resultError='cancelled',
      // which leads to a failed status.
      assert.equal(result.status, 'failed');
      assert.equal(result.error, 'cancelled');
    });

    it('does not bind the registry when no eventBus is provided', async () => {
      const wt = makeWorktree();
      const exec = createSdkExecutor({
        queryFactory: () => makeOkStream(),
      });
      const result = await exec.execute(makeRequest(wt, { workItemId: 'WORK-1' }));
      assert.equal(result.status, 'completed');
    });

    it('disposes the stop registry on terminal exit (no leaked subscription)', async () => {
      const wt = makeWorktree();
      const bus = createEventBus();
      const exec = createSdkExecutor({
        queryFactory: () => makeOkStream(),
        eventBus: bus,
      });
      const result = await exec.execute(makeRequest(wt, { workItemId: 'WORK-1' }));
      assert.equal(result.status, 'completed');
      // After execution, publishing WorkCancelled should not crash and
      // should not affect anything (registry was disposed).
      bus.publish(createDomainEvent('WorkCancelled', {
        workItemId: 'WORK-1',
        cancellationReason: 'user',
      }));
    });
  });

  describe('backward compatibility', () => {
    it('happy path with no P11 deps still works (no eventBus, no emitter)', async () => {
      const wt = makeWorktree();
      const exec = createSdkExecutor({
        queryFactory: () => makeOkStream(),
      });
      const result = await exec.execute(makeRequest(wt));
      assert.equal(result.status, 'completed');
      assert.equal(result.output, 'hello');
    });
  });

  describe('AgentTool event interception (Step 2)', () => {
    it('emits agentSpawn event when Agent tool_use event is yielded', async () => {
      const wt = makeWorktree();
      const events: Array<Record<string, unknown>> = [];
      const agentToolStream = (async function* () {
        yield {
          type: 'tool_use',
          name: 'Agent',
          input: {
            prompt: 'Implement the auth middleware in src/auth.ts with JWT validation',
            subagent_type: 'coder',
            description: 'Auth implementation worker',
          },
        };
        yield { type: 'text', text: 'spawned worker' };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
          session_id: 'sess-agent-1',
        };
      })();

      const exec = createSdkExecutor({
        queryFactory: () => agentToolStream,
        eventSink: (payload) => events.push(payload),
      });
      await exec.execute(makeRequest(wt));

      const spawnEvents = events.filter((e) => e.type === 'agentSpawn');
      assert.equal(spawnEvents.length, 1, 'should emit exactly one agentSpawn event');
      assert.equal(spawnEvents[0].agentRole, 'coder');
      assert.ok(
        (spawnEvents[0].childPrompt as string).startsWith('Implement the auth middleware'),
        'childPrompt should be truncated prefix of the prompt',
      );
      assert.equal(spawnEvents[0].childSubagentType, 'coder');
    });

    it('emits agentSpawn for AgentTool name variant', async () => {
      const wt = makeWorktree();
      const events: Array<Record<string, unknown>> = [];
      const agentToolStream = (async function* () {
        yield {
          type: 'tool_call',
          tool: 'AgentTool',
          arguments: {
            prompt: 'Research the codebase structure',
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        };
      })();

      const exec = createSdkExecutor({
        queryFactory: () => agentToolStream,
        eventSink: (payload) => events.push(payload),
      });
      await exec.execute(makeRequest(wt));

      const spawnEvents = events.filter((e) => e.type === 'agentSpawn');
      assert.equal(spawnEvents.length, 1);
      assert.ok(
        (spawnEvents[0].childPrompt as string).startsWith('Research the codebase'),
      );
    });

    it('does not emit agentSpawn for non-Agent tool events', async () => {
      const wt = makeWorktree();
      const events: Array<Record<string, unknown>> = [];
      const stream = (async function* () {
        yield {
          type: 'tool_use',
          name: 'Edit',
          input: { file: 'src/foo.ts' },
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        };
      })();

      const exec = createSdkExecutor({
        queryFactory: () => stream,
        eventSink: (payload) => events.push(payload),
      });
      await exec.execute(makeRequest(wt));

      const spawnEvents = events.filter((e) => e.type === 'agentSpawn');
      assert.equal(spawnEvents.length, 0, 'should not emit agentSpawn for non-Agent tools');
    });
  });

  describe('depth limiting (Step 5)', () => {
    it('removes Agent from allowedTools when ORCH_AGENT_DEPTH is at max', async () => {
      const wt = makeWorktree();
      let capturedAllowedTools: string[] = [];
      const exec = createSdkExecutor({
        allowedTools: ['Edit', 'Write', 'Read', 'Bash', 'Agent'],
        queryFactory: async (params) => {
          capturedAllowedTools = params.allowedTools;
          return makeOkStream();
        },
        agentDepth: 3,
      });
      await exec.execute(makeRequest(wt));

      assert.ok(
        !capturedAllowedTools.includes('Agent'),
        'Agent should be removed from allowedTools at max depth',
      );
      assert.ok(
        !capturedAllowedTools.includes('AgentTool'),
        'AgentTool should be removed from allowedTools at max depth',
      );
    });

    it('keeps Agent in allowedTools when depth is below max', async () => {
      const wt = makeWorktree();
      let capturedAllowedTools: string[] = [];
      const exec = createSdkExecutor({
        allowedTools: ['Edit', 'Write', 'Read', 'Bash', 'Agent'],
        queryFactory: async (params) => {
          capturedAllowedTools = params.allowedTools;
          return makeOkStream();
        },
        agentDepth: 1,
      });
      await exec.execute(makeRequest(wt));

      assert.ok(
        capturedAllowedTools.includes('Agent'),
        'Agent should remain in allowedTools below max depth',
      );
    });

    it('defaults agentDepth to 0 when not provided', async () => {
      const wt = makeWorktree();
      let capturedAllowedTools: string[] = [];
      const exec = createSdkExecutor({
        allowedTools: ['Edit', 'Write', 'Read', 'Bash', 'Agent'],
        queryFactory: async (params) => {
          capturedAllowedTools = params.allowedTools;
          return makeOkStream();
        },
      });
      await exec.execute(makeRequest(wt));

      assert.ok(
        capturedAllowedTools.includes('Agent'),
        'Agent should remain when no agentDepth provided (defaults to 0)',
      );
    });
  });
});
