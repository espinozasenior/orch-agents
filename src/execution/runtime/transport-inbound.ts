/**
 * Phase 9A: Transport-agnostic inbound message stream.
 *
 * Defines the TransportInbound interface and provides a StdinTransport
 * implementation that reads NDJSON from process.stdin. Future transports
 * (WebSocket, SSE) will implement the same interface in Phase 9E.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AgentMessage } from './agent-message-types';
import type { Logger } from '../../shared/logger';

// ---------------------------------------------------------------------------
// TransportInbound interface
// ---------------------------------------------------------------------------

export interface TransportInbound {
  /** Establish the transport connection. */
  connect(): Promise<void>;
  /** Async generator yielding messages as they arrive. */
  messages(): AsyncGenerator<AgentMessage, void, undefined>;
  /** Tear down the transport connection. */
  disconnect(): Promise<void>;
  /** Whether the transport is currently connected. */
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// StdinTransport: NDJSON from a Readable stream (defaults to process.stdin)
// ---------------------------------------------------------------------------

export interface StdinTransportOptions {
  /** Readable stream to consume (default: process.stdin). */
  readonly input?: Readable;
  /** Logger for diagnostics. */
  readonly logger?: Logger;
  /** AbortSignal for cancellation. */
  readonly signal?: AbortSignal;
}

export class StdinTransport implements TransportInbound {
  private readonly input: Readable;
  private readonly logger?: Logger;
  private readonly signal?: AbortSignal;
  private connected = false;
  private rl: ReadlineInterface | null = null;

  constructor(options: StdinTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.logger = options.logger;
    this.signal = options.signal;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async *messages(): AsyncGenerator<AgentMessage, void, undefined> {
    if (!this.connected) {
      throw new Error('Transport not connected. Call connect() first.');
    }

    this.rl = createInterface({ input: this.input, crlfDelay: Infinity });

    try {
      for await (const line of this.rl) {
        if (this.signal?.aborted) {
          break;
        }

        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        try {
          const parsed = JSON.parse(trimmed) as AgentMessage;
          yield parsed;
        } catch (err) {
          this.logger?.warn('Malformed NDJSON line, skipping', {
            line: trimmed.slice(0, 200),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.rl.close();
      this.rl = null;
      this.connected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ---------------------------------------------------------------------------
// MemoryTransport: push-based transport for testing / in-process use
// ---------------------------------------------------------------------------

export class MemoryTransport implements TransportInbound {
  private connected = false;
  private readonly buffer: AgentMessage[] = [];
  private resolve: ((value: IteratorResult<AgentMessage>) => void) | null = null;
  private done = false;

  async connect(): Promise<void> {
    this.connected = true;
    this.done = false;
  }

  /** Push a message into the transport from the outside. */
  push(message: AgentMessage): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: message, done: false });
    } else {
      this.buffer.push(message);
    }
  }

  /** Signal end-of-stream. */
  end(): void {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as AgentMessage, done: true });
    }
  }

  async *messages(): AsyncGenerator<AgentMessage, void, undefined> {
    if (!this.connected) {
      throw new Error('Transport not connected. Call connect() first.');
    }

    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }

      if (this.done) {
        break;
      }

      const result = await new Promise<IteratorResult<AgentMessage>>(
        (r) => { this.resolve = r; },
      );

      if (result.done) break;
      yield result.value;
    }
  }

  async disconnect(): Promise<void> {
    this.end();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
