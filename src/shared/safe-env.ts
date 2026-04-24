/**
 * Safe environment variable filtering for child processes.
 *
 * Extracted from execution/swarm/cli-client.ts so that all modules
 * that spawn child processes can share the same whitelist without
 * depending on the (now-deleted) CLI client module.
 */

import { SECRET_KEY_PATTERN, EXPLICIT_SCRUB_KEYS } from '../tasks/local-shell/guards.js';

// ---------------------------------------------------------------------------
// Safe environment variable whitelist (QUALITY-10 fix)
// ---------------------------------------------------------------------------

/**
 * WHITELIST approach: only the keys listed here are ever forwarded to child
 * processes. This is strictly safer than a scrub-list because unknown keys
 * are blocked by default. The `buildSafeEnv` function additionally validates
 * every whitelisted key against `SECRET_KEY_PATTERN` and the `INPUT_` prefix
 * as defense-in-depth — so even if someone mistakenly adds a dangerous key
 * here, it will be rejected at runtime.
 */
export const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
  'TMPDIR', 'TMP', 'TEMP',
  'EDITOR', 'VISUAL', 'PAGER',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'COLORTERM', 'TERM_PROGRAM', 'FORCE_COLOR',
  'CLAUDE_FLOW_V3_ENABLED', 'CLAUDE_FLOW_HOOKS_ENABLED',
  'AGENT_SPAWN_MODE',
  // GitHub App installation token — intentionally passed to child agents
  // so the gh CLI authenticates as the bot, not the ambient user.
  'GH_TOKEN',
  // npm/pnpm runtime
  'npm_config_prefix', 'npm_config_cache',
]);

/**
 * Keys that intentionally contain secrets and must bypass the SECRET_KEY_PATTERN
 * defense-in-depth check. These are short-lived tokens injected by the orchestrator
 * (e.g., GitHub App installation tokens), NOT long-lived credentials.
 */
const INTENTIONAL_SECRET_KEYS = new Set(['GH_TOKEN']);

/**
 * Build a safe env object from a source (defaults to process.env).
 *
 * Defense-in-depth: even though `SAFE_ENV_KEYS` is a whitelist, we still
 * reject any key that matches `SECRET_KEY_PATTERN`, starts with `INPUT_`,
 * or appears in the explicit CI scrub set. This catches future whitelist
 * mistakes before they reach a subprocess.
 */
export function buildSafeEnv(
  source: Record<string, string | undefined> = process.env,
  extraAllowedKeys?: Set<string>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (
      !INTENTIONAL_SECRET_KEYS.has(key) && (
        SECRET_KEY_PATTERN.test(key) ||
        key.startsWith('INPUT_') ||
        EXPLICIT_SCRUB_KEYS.has(key)
      )
    ) {
      continue; // defense-in-depth: reject even whitelisted dangerous keys
    }
    if (source[key] !== undefined) {
      safe[key] = source[key]!;
    }
  }
  // Extra allowed keys bypass the whitelist (for injected secrets from the store)
  if (extraAllowedKeys) {
    for (const key of extraAllowedKeys) {
      if (source[key] !== undefined) {
        safe[key] = source[key]!;
      }
    }
  }
  safe.FORCE_COLOR = '0';
  return safe;
}
