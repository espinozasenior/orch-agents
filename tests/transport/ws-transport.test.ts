import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WSTransport, type WebSocketLike } from '../../src/transport/ws-transport.js';

/** Mock WebSocket that auto-opens on creation */
function createMockWS(): WebSocketLike & { triggerMessage: (data: string) => void; triggerClose: (code: number, reason: string) => void } {
  const ws: WebSocketLike & { triggerMessage: (data: string) => void; triggerClose: (code: number, reason: string) => void } = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(_data: string | Uint8Array) {},
    close(_code?: number, _reason?: string) {
      ws.readyState = 3;
    },
    triggerMessage(data: string) {
      ws.onmessage?.({ data });
    },
    triggerClose(code: number, reason: string) {
      ws.onclose?.({ code, reason });
    },
  };
  // Auto-open in next microtask
  setTimeout(() => ws.onopen?.({}), 0);
  return ws;
}

describe('WSTransport', () => {
  let transport: WSTransport;
  let lastCreatedUrl: string;

  beforeEach(() => {
    lastCreatedUrl = '';
    transport = new WSTransport((url) => {
      lastCreatedUrl = url;
      return createMockWS();
    });
  });

  it('connects and converts https to wss', async () => {
    await transport.connect('https://example.com/session/123');
    assert.ok(lastCreatedUrl.startsWith('wss://'));
  });

  it('appends seq param when initialSequenceNum provided', async () => {
    await transport.connect('https://example.com/session/123', {
      initialSequenceNum: 42,
    });
    assert.ok(lastCreatedUrl.includes('?seq=42'));
  });

  it('does not append seq param when initialSequenceNum is -1 or absent', async () => {
    await transport.connect('https://example.com/session/123');
    assert.ok(!lastCreatedUrl.includes('?seq='));
  });

  it('delivers messages via onData handler', async () => {
    const received: string[] = [];
    transport.setOnData((data) => received.push(data as string));

    await transport.connect('https://example.com/session/123');

    // Need to get the mock WS to trigger message — recreate with captured ref
    let mockWs: ReturnType<typeof createMockWS> | null = null;
    const t2 = new WSTransport((url) => {
      lastCreatedUrl = url;
      mockWs = createMockWS();
      return mockWs;
    });
    const r2: string[] = [];
    t2.setOnData((data) => r2.push(data as string));
    await t2.connect('https://example.com/session/123');
    mockWs!.triggerMessage('{"seq":1}');

    assert.deepEqual(r2, ['{"seq":1}']);
  });

  it('calls onClose handler on WebSocket close', async () => {
    let mockWs: ReturnType<typeof createMockWS> | null = null;
    const t = new WSTransport((url) => {
      lastCreatedUrl = url;
      mockWs = createMockWS();
      return mockWs;
    });
    let closeCode = 0;
    t.setOnClose((code, _reason) => { closeCode = code; });
    await t.connect('https://example.com/session/123');
    mockWs!.triggerClose(1006, 'abnormal');

    assert.equal(closeCode, 1006);
  });

  it('throws when writing to a closed socket', async () => {
    await transport.connect('https://example.com/session/123');
    transport.close();

    await assert.rejects(
      () => transport.write('data'),
      /WebSocket is not open/
    );
  });

  it('tracks sequence number', async () => {
    assert.equal(transport.getLastSequenceNum(), -1);

    await transport.connect('https://example.com/session/123', {
      initialSequenceNum: 99,
    });
    assert.equal(transport.getLastSequenceNum(), 99);

    transport.updateSequenceNum(150);
    assert.equal(transport.getLastSequenceNum(), 150);
  });
});
