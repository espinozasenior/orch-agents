/**
 * GitHub App authentication — JWT signing + installation token caching.
 *
 * Uses Node built-in `crypto` for RS256 JWT signing (no external deps).
 * Tokens are cached and refreshed automatically when <5 min remaining.
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import type { Logger } from '../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitHubTokenProvider {
  getToken(): Promise<string>;
}

export interface GitHubAppTokenProviderOpts {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function base64url(data: string): string {
  return Buffer.from(data, 'utf-8').toString('base64url');
}

/** @internal Exported for testing. */
export function createJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: appId,
    iat: now - 60,
    exp: now + 600,
  }));

  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey, 'base64url');

  return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitHubAppTokenProvider(
  opts: GitHubAppTokenProviderOpts,
): GitHubTokenProvider {
  const { appId, installationId, logger } = opts;
  const privateKey = readFileSync(opts.privateKeyPath, 'utf-8');

  let cache: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function doRefresh(): Promise<string> {
    logger?.debug('Refreshing GitHub App installation token', { appId, installationId });

    const jwt = createJWT(appId, privateKey);

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'orch-agents',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub App token exchange failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { token: string; expires_at: string };

    if (!data.token || !data.expires_at) {
      throw new Error('GitHub App token response missing required fields (token, expires_at)');
    }

    cache = {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    };

    logger?.info('GitHub App installation token refreshed', {
      appId,
      expiresAt: data.expires_at,
    });

    return cache.token;
  }

  async function getToken(): Promise<string> {
    // Return cached token if >5 min remaining
    if (cache && cache.expiresAt > Date.now() + 300_000) {
      return cache.token;
    }

    // Dedup concurrent refresh calls
    if (!refreshing) {
      refreshing = doRefresh().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  return { getToken };
}
