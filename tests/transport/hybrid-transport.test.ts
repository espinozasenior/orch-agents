import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HybridTransport, getTransportForUrl } from '../../src/transport/hybrid-transport.js';
import { SSETransport } from '../../src/transport/sse-transport.js';
import { WSTransport, type WebSocketLike } from '../../src/transport/ws-transport.js';

function createMockWS(): WebSocketLike & {
  triggerMessage: (data: string) => void;
  triggerClose: (code: number, reason: string) => void;
} {
  const ws: WebSocketLike & {
    triggerMessage: (data: string) => void;
    triggerClose: (code: number, reason: string) => void;
  } = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {},
    close(_code?: number) {
      ws.readyState = 3;
    },
    triggerMessage(data: string) {
      ws.onmessage?.({ data });
    },
    triggerClose(code: number, reason: string) {
      ws.onclose?.({ code, reason });
    },
  };
  setTimeout(() => ws.onopen?.({}), 0);
  return ws;
}

describe('HybridTransport', () => {
  let transport: HybridTransport;
  let lastWsUrl: string;
  let lastPostUrl: string;
  let lastPostData: string;

  beforeEach(() => {
    lastWsUrl = '';
    lastPostUrl = '';
    lastPostData = '';

    transport = new HybridTransport(
      (url) => {
        lastWsUrl = url;
        return createMockWS();
      },
      async (url, data) => {
        lastPostUrl = url;
        lastPostData = data;
      }
    );
  });

  it('connects via WebSocket and converts URL', async () => {
    await transport.connect('https://example.com/sessions/abc');
    assert.ok(lastWsUrl.startsWith('wss://'));
  });

  it('writes via POST, not WebSocket', async () => {
    await transport.connect('https://example.com/sessions/abc');
    await transport.write('{"msg":"hello"}');

    assert.ok(lastPostUrl.includes('/worker/events'));
    assert.equal(lastPostData, '{"msg":"hello"}');
  });

  it('delivers messages from WebSocket reads', async () => {
    let mockWs: ReturnType<typeof createMockWS> | null = null;
    const t = new HybridTransport(
      (url) => {
        lastWsUrl = url;
        mockWs = createMockWS();
        return mockWs;
      },
      async () => {}
    );

    const received: string[] = [];
    t.setOnData((data) => received.push(data as string));
    await t.connect('https://example.com/sessions/abc');

    mockWs!.triggerMessage('{"seq":1}');
    assert.deepEqual(received, ['{"seq":1}']);
  });

  it('tracks sequence number', async () => {
    assert.equal(transport.getLastSequenceNum(), -1);
    await transport.connect('https://example.com/sessions/abc', {
      initialSequenceNum: 200,
    });
    assert.equal(transport.getLastSequenceNum(), 200);
  });

  it('close() prevents reconnection', async () => {
    let mockWs: ReturnType<typeof createMockWS> | null = null;
    const t = new HybridTransport(
      (url) => {
        lastWsUrl = url;
        mockWs = createMockWS();
        return mockWs;
      },
      async () => {}
    );

    let closeCalled = false;
    t.setOnClose(() => { closeCalled = true; });
    await t.connect('https://example.com/sessions/abc');
    t.close();

    // Triggering close after explicit close should not fire onClose
    // (ws is already null)
    assert.equal(closeCalled, false);
  });
});

describe('getTransportForUrl', () => {
  const mockEsFactory = () => ({
    readyState: 1 as number,
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: string; lastEventId?: string }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    addEventListener() {},
    close() {},
  });

  const mockWsFactory = () => createMockWS();
  const mockPostWriter = async () => {};

  it('selects SSE transport when SSE flag enabled (default)', () => {
    const transport = getTransportForUrl(
      'https://example.com/sessions/abc',
      {},
      { wsFactory: mockWsFactory, postWriter: mockPostWriter, esFactory: mockEsFactory }
    );
    assert.ok(transport instanceof SSETransport);
  });

  it('selects Hybrid transport when SSE disabled', () => {
    const transport = getTransportForUrl(
      'https://example.com/sessions/abc',
      { sseTransport: false },
      { wsFactory: mockWsFactory, postWriter: mockPostWriter }
    );
    assert.ok(transport instanceof HybridTransport);
  });

  it('selects WS transport when SSE and Hybrid disabled', () => {
    const transport = getTransportForUrl(
      'https://example.com/sessions/abc',
      { sseTransport: false, hybridTransport: false },
      { wsFactory: mockWsFactory, postWriter: mockPostWriter }
    );
    assert.ok(transport instanceof WSTransport);
  });

  it('throws when all transports disabled', () => {
    assert.throws(
      () => getTransportForUrl(
        'https://example.com/sessions/abc',
        { sseTransport: false, hybridTransport: false, wsTransport: false },
        { wsFactory: mockWsFactory, postWriter: mockPostWriter }
      ),
      /No transport enabled/
    );
  });
});
