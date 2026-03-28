/**
 * Agent Sandbox — isolates spawned agent processes from project hooks.
 *
 * Creates a clean temporary directory with no .claude/settings.json so that
 * spawned `claude --print -` processes do not inherit project hooks.
 * Also prevents session file accumulation by cleaning up after completion.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentSandbox {
  /** Clean temporary directory to use as cwd for spawned agents. */
  readonly cwd: string;
  /** Remove the temporary directory. Safe to call multiple times. */
  cleanup(): void;
}

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
 * It contains no `.claude/` subdirectory, so the Claude CLI will not
 * find project-level hooks.
 */
export function createAgentSandbox(): AgentSandbox {
  ensureExitHandler();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-'));
  activeSandboxes.add(tmpDir);

  return {
    cwd: tmpDir,
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
