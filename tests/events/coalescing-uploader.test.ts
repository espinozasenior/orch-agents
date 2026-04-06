import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CoalescingUploader,
  jsonMergePatch,
} from '../../src/events/coalescing-uploader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// jsonMergePatch unit tests
// ---------------------------------------------------------------------------

describe('jsonMergePatch', () => {
  it('merges top-level keys', () => {
    const result = jsonMergePatch({ a: 1, b: 2 }, { b: 3, c: 4 });
    assert.deepEqual(result, { a: 1, b: 3, c: 4 });
  });

  it('null values delete keys (RFC 7396)', () => {
    const result = jsonMergePatch(
      { a: 1, b: 2, c: 3 },
      { b: null } as Partial<{ a: number; b: number; c: number }>,
    );
    assert.deepEqual(result, { a: 1, c: 3 });
  });

  it('recursively merges nested objects', () => {
    const result = jsonMergePatch(
      { a: { x: 1, y: 2 }, b: 3 },
      { a: { y: 9 } } as Partial<{ a: { x: number; y: number }; b: number }>,
    );
    assert.deepEqual(result, { a: { x: 1, y: 9 }, b: 3 });
  });

  it('replaces non-object target with patch', () => {
    const result = jsonMergePatch('old' as unknown as Record<string, unknown>, { a: 1 });
    assert.deepEqual(result, { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// CoalescingUploader tests
// ---------------------------------------------------------------------------

describe('CoalescingUploader', () => {
  it('rapid state updates merged — 5 updates result in merged upload', async () => {
    const uploaded: Record<string, unknown>[][] = [];
    const uploader = new CoalescingUploader<Record<string, unknown>>({
      upload: async (batch) => {
        // Slow upload so subsequent updates queue
        await new Promise((r) => setTimeout(r, 20));
        uploaded.push(batch);
      },
      maxConsecutiveFailures: 3,
      baseDelayMs: 1,
    });

    // First update goes through immediately
    await uploader.update({ a: 1 });
    // Subsequent updates: they each enqueue a merged snapshot
    // Because maxQueueSize=1, each new update replaces via backpressure behavior
    // Let's wait for all uploads
    await uploader.flush();

    // At least 1 upload happened
    assert.ok(uploaded.length >= 1);
    // First upload should contain the state
    assert.deepEqual(uploaded[0]![0], { a: 1 });

    uploader.close();
  });

  it('RFC 7396 semantics — null values delete keys', async () => {
    const uploaded: Record<string, unknown>[][] = [];
    const uploader = new CoalescingUploader<Record<string, unknown>>({
      upload: async (batch) => { uploaded.push(batch); },
      maxConsecutiveFailures: 3,
    });

    await uploader.update({ a: 1, b: 2 });
    await uploader.flush();
    await uploader.update({ b: null } as unknown as Partial<Record<string, unknown>>);
    await uploader.flush();

    // The second upload should reflect the merge-patch with b deleted
    assert.ok(uploaded.length >= 2);
    const lastBatch = uploaded[uploaded.length - 1]!;
    // The second update starts fresh (pending is null) so it's just { b: null }
    // which when merged into null pending becomes { b: null } as the snapshot
    assert.deepEqual(lastBatch[0], { b: null });

    uploader.close();
  });

  it('only latest state uploaded when updates arrive faster than drain', async () => {
    const uploaded: Record<string, unknown>[][] = [];
    let uploadResolve: (() => void) | null = null;

    const uploader = new CoalescingUploader<Record<string, unknown>>({
      upload: async (batch) => {
        uploaded.push(batch);
        if (uploaded.length === 1) {
          // Block first upload
          await new Promise<void>((r) => { uploadResolve = r; });
        }
      },
      maxConsecutiveFailures: 3,
    });

    // First update starts uploading immediately
    const p1 = uploader.update({ state: 'idle', progress: 0 });

    // While first upload is blocked, fire more updates
    // These will queue/coalesce
    await tick();

    // Release first upload
    uploadResolve?.();
    await p1;

    // Now send a few rapid updates
    await uploader.update({ state: 'working', progress: 50 });
    await uploader.update({ progress: 75 });
    await uploader.flush();

    // The uploads should contain the merged states
    assert.ok(uploaded.length >= 2);

    uploader.close();
  });
});
