/**
 * Phase 9A-9E: Integration Staging Tests
 *
 * Validates implementations against spec acceptance criteria.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// 9A
import {
  AgentMessageType,
  ContextOverflowError,
  OutputTruncatedError,
} from '../../src/execution/runtime/agent-message-types';
import { MemoryTransport } from '../../src/execution/runtime/transport-inbound';

// 9B
import {
  encodeMessage,
  decodeMessage,
  MESSAGE_TYPES,
  type AnyMessage,
  type TaskMessage,
} from '../../src/execution/runtime/ndjson-protocol';
import {
  sessionTransition,
  isValidTransition,
} from '../../src/execution/runtime/session-state-machine';

// 9C
import { SerialBatchUploader } from '../../src/events/serial-batch-uploader';
import { CoalescingUploader } from '../../src/events/coalescing-uploader';
import { TextDeltaAccumulator } from '../../src/events/text-delta-accumulator';
import { RetryableError } from '../../src/events/retryable-error';

// 9D
import { CapacityWake } from '../../src/execution/runtime/capacity-wake';
import { CapacityMetricsCollector } from '../../src/execution/runtime/capacity-metrics';
import { parsePollConfig } from '../../src/execution/runtime/capacity-types';

// 9E
import { FlushGate } from '../../src/transport/flush-gate';
import { encodeNdjson, decodeNdjson } from '../../src/transport/ndjson';
import { SequenceTracker } from '../../src/transport/sequence-tracker';
import { isPermanentCloseCode } from '../../src/transport/transport';
import {
  createReconnectionState,
  shouldReconnect,
  nextBackoff,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
} from '../../src/transport/reconnection';

// ===================================================================
// Phase 9A
// ===================================================================

describe('9A Staging: AgentRunner types', () => {
  it('FR-9A.02: all 5 message types defined', () => {
    assert.equal(AgentMessageType.UserTask, 'user_task');
    assert.equal(AgentMessageType.ControlResponse, 'control_response');
    assert.equal(AgentMessageType.KeepAlive, 'keep_alive');
    assert.equal(AgentMessageType.EnvUpdate, 'env_update');
    assert.equal(AgentMessageType.Shutdown, 'shutdown');
  });

  it('FR-9A.03: MemoryTransport for testing', () => {
    const t = new MemoryTransport();
    assert.equal(typeof t.messages, 'function', 'Has messages()');
    const stream = t.messages();
    assert.equal(typeof stream[Symbol.asyncIterator], 'function', 'messages() is async iterable');
    assert.equal(typeof t.push, 'function', 'Has push()');
    assert.equal(typeof t.end, 'function', 'Has end()');
    assert.equal(typeof t.disconnect, 'function', 'Has disconnect()');
  });

  it('FR-9A.04: ContextOverflowError for reactive compact', () => {
    const err = new ContextOverflowError('overflow');
    assert.ok(err instanceof Error);
  });

  it('FR-9A.08: OutputTruncatedError for max-output recovery', () => {
    const err = new OutputTruncatedError('truncated');
    assert.ok(err instanceof Error);
  });
});

// ===================================================================
// Phase 9B
// ===================================================================

describe('9B Staging: NDJSON Protocol', () => {
  it('FR-9B.03: 6 message types defined', () => {
    assert.deepEqual([...MESSAGE_TYPES], ['task', 'result', 'permission_request', 'permission_response', 'status', 'error']);
  });

  it('FR-9B.03: encode/decode round-trips with required fields', () => {
    const msg: TaskMessage = {
      type: 'task',
      id: 'task-1',
      sessionId: 'sess-1',
      timestamp: Date.now(),
      payload: { prompt: 'hello' },
    };
    const encoded = encodeMessage(msg);
    assert.ok(encoded.endsWith('\n'));
    const decoded = decodeMessage(encoded.trim());
    assert.equal(decoded.type, 'task');
    assert.equal(decoded.id, 'task-1');
    assert.equal(decoded.sessionId, 'sess-1');
  });

  it('FR-9B.03: all message types encodable', () => {
    const now = Date.now();
    const messages: AnyMessage[] = [
      { type: 'task', id: 't1', sessionId: 's1', timestamp: now, payload: { prompt: 'test' } },
      { type: 'result', id: 'r1', sessionId: 's1', timestamp: now, payload: { success: true, output: 'done' } },
      { type: 'permission_request', id: 'p1', sessionId: 's1', timestamp: now, payload: { tool: 'Bash' } },
      { type: 'permission_response', id: 'p2', sessionId: 's1', timestamp: now, payload: { approved: true } },
      { type: 'status', id: 's2', sessionId: 's1', timestamp: now, payload: {} },
      { type: 'error', id: 'e1', sessionId: 's1', timestamp: now, payload: { code: 'ERR', message: 'fail' } },
    ];
    for (const msg of messages) {
      const decoded = decodeMessage(encodeMessage(msg).trim());
      assert.equal(decoded.type, msg.type);
    }
  });
});

describe('9B Staging: Session State Machine', () => {
  it('FR-9B.04: valid transitions', () => {
    // sessionTransition returns { from, to, timestamp }
    assert.equal(sessionTransition('idle', 'working').to, 'working');
    assert.equal(sessionTransition('working', 'idle').to, 'idle');
    assert.equal(sessionTransition('working', 'requires_action').to, 'requires_action');
    assert.equal(sessionTransition('idle', 'draining').to, 'draining');
  });

  it('FR-9B.04: invalid transitions throw', () => {
    assert.throws(() => sessionTransition('failed', 'idle'));
  });

  it('FR-9B.04: isValidTransition helper', () => {
    assert.equal(isValidTransition('idle', 'working'), true);
    assert.equal(isValidTransition('failed', 'idle'), false);
  });
});

// ===================================================================
// Phase 9C
// ===================================================================

describe('9C Staging: SerialBatchUploader', () => {
  it('FR-9C.02: only 1 upload in-flight', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const uploader = new SerialBatchUploader<number>({
      maxBatchSize: 2,
      upload: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 10));
        concurrent--;
      },
    });
    for (let i = 0; i < 6; i++) await uploader.enqueue(i);
    await uploader.flush();
    uploader.close();
    assert.equal(maxConcurrent, 1);
  });

  it('FR-9C.07: poison items excluded silently', async () => {
    const uploaded: unknown[][] = [];
    const uploader = new SerialBatchUploader<unknown>({
      maxBatchSize: 10,
      upload: async (batch) => { uploaded.push(batch); },
    });
    await uploader.enqueue({ ok: true });
    await uploader.enqueue(BigInt(42));
    await uploader.enqueue({ also: 'ok' });
    await uploader.flush();
    uploader.close();
    assert.ok(uploaded.flat().length >= 2);
  });

  it('FR-9C.08: flush drains all pending', async () => {
    const uploaded: number[][] = [];
    const uploader = new SerialBatchUploader<number>({
      maxBatchSize: 5,
      upload: async (batch) => { uploaded.push(batch); },
    });
    await uploader.enqueue(1);
    await uploader.enqueue(2);
    await uploader.flush();
    uploader.close();
    assert.ok(uploaded.flat().includes(1));
    assert.ok(uploaded.flat().includes(2));
  });
});

describe('9C Staging: CoalescingUploader', () => {
  it('FR-9C.10: updates merge via JSON Merge Patch', async () => {
    const uploads: Record<string, unknown>[][] = [];
    const uploader = new CoalescingUploader<Record<string, unknown>>({
      upload: async (batch) => { uploads.push(batch.map(b => structuredClone(b))); },
    });
    // Each update merges into pending, then enqueues
    await uploader.update({ a: 1 });
    await uploader.update({ b: 2 });
    await uploader.update({ c: 3 });
    await uploader.flush();
    // Should have uploaded merged states
    const allItems = uploads.flat();
    assert.ok(allItems.length >= 1, 'At least one upload');
    // Last item should have c: 3
    const last = allItems[allItems.length - 1];
    assert.equal(last.c, 3);
  });
});

describe('9C Staging: TextDeltaAccumulator', () => {
  it('FR-9C.11: accumulates and flushes snapshot via callback', async () => {
    const snapshots: string[] = [];
    const acc = new TextDeltaAccumulator({
      flushIntervalMs: 20,
      onSnapshot: (s) => snapshots.push(s),
    });
    acc.append('Hello');
    acc.append(' world');
    // Wait for timer flush
    await new Promise(r => setTimeout(r, 50));
    acc.close();
    assert.ok(snapshots.length >= 1, 'At least one snapshot');
    assert.ok(snapshots.some(s => s.includes('Hello world')));
  });
});

describe('9C Staging: RetryableError', () => {
  it('FR-9C.05: carries retryAfterMs', () => {
    const err = new RetryableError('rate limited', 5000);
    assert.ok(err instanceof Error);
    assert.equal(err.retryAfterMs, 5000);
  });
});

// ===================================================================
// Phase 9D
// ===================================================================

describe('9D Staging: CapacityWake', () => {
  it('FR-9D.01: constructs with valid config', () => {
    const wake = new CapacityWake({
      seekingIntervalMs: 200,
      atCapacityIntervalMs: 600,
      heartbeatIntervalMs: 1000,
    });
    assert.ok(wake);
    wake.close();
  });

  it('FR-9D.05: validates min interval >= 100ms', () => {
    assert.throws(
      () => parsePollConfig({ seekingIntervalMs: 50, atCapacityIntervalMs: 200, heartbeatIntervalMs: 1000 }),
      /100/,
    );
  });

  it('FR-9D.06: requires liveness mechanism', () => {
    assert.throws(
      () => parsePollConfig({ seekingIntervalMs: 200, atCapacityIntervalMs: 600 }),
      /liveness/i,
    );
  });

  it('FR-9D.08: metrics tracks wake events', () => {
    const metrics = new CapacityMetricsCollector(8);
    metrics.recordWake('capacity_freed');
    metrics.recordWake('capacity_freed');
    metrics.updateSlots(3);
    const s = metrics.snapshot();
    assert.equal(s.slots_total, 8);
    assert.equal(s.wake_count, 2);
    assert.equal(s.slots_used, 3);
    assert.equal(s.slots_available, 5);
  });
});

// ===================================================================
// Phase 9E
// ===================================================================

describe('9E Staging: FlushGate', () => {
  it('FR-9E.01: queues during receive, drains after flush', async () => {
    const received: string[] = [];
    const gate = new FlushGate<string>();
    gate.onMessage(async (msg) => { received.push(msg); });

    // Initial state is 'queuing' — messages buffered
    await gate.receive('a');
    await gate.receive('b');
    assert.equal(received.length, 0, 'Buffered in queuing state');

    // flush() delivers historical then drains queue, transitions to 'open'
    await gate.flush(['hist-1']);
    // After flush: historical + queued should be delivered
    assert.ok(received.includes('hist-1'), 'Historical delivered');
    assert.ok(received.includes('a'), 'Queued "a" drained');
    assert.ok(received.includes('b'), 'Queued "b" drained');
  });

  it('FR-9E.01: passthrough when open', async () => {
    const received: string[] = [];
    const gate = new FlushGate<string>();
    gate.onMessage(async (msg) => { received.push(msg); });
    // Open the gate first
    await gate.flush([]);
    // Now in 'open' state — passthrough
    await gate.receive('pass');
    assert.equal(received.length, 1);
  });
});

describe('9E Staging: NDJSON Encoder', () => {
  it('FR-9E.10: round-trips', () => {
    const obj = { type: 'test', data: [1, 2] };
    assert.deepEqual(decodeNdjson(encodeNdjson(obj)), obj);
  });

  it('FR-9E.10: escapes U+2028/U+2029', () => {
    const obj = { text: 'a\u2028b\u2029c' };
    const line = encodeNdjson(obj);
    assert.ok(!line.includes('\u2028'));
    assert.ok(!line.includes('\u2029'));
    assert.equal(decodeNdjson(line).text, 'a\u2028b\u2029c');
  });
});

describe('9E Staging: Sequence Tracker', () => {
  it('FR-9E.09: tracks sequence across transports', () => {
    const t = new SequenceTracker();
    assert.equal(t.getLastSequenceNum(), -1, 'Starts at -1');
    assert.equal(t.advance(1), true, 'Accepts seq 1');
    assert.equal(t.advance(2), true, 'Accepts seq 2');
    assert.equal(t.getLastSequenceNum(), 2);
    assert.equal(t.advance(1), false, 'Rejects duplicate');
  });
});

describe('9E Staging: Reconnection', () => {
  it('FR-9E.06: exponential backoff', () => {
    const state = createReconnectionState();
    const d1 = nextBackoff(state);
    assert.ok(d1 >= BACKOFF_BASE_MS * 0.8 && d1 <= BACKOFF_BASE_MS * 1.2, `~1s: ${d1}`);
    const d2 = nextBackoff(state);
    assert.ok(d2 > d1, 'Backoff increases');
  });

  it('FR-9E.07: fresh state has budget', () => {
    const state = createReconnectionState();
    const result = shouldReconnect(state, 1006, Date.now());
    assert.equal(result, true, 'Non-permanent code with budget');
  });

  it('FR-9E.08: permanent close code stops reconnection', () => {
    const state = createReconnectionState();
    assert.equal(shouldReconnect(state, 1000, Date.now()), false);
  });
});

describe('9E Staging: Close codes', () => {
  it('FR-9E.08: permanent codes identified', () => {
    assert.ok(isPermanentCloseCode(1000));
    assert.ok(isPermanentCloseCode(1001));
    assert.ok(isPermanentCloseCode(4000));
    assert.ok(isPermanentCloseCode(4050));
    assert.ok(!isPermanentCloseCode(1006));
    assert.ok(!isPermanentCloseCode(4100));
  });
});
