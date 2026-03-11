import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBuffer, type EventBuffer } from '../../src/webhook-gateway/event-buffer';
import { ConflictError, RateLimitError } from '../../src/shared/errors';

describe('EventBuffer', () => {
  let buffer: EventBuffer;

  afterEach(() => {
    if (buffer) {
      buffer.dispose();
    }
  });

  it('should accept first delivery ID (not duplicate)', () => {
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });
    // Should not throw
    buffer.check('delivery-1', 'owner/repo');
  });

  it('should reject same delivery ID within TTL (duplicate)', () => {
    buffer = createEventBuffer({
      deduplicationTtlMs: 30_000,
      cleanupIntervalMs: 60_000,
    });
    buffer.check('delivery-dup', 'owner/repo');

    assert.throws(
      () => buffer.check('delivery-dup', 'owner/repo'),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.match(err.message, /Duplicate delivery/);
        return true;
      },
    );
  });

  it('should accept same delivery ID after TTL expires', () => {
    // Use a very short TTL for testing
    buffer = createEventBuffer({
      deduplicationTtlMs: 1, // 1ms TTL
      cleanupIntervalMs: 60_000,
    });
    buffer.check('delivery-expire', 'owner/repo');

    // Wait for TTL to expire - use a synchronous busy wait for test
    const start = Date.now();
    while (Date.now() - start < 10) {
      // busy wait 10ms
    }

    // Should not throw after TTL expired
    buffer.check('delivery-expire', 'owner/repo');
  });

  it('should enforce rate limiting per repository', () => {
    buffer = createEventBuffer({
      maxEventsPerMinute: 3,
      cleanupIntervalMs: 60_000,
    });

    buffer.check('d-1', 'owner/repo');
    buffer.check('d-2', 'owner/repo');
    buffer.check('d-3', 'owner/repo');

    // 4th event should be rate limited
    assert.throws(
      () => buffer.check('d-4', 'owner/repo'),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.ok(err.retryAfter > 0);
        return true;
      },
    );
  });

  it('should track rate limits per repository independently', () => {
    buffer = createEventBuffer({
      maxEventsPerMinute: 2,
      cleanupIntervalMs: 60_000,
    });

    buffer.check('d-a1', 'owner/repo-a');
    buffer.check('d-a2', 'owner/repo-a');

    // repo-a is at limit, but repo-b should still work
    buffer.check('d-b1', 'owner/repo-b');
  });

  it('should allow different delivery IDs from same repo', () => {
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });

    buffer.check('unique-1', 'owner/repo');
    buffer.check('unique-2', 'owner/repo');
    buffer.check('unique-3', 'owner/repo');
    // All should pass (no duplicates)
  });

  it('should clean up after dispose', () => {
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });
    buffer.check('d-dispose', 'owner/repo');
    buffer.dispose();
    // After dispose, a new buffer should accept the same ID
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });
    buffer.check('d-dispose', 'owner/repo');
  });
});
