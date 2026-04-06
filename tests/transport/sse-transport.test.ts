import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SSETransport, type EventSourceLike } from '../../src/transport/sse-transport.js';

function createMockEventSource(): EventSourceLike & {
  triggerMessage: (data: string, lastEventId?: string) => void;
  triggerError: () => void;
  listeners: Map<string, ((ev: { data: string }) => void)[]>;
} {
  const listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  const es: EventSourceLike & {
    triggerMessage: (data: string, lastEventId?: string) => void;
    triggerError: () => void;
    listeners: Map<string, ((ev: { data: string }) => void)[]>;
  } = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    listeners,
    addEventListener(type: string, listener: (ev: { data: string }) => void) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    close() {
      es.readyState = 2;
    },
    triggerMessage(data: string, lastEventId?: string) {
      es.onmessage?.({ data, lastEventId });
    },
    triggerError() {
      es.readyState = 2;
      es.onerror?.({});
    },
  };
  setTimeout(() => es.onopen?.({}), 0);
  return es;
}

describe('SSETransport', () => {
  let transport: SSETransport;
  let lastCreatedUrl: string;
  let lastPostUrl: string;
  let lastPostData: string;

  beforeEach(() => {
    lastCreatedUrl = '';
    lastPostUrl = '';
    lastPostData = '';

    transport = new SSETransport(
      (url) => {
        lastCreatedUrl = url;
        return createMockEventSource();
      },
      async (url, data) => {
        lastPostUrl = url;
        lastPostData = data;
      }
    );
  });

  it('connects and derives stream URL', async () => {
    await transport.connect('https://example.com/sessions/abc');
    assert.ok(lastCreatedUrl.includes('/worker/events/stream'));
  });

  it('appends seq param when initialSequenceNum provided', async () => {
    await transport.connect('https://example.com/sessions/abc', {
      initialSequenceNum: 100,
    });
    assert.ok(lastCreatedUrl.includes('?seq=100'));
  });

  it('delivers messages via onData handler', async () => {
    const received: string[] = [];
    let mockEs: ReturnType<typeof createMockEventSource> | null = null;

    const t = new SSETransport(
      (url) => {
        lastCreatedUrl = url;
        mockEs = createMockEventSource();
        return mockEs;
      },
      async () => {}
    );
    t.setOnData((data) => received.push(data as string));
    await t.connect('https://example.com/sessions/abc');

    mockEs!.triggerMessage('{"seq":1}');
    assert.deepEqual(received, ['{"seq":1}']);
  });

  it('writes via POST to the correct URL', async () => {
    await transport.connect('https://example.com/sessions/abc');
    await transport.write('{"type":"message"}');

    assert.ok(lastPostUrl.includes('/worker/events'));
    assert.ok(!lastPostUrl.includes('/stream'));
    assert.equal(lastPostData, '{"type":"message"}');
  });

  it('calls onClose when EventSource permanently closes', async () => {
    let mockEs: ReturnType<typeof createMockEventSource> | null = null;
    let closeCode = 0;

    const t = new SSETransport(
      (url) => {
        lastCreatedUrl = url;
        mockEs = createMockEventSource();
        return mockEs;
      },
      async () => {}
    );
    t.setOnClose((code) => { closeCode = code; });

    // The error triggers reject, so we catch it
    try {
      await t.connect('https://example.com/sessions/abc');
      mockEs!.triggerError();
    } catch {
      // expected
    }
    // If readyState was already 1 when connect resolved, trigger error after
    if (closeCode === 0 && mockEs) {
      mockEs.triggerError();
    }
    assert.equal(closeCode, 1006);
  });

  it('tracks sequence number', () => {
    assert.equal(transport.getLastSequenceNum(), -1);
    transport.updateSequenceNum(50);
    assert.equal(transport.getLastSequenceNum(), 50);
  });

  it('close() sets source to null', async () => {
    await transport.connect('https://example.com/sessions/abc');
    transport.close();
    // After close, writing should still work (via POST, not EventSource)
    await transport.write('data');
  });
});
