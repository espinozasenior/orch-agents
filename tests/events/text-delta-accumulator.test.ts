import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TextDeltaAccumulator } from '../../src/events/text-delta-accumulator';

describe('TextDeltaAccumulator', () => {
  let accumulator: TextDeltaAccumulator | null = null;

  afterEach(() => {
    accumulator?.close();
    accumulator = null;
  });

  it('accumulates deltas into buffer', () => {
    const snapshots: string[] = [];
    accumulator = new TextDeltaAccumulator({
      flushIntervalMs: 1000, // won't fire during test
      onSnapshot: (s) => snapshots.push(s),
    });

    accumulator.append('Hello');
    accumulator.append(' ');
    accumulator.append('World');

    const result = accumulator.flush();
    assert.equal(result, 'Hello World');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0], 'Hello World');
  });

  it('snapshot emitted after flush interval', async () => {
    const snapshots: string[] = [];
    accumulator = new TextDeltaAccumulator({
      flushIntervalMs: 30,
      onSnapshot: (s) => snapshots.push(s),
    });

    accumulator.append('chunk1');
    accumulator.append('chunk2');

    // Wait for the timer to fire
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0], 'chunk1chunk2');
  });

  it('rapid deltas within interval produce single snapshot with full text', async () => {
    const snapshots: string[] = [];
    accumulator = new TextDeltaAccumulator({
      flushIntervalMs: 50,
      onSnapshot: (s) => snapshots.push(s),
    });

    // Fire 10 rapid deltas
    for (let i = 0; i < 10; i++) {
      accumulator.append(`d${i}`);
    }

    // Wait for timer
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0], 'd0d1d2d3d4d5d6d7d8d9');
  });

  it('flush() emits immediately and returns full-so-far buffer', () => {
    const snapshots: string[] = [];
    accumulator = new TextDeltaAccumulator({
      flushIntervalMs: 10_000,
      onSnapshot: (s) => snapshots.push(s),
    });

    accumulator.append('data');
    const result = accumulator.flush();

    assert.equal(result, 'data');
    assert.equal(snapshots.length, 1);

    // Buffer keeps the full-so-far text (not cleared).
    // Second flush re-emits the same snapshot.
    const result2 = accumulator.flush();
    assert.equal(result2, 'data');
    assert.equal(snapshots.length, 2);
  });

  it('close() clears timer and buffer', () => {
    const snapshots: string[] = [];
    accumulator = new TextDeltaAccumulator({
      flushIntervalMs: 50,
      onSnapshot: (s) => snapshots.push(s),
    });

    accumulator.append('data');
    accumulator.close();

    // No snapshot should have been emitted
    assert.equal(snapshots.length, 0);
  });
});
