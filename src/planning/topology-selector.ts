/**
 * Topology Selector.
 *
 * Selects the optimal swarm topology, consensus protocol, and max agents
 * based on complexity, impact, agent count, and methodology.
 *
 * Rules (from CLAUDE.md and architecture doc):
 * - hierarchical for coding swarms
 * - hierarchical-mesh for complex features
 * - star for minimal/incident response
 * - raft consensus for hive-mind
 * - maxAgents 6-8 for tight coordination
 */

import type { PlanningInput } from '../types';

// ---------------------------------------------------------------------------
// Selection result
// ---------------------------------------------------------------------------

export interface TopologySelection {
  topology: 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'ring' | 'star' | 'adaptive';
  consensus: 'raft' | 'pbft' | 'none';
  maxAgents: number;
  swarmStrategy: 'specialized' | 'balanced' | 'minimal';
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Selection logic
// ---------------------------------------------------------------------------

/**
 * Select optimal topology from triage result and planning input.
 */
export function selectTopology(input: PlanningInput): TopologySelection {
  const { triageResult } = input;
  const complexity = triageResult.complexity.percentage;
  const agentCount = input.agentTeam.length;

  // High complexity + system-wide impact → hierarchical-mesh
  if (complexity >= 60 && triageResult.impact === 'system-wide') {
    return {
      topology: 'hierarchical-mesh',
      consensus: 'raft',
      maxAgents: Math.min(agentCount + 2, 8),
      swarmStrategy: 'specialized',
      reasoning: 'High complexity + system-wide impact requires hierarchical-mesh with raft consensus',
    };
  }

  // High complexity → hierarchical
  if (complexity >= 40) {
    return {
      topology: 'hierarchical',
      consensus: 'raft',
      maxAgents: Math.min(agentCount + 1, 8),
      swarmStrategy: 'specialized',
      reasoning: 'Medium-high complexity benefits from hierarchical coordination',
    };
  }

  // Low complexity, isolated impact → star (minimal overhead)
  if (complexity < 25 && triageResult.impact === 'isolated') {
    return {
      topology: 'star',
      consensus: 'none',
      maxAgents: Math.min(agentCount, 4),
      swarmStrategy: 'minimal',
      reasoning: 'Low complexity isolated task uses minimal star topology',
    };
  }

  // Incident response → star with fast consensus
  if (triageResult.priority === 'P0-immediate') {
    return {
      topology: 'star',
      consensus: 'none',
      maxAgents: Math.min(agentCount, 4),
      swarmStrategy: 'minimal',
      reasoning: 'P0 incident response uses star for minimal latency',
    };
  }

  // Default: hierarchical with raft
  return {
    topology: 'hierarchical',
    consensus: 'raft',
    maxAgents: Math.min(agentCount, 6),
    swarmStrategy: agentCount > 4 ? 'specialized' : 'balanced',
    reasoning: 'Default hierarchical topology with raft consensus',
  };
}
