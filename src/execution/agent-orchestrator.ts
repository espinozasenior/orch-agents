/**
 * AgentOrchestrator — spawns agents for a phase, polls for completion
 * with exponential backoff, and terminates on timeout.
 *
 * Part of Phase 3: Real Agent Execution.
 */

import type { PlannedPhase, PlannedAgent, Artifact } from '../types';
import type { CliClient, AgentStatusResult } from './cli-client';
import type { Logger } from '../shared/logger';
import { AgentTimeoutError } from '../shared/errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpawnedAgent {
  agentId: string;
  role: string;
  type: string;
  tier: number;
  status: 'spawned' | 'running' | 'completed' | 'failed' | 'terminated';
}

export interface AgentOutcome {
  agentId: string;
  role: string;
  status: 'completed' | 'failed' | 'timeout';
  artifacts: Artifact[];
  duration: number;
  error?: string;
}

export interface AgentOrchestrator {
  spawnAgents(swarmId: string, phase: PlannedPhase, team: PlannedAgent[]): Promise<SpawnedAgent[]>;
  waitForAgents(agents: SpawnedAgent[], timeoutMs: number): Promise<AgentOutcome[]>;
  terminateAgents(agents: SpawnedAgent[]): Promise<void>;
}

export interface AgentOrchestratorDeps {
  logger: Logger;
  cliClient: CliClient;
  pollIntervalMs?: number;
  backoffMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const MAX_POLL_INTERVAL_MS = 10000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentOrchestrator(deps: AgentOrchestratorDeps): AgentOrchestrator {
  const {
    logger,
    cliClient,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
  } = deps;

  // -------------------------------------------------------------------------
  // spawnAgents
  // -------------------------------------------------------------------------

  async function spawnAgents(
    swarmId: string,
    phase: PlannedPhase,
    team: PlannedAgent[],
  ): Promise<SpawnedAgent[]> {
    // M9: Spawn agents concurrently using Promise.allSettled
    const spawnPromises = phase.agents.map((roleName) => {
      const agentDef = team.find(a => a.role === roleName);
      const agentType = agentDef?.type ?? roleName;
      const agentTier = agentDef?.tier ?? 2;

      logger.debug('Spawning agent', { role: roleName, type: agentType, swarmId });

      return cliClient.agentSpawn({
        type: agentType,
        name: `${phase.type}-${roleName}`,
        swarmId,
      }).then((result) => ({
        agentId: result.agentId,
        role: roleName,
        type: agentType,
        tier: agentTier,
        status: 'spawned' as const,
      }));
    });

    const settled = await Promise.allSettled(spawnPromises);
    const spawned: SpawnedAgent[] = settled.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const roleName = phase.agents[idx];
      const agentDef = team.find(a => a.role === roleName);
      const agentType = agentDef?.type ?? roleName;
      const agentTier = agentDef?.tier ?? 2;
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn('Failed to spawn agent', { role: roleName, error: errMsg });
      return {
        agentId: `failed-${roleName}`,
        role: roleName,
        type: agentType,
        tier: agentTier,
        status: 'failed' as const,
      };
    });

    logger.info('Spawned agents for phase', {
      phase: phase.type,
      count: spawned.length,
      agentIds: spawned.map(a => a.agentId),
    });

    return spawned;
  }

  // -------------------------------------------------------------------------
  // waitForAgents — exponential backoff polling
  // -------------------------------------------------------------------------

  async function waitForAgents(
    agents: SpawnedAgent[],
    timeoutMs: number,
  ): Promise<AgentOutcome[]> {
    const startTime = Date.now();
    let currentInterval = pollIntervalMs;

    // Track which agents are still pending
    const outcomes = new Map<string, AgentOutcome>();
    const pending = new Set(agents.map(a => a.agentId));
    const roleMap = new Map(agents.map(a => [a.agentId, a.role]));

    while (pending.size > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        // Terminate all still-pending agents
        const pendingAgents = agents.filter(a => pending.has(a.agentId));
        await terminateAgents(pendingAgents);

        // DESIGN-07 FIX: Include all pending agent IDs in the error
        const pendingIds = pendingAgents.map(a => a.agentId);
        throw new AgentTimeoutError(pendingIds[0], timeoutMs, pendingIds);
      }

      // Poll each pending agent
      for (const agentId of [...pending]) {
        let statusResult: AgentStatusResult;
        try {
          statusResult = await cliClient.agentStatus(agentId);
        } catch {
          // Treat poll failure as a transient error; retry next round
          logger.warn('Failed to poll agent status', { agentId });
          continue;
        }

        if (statusResult.status === 'completed' || statusResult.status === 'failed') {
          pending.delete(agentId);
          outcomes.set(agentId, {
            agentId,
            role: roleMap.get(agentId) ?? 'unknown',
            status: statusResult.status,
            artifacts: [],
            duration: Date.now() - startTime,
            error: statusResult.error,
          });
        }
      }

      if (pending.size > 0) {
        await sleep(currentInterval);
        currentInterval = Math.min(
          currentInterval * backoffMultiplier,
          MAX_POLL_INTERVAL_MS,
        );
      }
    }

    // BUG-05 FIX: Terminate all agents after successful completion
    await terminateAgents(agents);

    // Return outcomes in original agent order
    return agents.map(a => outcomes.get(a.agentId)!);
  }

  // -------------------------------------------------------------------------
  // terminateAgents
  // -------------------------------------------------------------------------

  async function terminateAgents(agents: SpawnedAgent[]): Promise<void> {
    await Promise.all(
      agents.map(async (agent) => {
        try {
          await cliClient.agentTerminate(agent.agentId);
          logger.debug('Terminated agent', { agentId: agent.agentId });
        } catch (err) {
          logger.warn('Failed to terminate agent', {
            agentId: agent.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  return { spawnAgents, waitForAgents, terminateAgents };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
