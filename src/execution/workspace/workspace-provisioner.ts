/**
 * Workspace Provisioner — composes WorktreeManager + LifecycleResolver +
 * ScriptRunner into a single provision() call.
 *
 * Creates an isolated worktree, runs setup/start lifecycle scripts, and
 * returns a ProvisionedWorkspace handle with status information.
 */

import type { WorktreeHandle } from '../../types';
import type { WorktreeManager } from './worktree-manager';
import type { Logger } from '../../shared/logger';
import type { EventBus } from '../../kernel/event-bus';
import type { WorkflowConfig } from '../../config/workflow-config';
import { createDomainEvent } from '../../kernel/event-bus';
import { resolveLifecycle } from './lifecycle-resolver';
import { runLifecycleScript as defaultRunScript, type ScriptRunResult } from './script-runner';
import { ExecutionError } from '../../kernel/errors';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProvisionedWorkspace extends WorktreeHandle {
  setupStatus: 'success' | 'failed' | 'skipped';
  startStatus: 'success' | 'failed' | 'skipped';
  setupDurationMs?: number;
  startDurationMs?: number;
  setupSource?: 'workflow' | 'repo';
  startSource?: 'workflow' | 'repo';
}

export interface WorkspaceProvisionerDeps {
  worktreeManager: WorktreeManager;
  logger: Logger;
  eventBus?: EventBus;
  workflowConfig?: WorkflowConfig;
  /** Injectable script runner for testing. Defaults to runLifecycleScript. */
  scriptRunner?: (command: string, cwd: string, timeoutMs: number, env?: Record<string, string>) => Promise<ScriptRunResult>;
  /** Injectable file-existence check for testing. Defaults to existsSync. */
  fileExists?: (path: string) => boolean;
}

export interface WorkspaceProvisioner {
  provision(planId: string, baseBranch: string, workBranch: string, repoName?: string): Promise<ProvisionedWorkspace>;
  dispose(handle: WorktreeHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkspaceProvisioner(deps: WorkspaceProvisionerDeps): WorkspaceProvisioner {
  const {
    worktreeManager,
    logger,
    eventBus,
    workflowConfig,
    scriptRunner = defaultRunScript,
    fileExists = existsSync,
  } = deps;

  return {
    async provision(planId, baseBranch, workBranch, repoName): Promise<ProvisionedWorkspace> {
      // 1. Create worktree
      const handle = await worktreeManager.create(planId, baseBranch, workBranch);

      // 2. Resolve lifecycle scripts
      const lifecycle = resolveLifecycle(repoName ?? '', workflowConfig, handle.path, fileExists);

      let setupStatus: ProvisionedWorkspace['setupStatus'] = 'skipped';
      let startStatus: ProvisionedWorkspace['startStatus'] = 'skipped';
      let setupDurationMs: number | undefined;
      let startDurationMs: number | undefined;
      let setupSource: ProvisionedWorkspace['setupSource'];
      let startSource: ProvisionedWorkspace['startSource'];

      // 3. Run setup script (if present)
      if (lifecycle.setup) {
        setupSource = lifecycle.setup.source;
        emitEvent('WorkspaceSetupStarted', {
          planId,
          worktreePath: handle.path,
          source: lifecycle.setup.source,
        });

        logger.info('Running setup script', {
          planId,
          command: lifecycle.setup.command,
          source: lifecycle.setup.source,
          timeoutMs: lifecycle.setupTimeout,
        });

        const setupResult = await scriptRunner(
          lifecycle.setup.command,
          handle.path,
          lifecycle.setupTimeout,
        );
        setupDurationMs = setupResult.durationMs;

        if (setupResult.exitCode !== 0) {
          setupStatus = 'failed';
          emitEvent('WorkspaceSetupFailed', {
            planId,
            worktreePath: handle.path,
            phase: 'setup' as const,
            error: setupResult.stderr || `exit code ${setupResult.exitCode}`,
            exitCode: setupResult.exitCode,
          });

          logger.error('Setup script failed', {
            planId,
            exitCode: setupResult.exitCode,
            timedOut: setupResult.timedOut,
            stderr: setupResult.stderr.slice(0, 500),
          });

          throw new ExecutionError(
            `Workspace setup failed for plan ${planId}: exit code ${setupResult.exitCode}`,
            { cause: new Error(setupResult.stderr) },
          );
        }

        setupStatus = 'success';
        logger.info('Setup script completed', { planId, durationMs: setupResult.durationMs });
      }

      // 4. Run start script (if present) — failure degrades but does NOT abort
      if (lifecycle.start) {
        startSource = lifecycle.start.source;

        logger.info('Running start script', {
          planId,
          command: lifecycle.start.command,
          source: lifecycle.start.source,
          timeoutMs: lifecycle.startTimeout,
        });

        const startResult = await scriptRunner(
          lifecycle.start.command,
          handle.path,
          lifecycle.startTimeout,
        );
        startDurationMs = startResult.durationMs;

        if (startResult.exitCode !== 0) {
          startStatus = 'failed';
          emitEvent('WorkspaceSetupFailed', {
            planId,
            worktreePath: handle.path,
            phase: 'start' as const,
            error: startResult.stderr || `exit code ${startResult.exitCode}`,
            exitCode: startResult.exitCode,
          });

          logger.warn('Start script failed (degraded mode)', {
            planId,
            exitCode: startResult.exitCode,
            timedOut: startResult.timedOut,
            stderr: startResult.stderr.slice(0, 500),
          });
        } else {
          startStatus = 'success';
          logger.info('Start script completed', { planId, durationMs: startResult.durationMs });
        }
      }

      // 5. Emit completion event
      emitEvent('WorkspaceSetupCompleted', {
        planId,
        worktreePath: handle.path,
        setupDurationMs: setupDurationMs ?? 0,
        startDurationMs: startDurationMs ?? 0,
      });

      // 6. Return enriched handle
      return {
        ...handle,
        setupStatus,
        startStatus,
        ...(setupDurationMs != null ? { setupDurationMs } : {}),
        ...(startDurationMs != null ? { startDurationMs } : {}),
        ...(setupSource ? { setupSource } : {}),
        ...(startSource ? { startSource } : {}),
      };
    },

    async dispose(handle: WorktreeHandle): Promise<void> {
      await worktreeManager.dispose(handle);
    },
  };

  // Emit a domain event (no-op if eventBus is not wired)
  function emitEvent<T extends 'WorkspaceSetupStarted' | 'WorkspaceSetupCompleted' | 'WorkspaceSetupFailed'>(
    type: T,
    payload: import('../../kernel/event-types').DomainEventMap[T]['payload'],
  ): void {
    if (!eventBus) return;
    eventBus.publish(createDomainEvent(type, payload));
  }
}
