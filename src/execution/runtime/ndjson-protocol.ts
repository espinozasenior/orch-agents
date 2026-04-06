/**
 * NDJSON Wire Protocol -- typed message envelopes for parent-child communication.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.03)
 *
 * Message types: task, result, permission_request, permission_response, status, error
 * Encoding: one JSON object per line (newline-delimited JSON).
 */

// ---------------------------------------------------------------------------
// Message type literals
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
  'task',
  'result',
  'permission_request',
  'permission_response',
  'status',
  'error',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Envelope base
// ---------------------------------------------------------------------------

export interface NdjsonEnvelope<T extends MessageType = MessageType, P = unknown> {
  readonly type: T;
  readonly id: string;
  readonly sessionId: string;
  readonly payload: P;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Concrete message types (discriminated union)
// ---------------------------------------------------------------------------

export interface TaskPayload {
  readonly tool?: string;
  readonly prompt?: string;
  readonly args?: Record<string, unknown>;
}

export interface ResultPayload {
  readonly success: boolean;
  readonly output: string;
  readonly error?: string;
}

export interface PermissionRequestPayload {
  readonly tool: string;
  readonly command?: string;
  readonly args?: Record<string, unknown>;
}

export interface PermissionResponsePayload {
  readonly approved: boolean;
  readonly reason?: string;
}

export interface StatusPayload {
  readonly tokensUsed?: number;
  readonly tasksCompleted?: number;
  readonly state?: string;
}

export interface ErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type TaskMessage = NdjsonEnvelope<'task', TaskPayload>;
export type ResultMessage = NdjsonEnvelope<'result', ResultPayload>;
export type PermissionRequestMessage = NdjsonEnvelope<'permission_request', PermissionRequestPayload>;
export type PermissionResponseMessage = NdjsonEnvelope<'permission_response', PermissionResponsePayload>;
export type StatusMessage = NdjsonEnvelope<'status', StatusPayload>;
export type ErrorMessage = NdjsonEnvelope<'error', ErrorPayload>;

export type AnyMessage =
  | TaskMessage
  | ResultMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | StatusMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTaskMessage(msg: AnyMessage): msg is TaskMessage {
  return msg.type === 'task';
}

export function isResultMessage(msg: AnyMessage): msg is ResultMessage {
  return msg.type === 'result';
}

export function isPermissionRequestMessage(msg: AnyMessage): msg is PermissionRequestMessage {
  return msg.type === 'permission_request';
}

export function isPermissionResponseMessage(msg: AnyMessage): msg is PermissionResponseMessage {
  return msg.type === 'permission_response';
}

export function isStatusMessage(msg: AnyMessage): msg is StatusMessage {
  return msg.type === 'status';
}

export function isErrorMessage(msg: AnyMessage): msg is ErrorMessage {
  return msg.type === 'error';
}

// ---------------------------------------------------------------------------
// Encoding / Decoding
// ---------------------------------------------------------------------------

import { ndjsonSafeStringify } from './ndjson-safe-stringify';

const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Encode a message to an NDJSON line (JSON + newline).
 * Uses ndjsonSafeStringify to escape U+2028/U+2029 (FR-P7-007).
 */
export function encodeMessage(msg: AnyMessage): string {
  return ndjsonSafeStringify(msg);
}

/**
 * Decode a single NDJSON line into a typed message envelope.
 * Throws on invalid input.
 */
export function decodeMessage(line: string): AnyMessage {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error('Empty NDJSON line');
  }
  if (trimmed.length > MAX_MESSAGE_SIZE) {
    throw new Error(`NDJSON message exceeds max size of ${MAX_MESSAGE_SIZE} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid JSON in NDJSON line: ${trimmed.slice(0, 100)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('NDJSON message must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.type !== 'string') {
    throw new Error('NDJSON message missing required "type" field');
  }

  if (!(MESSAGE_TYPES as readonly string[]).includes(obj.type)) {
    throw new Error(`Unknown NDJSON message type: ${obj.type}`);
  }

  if (typeof obj.id !== 'string') {
    throw new Error('NDJSON message missing required "id" field');
  }

  if (typeof obj.sessionId !== 'string') {
    throw new Error('NDJSON message missing required "sessionId" field');
  }

  if (typeof obj.timestamp !== 'number') {
    throw new Error('NDJSON message missing required "timestamp" field');
  }

  return parsed as AnyMessage;
}

// ---------------------------------------------------------------------------
// Error codes (FR-P7-005)
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  PARSE_ERROR: 'PARSE_ERROR',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];
