/**
 * Lifecycle Resolver — two-layer resolution of per-repo setup/start scripts.
 *
 * Resolution order:
 *   1. WORKFLOW.md override (`repos.<name>.lifecycle.setup`)
 *   2. `.orch-agents/setup.sh` in the worktree directory
 *   3. Skip (undefined)
 *
 * Same logic applies for `start`.
 */

import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { WorkflowConfig } from '../../config/workflow-config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedLifecycle {
  setup?: { command: string; source: 'workflow' | 'repo' };
  start?: { command: string; source: 'workflow' | 'repo' };
  setupTimeout: number;
  startTimeout: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SETUP_TIMEOUT = 300_000;  // 5 minutes
const DEFAULT_START_TIMEOUT = 120_000;  // 2 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve lifecycle scripts for a repo using two-layer resolution.
 *
 * @param repoName      Full repo name (e.g. "acme/api")
 * @param workflowConfig Parsed WORKFLOW.md config (may be undefined)
 * @param worktreePath  Absolute path to the worktree directory
 * @param fileExists    Injectable file-existence check (defaults to existsSync)
 */
export function resolveLifecycle(
  repoName: string,
  workflowConfig: WorkflowConfig | undefined,
  worktreePath: string,
  fileExists: (path: string) => boolean = existsSync,
): ResolvedLifecycle {
  const repoConfig = workflowConfig?.repos[repoName];
  const lifecycle = repoConfig?.lifecycle;

  const setup = resolveCommand(lifecycle?.setup, pathJoin(worktreePath, '.orch-agents', 'setup.sh'), fileExists);
  const start = resolveCommand(lifecycle?.start, pathJoin(worktreePath, '.orch-agents', 'start.sh'), fileExists);

  return {
    ...(setup ? { setup } : {}),
    ...(start ? { start } : {}),
    setupTimeout: lifecycle?.setupTimeout ?? DEFAULT_SETUP_TIMEOUT,
    startTimeout: lifecycle?.startTimeout ?? DEFAULT_START_TIMEOUT,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveCommand(
  workflowCommand: string | undefined,
  repoScriptPath: string,
  fileExists: (path: string) => boolean,
): { command: string; source: 'workflow' | 'repo' } | undefined {
  if (workflowCommand) {
    return { command: workflowCommand, source: 'workflow' };
  }
  if (fileExists(repoScriptPath)) {
    const scriptName = repoScriptPath.includes('setup.sh')
      ? 'bash .orch-agents/setup.sh'
      : 'bash .orch-agents/start.sh';
    return { command: scriptName, source: 'repo' };
  }
  return undefined;
}
