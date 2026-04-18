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
});
