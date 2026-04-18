/**
 * HMAC-SHA256 signature verification for GitHub webhooks.
 *
 * Uses Node.js crypto with timing-safe comparison to prevent
 * timing attacks. Throws AuthenticationError on mismatch.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '../kernel/errors';

/**
 * Verify the HMAC-SHA256 signature of a GitHub webhook payload.
 *
 * @param payload - The raw request body as a string or Buffer
 * @param signature - The X-Hub-Signature-256 header value (e.g. "sha256=abc123...")
 * @param secret - The webhook secret configured in GitHub
 * @throws {AuthenticationError} If the signature does not match
 */
export function verifySignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
  options?: { prefix?: string },
): void {
  // SECURITY: Require explicit opt-in to skip verification, never in production
  if (!secret) {
    if (process.env.SKIP_SIGNATURE_VERIFICATION === 'true' && process.env.NODE_ENV !== 'production') {
      console.warn('[SECURITY] Webhook signature verification SKIPPED — SKIP_SIGNATURE_VERIFICATION is set in non-production mode');
      return;
    }
    throw new AuthenticationError(
      'Webhook secret is not configured. Set WEBHOOK_SECRET or explicitly set SKIP_SIGNATURE_VERIFICATION=true for development.',
    );
  }

  if (!signature) {
    throw new AuthenticationError('Missing X-Hub-Signature-256 header');
  }

  const prefix = options?.prefix ?? 'sha256=';

  if (prefix && !signature.startsWith(prefix)) {
    throw new AuthenticationError(`Invalid signature format: must start with ${prefix}`);
  }

  const expectedHmac = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedSignature = `${prefix}${expectedHmac}`;

  // Both strings must be the same length for timingSafeEqual
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length) {
    throw new AuthenticationError('Invalid webhook signature');
  }

  if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new AuthenticationError('Invalid webhook signature');
  }
}
