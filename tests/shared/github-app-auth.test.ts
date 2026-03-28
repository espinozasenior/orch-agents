/**
 * Tests for GitHub App authentication — JWT signing + token caching.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createJWT, createGitHubAppTokenProvider } from '../../src/integration/github-app-auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateTestKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function writeTempPem(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-app-test-'));
  const path = join(dir, 'test.pem');
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// createJWT
// ---------------------------------------------------------------------------

describe('createJWT', () => {
  const { privateKey } = generateTestKeyPair();

  it('produces a 3-part JWT string', () => {
    const jwt = createJWT('12345', privateKey);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'JWT should have 3 parts');
    assert.ok(parts[0].length > 0, 'header should be non-empty');
    assert.ok(parts[1].length > 0, 'payload should be non-empty');
    assert.ok(parts[2].length > 0, 'signature should be non-empty');
  });

  it('header has alg RS256 and typ JWT', () => {
    const jwt = createJWT('12345', privateKey);
    const header = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');
  });

  it('payload has correct iss and exp ~10 min from now', () => {
    const jwt = createJWT('99999', privateKey);
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    assert.equal(payload.iss, '99999');

    const now = Math.floor(Date.now() / 1000);
    // iat should be ~60s before now
    assert.ok(Math.abs(payload.iat - (now - 60)) < 5, 'iat should be now - 60');
    // exp should be ~600s from now
    assert.ok(Math.abs(payload.exp - (now + 600)) < 5, 'exp should be now + 600');
  });
});

// ---------------------------------------------------------------------------
// createGitHubAppTokenProvider
// ---------------------------------------------------------------------------

describe('createGitHubAppTokenProvider', () => {
  it('throws when private key file does not exist', () => {
    assert.throws(
      () => createGitHubAppTokenProvider({
        appId: '1',
        privateKeyPath: '/nonexistent/key.pem',
        installationId: '2',
      }),
      /ENOENT/,
    );
  });

  describe('getToken', () => {
    const { privateKey } = generateTestKeyPair();
    let pemPath: string;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      pemPath = writeTempPem(privateKey);
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      try { unlinkSync(pemPath); } catch { /* ignore */ }
    });

    it('calls GitHub API and returns token', async () => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const mockFetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ token: 'ghs_test123', expires_at: expiresAt }),
        text: async () => '',
      }));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const provider = createGitHubAppTokenProvider({
        appId: '42',
        privateKeyPath: pemPath,
        installationId: '100',
      });

      const token = await provider.getToken();
      assert.equal(token, 'ghs_test123');
      assert.equal(mockFetch.mock.calls.length, 1);

      const [url, opts] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
      assert.ok(url.includes('/installations/100/access_tokens'));
      assert.equal(opts.method, 'POST');
      assert.ok((opts.headers as Record<string, string>).Authorization.startsWith('Bearer '));
    });

    it('returns cached token on second call', async () => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const mockFetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ token: 'ghs_cached', expires_at: expiresAt }),
        text: async () => '',
      }));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const provider = createGitHubAppTokenProvider({
        appId: '42',
        privateKeyPath: pemPath,
        installationId: '100',
      });

      const t1 = await provider.getToken();
      const t2 = await provider.getToken();
      assert.equal(t1, 'ghs_cached');
      assert.equal(t2, 'ghs_cached');
      assert.equal(mockFetch.mock.calls.length, 1, 'should only call API once');
    });

    it('refreshes token when cache expires within 5 minutes', async () => {
      // First token expires in less than 5 minutes — should trigger a refresh on second call
      const nearExpiry = new Date(Date.now() + 4 * 60_000).toISOString(); // 4 min from now
      const farExpiry = new Date(Date.now() + 3600_000).toISOString();
      let callCount = 0;
      const mockFetch = mock.fn(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            token: callCount === 1 ? 'ghs_short' : 'ghs_refreshed',
            expires_at: callCount === 1 ? nearExpiry : farExpiry,
          }),
          text: async () => '',
        };
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const provider = createGitHubAppTokenProvider({
        appId: '42',
        privateKeyPath: pemPath,
        installationId: '100',
      });

      const t1 = await provider.getToken();
      assert.equal(t1, 'ghs_short');
      assert.equal(mockFetch.mock.calls.length, 1);

      // Second call should refresh because cache expires in <5 min
      const t2 = await provider.getToken();
      assert.equal(t2, 'ghs_refreshed');
      assert.equal(mockFetch.mock.calls.length, 2, 'should call API twice when cache is near expiry');
    });

    it('throws on non-OK response', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'Bad credentials',
      }));
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const provider = createGitHubAppTokenProvider({
        appId: '42',
        privateKeyPath: pemPath,
        installationId: '100',
      });

      await assert.rejects(
        () => provider.getToken(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('401'));
          return true;
        },
      );
    });
  });
});
