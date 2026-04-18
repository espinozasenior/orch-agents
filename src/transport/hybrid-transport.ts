/**
 * Hybrid transport: WebSocket for reads, POST for writes.
 * FR-9E.04: HybridTransport — WS reads + POST writes.
 * FR-9E.05: Priority-based failover: SSE > Hybrid > WebSocket.
 * FR-9E.06: Reconnection budget with exponential backoff.
 * FR-9E.07: Sleep/wake detection resets budget.
 * FR-9E.09: Sequence continuity across transport swaps.
 */

import type {
  Transport,
  TransportOptions,
  OnDataHandler,
  OnCloseHandler,
  FeatureFlags,
} from './transport.js';
import type { WebSocketLike, WebSocketFactory } from './ws-transport.js';
import type { PostWriter } from './sse-transport.js';
import {
  createReconnectionState,
  shouldReconnect,
  nextBackoff,
  type ReconnectionState,
} from './reconnection.js';

export class HybridTransport implements Transport {
  private _ws: WebSocketLike | null = null;
  private _onData: OnDataHandler | null = null;
  private _onClose: OnCloseHandler | null = null;
  private _lastSeq: number = -1;
  private _url: string = '';
  private _writeUrl: string = '';
  private _reconnectionState: ReconnectionState | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _closed: boolean = false;
  private readonly _wsFactory: WebSocketFactory;
  private readonly _postWriter: PostWriter;

  constructor(wsFactory: WebSocketFactory, postWriter: PostWriter) {
    this._wsFactory = wsFactory;
    this._postWriter = postWriter;
  }

  async connect(url: string, options?: TransportOptions): Promise<void> {
    this._url = url;
    this._closed = false;
    // Derive POST write URL
    this._writeUrl = url.replace(/\/?$/, '/worker/events');

    if (options?.initialSequenceNum !== undefined) {
      this._lastSeq = options.initialSequenceNum;
    }

    if (!this._reconnectionState) {
      this._reconnectionState = createReconnectionState();
    }

    const wsUrl = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const fullUrl = this._lastSeq >= 0
      ? `${wsUrl}?seq=${this._lastSeq}`
      : wsUrl;

    return new Promise<void>((resolve, reject) => {
      const ws = this._wsFactory(fullUrl);
      this._ws = ws;

      ws.onopen = () => resolve();

      ws.onmessage = (ev) => {
        if (this._onData) {
          const data = typeof ev.data === 'string'
            ? ev.data
            : ev.data as Uint8Array;
          this._onData(data);
        }
      };

      ws.onclose = (ev) => {
        this._handleClose(ev.code, ev.reason);
      };

      ws.onerror = (ev) => {
        reject(ev);
      };
    });
  }

  private _handleClose(code: number, reason: string): void {
    if (this._closed) return;

    if (
      this._reconnectionState &&
      shouldReconnect(this._reconnectionState, code)
    ) {
      const delay = nextBackoff(this._reconnectionState);
      this._reconnectTimer = setTimeout(() => {
        this.connect(this._url, { initialSequenceNum: this._lastSeq })
          .catch(() => {
            // If reconnect fails, the onclose from the new ws will trigger another attempt
          });
      }, delay);
      if (typeof this._reconnectTimer === 'object' && 'unref' in this._reconnectTimer) {
        this._reconnectTimer.unref();
      }
    } else {
      // Permanent close or budget exhausted
      if (this._onClose) {
        this._onClose(code, reason);
      }
    }
  }

  async write(data: Uint8Array | string): Promise<void> {
    const payload = typeof data === 'string' ? data : new TextDecoder().decode(data);
    await this._postWriter(this._writeUrl, payload);
  }

  close(): void {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close(1000, 'client close');
      this._ws = null;
    }
  }

  setOnData(handler: OnDataHandler): void {
    this._onData = handler;
  }

  setOnClose(handler: OnCloseHandler): void {
    this._onClose = handler;
  }

  getLastSequenceNum(): number {
    return this._lastSeq;
  }

  updateSequenceNum(seq: number): void {
    this._lastSeq = seq;
  }
}

// --- Transport Selection ---

/**
 * FR-9E.05: Priority-based transport selection with feature-flag control.
 * Priority: SSE > Hybrid > WebSocket.
 */
export interface TransportDeps {
  wsFactory: WebSocketFactory;
  postWriter: PostWriter;
  esFactory?: import('./sse-transport.js').EventSourceFactory;
}

export async function getTransportForUrl(
  _sessionUrl: string,
  flags: FeatureFlags,
  deps: TransportDeps
): Promise<Transport> {
  const priorities = [
    { type: 'sse' as const, enabled: flags.sseTransport ?? true },
    { type: 'hybrid' as const, enabled: flags.hybridTransport ?? true },
    { type: 'ws' as const, enabled: flags.wsTransport ?? true },
  ];

  const selected = priorities.find(p => p.enabled);
  if (!selected) {
    throw new Error('No transport enabled');
  }

  switch (selected.type) {
    case 'sse': {
      if (!deps.esFactory) {
        throw new Error('EventSource factory required for SSE transport');
      }
      const { SSETransport } = await import('./sse-transport.js');
      return new SSETransport(deps.esFactory, deps.postWriter);
    }
    case 'hybrid':
      return new HybridTransport(deps.wsFactory, deps.postWriter);
    case 'ws': {
      const { WSTransport } = await import('./ws-transport.js');
      return new WSTransport(deps.wsFactory);
    }
  }
}
