/**
 * LocalShellTask guards — pure helpers with no spawn dependency.
 *
 * Mirrors Claude Code's `src/tasks/LocalShellTask/guards.ts`. These helpers
 * enforce the security boundary around `local_bash` task dispatch:
 *   - cwd must resolve inside an allowed worktree root (no symlink escape)
 *   - subprocess env is built from an allowlist + secret-key stripping
 *
 * Kept in a separate file so non-executor consumers can import without
 * pulling `child_process`. (FR-P13-006, FR-P13-007)
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// cwd allowlist
// ---------------------------------------------------------------------------

export class CwdNotAllowedError extends Error {
  constructor(public readonly resolvedCwd: string) {
    super(`cwd not inside any allowed root: ${resolvedCwd}`);
    this.name = 'CwdNotAllowedError';
  }
}

/**
 * Assert that `cwd` resolves to a path inside one of `allowedRoots`.
 * Both inputs are realpath-resolved before comparison so a symlink cannot
 * escape its declared root.
 *
 * Throws `CwdNotAllowedError` if no root contains the resolved cwd.
 */
export function assertCwdAllowed(cwd: string, allowedRoots: readonly string[]): void {
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new CwdNotAllowedError(cwd);
  }
  let real: string;
  try {
    real = realpathSync(resolve(cwd));
  } catch {
    throw new CwdNotAllowedError(cwd);
  }
  const realRoots = allowedRoots.map((root) => {
    try {
      return realpathSync(resolve(root));
    } catch {
      return resolve(root);
    }
  });
  const inside = realRoots.some(
    (root) => real === root || real.startsWith(root + sep),
  );
  if (!inside) {
    throw new CwdNotAllowedError(real);
  }
}

// ---------------------------------------------------------------------------
// env allowlist + secret stripping
// ---------------------------------------------------------------------------

/** Default allowlist for env vars inherited from the parent process. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SHELL',
];

/** Keys matching this pattern are stripped from the final env, even if
 * supplied explicitly via the payload. Defence in depth against secret
 * leakage from operator typos. */
export const SECRET_KEY_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

/**
 * Build the subprocess env: parent allowlist merged with payload overrides,
 * minus any key matching the secret pattern.
 *
 * - The parent process is read for allowlisted keys only — there is no
 *   automatic `process.env` passthrough.
 * - Payload values win over parent values for the same key.
 * - The secret pattern is applied LAST so a payload-supplied secret is also
 *   stripped (caller bug protection).
 */
export function buildEnv(
  payloadEnv: Record<string, string> | undefined,
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const key of allowlist) {
    const value = parentEnv[key];
    if (typeof value === 'string') {
      merged[key] = value;
    }
  }
  if (payloadEnv) {
    for (const [key, value] of Object.entries(payloadEnv)) {
      if (typeof value === 'string') {
        merged[key] = value;
      }
    }
  }
  for (const key of Object.keys(merged)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      delete merged[key];
    }
  }
  return merged;
}
