#!/usr/bin/env node
/**
 * `npm run dev:setup` — idempotent local-dev bootstrap.
 *
 * Ensures the operator has:
 *   1. A bearer token in `data/web-tokens.db`
 *   2. `ORCH_API_TOKEN=<token>` in root `.env`
 *   3. `packages/web/.env.local` with the same token + URL config
 *
 * Re-runs are safe: nothing is overwritten if it already looks right.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMintToken } from '../src/setup/commands/mint-token';
import { readEnvFile, writeEnvFile } from '../src/setup/env-writer';
import { createWebTokenStore, ALL_SCOPES as ALL_SCOPE_LIST } from '../src/web-api/web-auth';

const ROOT = process.cwd();
const ENV_PATH = resolve(ROOT, '.env');
const WEB_ENV_PATH = resolve(ROOT, 'packages/web/.env.local');
const TOKENS_DB = resolve(ROOT, 'data/web-tokens.db');
const ALL_SCOPES = 'runs:read,automations:write,secrets:read,secrets:write,workflow:read';

const C_RESET = '\x1b[0m';
const C_GREEN = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_DIM = '\x1b[2m';
const C_BOLD = '\x1b[1m';

function log(msg: string): void {
  console.log(msg);
}

async function main(): Promise<void> {
  mkdirSync(resolve(ROOT, 'data'), { recursive: true });
  const rootEnv = existsSync(ENV_PATH) ? readEnvFile(ENV_PATH) : {};
  const webEnv = existsSync(WEB_ENV_PATH) ? readEnvFile(WEB_ENV_PATH) : {};

  const actions: string[] = [];

  // Step 1+2 — Mint a token if neither the DB nor the env has one,
  // OR if the existing one is unknown / lacks all dev scopes.
  const hasDbTokens = existsSync(TOKENS_DB);
  const hasRootToken = Boolean(rootEnv.ORCH_API_TOKEN && rootEnv.ORCH_API_TOKEN.length >= 32);

  let needsMint = !hasDbTokens || !hasRootToken;
  let mintReason = needsMint ? 'no token yet' : '';
  if (!needsMint && rootEnv.ORCH_API_TOKEN) {
    const store = createWebTokenStore(TOKENS_DB);
    try {
      const validated = store.validate(rootEnv.ORCH_API_TOKEN);
      if (!validated) {
        needsMint = true;
        mintReason = 'existing token is unknown to the tokens DB (revoked or stale)';
      } else {
        const missing = ALL_SCOPE_LIST.filter((s) => !validated.scopes.includes(s));
        if (missing.length > 0) {
          needsMint = true;
          mintReason = `existing token is missing scope(s): ${missing.join(', ')}`;
        }
      }
    } finally {
      store.close();
    }
  }

  if (needsMint) {
    await runMintToken({
      label: 'dev-bootstrap',
      scopes: ALL_SCOPES,
      toEnv: ENV_PATH,
    });
    actions.push(
      `${C_GREEN}✓${C_RESET} Minted dev-bootstrap token, wrote ${C_BOLD}ORCH_API_TOKEN${C_RESET} to .env  ${C_DIM}(${mintReason})${C_RESET}`,
    );
  } else {
    actions.push(`${C_DIM}·${C_RESET} ORCH_API_TOKEN in .env is valid and has all 5 scopes`);
  }

  // Re-read root env so we have the value to copy into the web env
  const rootEnvAfter = readEnvFile(ENV_PATH);
  const token = rootEnvAfter.ORCH_API_TOKEN;
  if (!token) {
    throw new Error('ORCH_API_TOKEN is unexpectedly missing from .env after mint');
  }

  // Step 3 — Web .env.local
  const webNeedsUpdate =
    webEnv.ORCH_API_URL !== 'http://127.0.0.1:3002' ||
    webEnv.ORCH_ADMIN_URL !== 'http://127.0.0.1:3001' ||
    webEnv.ORCH_API_TOKEN !== token;

  if (webNeedsUpdate) {
    writeEnvFile(WEB_ENV_PATH, {
      ORCH_API_URL: 'http://127.0.0.1:3002',
      ORCH_ADMIN_URL: 'http://127.0.0.1:3001',
      ORCH_API_TOKEN: token,
    });
    actions.push(`${C_GREEN}✓${C_RESET} Wrote ${C_BOLD}packages/web/.env.local${C_RESET} (URLs + matching token)`);
  } else {
    actions.push(`${C_DIM}·${C_RESET} packages/web/.env.local already configured`);
  }

  // Step 4 — Optional secrets store warning (do NOT auto-write a master key)
  const hasMasterKey = Boolean(rootEnv.SECRETS_MASTER_KEY);
  if (!hasMasterKey) {
    actions.push(
      `${C_YELLOW}!${C_RESET} ${C_BOLD}SECRETS_MASTER_KEY${C_RESET} is not set — the Secrets tab in the UI will show "not configured".`,
    );
    actions.push(
      `  ${C_DIM}Generate one with:${C_RESET} node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
    actions.push(`  ${C_DIM}Then add it to .env as SECRETS_MASTER_KEY=<value> and re-run npm run dev.${C_RESET}`);
  } else {
    actions.push(`${C_DIM}·${C_RESET} SECRETS_MASTER_KEY is set`);
  }

  // Step 5 — Summary
  log('');
  log(`${C_BOLD}orch-agents dev-setup${C_RESET}`);
  log('');
  for (const line of actions) log('  ' + line);
  log('');
  log(`  ${C_BOLD}Next:${C_RESET} ${C_GREEN}npm run dev${C_RESET}  ${C_DIM}(boots API + web together)${C_RESET}`);
  log('');
}

main().catch((err: unknown) => {
  console.error('dev-setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
