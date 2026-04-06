import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SequenceTracker } from '../../src/transport/sequence-tracker.js';

describe('SequenceTracker', () => {
  it('returns -1 before any messages', () => {
    const tracker = new SequenceTracker();
    assert.equal(tracker.getLastSequenceNum(), -1);
  });

  it('sequential messages all return advance = true', () => {
    const tracker = new SequenceTracker();
    assert.equal(tracker.advance(1), true);
    assert.equal(tracker.advance(2), true);
    assert.equal(tracker.advance(3), true);
    assert.equal(tracker.getLastSequenceNum(), 3);
  });

  it('duplicate message returns advance = false', () => {
    const tracker = new SequenceTracker();
    assert.equal(tracker.advance(2), true);
    assert.equal(tracker.advance(2), false); // duplicate
    assert.equal(tracker.getLastSequenceNum(), 2);
  });

  it('out-of-order message (lower seq) returns advance = false', () => {
    const tracker = new SequenceTracker();
    assert.equal(tracker.advance(3), true);
    assert.equal(tracker.advance(1), false); // out-of-order
    assert.equal(tracker.getLastSequenceNum(), 3);
  });

  it('returns highest seen sequence number', () => {
    const tracker = new SequenceTracker();
    tracker.advance(5);
    tracker.advance(10);
    tracker.advance(7); // out-of-order, ignored
    assert.equal(tracker.getLastSequenceNum(), 10);
  });

  it('handles gap in sequence numbers (seq 1, 5, 6)', () => {
    const tracker = new SequenceTracker();
    assert.equal(tracker.advance(1), true);
    assert.equal(tracker.advance(5), true); // gap is fine
    assert.equal(tracker.advance(6), true);
    assert.equal(tracker.getLastSequenceNum(), 6);
  });

  it('reset() returns to initial state', () => {
    const tracker = new SequenceTracker();
    tracker.advance(10);
    assert.equal(tracker.getLastSequenceNum(), 10);

    tracker.reset();
    assert.equal(tracker.getLastSequenceNum(), -1);
    assert.equal(tracker.advance(1), true);
  });

  it('advance(0) works from initial state', () => {
    const tracker = new SequenceTracker();
    assert.equal(tracker.advance(0), true);
    assert.equal(tracker.getLastSequenceNum(), 0);
  });
});
