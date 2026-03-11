/**
 * HMAC-SHA256 signature verification for GitHub webhooks.
 *
 * Uses Node.js crypto with timing-safe comparison to prevent
 * timing attacks. Throws AuthenticationError on mismatch.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '../shared/errors';

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
): void {
  // Dev mode: skip verification when no secret is configured
  if (!secret) {
    return;
  }

  if (!signature) {
    throw new AuthenticationError('Missing X-Hub-Signature-256 header');
  }

  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) {
    throw new AuthenticationError('Invalid signature format: must start with sha256=');
  }

  const expectedHmac = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedSignature = `${expectedPrefix}${expectedHmac}`;

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
