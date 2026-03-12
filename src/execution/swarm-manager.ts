/**
 * Swarm Manager.
 *
 * Initializes and shuts down claude-flow swarms for a given WorkflowPlan.
 * Tracks active swarm handles so shutdown is idempotent and safe.
 *
 * Dependencies are injected via SwarmManagerDeps, making this fully
 * testable with mock McpClient (London School TDD).
 */

import type { WorkflowPlan } from '../types';
import type { McpClient } from './mcp-client';
import type { Logger } from '../shared/logger';
import { SwarmError } from '../shared/errors';

// ---------------------------------------------------------------------------
// SwarmHandle — returned by initSwarm, mutated on shutdown
// ---------------------------------------------------------------------------

export interface SwarmHandle {
  swarmId: string;
  topology: string;
  maxAgents: number;
  status: 'active' | 'shutdown';
}

// ---------------------------------------------------------------------------
// SwarmManager interface and dependencies
// ---------------------------------------------------------------------------

export interface SwarmManager {
  initSwarm(plan: WorkflowPlan): Promise<SwarmHandle>;
  shutdownSwarm(swarmId: string): Promise<void>;
}

export interface SwarmManagerDeps {
  logger: Logger;
  mcpClient: McpClient;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SwarmManager that delegates to McpClient for swarm lifecycle.
 */
export function createSwarmManager(deps: SwarmManagerDeps): SwarmManager {
  const { logger, mcpClient } = deps;
  const handles = new Map<string, SwarmHandle>();

  return {
    async initSwarm(plan: WorkflowPlan): Promise<SwarmHandle> {
      logger.info('Initializing swarm', {
        planId: plan.id,
        topology: plan.topology,
        maxAgents: plan.maxAgents,
      });

      let swarmId: string;
      try {
        const result = await mcpClient.swarmInit({
          topology: plan.topology,
          maxAgents: plan.maxAgents,
          strategy: plan.swarmStrategy,
          consensus: plan.consensus,
        });
        swarmId = result.swarmId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Failed to initialize swarm', { planId: plan.id, error: message });
        throw new SwarmError(`Swarm init failed: ${message}`, { cause: err });
      }

      const handle: SwarmHandle = {
        swarmId,
        topology: plan.topology,
        maxAgents: plan.maxAgents,
        status: 'active',
      };

      handles.set(swarmId, handle);

      logger.info('Swarm initialized', { swarmId, topology: plan.topology });
      return handle;
    },

    async shutdownSwarm(swarmId: string): Promise<void> {
      const handle = handles.get(swarmId);

      if (!handle) {
        logger.warn('Shutdown requested for unknown swarm', { swarmId });
        return;
      }

      if (handle.status === 'shutdown') {
        logger.debug('Swarm already shut down', { swarmId });
        return;
      }

      logger.info('Shutting down swarm', { swarmId });
      await mcpClient.swarmShutdown(swarmId);
      handle.status = 'shutdown';
      logger.info('Swarm shut down', { swarmId });
    },
  };
}
