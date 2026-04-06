/**
 * Server-Sent Events transport implementation.
 * FR-9E.04: SSETransport — SSE read + POST write transport.
 * FR-9E.09: Sequence number tracking, reconnection with last-event-id.
 */

import type {
  Transport,
  TransportOptions,
  OnDataHandler,
  OnCloseHandler,
  OnEventHandler,
} from './transport.js';

/**
 * Minimal EventSource interface for dependency injection.
 */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export type PostWriter = (url: string, data: string) => Promise<void>;

export class SSETransport implements Transport {
  private _source: EventSourceLike | null = null;
  private _onData: OnDataHandler | null = null;
  private _onClose: OnCloseHandler | null = null;
  private _onEvent: OnEventHandler | null = null;
  private _lastSeq: number = -1;
  private _writeUrl: string = '';
  private readonly _esFactory: EventSourceFactory;
  private readonly _postWriter: PostWriter;

  constructor(esFactory: EventSourceFactory, postWriter: PostWriter) {
    this._esFactory = esFactory;
    this._postWriter = postWriter;
  }

  async connect(url: string, options?: TransportOptions): Promise<void> {
    if (options?.initialSequenceNum !== undefined) {
      this._lastSeq = options.initialSequenceNum;
    }

    // Derive URLs per spec: stream URL for SSE, base URL for POST writes
    const streamUrl = url.endsWith('/worker/events/stream')
      ? url
      : `${url}/worker/events/stream`;
    this._writeUrl = streamUrl.replace('/worker/events/stream', '/worker/events');

    const fullUrl = this._lastSeq >= 0
      ? `${streamUrl}?seq=${this._lastSeq}`
      : streamUrl;

    return new Promise<void>((resolve, reject) => {
      const source = this._esFactory(fullUrl);
      this._source = source;

      source.onopen = () => resolve();

      source.onmessage = (ev) => {
        if (this._onData) {
          this._onData(ev.data);
        }
      };

      source.onerror = (ev) => {
        // EventSource auto-reconnects on error, but if readyState is CLOSED (2),
        // it's a permanent failure
        if (source.readyState === 2) {
          if (this._onClose) {
            this._onClose(1006, 'EventSource closed');
          }
          reject(ev);
        }
      };
    });
  }

  async write(data: Uint8Array | string): Promise<void> {
    const payload = typeof data === 'string' ? data : new TextDecoder().decode(data);
    await this._postWriter(this._writeUrl, payload);
  }

  close(): void {
    if (this._source) {
      this._source.close();
      this._source = null;
    }
  }

  setOnData(handler: OnDataHandler): void {
    this._onData = handler;
  }

  setOnClose(handler: OnCloseHandler): void {
    this._onClose = handler;
  }

  setOnEvent(handler: OnEventHandler): void {
    this._onEvent = handler;
    // Wire up named events if source exists
    if (this._source && this._onEvent) {
      this._source.addEventListener('message', (ev) => {
        this._onEvent?.('message', ev.data);
      });
    }
  }

  getLastSequenceNum(): number {
    return this._lastSeq;
  }

  updateSequenceNum(seq: number): void {
    this._lastSeq = seq;
  }
}
