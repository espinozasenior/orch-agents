/**
 * Sequence number tracker for cross-transport continuity.
 * FR-9E.09: Sequence number continuity across transport swaps.
 * Prevents full history replay on failover and filters duplicates.
 */

export class SequenceTracker {
  private _lastSeq: number = -1;

  /**
   * Attempt to advance the sequence.
   * Returns true if the message is new (seq > lastSeq), false if duplicate/out-of-order.
   */
  advance(seq: number): boolean {
    if (seq <= this._lastSeq) {
      return false; // duplicate or out-of-order — skip
    }
    this._lastSeq = seq;
    return true;
  }

  /**
   * Get the last seen sequence number.
   * Returns -1 before any messages have been processed.
   */
  getLastSequenceNum(): number {
    return this._lastSeq;
  }

  /**
   * Reset the tracker to initial state.
   */
  reset(): void {
    this._lastSeq = -1;
  }
}
