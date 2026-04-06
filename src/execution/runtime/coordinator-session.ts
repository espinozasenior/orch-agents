/**
 * Coordinator Session Manager (P9)
 *
 * Evolved from a thin prompt wrapper to the primary session manager.
 * Manages CoordinatorState across turns, intercepts task-notification
 * XML from workers, and uses the full coordinator type system for
 * dispatch decisions.
 *
 * When CLAUDE_CODE_COORDINATOR_MODE=0, falls back to pass-through
 * (existing behavior).
 */

import type {
  InteractiveTaskExecutor,
  InteractiveExecutionRequest,
} from './interactive-executor';
import type { TaskExecutionResult } from './task-executor';
import {
  getCoordinatorSystemPrompt,
  getCoordinatorUserContext,
} from '../../coordinator/coordinatorPrompt';
import {
  parseTaskNotification,
  isTaskNotification,
} from '../../coordinator/notificationParser';
import { decideContinueOrSpawn } from '../../coordinator/decisionMatrix';
import { isCoordinatorMode } from '../../coordinator/index';
import type {
  WorkerPhase,
  WorkerState,
  CoordinatorState,
  CoordinatorAction,
  CoordinatorTaskRequest,
  TaskSpec,
} from '../../coordinator/types';
import type { Logger } from '../../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { CoordinatorTaskRequest };

export interface CoordinatorSessionDeps {
  baseExecutor: InteractiveTaskExecutor;
  logger?: Logger;
  mcpClients?: Array<{ name: string }>;
  scratchpadDir?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a coordinator-enhanced executor. When coordinator mode is active,
 * the session manages worker state, intercepts task notifications, and
 * drives phase transitions. When coordinator mode is off, passes through
 * unchanged.
 */
export function createCoordinatorSession(
  deps: CoordinatorSessionDeps,
): InteractiveTaskExecutor & { enqueueTask(req: CoordinatorTaskRequest): void } {
  const {
    baseExecutor,
    logger,
    mcpClients = [],
    scratchpadDir,
  } = deps;

  // Coordinator state: tracks workers, findings, current phase, and task queue
  const state: CoordinatorState = {
    workers: new Map<string, WorkerState>(),
    findings: new Map<string, string>(),
    currentPhase: 'research',
  };

  const taskQueue: CoordinatorTaskRequest[] = [];

  // -------------------------------------------------------------------------
  // Notification processing
  // -------------------------------------------------------------------------

  function processNotification(messageText: string): CoordinatorAction {
    if (!isTaskNotification(messageText)) {
      return { type: 'wait' };
    }

    const notification = parseTaskNotification(messageText);
    const worker = state.workers.get(notification.taskId);

    if (!worker) {
      logger?.warn('Notification received for unknown worker', {
        taskId: notification.taskId,
        status: notification.status,
      });
      return { type: 'wait' };
    }

    // Update worker status
    worker.lastStatus = worker.status;
    worker.status = notification.status;

    if (notification.status === 'completed') {
      // Record findings
      if (notification.result) {
        state.findings.set(notification.taskId, notification.result);
      }

      if (worker.phase === 'research') {
        // Check if all research workers are done
        const allResearchDone = allWorkersInPhaseTerminal('research');
        if (allResearchDone) {
          state.currentPhase = 'synthesis';
          logger?.info('All research workers complete; transitioning to synthesis', {
            findingsCount: state.findings.size,
          });
          return { type: 'wait' };
        }
        return { type: 'wait' };
      }

      if (worker.phase === 'implementation') {
        // Spawn a fresh verifier after implementation
        const verifySpec: TaskSpec = {
          type: 'verification',
          targetFiles: worker.filesExplored,
          description: `Verify implementation by worker ${notification.taskId}`,
        };
        return { type: 'spawn', phase: 'verification', spec: verifySpec };
      }

      if (worker.phase === 'verification') {
        const summary = notification.summary ?? 'Verification complete';
        return { type: 'report', summary };
      }

      return { type: 'wait' };
    }

    if (notification.status === 'failed') {
      // Consult decision matrix for failure recovery
      const correctionSpec: TaskSpec = {
        type: 'correction',
        targetFiles: worker.filesExplored,
        description: `Correct failure in worker ${notification.taskId}: ${notification.summary}`,
      };

      const decision = decideContinueOrSpawn(worker, correctionSpec);

      if (decision === 'continue') {
        return {
          type: 'continue',
          workerId: notification.taskId,
          message: `Correct failure: ${notification.summary}`,
        };
      }

      return {
        type: 'spawn',
        phase: worker.phase,
        spec: correctionSpec,
      };
    }

    // killed or unknown — just wait
    return { type: 'wait' };
  }

  function allWorkersInPhaseTerminal(phase: WorkerPhase): boolean {
    for (const w of state.workers.values()) {
      if (w.phase === phase && w.status === 'running') {
        return false;
      }
    }
    // At least one worker must exist in this phase
    let hasAny = false;
    for (const w of state.workers.values()) {
      if (w.phase === phase) {
        hasAny = true;
        break;
      }
    }
    return hasAny;
  }

  // -------------------------------------------------------------------------
  // Concurrency enforcement (P9)
  // -------------------------------------------------------------------------

  /**
   * Check whether any running implementation worker has an overlapping
   * file set with the given target files. Two file sets conflict if any
   * file path appears in both.
   */
  function hasFileSetConflict(
    coordinatorState: CoordinatorState,
    targetFiles: string[],
  ): boolean {
    if (targetFiles.length === 0) {
      return false;
    }
    const targetSet = new Set(targetFiles);
    for (const worker of coordinatorState.workers.values()) {
      if (worker.phase !== 'implementation' || worker.status !== 'running') {
        continue;
      }
      for (const file of worker.filesExplored) {
        if (targetSet.has(file)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Determine whether a spawn action should be deferred due to
   * concurrency rules:
   * - Research phase: always allowed (parallel freely)
   * - Implementation phase: serialize when file sets overlap
   */
  function shouldDeferSpawn(
    action: CoordinatorAction,
  ): boolean {
    if (action.type !== 'spawn') {
      return false;
    }
    // Research tasks run in parallel freely
    if (action.phase === 'research') {
      return false;
    }
    // Implementation: check for overlapping file sets
    if (action.phase === 'implementation') {
      return hasFileSetConflict(state, action.spec.targetFiles);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Task queue management
  // -------------------------------------------------------------------------

  function enqueueTask(req: CoordinatorTaskRequest): void {
    taskQueue.push(req);
    logger?.info('Task enqueued to coordinator', {
      taskId: req.id,
      source: req.source,
      queueDepth: taskQueue.length,
    });
  }

  // -------------------------------------------------------------------------
  // Action directive builder
  // -------------------------------------------------------------------------

  function buildActionDirective(action: CoordinatorAction): string {
    switch (action.type) {
      case 'spawn':
        return `ACTION REQUIRED: Spawn a new ${action.phase} worker.\n` +
          `Task type: ${action.spec.type}\n` +
          `Description: ${action.spec.description}\n` +
          `Target files: ${action.spec.targetFiles.join(', ') || '(none)'}`;
      case 'continue':
        return `ACTION REQUIRED: Continue existing worker ${action.workerId}.\n` +
          `Message: ${action.message}`;
      case 'report':
        return `ACTION REQUIRED: Report final summary to the user.\n` +
          `Summary: ${action.summary}`;
      case 'wait':
        return '';
    }
  }

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------

  return {
    enqueueTask,

    async execute(
      request: InteractiveExecutionRequest,
    ): Promise<TaskExecutionResult> {
      if (!isCoordinatorMode()) {
        return baseExecutor.execute(request);
      }

      logger?.info('Coordinator session: enhancing prompt with coordinator context', {
        agentRole: request.agentRole,
        mcpClientCount: mcpClients.length,
        hasScratchpad: scratchpadDir !== undefined,
        currentPhase: state.currentPhase,
        activeWorkers: state.workers.size,
        queueDepth: taskQueue.length,
      });

      // Process any task-notification XML in the prompt before forwarding
      let action = processNotification(request.prompt);

      if (action.type !== 'wait') {
        logger?.info('Coordinator action from notification', {
          actionType: action.type,
          phase: state.currentPhase,
        });
      }

      // P9 concurrency enforcement: defer implementation spawns with
      // overlapping file sets to serialize conflicting workers.
      if (shouldDeferSpawn(action)) {
        logger?.info('Deferring spawn due to file set conflict with running implementation worker', {
          phase: (action as { phase: WorkerPhase }).phase,
          targetFiles: (action as { spec: TaskSpec }).spec.targetFiles,
        });
        action = { type: 'wait' };
      }

      // Build action directive based on coordinator decision
      const actionDirective = buildActionDirective(action);

      const systemPrompt = getCoordinatorSystemPrompt();
      const { workerToolsContext } = getCoordinatorUserContext(
        mcpClients,
        scratchpadDir,
      );

      // Include queued tasks context when tasks are waiting
      const queueContext = taskQueue.length > 0
        ? `\n--- QUEUED TASKS (${taskQueue.length}) ---\n` +
          taskQueue.map((t, i) => `${i + 1}. [${t.source}] ${t.description} (priority: ${t.priority})`).join('\n')
        : '';

      const enhancedPrompt = [
        '--- COORDINATOR SYSTEM PROMPT ---',
        systemPrompt,
        '',
        '--- WORKER CONTEXT ---',
        workerToolsContext,
        queueContext,
        actionDirective ? `\n--- COORDINATOR ACTION ---\n${actionDirective}` : '',
        '',
        '--- TASK ---',
        request.prompt,
      ].filter(Boolean).join('\n');

      const enhancedRequest: InteractiveExecutionRequest = {
        ...request,
        prompt: enhancedPrompt,
      };

      return baseExecutor.execute(enhancedRequest);
    },
  };
}
