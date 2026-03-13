/**
 * Task Delegator.
 *
 * Creates tasks from a workflow plan, assigns them to spawned agents,
 * and collects results. Part of Phase 3: Real Agent Execution.
 *
 * All MCP interaction goes through the injected CliClient,
 * keeping this module fully testable via mocks.
 */

import type { WorkflowPlan, PlannedPhase, SPARCPhase, Artifact } from '../types';
import type { CliClient } from './cli-client';
import type { Logger } from '../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpawnedAgentRef {
  agentId: string;
  role: string;
}

export interface DelegatedTask {
  taskId: string;
  phaseType: SPARCPhase;
  assignedAgentId: string;
  description: string;
  status: 'created' | 'assigned' | 'in-progress' | 'completed' | 'failed';
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed';
  output: string;
  artifacts: Artifact[];
}

export interface TaskDelegator {
  createAndAssign(
    plan: WorkflowPlan,
    phase: PlannedPhase,
    agents: SpawnedAgentRef[],
  ): Promise<DelegatedTask[]>;

  collectResults(tasks: DelegatedTask[]): Promise<TaskResult[]>;
}

export interface TaskDelegatorDeps {
  logger: Logger;
  cliClient: CliClient;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskDelegator(deps: TaskDelegatorDeps): TaskDelegator {
  const { logger, cliClient } = deps;

  return {
    async createAndAssign(
      plan: WorkflowPlan,
      phase: PlannedPhase,
      agents: SpawnedAgentRef[],
    ): Promise<DelegatedTask[]> {
      const delegated: DelegatedTask[] = [];

      for (const agent of agents) {
        const description = buildTaskDescription(plan, phase, agent);

        logger.debug('Creating task for agent', {
          agentId: agent.agentId,
          phaseType: phase.type,
        });

        const { taskId } = await cliClient.taskCreate({
          description,
          metadata: {
            planId: plan.id,
            workItemId: plan.workItemId,
            phaseType: phase.type,
            agentRole: agent.role,
          },
        });

        logger.debug('Assigning task to agent', { taskId, agentId: agent.agentId });

        await cliClient.taskAssign(taskId, agent.agentId);

        delegated.push({
          taskId,
          phaseType: phase.type,
          assignedAgentId: agent.agentId,
          description,
          status: 'assigned',
        });
      }

      logger.info('Tasks created and assigned', {
        phaseType: phase.type,
        count: delegated.length,
      });

      return delegated;
    },

    async collectResults(tasks: DelegatedTask[]): Promise<TaskResult[]> {
      const results: TaskResult[] = [];

      for (const task of tasks) {
        logger.debug('Collecting result for task', { taskId: task.taskId });

        const statusResult = await cliClient.taskStatus(task.taskId);

        const isFailed =
          statusResult.status === 'failed' ||
          (statusResult.status !== 'completed' && statusResult.status !== 'in-progress');

        const artifacts = parseArtifacts(statusResult.output, isFailed);

        results.push({
          taskId: task.taskId,
          agentId: task.assignedAgentId,
          status: isFailed ? 'failed' : 'completed',
          output: statusResult.output ?? '',
          artifacts,
        });
      }

      logger.info('Results collected', {
        total: results.length,
        completed: results.filter((r) => r.status === 'completed').length,
        failed: results.filter((r) => r.status === 'failed').length,
      });

      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildTaskDescription(
  plan: WorkflowPlan,
  phase: PlannedPhase,
  agent: SpawnedAgentRef,
): string {
  return [
    `Execute SPARC ${phase.type} phase`,
    `Gate: ${phase.gate}`,
    `Work item: ${plan.workItemId}`,
    `Methodology: ${plan.methodology}`,
    `Agent role: ${agent.role}`,
  ].join(' | ');
}

function parseArtifacts(output: string | undefined, isFailed: boolean): Artifact[] {
  if (isFailed || !output) return [];

  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed?.artifacts)) {
      return parsed.artifacts as Artifact[];
    }
  } catch {
    // Output is not JSON; no artifacts to extract.
  }

  return [];
}
