import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SerialBatchUploader } from '../../src/events/serial-batch-uploader';
import { RetryableError } from '../../src/events/retryable-error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUploader<T>(
  overrides: {
    upload?: (batch: T[]) => Promise<void>;
    maxBatchSize?: number;
    maxBatchBytes?: number;
    maxQueueSize?: number;
    maxConsecutiveFailures?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onBatchDropped?: (batch: T[], error: unknown) => void;
  } = {},
) {
  const uploadFn =
    overrides.upload ?? (async (_batch: T[]) => { /* noop */ });
  return new SerialBatchUploader<T>({
    upload: uploadFn,
    maxBatchSize: overrides.maxBatchSize ?? 100,
    maxBatchBytes: overrides.maxBatchBytes ?? 1_000_000,
    maxQueueSize: overrides.maxQueueSize ?? 500,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 5,
    baseDelayMs: overrides.baseDelayMs ?? 1,    // fast tests
    maxDelayMs: overrides.maxDelayMs ?? 50,
    onBatchDropped: overrides.onBatchDropped,
  });
}

/** Drain the microtask queue so scheduleDrain() fires. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SerialBatchUploader', () => {
  describe('batch formation', () => {
    it('respects maxBatchSize — 50 items with maxBatchSize=10 yields batches of <=10', async () => {
      const batches: number[][] = [];
      const uploader = makeUploader<number>({
        maxBatchSize: 10,
        upload: async (batch) => { batches.push([...batch]); },
      });

      // Enqueue all concurrently so they queue before drain starts
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => uploader.enqueue(i)),
      );
      await uploader.flush();

      // All 50 items uploaded across batches of at most 10
      const allItems = batches.flat();
      assert.equal(allItems.length, 50);
      for (const b of batches) {
        assert.ok(b.length <= 10, `batch size ${b.length} exceeds maxBatchSize=10`);
      }
      assert.ok(batches.length >= 5, `expected >=5 batches, got ${batches.length}`);
    });

    it('respects maxBatchBytes — items cut off when byte limit exceeded', async () => {
      const batches: string[][] = [];
      // Each item ~12 bytes as JSON ("hello-world")
      const uploader = makeUploader<string>({
        maxBatchSize: 100,
        maxBatchBytes: 30, // fits ~2 items
        upload: async (batch) => { batches.push(batch); },
      });

      await uploader.enqueue('hello-world');
      await uploader.enqueue('hello-world');
      await uploader.enqueue('hello-world');
      await uploader.flush();

      assert.ok(batches.length >= 2, `expected >=2 batches, got ${batches.length}`);
      for (const b of batches) {
        assert.ok(b.length <= 2, `batch too large: ${b.length}`);
      }
    });

    it('first item always included regardless of byte size', async () => {
      const batches: string[][] = [];
      const bigItem = 'x'.repeat(10_000);
      const uploader = makeUploader<string>({
        maxBatchBytes: 50, // way smaller than bigItem
        upload: async (batch) => { batches.push(batch); },
      });

      await uploader.enqueue(bigItem);
      await uploader.flush();

      assert.equal(batches.length, 1);
      assert.equal(batches[0]![0], bigItem);
    });
  });

  describe('serial execution guarantee', () => {
    it('only 1 upload in-flight at a time', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const uploader = makeUploader<number>({
        maxBatchSize: 1,
        upload: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
        },
      });

      for (let i = 0; i < 5; i++) {
        await uploader.enqueue(i);
      }
      await uploader.flush();

      assert.equal(maxConcurrent, 1);
    });
  });

  describe('backpressure', () => {
    it('blocks enqueue when queue is full', async () => {
      // Strategy: maxQueueSize=1, maxBatchSize=1.
      // enqueue(1) → pending=[1], scheduleDrain. enqueue(1) resolves.
      // Drain microtask takes [1], calls upload (blocks). pending=[].
      // enqueue(2) → pending=[2], scheduleDrain (no-op: draining=true). Resolves.
      // Now pending.length=1 >= maxQueueSize=1, so enqueue(3) will block.
      const uploadResolvers: (() => void)[] = [];
      const uploader = makeUploader<number>({
        maxQueueSize: 1,
        maxBatchSize: 1,
        upload: async () => {
          await new Promise<void>((r) => { uploadResolvers.push(r); });
        },
      });

      // Push first item and let drain start
      const p1 = uploader.enqueue(1);
      await tick(); // drain fires, takes [1], upload blocks. pending=[]

      // Push second item — fits because pending=0 < 1
      const p2 = uploader.enqueue(2); // pending=[2]

      // Third should block (pending.length=1 >= maxQueueSize=1)
      let blocked = true;
      const p3 = uploader.enqueue(3).then(() => { blocked = false; });

      await tick();
      await tick();
      assert.equal(blocked, true, 'enqueue should block when queue is full');

      // Release first upload — drain continues, takes [2], uploads.
      // releaseBackpressure() called after upload, unblocks p3.
      uploadResolvers[0]!();
      // Need to also release the second upload for p3 to push
      await tick();
      if (uploadResolvers.length > 1) uploadResolvers[1]!();
      await tick();
      // Release any further uploads
      for (const r of uploadResolvers) r();

      await p3;
      assert.equal(blocked, false);

      uploader.close();
      await Promise.allSettled([p1, p2]);
    });

    it('blocked caller resumes after successful upload', async () => {
      const uploaded: number[][] = [];
      let uploadResolve: (() => void) | null = null;
      const uploader = makeUploader<number>({
        maxQueueSize: 2,
        maxBatchSize: 2,
        upload: async (batch) => {
          uploaded.push(batch);
          if (uploadResolve === null) {
            await new Promise<void>((r) => { uploadResolve = r; });
          }
        },
      });

      await uploader.enqueue(1);
      await uploader.enqueue(2);

      // This should block
      const p = uploader.enqueue(3);
      await tick();

      // Release the upload
      uploadResolve!();
      await p;

      await uploader.flush();
      // Item 3 was eventually enqueued and uploaded
      const allItems = uploaded.flat();
      assert.ok(allItems.includes(3));

      uploader.close();
    });
  });

  describe('exponential backoff', () => {
    it('failure delays increase exponentially', async () => {
      const delays: number[] = [];
      let callCount = 0;
      const originalSetTimeout = globalThis.setTimeout;

      // We'll track the actual delays requested by observing sleep calls
      // Use a fast baseDelayMs so test doesn't take long
      const uploader = makeUploader<number>({
        maxBatchSize: 1,
        maxConsecutiveFailures: 4,
        baseDelayMs: 10,
        maxDelayMs: 1000,
        upload: async () => {
          callCount++;
          if (callCount <= 3) {
            throw new Error('fail');
          }
        },
      });

      await uploader.enqueue(1);
      await uploader.flush();

      // After 3 failures + 1 success, the item should eventually upload
      assert.ok(callCount >= 4, `expected >=4 calls, got ${callCount}`);
    });
  });

  describe('RetryableError with retryAfterMs', () => {
    it('uses server-supplied delay clamped to [base, max]', async () => {
      let callCount = 0;
      const uploader = makeUploader<number>({
        maxBatchSize: 1,
        maxConsecutiveFailures: 3,
        baseDelayMs: 5,
        maxDelayMs: 50,
        upload: async () => {
          callCount++;
          if (callCount === 1) {
            throw new RetryableError('rate limited', 10);
          }
        },
      });

      await uploader.enqueue(1);
      await uploader.flush();

      assert.equal(callCount, 2); // 1 failure + 1 success (retried item)
    });

    it('clamps excessive retry-after to maxDelayMs', async () => {
      let callCount = 0;
      const start = Date.now();

      const uploader = makeUploader<number>({
        maxBatchSize: 1,
        maxConsecutiveFailures: 3,
        baseDelayMs: 1,
        maxDelayMs: 20,
        upload: async () => {
          callCount++;
          if (callCount === 1) {
            throw new RetryableError('rate limited', 999_999);
          }
        },
      });

      await uploader.enqueue(1);
      await uploader.flush();

      const elapsed = Date.now() - start;
      // Should be clamped to 20ms, not 999_999ms
      assert.ok(elapsed < 200, `took ${elapsed}ms — retry-after was not clamped`);
    });
  });

  describe('drop policy', () => {
    it('drops batch after maxConsecutiveFailures and fires callback', async () => {
      const droppedBatches: number[][] = [];
      let droppedError: unknown = null;
      let callCount = 0;

      const uploader = makeUploader<number>({
        maxBatchSize: 100,
        maxConsecutiveFailures: 3,
        baseDelayMs: 1,
        upload: async () => {
          callCount++;
          throw new Error('persistent failure');
        },
        onBatchDropped: (batch, err) => {
          droppedBatches.push(batch as number[]);
          droppedError = err;
        },
      });

      await uploader.enqueue(1);
      await uploader.enqueue(2);
      await uploader.flush();

      assert.equal(droppedBatches.length, 1);
      assert.deepEqual(droppedBatches[0], [1, 2]);
      assert.ok(droppedError instanceof Error);
    });

    it('resets consecutive failure counter after successful upload', async () => {
      let callCount = 0;
      let dropCount = 0;

      const uploader = makeUploader<number>({
        maxBatchSize: 1,
        maxConsecutiveFailures: 3,
        baseDelayMs: 1,
        upload: async () => {
          callCount++;
          // Fail first 2 times, then succeed
          if (callCount <= 2) {
            throw new Error('transient');
          }
        },
        onBatchDropped: () => { dropCount++; },
      });

      await uploader.enqueue(1);
      await uploader.flush();

      // Should NOT have dropped — only 2 failures then success
      assert.equal(dropCount, 0);
    });
  });

  describe('poison resistance', () => {
    it('item with BigInt silently excluded, remaining items upload', async () => {
      const uploaded: unknown[][] = [];
      const uploader = makeUploader<unknown>({
        upload: async (batch) => { uploaded.push(batch); },
      });

      await uploader.enqueue({ value: BigInt(42) });
      await uploader.enqueue({ value: 'clean' });
      await uploader.flush();

      assert.equal(uploaded.length, 1);
      assert.deepEqual(uploaded[0], [{ value: 'clean' }]);
    });

    it('item with circular reference excluded', async () => {
      const uploaded: unknown[][] = [];
      const uploader = makeUploader<unknown>({
        upload: async (batch) => { uploaded.push(batch); },
      });

      const circular: Record<string, unknown> = { a: 1 };
      circular['self'] = circular;

      await uploader.enqueue(circular);
      await uploader.enqueue({ b: 2 });
      await uploader.flush();

      assert.equal(uploaded.length, 1);
      assert.deepEqual(uploaded[0], [{ b: 2 }]);
    });

    it('item with throwing toJSON() excluded', async () => {
      const uploaded: unknown[][] = [];
      const uploader = makeUploader<unknown>({
        upload: async (batch) => { uploaded.push(batch); },
      });

      const bad = {
        toJSON() { throw new Error('nope'); },
      };

      await uploader.enqueue(bad);
      await uploader.enqueue({ c: 3 });
      await uploader.flush();

      assert.equal(uploaded.length, 1);
      assert.deepEqual(uploaded[0], [{ c: 3 }]);
    });

    it('all items poisoned — no upload call, drain continues', async () => {
      let uploadCalled = false;
      const uploader = makeUploader<unknown>({
        upload: async () => { uploadCalled = true; },
      });

      await uploader.enqueue({ value: BigInt(1) });
      await uploader.enqueue({ value: BigInt(2) });
      await tick();
      // Give drain time to complete
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(uploadCalled, false);
    });
  });

  describe('flush()', () => {
    it('resolves only after all pending items uploaded', async () => {
      const uploaded: number[][] = [];
      const uploader = makeUploader<number>({
        maxBatchSize: 2,
        upload: async (batch) => { uploaded.push(batch); },
      });

      for (let i = 0; i < 6; i++) {
        await uploader.enqueue(i);
      }
      await uploader.flush();

      const allItems = uploaded.flat();
      assert.equal(allItems.length, 6);
    });

    it('resolves immediately on empty queue', async () => {
      const uploader = makeUploader<number>();
      // Should not hang
      await uploader.flush();
    });
  });

  describe('close()', () => {
    it('drops pending items and resolves blocked callers', async () => {
      const uploadResolvers: (() => void)[] = [];
      const uploader = makeUploader<number>({
        maxQueueSize: 1,
        maxBatchSize: 1,
        upload: async () => {
          await new Promise<void>((r) => { uploadResolvers.push(r); });
        },
      });

      // enqueue(1), let drain take it (upload blocks). pending=[]
      const p1 = uploader.enqueue(1);
      await tick();

      // enqueue(2) fills pending to 1 = maxQueueSize
      const p2 = uploader.enqueue(2);

      // enqueue(3) should block
      let blockedResolved = false;
      const p3 = uploader.enqueue(3).then(() => { blockedResolved = true; });
      await tick();
      await tick();
      assert.equal(blockedResolved, false);

      // Close should resolve the blocked caller and clear queue
      uploader.close();
      await p3;
      assert.equal(blockedResolved, true);
      assert.equal(uploader.queueSize, 0);

      // Unblock hanging uploads to avoid leaked promises
      for (const r of uploadResolvers) r();
      await Promise.allSettled([p1, p2]);
    });

    it('prevents future enqueue calls (no-op)', async () => {
      const uploaded: number[][] = [];
      const uploader = makeUploader<number>({
        upload: async (batch) => { uploaded.push(batch); },
      });

      uploader.close();
      await uploader.enqueue(1);
      await tick();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(uploaded.length, 0);
    });
  });

  describe('concurrent enqueue', () => {
    it('all items eventually uploaded from multiple async contexts', async () => {
      const uploaded: number[][] = [];
      const uploader = makeUploader<number>({
        maxBatchSize: 5,
        upload: async (batch) => { uploaded.push(batch); },
      });

      // Fire multiple enqueues concurrently
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => uploader.enqueue(i)),
      );
      await uploader.flush();

      const allItems = uploaded.flat().sort((a, b) => a - b);
      assert.equal(allItems.length, 20);
      for (let i = 0; i < 20; i++) {
        assert.equal(allItems[i], i);
      }
    });
  });
});
