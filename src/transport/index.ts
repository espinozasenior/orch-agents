/**
 * Transport layer barrel exports.
 * Phase 9E: FlushGate and Multi-Transport Layer.
 */

export {
  FlushGate,
  FlushGateOverflowError,
  type FlushGateState,
  type MessageHandler,
} from './flush-gate.js';

export {
  type Transport,
  type TransportType,
  type TransportConfig,
  type TransportOptions,
  type FeatureFlags,
  type TransportPriority,
  type OnDataHandler,
  type OnCloseHandler,
  type OnEventHandler,
  isPermanentCloseCode,
  CLOSE_NORMAL,
  CLOSE_GOING_AWAY,
  CLOSE_APP_FATAL_MIN,
  CLOSE_APP_FATAL_MAX,
} from './transport.js';

export { WSTransport, type WebSocketLike, type WebSocketFactory } from './ws-transport.js';
export { SSETransport, type EventSourceLike, type EventSourceFactory, type PostWriter } from './sse-transport.js';
export { HybridTransport, getTransportForUrl, type TransportDeps } from './hybrid-transport.js';

export {
  createReconnectionState,
  shouldReconnect,
  nextBackoff,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BUDGET_MS,
  SLEEP_WAKE_THRESHOLD_MS,
  type ReconnectionState,
} from './reconnection.js';

export { SequenceTracker } from './sequence-tracker.js';

export { encodeNdjson, decodeNdjson, decodeNdjsonStream } from './ndjson.js';
