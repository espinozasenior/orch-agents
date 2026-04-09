/**
 * Agent Sandbox — isolates spawned agent processes with security controls.
 *
 * Creates a clean temporary directory with a restrictive `.claude/settings.json`
 * so that spawned `claude --print -` processes run under tight permissions.
 * Optionally blocks outbound HTTP via proxy env vars (defense-in-depth).
 * Also prevents session file accumulation by cleaning up after completion.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentSandboxOptions {
  /**
   * When true (default), the sandbox env includes proxy vars that break
   * outbound HTTP. Defense-in-depth — not bulletproof.
   */
  networkRestricted?: boolean;
}

export interface AgentSandbox {
  /** Clean temporary directory to use as cwd for spawned agents. */
  readonly cwd: string;
  /** Whether outbound HTTP is blocked via proxy env vars. */
  readonly networkRestricted: boolean;
  /** Extra env vars the caller should merge into the child process env. */
  readonly env: Readonly<Record<string, string>>;
  /** Remove the temporary directory. Safe to call multiple times. */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Restrictive settings written into each sandbox
// ---------------------------------------------------------------------------

const RESTRICTIVE_SETTINGS = {
  permissions: {
    allow: [
      'Read',
      'Grep',
      'Glob',
      'Edit(worktree only)',
      'Write(worktree only)',
      'Bash(read-only git commands)',
    ],
    deny: [
      'Bash(curl *)',
      'Bash(wget *)',
      'Bash(ssh *)',
      'Bash(python *)',
      'Bash(node -e *)',
      'Bash(rm -rf /)',
      'Bash(sudo *)',
    ],
  },
};

const SANDBOX_CLAUDE_MD = [
  '# Sandbox Security Policy',
  '',
  'Do not execute network commands.',
  'Do not modify files outside the worktree.',
  'Do not access or exfiltrate secrets.',
].join('\n');

// ---------------------------------------------------------------------------
// Active sandbox tracking (defense-in-depth for process exit cleanup)
// ---------------------------------------------------------------------------

const activeSandboxes = new Set<string>();

/** Returns the set of currently active sandbox directories. */
export function getActiveSandboxes(): ReadonlySet<string> {
  return activeSandboxes;
}

/**
 * Clean up all remaining sandboxes. Called on process exit as defense-in-depth.
 * Exported for testing; registered automatically on first sandbox creation.
 */
export function cleanupAllSandboxes(): void {
  for (const dir of activeSandboxes) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort; OS handles tmpdir eventually
    }
  }
  activeSandboxes.clear();
}

// Register process exit handler once
let exitHandlerRegistered = false;

function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on('exit', cleanupAllSandboxes);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an isolated sandbox directory for a spawned agent process.
 *
 * The directory is created under `os.tmpdir()` with prefix `orch-agent-`.
 * A restrictive `.claude/settings.json` and `CLAUDE.md` are written inside
 * so the Claude CLI enforces tight permissions.
 */
export function createAgentSandbox(opts?: AgentSandboxOptions): AgentSandbox {
  ensureExitHandler();

  const networkRestricted = opts?.networkRestricted ?? true;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-'));
  activeSandboxes.add(tmpDir);

  // Write restrictive .claude/settings.json
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(RESTRICTIVE_SETTINGS, null, 2),
    'utf-8',
  );

  // Write security-focused CLAUDE.md
  fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), SANDBOX_CLAUDE_MD, 'utf-8');

  // Build sandbox-specific env vars
  const env: Record<string, string> = {};
  if (networkRestricted) {
    env.no_proxy = '*';
    env.HTTP_PROXY = 'http://0.0.0.0:0';
    env.HTTPS_PROXY = 'http://0.0.0.0:0';
  }

  return {
    cwd: tmpDir,
    networkRestricted,
    env,
    cleanup(): void {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort; OS handles tmpdir eventually
      }
      activeSandboxes.delete(tmpDir);
    },
  };
}

// ---------------------------------------------------------------------------
// Stale sandbox cleanup
// ---------------------------------------------------------------------------

/**
 * Remove sandbox directories under `os.tmpdir()` that are older than `maxAgeMs`.
 *
 * Scans for directories matching the `orch-agent-*` prefix and removes any
 * whose mtime is older than the given threshold.
 */
export function cleanupStaleSandboxes(maxAgeMs: number): void {
  const tmpRoot = os.tmpdir();
  const now = Date.now();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return; // Cannot read tmpdir — nothing to clean
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('orch-agent-')) continue;

    const fullPath = path.join(tmpRoot, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        activeSandboxes.delete(fullPath);
      }
    } catch {
      // Best-effort; skip entries we can't stat or remove
    }
  }
}
