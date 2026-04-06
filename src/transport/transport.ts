/**
 * Transport interface and shared types for multi-transport layer.
 * FR-9E.03: Transport interface with connect(), write(), close(), setOnData(), setOnClose()
 * FR-9E.08: Permanent close code handling
 */

// --- Close Code Constants ---

/** Normal closure — no reconnection */
export const CLOSE_NORMAL = 1000;
/** Going away — no reconnection */
export const CLOSE_GOING_AWAY = 1001;
/** Application-defined fatal range: 4000-4099 */
export const CLOSE_APP_FATAL_MIN = 4000;
export const CLOSE_APP_FATAL_MAX = 4099;

/**
 * Returns true if the close code indicates a permanent (non-retriable) closure.
 * FR-9E.08: abort reconnection on codes 1000, 1001, 4000-4099
 */
export function isPermanentCloseCode(code: number): boolean {
  if (code === CLOSE_NORMAL || code === CLOSE_GOING_AWAY) return true;
  if (code >= CLOSE_APP_FATAL_MIN && code <= CLOSE_APP_FATAL_MAX) return true;
  return false;
}

// --- Transport Types ---

export type TransportType = 'sse' | 'hybrid' | 'ws';

export interface TransportOptions {
  /** Resume from this sequence number — server skips messages up to this seq */
  initialSequenceNum?: number;
  /** Additional headers for the connection */
  headers?: Record<string, string>;
}

export interface TransportConfig {
  url: string;
  type: TransportType;
  options?: TransportOptions;
}

export type OnDataHandler = (data: Uint8Array | string) => void;
export type OnCloseHandler = (code: number, reason: string) => void;
export type OnEventHandler = (event: string, data: string) => void;

/**
 * FR-9E.03: Transport interface for multi-transport layer.
 * All transports share the same wire format (NDJSON) for interchangeability.
 */
export interface Transport {
  connect(url: string, options?: TransportOptions): Promise<void>;
  write(data: Uint8Array | string): Promise<void>;
  close(): void;
  setOnData(handler: OnDataHandler): void;
  setOnClose(handler: OnCloseHandler): void;
  setOnEvent?(handler: OnEventHandler): void;
  getLastSequenceNum(): number;
}

// --- Feature Flags ---

export interface FeatureFlags {
  sseTransport?: boolean;
  hybridTransport?: boolean;
  wsTransport?: boolean;
}

export interface TransportPriority {
  type: TransportType;
  enabled: boolean;
}
