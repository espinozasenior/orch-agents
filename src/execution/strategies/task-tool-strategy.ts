/**
 * Task-Tool Strategy — executes agents via task executor prompts (Phase 4).
 *
 * Builds contextual prompts from IntakeEvent, dispatches them concurrently,
 * and collects results into artifacts.
 */

import { randomUUID } from 'node:crypto';
import type { PlannedPhase, PhaseResult, WorkflowPlan, IntakeEvent } from '../../types';
import type { Logger } from '../../shared/logger';
import type { TaskExecutionResult } from '../task-executor';
import { buildPrompt } from '../prompt-builder';
import type { PhaseStrategy, StrategyDeps } from './phase-strategy';
import { computeUtilization, computeModelCost, makeFailedResult, resolveStatus } from './strategy-helpers';
import { ExecutionError } from '../../shared/errors';

/**
 * Create a task-tool strategy instance.
 */
export function createTaskToolStrategy(): PhaseStrategy {
  return {
    name: 'task-tool',

    canHandle(deps: StrategyDeps, _phase: PlannedPhase, intakeEvent?: IntakeEvent): boolean {
      return !!(deps.taskExecutor && intakeEvent);
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
        throw new ExecutionError('intakeEvent required for task-tool strategy');
      }

      const phaseId = randomUUID();
      const startTime = Date.now();

      logger?.info('Running phase with task-tool agents', { planId: plan.id, phase: phase.type });

      try {
        // Build and execute prompts concurrently for each agent role
        const agentRoles = phase.agents;
        const execPromises = agentRoles.map((role) => {
          const agent = plan.agentTeam.find((a) => a.role === role || a.type === role)
            ?? { role, type: role, tier: 2 as const, required: true };

          const prompt = buildPrompt(phase, agent, intakeEvent, plan);

          logger?.info('Dispatching task-tool agent', {
            planId: plan.id,
            phase: phase.type,
            agentRole: agent.role,
            agentType: agent.type,
            tier: agent.tier,
            promptLength: prompt.length,
          });

          return deps.taskExecutor!.execute({
            prompt,
            agentRole: agent.role,
            agentType: agent.type,
            tier: agent.tier,
            phaseType: phase.type,
            timeout: deps.phaseTimeoutMs,
            metadata: { planId: plan.id, workItemId: plan.workItemId },
          }).then((result) => {
            logger?.info('Task-tool agent completed', {
              planId: plan.id,
              phase: phase.type,
              agentRole: agent.role,
              status: result.status,
              duration: result.duration,
              outputLength: result.output.length,
              ...(result.error ? { error: result.error } : {}),
            });
            logger?.debug('Task-tool agent output preview', {
              agentRole: agent.role,
              outputPreview: result.output.slice(0, 500),
            });
            return result;
          });
        });

        // Use allSettled to preserve partial results when one agent throws
        const settled = await Promise.allSettled(execPromises);
        const execResults: TaskExecutionResult[] = settled.map((s, idx) => {
          if (s.status === 'fulfilled') return s.value;
          const error = String(s.reason);
          logger?.error('Task-tool agent threw exception', {
            planId: plan.id,
            phase: phase.type,
            agentRole: agentRoles[idx],
            error,
          });
          return { status: 'failed' as const, output: '', duration: 0, error };
        });

        // Build artifacts
        const artifacts = execResults
          .map((r, originalIndex) => ({ result: r, originalIndex }))
          .filter(({ result }) => result.status === 'completed')
          .map(({ result, originalIndex }) => ({
            id: randomUUID(),
            phaseId,
            type: phase.type,
            url: `task-tool://${phaseId}/${originalIndex}`,
            metadata: {
              agentRole: agentRoles[originalIndex],
              output: result.output,
              duration: result.duration,
            } as Record<string, unknown>,
          }));

        logger?.debug('Task-tool phase artifacts', {
          artifactCount: artifacts.length,
        });

        // Run gate checker
        const gateResult = await deps.gateChecker(plan.id, phase);
        const duration = Date.now() - startTime;

        // Determine status
        const allFailed = execResults.every((r) => r.status === 'failed');
        let status: 'completed' | 'failed' | 'skipped';
        if (allFailed) {
          status = phase.skippable ? 'skipped' : 'failed';
        } else {
          status = resolveStatus(gateResult.passed, phase.skippable);
        }

        logger?.info('Task-tool phase completed', {
          planId: plan.id,
          phase: phase.type,
          status,
          agents: execResults.length,
          completed: execResults.filter((r) => r.status === 'completed').length,
          failed: execResults.filter((r) => r.status === 'failed').length,
          duration,
        });

        return {
          phaseId,
          planId: plan.id,
          phaseType: phase.type,
          status,
          artifacts,
          metrics: {
            duration,
            agentUtilization: computeUtilization(phase, plan),
            modelCost: computeModelCost(phase, plan),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Task-tool phase execution failed', { planId: plan.id, phase: phase.type, error: message });
        return makeFailedResult(phaseId, plan, phase, startTime);
      }
    },
  };
}
