import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  callWithOverloadRetry,
  isOverloadedError,
  abortableSleep,
  OverloadExhaustedError,
  OverloadAbortedError,
  DEFAULT_OVERLOAD_MAX_RETRIES,
  type QueryLoopEvent,
} from '../../src/query/index.js';

// Deterministic helpers --------------------------------------------------

/** Sleeper that records delays without actually waiting. */
function recordingSleep(): {
  delays: number[];
  fn: (ms: number, signal?: AbortSignal) => Promise<void>;
} {
  const delays: number[] = [];
  return {
    delays,
    fn: async (ms, signal) => {
      delays.push(ms);
      if (signal?.aborted) throw new OverloadAbortedError();
    },
  };
}

const fixedRandom = () => 0.5; // jitter centred → no perturbation when (0.5*2-1)=0

describe('isOverloadedError', () => {
  it('detects status === 529', () => {
    assert.equal(isOverloadedError({ status: 529 }), true);
  });
  it('detects statusCode === 529', () => {
    assert.equal(isOverloadedError({ statusCode: 529 }), true);
  });
  it('detects type === overloaded_error', () => {
    assert.equal(isOverloadedError({ type: 'overloaded_error' }), true);
  });
  it('detects nested error.type === overloaded_error', () => {
    assert.equal(
      isOverloadedError({ error: { type: 'overloaded_error' } }),
      true,
    );
  });
  it('detects message containing "overloaded" (case-insensitive)', () => {
    assert.equal(
      isOverloadedError(new Error('Service Overloaded, retry later')),
      true,
    );
  });
  it('returns false for unrelated errors', () => {
    assert.equal(isOverloadedError(new Error('not found')), false);
    assert.equal(isOverloadedError({ status: 500 }), false);
    assert.equal(isOverloadedError(null), false);
    assert.equal(isOverloadedError(undefined), false);
  });
});

describe('callWithOverloadRetry', () => {
  it('returns the value on first success without retry', async () => {
    const sleep = recordingSleep();
    const result = await callWithOverloadRetry(async () => 'ok', {
      sleep: sleep.fn,
      random: fixedRandom,
    });
    assert.equal(result, 'ok');
    assert.equal(sleep.delays.length, 0);
  });

  it('retries on overloaded errors with exponential backoff: 1s, 2s, 4s, 8s', async () => {
    const sleep = recordingSleep();
    let calls = 0;
    const result = await callWithOverloadRetry(
      async () => {
        calls++;
        if (calls < 5) throw { status: 529 };
        return 'eventually-ok';
      },
      { sleep: sleep.fn, random: fixedRandom },
    );
    assert.equal(result, 'eventually-ok');
    assert.equal(calls, 5); // initial + 4 retries
    assert.deepEqual(sleep.delays, [1000, 2000, 4000, 8000]);
  });

  it('throws OverloadExhaustedError after maxRetries', async () => {
    const sleep = recordingSleep();
    await assert.rejects(
      callWithOverloadRetry(
        async () => {
          throw { status: 529, message: 'still busy' };
        },
        { sleep: sleep.fn, random: fixedRandom },
      ),
      (err: unknown) => {
        assert.ok(err instanceof OverloadExhaustedError);
        assert.equal((err as OverloadExhaustedError).attempts, DEFAULT_OVERLOAD_MAX_RETRIES + 1);
        return true;
      },
    );
    assert.equal(sleep.delays.length, DEFAULT_OVERLOAD_MAX_RETRIES);
  });

  it('propagates non-overload errors immediately on first failure', async () => {
    const sleep = recordingSleep();
    let calls = 0;
    await assert.rejects(
      callWithOverloadRetry(
        async () => {
          calls++;
          throw new Error('500 internal');
        },
        { sleep: sleep.fn, random: fixedRandom },
      ),
      /500 internal/,
    );
    assert.equal(calls, 1);
    assert.equal(sleep.delays.length, 0);
  });

  it('emits OverloadRetry observability event per attempt', async () => {
    const sleep = recordingSleep();
    const events: QueryLoopEvent[] = [];
    let calls = 0;
    await callWithOverloadRetry(
      async () => {
        calls++;
        if (calls < 3) throw { status: 529, message: 'busy' };
        return 'ok';
      },
      {
        sleep: sleep.fn,
        random: fixedRandom,
        emit: (e) => events.push(e),
        taskId: 'task-xyz',
      },
    );
    const retries = events.filter((e) => e.type === 'OverloadRetry');
    assert.equal(retries.length, 2);
    assert.equal(retries[0].type === 'OverloadRetry' && retries[0].taskId, 'task-xyz');
    assert.equal(retries[0].type === 'OverloadRetry' && retries[0].attempt, 1);
    assert.equal(retries[1].type === 'OverloadRetry' && retries[1].attempt, 2);
  });

  it('aborts pending backoff on signal — throws OverloadAbortedError', async () => {
    const ac = new AbortController();
    const abortingSleep = async (_ms: number, signal?: AbortSignal) => {
      ac.abort();
      if (signal?.aborted) throw new OverloadAbortedError();
    };
    await assert.rejects(
      callWithOverloadRetry(
        async () => { throw { status: 529 }; },
        { sleep: abortingSleep, random: fixedRandom, signal: ac.signal },
      ),
      (err: unknown) => err instanceof OverloadAbortedError,
    );
  });

  it('honours custom maxRetries', async () => {
    const sleep = recordingSleep();
    await assert.rejects(
      callWithOverloadRetry(
        async () => { throw { status: 529 }; },
        { sleep: sleep.fn, random: fixedRandom, maxRetries: 2 },
      ),
      OverloadExhaustedError,
    );
    assert.equal(sleep.delays.length, 2);
    assert.deepEqual(sleep.delays, [1000, 2000]);
  });

  it('jitter ratio shifts delay within ±25% bounds (no fixed seed)', async () => {
    const sleep = recordingSleep();
    let calls = 0;
    await callWithOverloadRetry(
      async () => {
        calls++;
        if (calls < 2) throw { status: 529 };
        return 'ok';
      },
      { sleep: sleep.fn, random: () => 1.0 /* full positive jitter */ },
    );
    assert.equal(sleep.delays.length, 1);
    // 1000 + 1000*0.25*1 = 1250
    assert.equal(sleep.delays[0], 1250);
  });
});

describe('abortableSleep', () => {
  it('resolves after the requested delay', async () => {
    const t0 = Date.now();
    await abortableSleep(20);
    assert.ok(Date.now() - t0 >= 18);
  });
  it('rejects immediately if signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(abortableSleep(1000, ac.signal), OverloadAbortedError);
  });
  it('rejects when signal aborts during wait', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(abortableSleep(1000, ac.signal), OverloadAbortedError);
  });
});
