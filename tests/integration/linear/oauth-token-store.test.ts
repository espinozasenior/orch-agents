/**
 * Tests for OAuthTokenStore -- London School TDD with mocked fetch.
 *
 * Covers: token exchange, refresh (proactive + forced + coalescing),
 * revocation, error handling, and persistence callback.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOAuthTokenStore,
  type OAuthTokenStore,
  type OAuthTokenStoreDeps,
  type OAuthTokenSet,
} from '../../../src/integration/linear/oauth-token-store';
import { LinearAuthError } from '../../../src/integration/linear/linear-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createMockTokenFetch(
  responseBody: Record<string, unknown>,
  status = 200,
) {
  const calls: FetchCall[] = [];
  const fetchFn: OAuthTokenStoreDeps['fetchFn'] = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

function createDelayedFetch(
  responseBody: Record<string, unknown>,
  delayMs: number,
) {
  const calls: FetchCall[] = [];
  const fetchFn: OAuthTokenStoreDeps['fetchFn'] = async (url, init) => {
    calls.push({ url, init });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

function defaultDeps(overrides: Partial<OAuthTokenStoreDeps> = {}): OAuthTokenStoreDeps {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OAuthTokenStore', () => {
  describe('exchangeCode', () => {
    it('calls token endpoint with correct params and stores tokens', async () => {
      const { fetchFn, calls } = createMockTokenFetch({
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        expires_in: 3600,
      });

      const store = createOAuthTokenStore(defaultDeps({ fetchFn }));
      const result = await store.exchangeCode('auth-code-789', 'http://localhost/callback');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.linear.app/oauth/token');

      const body = new URLSearchParams(calls[0].init.body as string);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'auth-code-789');
      assert.equal(body.get('client_id'), 'test-client-id');
      assert.equal(body.get('client_secret'), 'test-client-secret');
      assert.equal(body.get('redirect_uri'), 'http://localhost/callback');

      assert.equal(result.accessToken, 'access-123');
      assert.equal(result.refreshToken, 'refresh-456');
      assert.ok(result.expiresAt > Date.now());

      // Verify stored internally
      assert.equal(store.getAccessToken(), 'access-123');
    });

    it('throws LinearAuthError on failed code exchange', async () => {
      const { fetchFn } = createMockTokenFetch({ error: 'invalid_grant' }, 400);
      const store = createOAuthTokenStore(defaultDeps({ fetchFn }));

      await assert.rejects(
        () => store.exchangeCode('bad-code', 'http://localhost/callback'),
        (err: unknown) => {
          assert.ok(err instanceof LinearAuthError);
          assert.equal(err.statusCode, 400);
          return true;
        },
      );
    });
  });

  describe('refreshIfNeeded', () => {
    it('refreshes when within 5 minutes of expiry', async () => {
      const { fetchFn, calls } = createMockTokenFetch({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      });

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes from now (within buffer)
        },
      }));

      await store.refreshIfNeeded();

      assert.equal(calls.length, 1);
      const body = new URLSearchParams(calls[0].init.body as string);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'old-refresh');
      assert.equal(store.getAccessToken(), 'new-access');
    });

    it('does NOT refresh when token is fresh', async () => {
      const { fetchFn, calls } = createMockTokenFetch({
        access_token: 'new-access',
        expires_in: 3600,
      });

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'still-good',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes from now
        },
      }));

      await store.refreshIfNeeded();

      assert.equal(calls.length, 0);
      assert.equal(store.getAccessToken(), 'still-good');
    });

    it('refreshes when force=true even if token is fresh', async () => {
      const { fetchFn, calls } = createMockTokenFetch({
        access_token: 'forced-new',
        refresh_token: 'forced-refresh',
        expires_in: 3600,
      });

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'still-good',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 30 * 60 * 1000,
        },
      }));

      await store.refreshIfNeeded(true);

      assert.equal(calls.length, 1);
      assert.equal(store.getAccessToken(), 'forced-new');
    });

    it('coalesces concurrent refresh calls into one network request', async () => {
      const { fetchFn, calls } = createDelayedFetch(
        {
          access_token: 'coalesced',
          refresh_token: 'coalesced-refresh',
          expires_in: 3600,
        },
        50,
      );

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'old',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 1 * 60 * 1000, // expiring soon
        },
      }));

      // Fire 3 concurrent refreshes
      await Promise.all([
        store.refreshIfNeeded(),
        store.refreshIfNeeded(),
        store.refreshIfNeeded(),
      ]);

      // Only one fetch call despite 3 concurrent refreshIfNeeded calls
      assert.equal(calls.length, 1);
      assert.equal(store.getAccessToken(), 'coalesced');
    });

    it('stores new refresh token from response', async () => {
      const { fetchFn } = createMockTokenFetch({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      });

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'old',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() - 1000, // already expired
        },
      }));

      await store.refreshIfNeeded();

      const tokenSet = store.getTokenSet();
      assert.equal(tokenSet.refreshToken, 'rotated-refresh');
    });

    it('throws LinearAuthError when refresh fails', async () => {
      const { fetchFn } = createMockTokenFetch({ error: 'invalid_grant' }, 401);

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'old',
          refreshToken: 'revoked-refresh',
          expiresAt: Date.now() - 1000,
        },
      }));

      await assert.rejects(
        () => store.refreshIfNeeded(),
        (err: unknown) => {
          assert.ok(err instanceof LinearAuthError);
          assert.equal(err.statusCode, 401);
          return true;
        },
      );
    });

    it('fires onTokenRefreshed callback after successful refresh', async () => {
      const { fetchFn } = createMockTokenFetch({
        access_token: 'callback-access',
        refresh_token: 'callback-refresh',
        expires_in: 7200,
      });

      let callbackTokens: OAuthTokenSet | undefined;
      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'old',
          refreshToken: 'refresh',
          expiresAt: Date.now() - 1000,
        },
        onTokenRefreshed: (tokens) => {
          callbackTokens = tokens;
        },
      }));

      await store.refreshIfNeeded();

      assert.ok(callbackTokens);
      assert.equal(callbackTokens!.accessToken, 'callback-access');
      assert.equal(callbackTokens!.refreshToken, 'callback-refresh');
    });
  });

  describe('revokeToken', () => {
    it('calls revoke endpoint and clears tokens', async () => {
      const { fetchFn, calls } = createMockTokenFetch({});

      const store = createOAuthTokenStore(defaultDeps({
        fetchFn,
        initialTokens: {
          accessToken: 'to-revoke',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3600000,
        },
      }));

      await store.revokeToken();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.linear.app/oauth/revoke');

      const body = new URLSearchParams(calls[0].init.body as string);
      assert.equal(body.get('token'), 'to-revoke');

      assert.equal(store.getAccessToken(), '');
    });
  });

  describe('getTokenSet', () => {
    it('returns a copy of the current token set', () => {
      const store = createOAuthTokenStore(defaultDeps({
        initialTokens: {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: 999999,
        },
      }));

      const set = store.getTokenSet();
      assert.equal(set.accessToken, 'access');
      assert.equal(set.refreshToken, 'refresh');
      assert.equal(set.expiresAt, 999999);
    });
  });
});
