/**
 * Tests for shared/webhook-error-handler.ts
 *
 * Covers HTTP status code mapping for each AppError subclass,
 * structured response bodies, and fallback to 500.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhookError } from '../../src/shared/webhook-error-handler';
import {
  AppError,
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ValidationError,
  ExecutionError,
} from '../../src/shared/errors';

// ---------------------------------------------------------------------------
// Test helpers — minimal FastifyReply and Logger stubs
// ---------------------------------------------------------------------------

interface StubReplyState {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

function createStubReply(): { reply: ReturnType<typeof createFakeReply>; state: StubReplyState } {
  const state: StubReplyState = { statusCode: 0, headers: {}, body: undefined };
  const reply = createFakeReply(state);
  return { reply, state };
}

function createFakeReply(state: StubReplyState) {
  const self = {
    status(code: number) { state.statusCode = code; return self; },
    header(key: string, val: string) { state.headers[key] = val; return self; },
    send(body: unknown) { state.body = body; return self; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return self as any;
}

function createStubLogger() {
  const calls: Array<{ level: string; msg: string; meta?: unknown }> = [];
  return {
    calls,
    info(msg: string, meta?: unknown) { calls.push({ level: 'info', msg, meta }); },
    warn(msg: string, meta?: unknown) { calls.push({ level: 'warn', msg, meta }); },
    error(msg: string, meta?: unknown) { calls.push({ level: 'error', msg, meta }); },
    debug(msg: string, meta?: unknown) { calls.push({ level: 'debug', msg, meta }); },
    fatal(msg: string, meta?: unknown) { calls.push({ level: 'fatal', msg, meta }); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleWebhookError', () => {
  it('returns 401 for AuthenticationError', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new AuthenticationError('bad token'), reply, log);
    assert.strictEqual(state.statusCode, 401);
    const body = state.body as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'ERR_AUTHENTICATION');
    assert.strictEqual(body.error.message, 'bad token');
  });

  it('returns 409 for ConflictError', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new ConflictError('duplicate delivery'), reply, log);
    assert.strictEqual(state.statusCode, 409);
    const body = state.body as { error: { code: string } };
    assert.strictEqual(body.error.code, 'ERR_CONFLICT');
  });

  it('returns 429 for RateLimitError with Retry-After header', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new RateLimitError(60), reply, log);
    assert.strictEqual(state.statusCode, 429);
    assert.strictEqual(state.headers['Retry-After'], '60');
    const body = state.body as { error: { retryAfter: number } };
    assert.strictEqual(body.error.retryAfter, 60);
  });

  it('returns 400 for ValidationError with fields', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(
      new ValidationError('invalid payload', { body: 'missing required field' }),
      reply,
      log,
    );
    assert.strictEqual(state.statusCode, 400);
    const body = state.body as { error: { code: string; fields: Record<string, string> } };
    assert.strictEqual(body.error.code, 'ERR_VALIDATION');
    assert.deepStrictEqual(body.error.fields, { body: 'missing required field' });
  });

  it('returns custom statusCode for generic AppError', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(
      new AppError('custom error', { code: 'ERR_CUSTOM', statusCode: 503 }),
      reply,
      log,
    );
    assert.strictEqual(state.statusCode, 503);
    const body = state.body as { error: { code: string } };
    assert.strictEqual(body.error.code, 'ERR_CUSTOM');
  });

  it('returns 500 for ExecutionError (domain error extending AppError)', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new ExecutionError('agent crashed'), reply, log);
    assert.strictEqual(state.statusCode, 500);
    const body = state.body as { error: { code: string } };
    assert.strictEqual(body.error.code, 'ERR_EXECUTION');
  });

  it('returns 500 for unknown Error', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new Error('unexpected'), reply, log);
    assert.strictEqual(state.statusCode, 500);
    const body = state.body as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'ERR_INTERNAL');
    assert.strictEqual(body.error.message, 'An unexpected error occurred');
  });

  it('returns 500 for non-Error values (string)', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError('string error', reply, log);
    assert.strictEqual(state.statusCode, 500);
  });

  it('returns 500 for non-Error values (null)', () => {
    const { reply, state } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(null, reply, log);
    assert.strictEqual(state.statusCode, 500);
  });

  it('logs at warn level for AuthenticationError', () => {
    const { reply } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new AuthenticationError(), reply, log);
    assert.ok(log.calls.some(c => c.level === 'warn'));
  });

  it('logs at info level for ConflictError', () => {
    const { reply } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new ConflictError('dup'), reply, log);
    assert.ok(log.calls.some(c => c.level === 'info'));
  });

  it('logs at error level for unexpected errors', () => {
    const { reply } = createStubReply();
    const log = createStubLogger();
    handleWebhookError(new TypeError('oops'), reply, log);
    assert.ok(log.calls.some(c => c.level === 'error'));
  });
});
