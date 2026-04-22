/**
 * LocalAgentTask — CC-aligned coordinator dispatch path.
 *
 * Mirrors Claude Code's `src/tasks/LocalAgentTask/LocalAgentTask.tsx` location
 * convention. This file owns the coordinator-mode execution lifecycle for a
 * single local agent task spawned in response to a Linear AgentPrompted event.
 *
 * Behaviour is byte-identical to the coordinator branch previously hosted in
 * `src/execution/simple-executor.ts` (see lines 158-552 of that file at the
 * time of extraction). The legacy multi-agent template path remains in
 * simple-executor.ts and is still wired to the IntakeCompleted handler.
 *
 * Single responsibility: execute ONE coordinator agent task end-to-end —
 *   1. Create P6 task (when registry wired) and worktree
 *   2. Build coordinator system prompt + user context
 *   3. Apply P8 fork eligibility gates (always blocks in coordinator mode)
 *   4. Emit Linear thought activity (FR-10A.02)
 *   5. Transition task pending → running and dispatch to interactive executor
 *   6. Apply artifacts, push branch, post Linear/PR response
 *   7. Transition task to completed/failed and emit PhaseCompleted event
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowPlan, IntakeEvent, Finding } from '../types';
import { isLinearMeta } from '../types';
import { phaseId } from '../kernel/branded-types';
import type { PlanId } from '../kernel/branded-types';
import type { InteractiveTaskExecutor } from './runtime/interactive-executor';
import type { WorktreeManager } from './workspace/worktree-manager';
import type { WorkspaceProvisioner } from './workspace/workspace-provisioner';
import type { ArtifactApplier } from './workspace/artifact-applier';
import type { GitHubClient } from '../integration/github-client';
import type { LinearClient } from '../integration/linear/linear-client';
import type { Logger } from '../shared/logger';
import type { EventBus } from '../kernel/event-bus';
import { createDomainEvent } from '../kernel/event-bus';
import { getCoordinatorSystemPrompt, getCoordinatorUserContext } from '../coordinator/coordinatorPrompt';
import { emitThought } from '../integration/linear/activity-router';
import { createTask, TaskType, TaskStatus, transition } from './task';
import type { TaskRegistry } from './task';
import { runPostExecutionActions } from './post-execution-actions';
import type { ReviewGate } from '../review/review-gate';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CoordinatorDispatcherDeps {
  interactiveExecutor: InteractiveTaskExecutor;
  worktreeManager: WorktreeManager;
  artifactApplier: ArtifactApplier;
  githubClient?: GitHubClient;
  linearClient?: Pick<LinearClient, 'createComment' | 'createAgentActivity'>;
  logger: Logger;
  eventBus?: EventBus;
  agentTimeoutMs?: number;
  /** P6: Optional TaskRegistry for task backbone wiring. */
  taskRegistry?: TaskRegistry;
  /** MCP server descriptors passed through to coordinator prompt context. */
  mcpClients?: Array<{ name: string }>;
  /** Provides a fresh GitHub token for the agent's gh CLI (bot identity). */
  getGitHubToken?: () => Promise<string>;
  /** Optional ReviewGate for producing findings on PR diffs. */
  reviewGate?: ReviewGate;
  /** Optional WorkspaceProvisioner for lifecycle scripts. Falls back to worktreeManager when absent. */
  workspaceProvisioner?: WorkspaceProvisioner;
}

export interface CoordinatorDispatcher {
  /**
   * Execute a single coordinator-mode plan end-to-end.
   *
   * The plan must contain exactly one agent (the coordinator). Multi-agent
   * teams are NOT supported by this dispatcher.
   */
  execute(plan: WorkflowPlan, intakeEvent: IntakeEvent): Promise<ExecutionResult>;
}

export interface ExecutionResult {
  status: 'completed' | 'failed' | 'partial';
  agentResults: AgentResult[];
  totalDuration: number;
  sessionId?: string;
  lastActivityAt?: string;
  continuationState?: import('./runtime/task-executor').TaskExecutionResult['continuationState'];
  tokenUsage?: import('./runtime/task-executor').TaskExecutionResult['tokenUsage'];
}

export interface AgentResult {
  agentRole: string;
  agentType: string;
  status: 'completed' | 'failed' | 'skipped';
  commitSha?: string;
  findings: Finding[];
  duration: number;
  output?: string;
  sessionId?: string;
  lastActivityAt?: string;
  continuationState?: import('./runtime/task-executor').TaskExecutionResult['continuationState'];
  tokenUsage?: import('./runtime/task-executor').TaskExecutionResult['tokenUsage'];
  /** P6: Task ID from the task backbone, when TaskRegistry is wired. */
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCoordinatorDispatcher(deps: CoordinatorDispatcherDeps): CoordinatorDispatcher {
  async function disposeHandle(handle: import('../types').WorktreeHandle): Promise<void> {
    if (deps.workspaceProvisioner) {
      await deps.workspaceProvisioner.dispose(handle);
    } else {
      await deps.worktreeManager.dispose(handle);
    }
  }

  function emitPhaseCompleted(pId: PlanId, status: 'completed' | 'failed', agentStart: number): void {
    if (!deps.eventBus) return;
    deps.eventBus.publish(createDomainEvent('PhaseCompleted', {
      phaseResult: {
        phaseId: phaseId(randomUUID()),
        planId: pId,
        phaseType: 'refinement' as const,
        status,
        artifacts: [],
        metrics: { duration: Date.now() - agentStart, agentUtilization: 1, modelCost: 0 },
      },
    }));
  }

  return {
    async execute(plan, intakeEvent): Promise<ExecutionResult> {
      const startTime = Date.now();
      const agentResults: AgentResult[] = [];
      const agents = plan.agentTeam;
      // Coordinator mode runs exactly one agent. Chain ref kept for parity
      // with the worktree creation API and base-branch fallback semantics.
      const lastCommitRef = intakeEvent.entities.branch ?? 'main';

      for (const agent of agents) {
        const agentStart = Date.now();
        let handle: Awaited<ReturnType<WorktreeManager['create']>> | undefined;
        let taskId: string | undefined;

        // AIG: Emit PhaseStarted event before each agent runs
        if (deps.eventBus) {
          deps.eventBus.publish(createDomainEvent('PhaseStarted', {
            planId: plan.id,
            phaseType: 'refinement' as const,
            agents: [agent.type],
          }));
        }

        try {
          // P6: Create task before dispatch (when registry is wired)
          let task: import('./task/types').Task | undefined;
          if (deps.taskRegistry) {
            task = createTask(TaskType.local_agent);
            taskId = task.id;
            deps.taskRegistry.register(task);
          }

          // 1. Create worktree from base branch (coordinator runs from base —
          //    no inter-agent commit chaining since there's only one agent).
          //    When a WorkspaceProvisioner is available, use it to also run
          //    per-repo lifecycle scripts (setup.sh / start.sh).
          const repoName = intakeEvent.entities.repo;
          if (deps.workspaceProvisioner) {
            handle = await deps.workspaceProvisioner.provision(
              plan.id, lastCommitRef, `agent/${plan.id}/${agent.role}`, repoName,
            );
          } else {
            handle = await deps.worktreeManager.create(
              plan.id, lastCommitRef, `agent/${plan.id}/${agent.role}`,
            );
          }

          // 2. Build coordinator prompt: system prompt + worker tools + Linear context
          const coordinatorPrompt = getCoordinatorSystemPrompt();
          const { workerToolsContext: workerContext } = getCoordinatorUserContext(deps.mcpClients ?? []);
          const issueRef = intakeEvent.entities.requirementId ?? '';
          const issueDesc = intakeEvent.rawText ?? '';

          const contextParts: string[] = [coordinatorPrompt, workerContext, '---'];

          if (issueRef) {
            contextParts.push(`## Issue: ${issueRef}`);
          }

          // If this is a comment/follow-up, label it clearly so the coordinator
          // knows this is a question about the issue, not a new task
          const meta = intakeEvent.sourceMetadata;
          if (isLinearMeta(meta) && meta.intent === 'custom:linear-prompted' && issueDesc) {
            contextParts.push(
              '## User Comment (follow-up on the issue above)',
              issueDesc,
              '',
              'Answer the user\'s question in context of this Linear issue. ' +
              'Read the issue description and any relevant code before responding. ' +
              'If the user asks about a feature, check the codebase to see if it\'s implemented.',
            );
          } else {
            contextParts.push('## Task', issueDesc || 'Complete the assigned task.');
          }

          const prompt = contextParts.join('\n\n');

          // 4. Emit thought activity before execution (FR-10A.02)
          const agentSessionIdForThought = isLinearMeta(meta) ? meta.agentSessionId : undefined;
          await emitThought(
            agentSessionIdForThought,
            'Working on your request...',
            deps.linearClient,
            deps.logger,
          );

          // P6: Transition task to running before execution
          if (deps.taskRegistry && task && taskId) {
            task = transition(task, TaskStatus.running);
            deps.taskRegistry.update(taskId, task);
          }

          // 5. Set GH_TOKEN for bot identity in agent's gh CLI
          if (deps.getGitHubToken) {
            try {
              process.env.GH_TOKEN = await deps.getGitHubToken();
            } catch (err) {
              deps.logger.warn('Failed to set GH_TOKEN for agent', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // 6. Run Claude Code session in worktree
          const execResult = await deps.interactiveExecutor.execute({
            prompt,
            worktreePath: handle.path,
            agentRole: agent.role,
            agentType: agent.type,
            tier: agent.tier,
            phaseType: 'refinement',
            timeout: deps.agentTimeoutMs ?? 900_000,
            metadata: {
              planId: plan.id,
              workItemId: plan.workItemId,
              taskId,
            },
          });

          if (execResult.status === 'failed') {
            if (deps.taskRegistry && task && taskId) {
              const failed = transition(task, TaskStatus.failed);
              deps.taskRegistry.update(taskId, failed);
            }
            agentResults.push({
              agentRole: agent.role,
              agentType: agent.type,
              status: 'failed',
              findings: [],
              duration: Date.now() - agentStart,
              sessionId: execResult.sessionId,
              lastActivityAt: execResult.lastActivityAt,
              continuationState: execResult.continuationState,
              tokenUsage: execResult.tokenUsage,
              taskId,
            });
            emitPhaseCompleted(plan.id, 'failed', agentStart);
            await disposeHandle(handle);
            continue;
          }

          // 6. Validate & commit
          const applyResult = await deps.artifactApplier.apply(plan.id, handle, {
            commitMessage: `${agent.role}: ${agent.type} work on ${plan.workItemId}`,
          });

          if (applyResult.status === 'rejected') {
            if (deps.taskRegistry && task && taskId) {
              const failed = transition(task, TaskStatus.failed);
              deps.taskRegistry.update(taskId, failed);
            }
            agentResults.push({
              agentRole: agent.role,
              agentType: agent.type,
              status: 'failed',
              findings: [],
              duration: Date.now() - agentStart,
              sessionId: execResult.sessionId,
              lastActivityAt: execResult.lastActivityAt,
              continuationState: execResult.continuationState,
              tokenUsage: execResult.tokenUsage,
              taskId,
            });
            emitPhaseCompleted(plan.id, 'failed', agentStart);
            await disposeHandle(handle);
            continue;
          }

          // 7. Run ReviewGate for findings (when available and PR context exists)
          let findings: Finding[] = [];
          if (deps.reviewGate && applyResult.commitSha && intakeEvent.entities.prNumber && intakeEvent.entities.repo) {
            try {
              const verdict = await deps.reviewGate.review({
                planId: plan.id,
                workItemId: plan.workItemId,
                commitSha: applyResult.commitSha,
                branch: handle.branch,
                worktreePath: handle.path,
                diff: '', // ReviewGate's test runner and security scanner use worktreePath directly
                artifacts: [],
                context: { attempt: 1, commitSha: applyResult.commitSha },
              });
              findings = verdict.findings;
            } catch (reviewErr) {
              deps.logger.warn('ReviewGate failed, continuing without findings', {
                planId: plan.id,
                error: reviewErr instanceof Error ? reviewErr.message : String(reviewErr),
              });
            }
          }

          // 8. Run post-execution actions (push, PR creation, review, comments)
          await runPostExecutionActions(
            {
              githubClient: deps.githubClient,
              linearClient: deps.linearClient,
              logger: deps.logger,
            },
            {
              agent: { type: agent.type, role: agent.role },
              planId: plan.id,
              workItemId: plan.workItemId,
              agentStart,
              apply: { commitSha: applyResult.commitSha, changedFiles: applyResult.changedFiles },
              exec: { output: execResult.output, status: execResult.status },
              intake: intakeEvent,
              worktree: { path: handle.path, branch: handle.branch, baseBranch: lastCommitRef },
              findings,
            },
          );

          // P6: Transition task to completed
          if (deps.taskRegistry && task && taskId) {
            const completed = transition(task, TaskStatus.completed);
            deps.taskRegistry.update(taskId, completed);
          }

          agentResults.push({
            agentRole: agent.role,
            agentType: agent.type,
            status: 'completed',
            commitSha: applyResult.commitSha,
            findings,
            duration: Date.now() - agentStart,
            output: execResult.output,
            sessionId: execResult.sessionId,
            lastActivityAt: execResult.lastActivityAt,
            continuationState: execResult.continuationState,
            tokenUsage: execResult.tokenUsage,
            taskId,
          });

          emitPhaseCompleted(plan.id, 'completed', agentStart);

          // 10. Cleanup worktree
          await disposeHandle(handle);

        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error('Agent execution failed', {
            planId: plan.id, agent: agent.type, error: message,
          });
          if (handle) {
            await disposeHandle(handle).catch(err => deps.logger.warn('Worktree dispose failed', { error: err instanceof Error ? err.message : String(err) }));
          }
          if (deps.taskRegistry && taskId) {
            try {
              const currentTask = deps.taskRegistry.get(taskId);
              if (currentTask && currentTask.status !== TaskStatus.failed && currentTask.status !== TaskStatus.completed) {
                const failed = transition(currentTask, TaskStatus.failed);
                deps.taskRegistry.update(taskId, failed);
              }
            } catch { /* best effort */ }
          }
          agentResults.push({
            agentRole: agent.role,
            agentType: agent.type,
            status: 'failed',
            findings: [],
            duration: Date.now() - agentStart,
            sessionId: undefined,
            lastActivityAt: undefined,
            continuationState: undefined,
            tokenUsage: undefined,
            taskId,
          });
          emitPhaseCompleted(plan.id, 'failed', agentStart);
        }
      }

      const allCompleted = agentResults.length > 0
        ? agentResults.every((r) => r.status === 'completed')
        : false;
      const anyCompleted = agentResults.some((r) => r.status === 'completed');
      const latestAgentResult = agentResults[agentResults.length - 1];

      return {
        status: allCompleted ? 'completed' : anyCompleted ? 'partial' : 'failed',
        agentResults,
        totalDuration: Date.now() - startTime,
        sessionId: latestAgentResult?.sessionId,
        lastActivityAt: latestAgentResult?.lastActivityAt,
        continuationState: latestAgentResult?.continuationState,
        tokenUsage: latestAgentResult?.tokenUsage,
      };
    },
  };
}

// Post-execution formatting has been extracted to src/execution/post-execution-actions.ts
