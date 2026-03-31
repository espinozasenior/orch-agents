/**
 * OAuth token lifecycle management for Linear actor=app authentication.
 *
 * Handles token exchange, refresh with 5-minute buffer, revocation,
 * and concurrent refresh coalescing to prevent thundering herd.
 *
 * Factory: createOAuthTokenStore(deps) => OAuthTokenStore
 */

import type { Logger } from '../../shared/logger';
import { LinearAuthError } from './linear-client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute timestamp (ms since epoch) when the access token expires. */
  expiresAt: number;
}

export interface OAuthTokenStore {
  /** Return the current access token (synchronous). */
  getAccessToken(): string;
  /** Return the full token set (synchronous). */
  getTokenSet(): OAuthTokenSet;
  /**
   * Refresh the access token if it is within 5 minutes of expiry.
   * When `force` is true, always refresh regardless of expiry.
   * Concurrent calls coalesce into a single network request.
   */
  refreshIfNeeded(force?: boolean): Promise<void>;
  /**
   * Exchange an authorization code for tokens.
   * Stores the resulting token set internally.
   */
  exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet>;
  /** Revoke the current access token. */
  revokeToken(): Promise<void>;
}

export interface OAuthTokenStoreDeps {
  clientId: string;
  clientSecret: string;
  initialTokens?: OAuthTokenSet;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  logger?: Logger;
  /** Override token endpoint (default: https://api.linear.app/oauth/token). */
  tokenEndpoint?: string;
  /** Override revoke endpoint (default: https://api.linear.app/oauth/revoke). */
  revokeEndpoint?: string;
  /** Called after a successful token refresh with the new token set. */
  onTokenRefreshed?: (tokens: OAuthTokenSet) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';
const DEFAULT_REVOKE_ENDPOINT = 'https://api.linear.app/oauth/revoke';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOAuthTokenStore(deps: OAuthTokenStoreDeps): OAuthTokenStore {
  const {
    clientId,
    clientSecret,
    logger,
    onTokenRefreshed,
  } = deps;

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const tokenEndpoint = deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const revokeEndpoint = deps.revokeEndpoint ?? DEFAULT_REVOKE_ENDPOINT;

  let tokens: OAuthTokenSet = deps.initialTokens
    ? { ...deps.initialTokens }
    : { accessToken: '', refreshToken: '', expiresAt: 0 };

  /** In-flight refresh promise for coalescing concurrent calls. */
  let inflightRefresh: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    logger?.debug('oauth-token-store: refreshing access token');

    const response = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      logger?.error('oauth-token-store: refresh failed', {
        status: response.status,
        body: text,
      });
      throw new LinearAuthError(
        `Token refresh failed: ${response.status}`,
        response.status,
        { cause: text },
      );
    }

    const body = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000,
    };

    onTokenRefreshed?.(tokens);
  }

  return {
    getAccessToken(): string {
      return tokens.accessToken;
    },

    getTokenSet(): OAuthTokenSet {
      return { ...tokens };
    },

    async refreshIfNeeded(force = false): Promise<void> {
      const needsRefresh = force || (tokens.expiresAt - Date.now() < REFRESH_BUFFER_MS);
      if (!needsRefresh) return;

      // Coalesce concurrent refresh calls
      if (inflightRefresh) {
        return inflightRefresh;
      }

      inflightRefresh = doRefresh().finally(() => {
        inflightRefresh = null;
      });

      return inflightRefresh;
    },

    async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenSet> {
      logger?.debug('oauth-token-store: exchanging authorization code');

      const response = await fetchFn(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        logger?.error('oauth-token-store: code exchange failed', {
          status: response.status,
        });
        throw new LinearAuthError(
          `Code exchange failed: ${response.status}`,
          response.status,
          { cause: text },
        );
      }

      const body = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      tokens = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + body.expires_in * 1000,
      };

      onTokenRefreshed?.(tokens);
      return { ...tokens };
    },

    async revokeToken(): Promise<void> {
      logger?.debug('oauth-token-store: revoking token');

      const response = await fetchFn(revokeEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          token: tokens.accessToken,
        }).toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new LinearAuthError(
          `Token revocation failed: ${response.status}`,
          response.status,
          { cause: text },
        );
      }

      tokens = { accessToken: '', refreshToken: '', expiresAt: 0 };
    },
  };
}
