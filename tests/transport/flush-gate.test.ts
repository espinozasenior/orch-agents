import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FlushGate, FlushGateOverflowError } from '../../src/transport/flush-gate.js';

describe('FlushGate', () => {
  let gate: FlushGate<string>;
  let delivered: string[];

  beforeEach(() => {
    delivered = [];
    gate = new FlushGate<string>();
    gate.onMessage(async (msg) => {
      delivered.push(msg);
    });
  });

  describe('queuing state', () => {
    it('buffers messages and does not deliver them', async () => {
      await gate.receive('live-1');
      await gate.receive('live-2');

      assert.equal(gate.state, 'queuing');
      assert.equal(gate.queueLength, 2);
      assert.deepEqual(delivered, []);
    });
  });

  describe('flush()', () => {
    it('delivers historical messages in order, then drains queue FIFO', async () => {
      // Queue some live messages first
      await gate.receive('live-1');
      await gate.receive('live-2');

      // Flush with historical messages
      await gate.flush(['hist-1', 'hist-2', 'hist-3']);

      assert.deepEqual(delivered, [
        'hist-1', 'hist-2', 'hist-3',  // historical in order
        'live-1', 'live-2',            // queued live in FIFO
      ]);
      assert.equal(gate.state, 'open');
    });

    it('opens gate immediately with empty historical array', async () => {
      await gate.flush([]);
      assert.equal(gate.state, 'open');
      assert.deepEqual(delivered, []);
    });

    it('handles live messages arriving during flush delivery', async () => {
      // Set up a handler that simulates concurrent receive during flush
      const order: string[] = [];
      const concurrentGate = new FlushGate<string>();

      let flushStarted = false;
      concurrentGate.onMessage(async (msg) => {
        order.push(msg);
        // Simulate: while flushing historical, a live message arrives
        if (msg === 'hist-1' && !flushStarted) {
          flushStarted = true;
          // This should be queued since we're still flushing
          await concurrentGate.receive('concurrent-live');
        }
      });

      await concurrentGate.receive('pre-live');
      await concurrentGate.flush(['hist-1', 'hist-2']);

      assert.deepEqual(order, [
        'hist-1', 'hist-2',      // historical
        'pre-live',              // pre-queued live
        'concurrent-live',       // concurrent live queued during flush
      ]);
    });
  });

  describe('open state', () => {
    it('passes messages through immediately', async () => {
      await gate.flush([]); // open the gate
      assert.equal(gate.state, 'open');

      await gate.receive('passthrough-1');
      await gate.receive('passthrough-2');

      assert.deepEqual(delivered, ['passthrough-1', 'passthrough-2']);
      assert.equal(gate.queueLength, 0);
    });
  });

  describe('queue overflow', () => {
    it('throws FlushGateOverflowError at maxQueueSize', async () => {
      const smallGate = new FlushGate<number>({ maxQueueSize: 3 });
      smallGate.onMessage(async () => {});

      await smallGate.receive(1);
      await smallGate.receive(2);
      await smallGate.receive(3);

      await assert.rejects(
        () => smallGate.receive(4),
        (err: Error) => {
          assert.ok(err instanceof FlushGateOverflowError);
          assert.match(err.message, /Queue exceeded 3 messages/);
          return true;
        }
      );
    });

    it('logs warning at 5000 messages', async () => {
      const warnings: string[] = [];
      const bigGate = new FlushGate<number>({
        onWarning: (msg) => warnings.push(msg),
      });
      bigGate.onMessage(async () => {});

      // Fill to exactly warning threshold
      for (let i = 0; i < 5001; i++) {
        await bigGate.receive(i);
      }

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /5000/);
    });
  });

  describe('reset()', () => {
    it('returns gate to queuing state and clears the queue', async () => {
      await gate.receive('msg-1');
      assert.equal(gate.queueLength, 1);

      gate.reset();

      assert.equal(gate.state, 'queuing');
      assert.equal(gate.queueLength, 0);
    });

    it('allows re-flushing after reset', async () => {
      await gate.flush(['first-flush']);
      assert.equal(gate.state, 'open');

      gate.reset();
      assert.equal(gate.state, 'queuing');

      await gate.receive('new-live');
      await gate.flush(['second-flush']);

      // delivered includes first-flush from before reset, plus new ones
      assert.deepEqual(delivered, ['first-flush', 'second-flush', 'new-live']);
    });
  });

  describe('no handler registered', () => {
    it('does not throw when no handler is set', async () => {
      const noHandlerGate = new FlushGate<string>();
      await noHandlerGate.flush(['msg']);
      assert.equal(noHandlerGate.state, 'open');
    });
  });
});
