/**
 * ArtifactCollector — collects and normalizes agent task results into
 * Artifact objects and stores checkpoints via memory.
 *
 * Part of Phase 3: Real Agent Execution.
 */

import { randomUUID } from 'node:crypto';
import type { Artifact, PlannedPhase } from '../types';
import type { CliClient } from './cli-client';
import type { Logger } from '../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaskResultRef {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed';
  output: string;
}

export interface ArtifactCollector {
  /**
   * Convert raw task results into normalized Artifact objects.
   */
  collect(
    phaseId: string,
    phase: PlannedPhase,
    taskResults: TaskResultRef[],
  ): Artifact[];

  /**
   * Persist artifacts to memory as a checkpoint for the given plan/phase.
   * Failures are logged but never thrown — checkpointing is best-effort.
   */
  storeCheckpoint(planId: string, phaseId: string, artifacts: Artifact[]): Promise<void>;
}

export interface ArtifactCollectorDeps {
  logger: Logger;
  cliClient: CliClient;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createArtifactCollector(deps: ArtifactCollectorDeps): ArtifactCollector {
  const { logger, cliClient } = deps;

  return {
    collect(
      phaseId: string,
      phase: PlannedPhase,
      taskResults: TaskResultRef[],
    ): Artifact[] {
      return taskResults.map((result) => ({
        id: randomUUID(),
        phaseId,
        type: phase.type,
        url: `memory://${phaseId}/${result.taskId}`,
        metadata: {
          agentId: result.agentId,
          taskId: result.taskId,
          status: result.status,
          output: result.output,
        },
      }));
    },

    async storeCheckpoint(
      planId: string,
      phaseId: string,
      artifacts: Artifact[],
    ): Promise<void> {
      const key = `${planId}/${phaseId}`;
      const value = JSON.stringify(artifacts);
      const namespace = `artifacts:${planId}`;

      try {
        await cliClient.memoryStore(key, value, { namespace });
        logger.debug('Stored artifact checkpoint', { planId, phaseId, count: artifacts.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to store artifact checkpoint', {
          planId,
          phaseId,
          error: message,
        });
      }
    },
  };
}
