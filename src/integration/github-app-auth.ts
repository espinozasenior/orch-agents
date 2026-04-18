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
  /** Resolve an installation token for the org/user that owns the given repo. */
  getTokenForRepo(repoFullName: string): Promise<string>;
  /** Fetch the App's slug from GitHub (e.g., "automata-ai-bot"). Bot login is `${slug}[bot]`. */
  getAppSlug(): Promise<string>;
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

// ---------------------------------------------------------------------------
// Installation list types
// ---------------------------------------------------------------------------

interface GitHubInstallation {
  id: number;
  account: { login: string } | null;
}

export function createGitHubAppTokenProvider(
  opts: GitHubAppTokenProviderOpts,
): GitHubTokenProvider {
  const { appId, installationId, logger } = opts;
  const privateKey = readFileSync(opts.privateKeyPath, 'utf-8');

  // Per-installation token cache keyed by installation ID string
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();
  const refreshing = new Map<string, Promise<string>>();

  // Installation list cache (refreshed every 10 minutes)
  let installationsCache: GitHubInstallation[] | null = null;
  let installationsCacheExpiresAt = 0;

  async function listInstallations(): Promise<GitHubInstallation[]> {
    if (installationsCache && Date.now() < installationsCacheExpiresAt) {
      return installationsCache;
    }

    const jwt = createJWT(appId, privateKey);
    const response = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'orch-agents',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub GET /app/installations failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as GitHubInstallation[];
    installationsCache = data;
    installationsCacheExpiresAt = Date.now() + 10 * 60_000; // 10 min TTL

    logger?.debug('GitHub App installations fetched', {
      count: data.length,
      accounts: data.map((i) => i.account?.login).filter(Boolean),
    });

    return data;
  }

  async function resolveInstallationId(owner: string): Promise<string> {
    const installations = await listInstallations();
    const match = installations.find(
      (i) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
    );

    if (!match) {
      const available = installations
        .map((i) => i.account?.login)
        .filter(Boolean)
        .join(', ');
      throw new Error(
        `No GitHub App installation found for owner "${owner}". ` +
        `Available installations: [${available}]`,
      );
    }

    return String(match.id);
  }

  async function doRefreshForInstallation(instId: string): Promise<string> {
    logger?.debug('Refreshing GitHub App installation token', { appId, installationId: instId });

    const jwt = createJWT(appId, privateKey);

    const response = await fetch(
      `https://api.github.com/app/installations/${instId}/access_tokens`,
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

    tokenCache.set(instId, {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    });

    logger?.info('GitHub App installation token refreshed', {
      appId,
      installationId: instId,
      expiresAt: data.expires_at,
    });

    return data.token;
  }

  function getTokenForInstallation(instId: string): Promise<string> {
    // Return cached token if >5 min remaining
    const cached = tokenCache.get(instId);
    if (cached && cached.expiresAt > Date.now() + 300_000) {
      return Promise.resolve(cached.token);
    }

    // Dedup concurrent refresh calls per installation
    let pending = refreshing.get(instId);
    if (!pending) {
      pending = doRefreshForInstallation(instId).finally(() => {
        refreshing.delete(instId);
      });
      refreshing.set(instId, pending);
    }
    return pending;
  }

  async function getToken(): Promise<string> {
    return getTokenForInstallation(installationId);
  }

  async function getTokenForRepo(repoFullName: string): Promise<string> {
    const slashIdx = repoFullName.indexOf('/');
    if (slashIdx < 1) {
      throw new Error(`Invalid repo name "${repoFullName}" — expected "owner/repo" format`);
    }
    const owner = repoFullName.slice(0, slashIdx);
    const instId = await resolveInstallationId(owner);
    return getTokenForInstallation(instId);
  }

  let appSlug: string | null = null;

  async function getAppSlug(): Promise<string> {
    if (appSlug) return appSlug;

    const jwt = createJWT(appId, privateKey);
    const response = await fetch('https://api.github.com/app', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'orch-agents',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub GET /app failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { slug: string };
    if (!data.slug) {
      throw new Error('GitHub App response missing slug field');
    }

    appSlug = data.slug;
    logger?.info('GitHub App slug resolved', { slug: appSlug });
    return appSlug;
  }

  return { getToken, getTokenForRepo, getAppSlug };
}
