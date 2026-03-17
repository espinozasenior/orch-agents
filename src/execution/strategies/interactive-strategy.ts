/**
 * Interactive Strategy — executes agents in isolated git worktrees (Phase 5).
 *
 * Creates a worktree, builds implementation prompts, executes interactively,
 * validates via artifact applier, runs fix-it loop, and posts PR comments.
 *
 * Emits Phase 5 domain events when an eventBus is available in deps.
 */

import { randomUUID } from 'node:crypto';
import type { PlannedPhase, PhaseResult, WorkflowPlan, IntakeEvent } from '../../types';
import type { Logger } from '../../shared/logger';
import type { WorktreeManager } from '../worktree-manager';
import { buildImplementationPrompt } from '../prompt-builder';
import { createDomainEvent } from '../../shared/event-bus';
import type { PhaseStrategy, StrategyDeps } from './phase-strategy';
import { computeUtilization, computeModelCost, makeFailedResult } from './strategy-helpers';
import { ExecutionError } from '../../shared/errors';

/**
 * Options for the interactive strategy factory.
 */
export interface InteractiveStrategyOptions {
  /** Eligible phase types. Defaults to ['refinement']. */
  eligiblePhaseTypes?: string[];
}

/**
 * Create an interactive strategy instance.
 */
export function createInteractiveStrategy(opts: InteractiveStrategyOptions = {}): PhaseStrategy {
  const eligiblePhaseTypes = opts.eligiblePhaseTypes ?? ['refinement'];

  return {
    name: 'interactive',

    canHandle(deps: StrategyDeps, phase: PlannedPhase, intakeEvent?: IntakeEvent): boolean {
      const hasInteractiveDeps = !!(deps.interactiveExecutor && deps.worktreeManager && deps.artifactApplier);
      return !!(deps.taskExecutor && intakeEvent && eligiblePhaseTypes.includes(phase.type) && hasInteractiveDeps);
    },

    async run(
      plan: WorkflowPlan,
      phase: PlannedPhase,
      deps: StrategyDeps,
      logger?: Logger,
      intakeEvent?: IntakeEvent,
    ): Promise<PhaseResult> {
      // M7: Runtime guard for intakeEvent
      if (!intakeEvent) {
        throw new ExecutionError('intakeEvent required for interactive strategy');
      }

      const phaseId = randomUUID();
      const startTime = Date.now();
      const agentRole = phase.agents[0] ?? 'implementer';
      const agent = plan.agentTeam.find((a) => a.role === agentRole || a.type === agentRole)
        ?? { role: agentRole, type: agentRole, tier: 2 as const, required: true };

      logger?.info('Running phase with interactive agents', {
        planId: plan.id, phase: phase.type, agentRole,
      });

      let handle: Awaited<ReturnType<WorktreeManager['create']>> | undefined;

      try {
        // 1. Create isolated worktree
        const baseBranch = intakeEvent.entities.branch ?? 'main';
        handle = await deps.worktreeManager!.create(plan.id, baseBranch, `agent/${plan.id}`);

        // 2. Build implementation prompt
        const prompt = buildImplementationPrompt(phase, agent, intakeEvent, plan, {
          worktreePath: handle.path,
        });

        // 3. Execute via interactive executor
        const execResult = await deps.interactiveExecutor!.execute({
          prompt,
          worktreePath: handle.path,
          agentRole: agent.role,
          agentType: agent.type,
          tier: agent.tier,
          phaseType: phase.type,
          timeout: deps.phaseTimeoutMs,
          metadata: { planId: plan.id, workItemId: plan.workItemId },
        });

        if (execResult.status === 'failed') {
          logger?.warn('Interactive execution failed', {
            planId: plan.id, error: execResult.error,
          });
          await deps.worktreeManager!.dispose(handle);
          return makeFailedResult(phaseId, plan, phase, startTime);
        }

        // 4. Validate & commit via artifact applier
        const applyResult = await deps.artifactApplier!.apply(plan.id, handle, {
          commitMessage: `agent/${agent.role}: ${phase.type}`,
        });

        if (applyResult.status === 'rejected') {
          logger?.warn('Artifact apply rejected', {
            planId: plan.id, reason: applyResult.rejectionReason,
          });
          // Emit RollbackTriggered event
          emitEvent(deps, 'RollbackTriggered', {
            planId: plan.id,
            reason: applyResult.rejectionReason ?? 'Artifact apply rejected',
            worktreePath: handle.path,
          }, plan.id);
          await deps.worktreeManager!.dispose(handle);
          return makeFailedResult(phaseId, plan, phase, startTime);
        }

        // Emit ArtifactsApplied event
        if (applyResult.commitSha) {
          emitEvent(deps, 'ArtifactsApplied', {
            planId: plan.id,
            commitSha: applyResult.commitSha,
            branch: handle.branch,
            changedFiles: applyResult.changedFiles,
          }, plan.id);
        }

        // Emit CommitCreated event
        if (applyResult.commitSha) {
          emitEvent(deps, 'CommitCreated', {
            planId: plan.id,
            sha: applyResult.commitSha,
            branch: handle.branch,
            files: applyResult.changedFiles,
            message: `agent/${agent.role}: ${phase.type}`,
          }, plan.id);
        }

        // 5. Run fix-it loop if review gate is available
        let fixItPassed = true;
        let fixItSummary: string | undefined;
        if (deps.fixItLoop && deps.reviewGate && applyResult.commitSha) {
          // Emit ReviewRequested event
          emitEvent(deps, 'ReviewRequested', {
            planId: plan.id,
            commitSha: applyResult.commitSha,
            branch: handle.branch,
            artifacts: [],
            attempt: 1,
          }, plan.id);

          const fixResult = await deps.fixItLoop.run({
            planId: plan.id,
            workItemId: plan.workItemId,
            branch: handle.branch,
            worktreePath: handle.path,
            initialCommitSha: applyResult.commitSha,
            artifacts: [],
            maxAttempts: 3,
            timeout: deps.phaseTimeoutMs,
          });
          fixItPassed = fixResult.status === 'passed';
          fixItSummary = fixResult.finalVerdict.feedback ?? undefined;

          // Emit events based on fix-it result
          if (deps.eventBus) {
            if (!fixItPassed) {
              emitEvent(deps, 'ReviewRejected', {
                planId: plan.id,
                findings: fixResult.finalVerdict.findings,
                feedback: fixResult.finalVerdict.feedback ?? 'Review rejected',
                attempt: fixResult.attempts,
              }, plan.id);
            }

            // Emit FixRequested for each fix attempt in history
            for (const attempt of fixResult.history) {
              if (attempt.fixApplied) {
                emitEvent(deps, 'FixRequested', {
                  planId: plan.id,
                  feedback: attempt.verdict.feedback ?? '',
                  findings: attempt.verdict.findings,
                  attempt: attempt.attempt,
                }, plan.id);
              }
            }
          }
        }

        // 6. Post PR comment if passed and GitHub client available
        if (fixItPassed && deps.githubClient && intakeEvent.entities.prNumber && intakeEvent.entities.repo) {
          try {
            const commentBody = fixItSummary ?? `Agent ${agent.role} completed ${phase.type} phase.`;
            const botName = process.env.BOT_USERNAME ?? 'orch-agents';
            await deps.githubClient.postPRComment(
              intakeEvent.entities.repo,
              intakeEvent.entities.prNumber,
              `${commentBody}\n<!-- ${botName}-bot -->`,
            );
          } catch (ghErr) {
            logger?.warn('Failed to post PR comment', {
              planId: plan.id,
              error: ghErr instanceof Error ? ghErr.message : String(ghErr),
            });
          }
        }

        // 7. Dispose worktree
        await deps.worktreeManager!.dispose(handle);

        // 8. Return result
        const duration = Date.now() - startTime;
        return {
          phaseId,
          planId: plan.id,
          phaseType: phase.type,
          status: fixItPassed ? 'completed' : 'failed',
          artifacts: applyResult.changedFiles.map((file) => ({
            id: randomUUID(),
            phaseId,
            type: phase.type,
            url: `worktree://${plan.id}/${file}`,
            metadata: { file, commitSha: applyResult.commitSha },
          })),
          metrics: {
            duration,
            agentUtilization: computeUtilization(phase, plan),
            modelCost: computeModelCost(phase, plan),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Interactive phase execution failed', {
          planId: plan.id, phase: phase.type, error: message,
        });

        // Emit RollbackTriggered on unexpected failure
        if (handle) {
          emitEvent(deps, 'RollbackTriggered', {
            planId: plan.id,
            reason: message,
            worktreePath: handle.path,
          }, plan.id);
          await deps.worktreeManager!.dispose(handle).catch((err) =>
            logger?.warn('Failed to dispose worktree during error cleanup', {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }

        return makeFailedResult(phaseId, plan, phase, startTime);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Emit a domain event if eventBus is available. No-op otherwise.
 */
function emitEvent<T extends import('../../shared/event-types').DomainEventType>(
  deps: StrategyDeps,
  type: T,
  payload: import('../../shared/event-types').DomainEventMap[T]['payload'],
  correlationId: string,
): void {
  if (!deps.eventBus) return;
  deps.eventBus.publish(createDomainEvent(type, payload, correlationId));
}
