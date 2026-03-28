/**
 * Safe environment variable filtering for child processes.
 *
 * Extracted from execution/swarm/cli-client.ts so that all modules
 * that spawn child processes can share the same whitelist without
 * depending on the (now-deleted) CLI client module.
 */

// ---------------------------------------------------------------------------
// Safe environment variable whitelist (QUALITY-10 fix)
// ---------------------------------------------------------------------------

/** Keys safe to pass to child processes. No secrets, tokens, or credentials. */
export const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
  'TMPDIR', 'TMP', 'TEMP',
  'EDITOR', 'VISUAL', 'PAGER',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'COLORTERM', 'TERM_PROGRAM', 'FORCE_COLOR',
  'CLAUDE_FLOW_V3_ENABLED', 'CLAUDE_FLOW_HOOKS_ENABLED',
  // npm/pnpm runtime
  'npm_config_prefix', 'npm_config_cache',
]);

/** Build a safe env object from a source (defaults to process.env). */
export function buildSafeEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) {
      safe[key] = source[key]!;
    }
  }
  safe.FORCE_COLOR = '0';
  return safe;
}
