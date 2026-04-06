/**
 * WebSocket transport implementation.
 * FR-9E.04: WSTransport — WebSocket read + write transport.
 * FR-9E.09: Sequence number tracking via getLastSequenceNum().
 */

import type {
  Transport,
  TransportOptions,
  OnDataHandler,
  OnCloseHandler,
} from './transport.js';

/**
 * Minimal WebSocket interface for dependency injection.
 * Matches the subset of the W3C WebSocket API we use.
 */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export class WSTransport implements Transport {
  private _ws: WebSocketLike | null = null;
  private _onData: OnDataHandler | null = null;
  private _onClose: OnCloseHandler | null = null;
  private _lastSeq: number = -1;
  private readonly _wsFactory: WebSocketFactory;

  constructor(wsFactory: WebSocketFactory) {
    this._wsFactory = wsFactory;
  }

  async connect(url: string, options?: TransportOptions): Promise<void> {
    if (options?.initialSequenceNum !== undefined) {
      this._lastSeq = options.initialSequenceNum;
    }

    return new Promise<void>((resolve, reject) => {
      const wsUrl = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      const fullUrl = this._lastSeq >= 0
        ? `${wsUrl}?seq=${this._lastSeq}`
        : wsUrl;

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
        if (this._onClose) {
          this._onClose(ev.code, ev.reason);
        }
      };

      ws.onerror = (ev) => {
        reject(ev);
      };
    });
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (!this._ws || this._ws.readyState !== 1) {
      throw new Error('WebSocket is not open');
    }
    this._ws.send(data);
  }

  close(): void {
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
