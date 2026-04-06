import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { StdinTransport, MemoryTransport } from '../../../src/execution/runtime/transport-inbound';
import { AgentMessageType, type AgentMessage } from '../../../src/execution/runtime/agent-message-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readableFromLines(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n'));
}

function makeMsg(type: AgentMessage['type'], id: string): string {
  return JSON.stringify({ type, id, timestamp: Date.now(), payload: {} });
}

// ---------------------------------------------------------------------------
// StdinTransport
// ---------------------------------------------------------------------------

describe('StdinTransport', () => {
  it('parses valid NDJSON lines into AgentMessages', async () => {
    const lines = [
      makeMsg(AgentMessageType.UserTask, 'msg-1'),
      makeMsg(AgentMessageType.KeepAlive, 'msg-2'),
    ];
    const input = readableFromLines(lines);
    const transport = new StdinTransport({ input });

    await transport.connect();
    const received: AgentMessage[] = [];
    for await (const msg of transport.messages()) {
      received.push(msg);
    }

    assert.equal(received.length, 2);
    assert.equal(received[0].type, AgentMessageType.UserTask);
    assert.equal(received[0].id, 'msg-1');
    assert.equal(received[1].type, AgentMessageType.KeepAlive);
  });

  it('skips malformed JSON lines without crashing', async () => {
    const lines = [
      makeMsg(AgentMessageType.UserTask, 'ok-1'),
      'this is not json',
      makeMsg(AgentMessageType.Shutdown, 'ok-2'),
    ];
    const input = readableFromLines(lines);
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      trace: () => {}, debug: () => {}, info: () => {},
      error: () => {}, fatal: () => {},
      child: () => logger,
    };
    const transport = new StdinTransport({ input, logger: logger as never });

    await transport.connect();
    const received: AgentMessage[] = [];
    for await (const msg of transport.messages()) {
      received.push(msg);
    }

    assert.equal(received.length, 2);
    assert.equal(received[0].id, 'ok-1');
    assert.equal(received[1].id, 'ok-2');
    assert.equal(warnings.length, 1);
  });

  it('skips empty lines', async () => {
    const lines = [
      makeMsg(AgentMessageType.UserTask, 'msg-1'),
      '',
      '   ',
      makeMsg(AgentMessageType.Shutdown, 'msg-2'),
    ];
    const input = readableFromLines(lines);
    const transport = new StdinTransport({ input });

    await transport.connect();
    const received: AgentMessage[] = [];
    for await (const msg of transport.messages()) {
      received.push(msg);
    }

    assert.equal(received.length, 2);
  });

  it('detects stdin close as disconnect', async () => {
    const input = readableFromLines([makeMsg(AgentMessageType.UserTask, 'last')]);
    const transport = new StdinTransport({ input });

    await transport.connect();
    assert.equal(transport.isConnected(), true);

    // Consume all messages
    const received: AgentMessage[] = [];
    for await (const msg of transport.messages()) {
      received.push(msg);
    }

    assert.equal(received.length, 1);
    assert.equal(transport.isConnected(), false);
  });

  it('throws if messages() called before connect()', async () => {
    const input = readableFromLines([]);
    const transport = new StdinTransport({ input });

    await assert.rejects(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _msg of transport.messages()) {
          // should not reach here
        }
      },
      { message: /not connected/i },
    );
  });

  it('stops yielding when AbortSignal is triggered', async () => {
    const ac = new AbortController();
    // Create a stream that won't naturally end
    const input = new Readable({ read() { /* intentionally empty */ } });
    const transport = new StdinTransport({ input, signal: ac.signal });

    await transport.connect();

    const received: AgentMessage[] = [];
    const iterPromise = (async () => {
      for await (const msg of transport.messages()) {
        received.push(msg);
      }
    })();

    // Push one line then abort
    input.push(makeMsg(AgentMessageType.UserTask, 'before-abort') + '\n');
    // Give the readline time to process
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    input.push(null); // close the stream to unblock readline

    await iterPromise;
    assert.equal(received.length, 1);
  });
});

// ---------------------------------------------------------------------------
// MemoryTransport
// ---------------------------------------------------------------------------

describe('MemoryTransport', () => {
  it('yields pushed messages', async () => {
    const transport = new MemoryTransport();
    await transport.connect();

    const received: AgentMessage[] = [];
    const iterPromise = (async () => {
      for await (const msg of transport.messages()) {
        received.push(msg);
      }
    })();

    transport.push({
      type: AgentMessageType.UserTask,
      id: 'push-1',
      timestamp: Date.now(),
      payload: {},
    } as AgentMessage);
    transport.end();

    await iterPromise;
    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'push-1');
  });

  it('buffers messages pushed before consumption', async () => {
    const transport = new MemoryTransport();
    await transport.connect();

    transport.push({
      type: AgentMessageType.KeepAlive,
      id: 'buf-1',
      timestamp: Date.now(),
    } as AgentMessage);
    transport.push({
      type: AgentMessageType.Shutdown,
      id: 'buf-2',
      timestamp: Date.now(),
    } as AgentMessage);
    transport.end();

    const received: AgentMessage[] = [];
    for await (const msg of transport.messages()) {
      received.push(msg);
    }

    assert.equal(received.length, 2);
  });

  it('disconnect signals end of stream', async () => {
    const transport = new MemoryTransport();
    await transport.connect();

    const iterPromise = (async () => {
      const received: AgentMessage[] = [];
      for await (const msg of transport.messages()) {
        received.push(msg);
      }
      return received;
    })();

    await transport.disconnect();
    const received = await iterPromise;
    assert.equal(received.length, 0);
    assert.equal(transport.isConnected(), false);
  });
});
