/**
 * `orch-setup mint-token` — bootstrap a web API token.
 *
 * Solves the chicken-and-egg: the `/settings/tokens` UI lets operators mint
 * tokens, but reaching the UI requires a working ORCH_API_TOKEN. This CLI
 * mints the *first* token from a shell so the operator can put it in the
 * web process env without touching curl or SQLite.
 *
 * Usage:
 *   orch-setup mint-token --label="dev" --scopes=runs:read,automations:write
 *   orch-setup mint-token --label="dev" --scopes=runs:read --to-env=.env
 */

import { resolve } from 'node:path';
import { ALL_SCOPES, createWebTokenStore, type WebTokenScope } from '../../web-api/web-auth';
import { writeEnvFile } from '../env-writer';

export interface MintTokenOptions {
  label: string;
  scopes: string;
  toEnv?: string;
  /** Override the SQLite path (tests inject this). Defaults to data/secrets.db. */
  dbPath?: string;
}

function parseScopes(raw: string): WebTokenScope[] {
  const scopes = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (scopes.length === 0) {
    throw new Error(`--scopes is required (one or more of: ${ALL_SCOPES.join(', ')})`);
  }
  for (const s of scopes) {
    if (!(ALL_SCOPES as readonly string[]).includes(s)) {
      throw new Error(`unknown scope '${s}'. Valid scopes: ${ALL_SCOPES.join(', ')}`);
    }
  }
  return scopes as WebTokenScope[];
}

export async function runMintToken(options: MintTokenOptions): Promise<void> {
  if (!options.label || !options.label.trim()) {
    throw new Error('--label is required');
  }
  const scopes = parseScopes(options.scopes);
  // Must match the path used by index.ts when wiring the API's web token store.
  // Override with WEB_TOKENS_DB_PATH if you've moved it.
  const dbPath =
    options.dbPath ??
    process.env.WEB_TOKENS_DB_PATH ??
    resolve(process.cwd(), 'data', 'web-tokens.db');

  const store = createWebTokenStore(dbPath);
  try {
    const minted = store.mint({ label: options.label, scopes });

    if (options.toEnv) {
      const envPath = resolve(options.toEnv);
      writeEnvFile(envPath, { ORCH_API_TOKEN: minted.token });
      console.log(`  \x1b[32mMinted token '${minted.label}' (${minted.id})\x1b[0m`);
      console.log(`  \x1b[2mWrote ORCH_API_TOKEN=... to ${envPath}\x1b[0m`);
      console.log(`  \x1b[2mScopes: ${minted.scopes.join(', ')}\x1b[0m`);
    } else {
      // Plaintext only — nothing else, so it pipes cleanly into other tools.
      console.log(minted.token);
    }
  } finally {
    store.close();
  }
}
