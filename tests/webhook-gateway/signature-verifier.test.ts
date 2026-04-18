import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../../src/webhook-gateway/signature-verifier';
import { AuthenticationError } from '../../src/kernel/errors';

function computeSignature(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hmac}`;
}

describe('verifySignature', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"action":"opened"}';

  it('should pass with a valid signature', () => {
    const signature = computeSignature(payload, secret);
    // Should not throw
    verifySignature(payload, signature, secret);
  });

  it('should throw AuthenticationError with an invalid signature', () => {
    const badSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
    assert.throws(
      () => verifySignature(payload, badSignature, secret),
      (err: unknown) => {
        assert.ok(err instanceof AuthenticationError);
        assert.match(err.message, /Invalid webhook signature/);
        return true;
      },
    );
  });

  it('should throw when secret is empty and SKIP_SIGNATURE_VERIFICATION is not set', () => {
    delete process.env.SKIP_SIGNATURE_VERIFICATION;
    assert.throws(
      () => verifySignature(payload, 'garbage', ''),
      (err: unknown) => {
        assert.ok(err instanceof AuthenticationError);
        assert.match(err.message, /Webhook secret is not configured/);
        return true;
      },
    );
  });

  it('should skip verification when SKIP_SIGNATURE_VERIFICATION=true and secret is empty', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.SKIP_SIGNATURE_VERIFICATION = 'true';
    process.env.NODE_ENV = 'test';
    try {
      // Should not throw even with garbage signature
      verifySignature(payload, 'garbage', '');
    } finally {
      delete process.env.SKIP_SIGNATURE_VERIFICATION;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('should throw when signature header is missing and secret is set', () => {
    assert.throws(
      () => verifySignature(payload, '', secret),
      (err: unknown) => {
        assert.ok(err instanceof AuthenticationError);
        assert.match(err.message, /Missing X-Hub-Signature-256/);
        return true;
      },
    );
  });

  it('should throw when signature format is invalid', () => {
    assert.throws(
      () => verifySignature(payload, 'md5=abc123', secret),
      (err: unknown) => {
        assert.ok(err instanceof AuthenticationError);
        assert.match(err.message, /Invalid signature format/);
        return true;
      },
    );
  });

  it('should use timing-safe comparison (different length rejects)', () => {
    // A signature with wrong length should also be rejected
    assert.throws(
      () => verifySignature(payload, 'sha256=tooshort', secret),
      (err: unknown) => {
        assert.ok(err instanceof AuthenticationError);
        return true;
      },
    );
  });

  it('should work with Buffer payload', () => {
    const bufPayload = Buffer.from(payload);
    const signature = computeSignature(payload, secret);
    // Should not throw
    verifySignature(bufPayload, signature, secret);
  });
});
