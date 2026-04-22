/**
 * DirectSpawnStrategy -- intercepts Agent tool calls and dispatches them
 * through SwarmDaemon for programmatic child-agent control.
 *
 * Feature flag: AGENT_SPAWN_MODE=direct
 *
 * Provides: executeAgentTool (block-until-complete), getChildStatus,
 * cancelChild, getActiveChildren.
 */

import { randomUUID } from 'node:crypto';

import type { Logger } from '../../shared/logger';
import type { EventBus } from '../../kernel/event-bus';
import type { SwarmDaemon } from './swarm-daemon';
import type { WorktreeManager } from '../workspace/worktree-manager';
import type { WorktreeHandle } from '../../types';
import type { NdjsonEnvelope, TaskPayload } from './ndjson-protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChildStatus {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly prompt: string;
  readonly startTime: number;
  readonly duration?: number;
  readonly output?: string;
}

export interface DirectSpawnStrategyDeps {
  readonly swarmDaemon: SwarmDaemon;
  readonly worktreeManager: WorktreeManager;
  readonly logger: Logger;
  readonly parentAbortSignal?: AbortSignal;
  readonly eventBus?: EventBus;
  readonly parentPlanId?: string;
}

export interface DirectSpawnStrategy {
  executeAgentTool(args: {
    prompt: string;
    subagent_type?: string;
    description?: string;
    isolation?: 'worktree';
  }): Promise<string>;

  getChildStatus(childId: string): ChildStatus | undefined;
  cancelChild(childId: string): void;
  getActiveChildren(): ChildStatus[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDirectSpawnStrategy(deps: DirectSpawnStrategyDeps): DirectSpawnStrategy {
  const {
    swarmDaemon,
    worktreeManager,
    logger: baseLogger,
    parentAbortSignal,
    eventBus,
    parentPlanId = 'unknown',
  } = deps;
  const logger = baseLogger.child ? baseLogger.child({ component: 'DirectSpawnStrategy' }) : baseLogger;

  const children = new Map<string, ChildStatus>();

  function updateChild(id: string, patch: Partial<ChildStatus>): void {
    const existing = children.get(id);
    if (existing) {
      children.set(id, { ...existing, ...patch } as ChildStatus);
    }
  }

  function emitEvent(type: string, payload: Record<string, unknown>): void {
    if (!eventBus) return;
    eventBus.publish({
      type,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: parentPlanId,
      payload,
    } as Parameters<typeof eventBus.publish>[0]);
  }

  async function executeAgentTool(args: {
    prompt: string;
    subagent_type?: string;
    description?: string;
    isolation?: 'worktree';
  }): Promise<string> {
    const childId = `child-${randomUUID().slice(0, 8)}`;
    const startTime = Date.now();

    children.set(childId, {
      id: childId,
      status: 'queued',
      prompt: args.prompt.slice(0, 500),
      startTime,
    });

    emitEvent('ChildAgentRequested', {
      parentPlanId,
      childId,
      prompt: args.prompt.slice(0, 500),
      subagentType: args.subagent_type,
    });

    logger.info('Child agent requested', {
      childId,
      subagentType: args.subagent_type,
      promptLength: args.prompt.length,
    });

    // Create worktree for child isolation
    let worktreeHandle: WorktreeHandle | undefined;
    try {
      const workBranch = `agent/${childId}`;
      worktreeHandle = await worktreeManager.create(childId, 'main', workBranch);
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      updateChild(childId, { status: 'failed', duration, output: error });
      emitEvent('ChildAgentFailed', { parentPlanId, childId, duration, error });
      logger.error('Failed to create worktree for child agent', { childId, error });
      return `Child agent failed: ${error}`;
    }

    updateChild(childId, { status: 'running' });

    // Build NDJSON task envelope
    const taskEnvelope: NdjsonEnvelope<'task', TaskPayload> = {
      type: 'task',
      id: childId,
      sessionId: childId,
      payload: {
        prompt: args.prompt,
      },
      timestamp: Date.now(),
    };

    // Dispatch to SwarmDaemon and wait for result
    return new Promise<string>((resolve) => {
      let settled = false;

      function settle(output: string, status: 'completed' | 'failed' | 'cancelled'): void {
        if (settled) return;
        settled = true;

        const duration = Date.now() - startTime;
        updateChild(childId, { status, duration, output });

        if (status === 'completed') {
          emitEvent('ChildAgentCompleted', { parentPlanId, childId, duration, output });
        } else if (status === 'cancelled') {
          emitEvent('ChildAgentCancelled', { parentPlanId, childId, duration });
        } else {
          emitEvent('ChildAgentFailed', { parentPlanId, childId, duration, error: output });
        }

        // Cleanup worktree (best-effort, non-blocking)
        if (worktreeHandle) {
          worktreeManager.dispose(worktreeHandle).catch((err) => {
            logger.warn('Failed to dispose child worktree', {
              childId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        logger.info('Child agent settled', { childId, status, duration });
        resolve(output);
      }

      // Listen for parent cancellation
      if (parentAbortSignal) {
        if (parentAbortSignal.aborted) {
          settle('Parent agent cancelled', 'cancelled');
          return;
        }
        const onAbort = () => {
          settle('Parent agent cancelled', 'cancelled');
        };
        parentAbortSignal.addEventListener('abort', onAbort, { once: true });
      }

      // The SwarmDaemon dispatches to a SessionRunner which fires onResult
      // callback. We intercept the result by subscribing to the daemon's
      // event flow. Since we're using an internal dispatch, we wrap it in
      // a result listener pattern.
      //
      // The SwarmDaemon.handleResult is called when a SessionRunner fires
      // its onResult callback. We use the daemon's dispatch method and
      // rely on the daemon's internal session management.
      //
      // For the direct spawn path, we dispatch the task and set up a
      // timeout. The result comes back through the SwarmDaemon's callback
      // flow. Since we can't directly hook into a single-task callback on
      // the daemon, we use polling on the session state.
      //
      // Simplified approach: dispatch and rely on timeout + polling.
      swarmDaemon.dispatch(taskEnvelope).then(() => {
        logger.debug('Task dispatched to swarm daemon', { childId });

        // Poll for completion -- the daemon handles result callbacks
        // internally. We check the child status periodically.
        // The actual completion signal comes from the daemon's session
        // completing and transitioning to idle.
        const pollInterval = setInterval(() => {
          if (settled) {
            clearInterval(pollInterval);
            return;
          }

          // Check daemon health for session completion hints
          const health = swarmDaemon.health();
          const sessions = swarmDaemon.getSessions();
          const ourSession = sessions.find((s) => s.currentTaskId === childId);

          if (!ourSession && health.queueDepth === 0) {
            // Session completed and returned to idle (task consumed)
            clearInterval(pollInterval);
            settle('Child agent completed', 'completed');
          }
        }, 1_000);
        // unref so polling doesn't block process exit
        if (typeof pollInterval === 'object' && 'unref' in pollInterval) {
          pollInterval.unref();
        }

        // Hard timeout: 10 minutes
        const hardTimeout = setTimeout(() => {
          if (!settled) {
            clearInterval(pollInterval);
            settle('Child agent timed out after 10 minutes', 'failed');
          }
        }, 600_000);
        // unref so timeout doesn't block process exit
        if (typeof hardTimeout === 'object' && 'unref' in hardTimeout) {
          hardTimeout.unref();
        }
      }).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        settle(`Dispatch failed: ${error}`, 'failed');
      });
    });
  }

  function getChildStatus(childId: string): ChildStatus | undefined {
    return children.get(childId);
  }

  function cancelChild(childId: string): void {
    const child = children.get(childId);
    if (!child || child.status === 'completed' || child.status === 'failed' || child.status === 'cancelled') {
      return;
    }

    const duration = Date.now() - child.startTime;
    updateChild(childId, { status: 'cancelled', duration });
    emitEvent('ChildAgentCancelled', { parentPlanId, childId, duration });
    logger.info('Child agent cancelled', { childId });
  }

  function getActiveChildren(): ChildStatus[] {
    return [...children.values()].filter(
      (c) => c.status === 'queued' || c.status === 'running',
    );
  }

  return {
    executeAgentTool,
    getChildStatus,
    cancelChild,
    getActiveChildren,
  };
}
