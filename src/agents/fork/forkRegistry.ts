/**
 * P5 — Fork Agent Registry
 *
 * Wires the fork subagent into the agent system by:
 * 1. Creating a composite registry that merges disk-loaded agents with
 *    programmatic agents (like FORK_AGENT).
 * 2. Providing convenience functions for fork eligibility checks and
 *    message building.
 */

import type { ForkAgentDefinition, ForkMessage } from './types.js';
import {
  FORK_AGENT,
  isForkSubagentEnabled,
  isInForkChild,
  buildForkConversationMessages,
} from './forkSubagent.js';

// ---------------------------------------------------------------------------
// Agent registry types
// ---------------------------------------------------------------------------

/**
 * Minimal agent definition for registry purposes.
 * Disk agents and programmatic agents share this shape.
 */
export interface AgentEntry {
  agentType: string;
  whenToUse: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Composite registry
// ---------------------------------------------------------------------------

/**
 * Creates a composite agent registry by merging disk-loaded agents
 * with programmatic agents (e.g., FORK_AGENT).
 *
 * Programmatic agents override disk agents with the same agentType.
 *
 * @param diskAgents - Agents loaded from disk (e.g., YAML definitions)
 * @param programmaticAgents - Built-in agents registered in code
 * @returns Merged registry keyed by agentType
 */
export function createCompositeAgentRegistry(
  diskAgents: Map<string, AgentEntry>,
  programmaticAgents: Map<string, AgentEntry>,
): Map<string, AgentEntry> {
  const registry = new Map<string, AgentEntry>();

  // Disk agents first (lower priority)
  for (const [key, agent] of diskAgents) {
    registry.set(key, agent);
  }

  // Programmatic agents override (higher priority)
  for (const [key, agent] of programmaticAgents) {
    registry.set(key, agent);
  }

  return registry;
}

/**
 * Returns the default programmatic agent registry containing FORK_AGENT.
 */
export function getDefaultProgrammaticAgents(): Map<string, AgentEntry> {
  const agents = new Map<string, AgentEntry>();
  agents.set(FORK_AGENT.agentType, FORK_AGENT);
  return agents;
}

/**
 * Returns the FORK_AGENT definition for direct access.
 */
export function getForkAgentDefinition(): ForkAgentDefinition {
  return FORK_AGENT;
}

// ---------------------------------------------------------------------------
// Fork eligibility
// ---------------------------------------------------------------------------

/**
 * Determines whether a fork subagent should be used instead of a
 * fresh agent spawn.
 *
 * Fork is used when:
 * - Fork feature is enabled (not coordinator, not non-interactive)
 * - The current agent is not already a fork child (depth = 1 limit)
 *
 * @param isCoordinator - Whether we are in coordinator mode
 * @param isNonInteractive - Whether the session is non-interactive
 * @param messages - Current conversation messages (checked for fork tag)
 * @returns true if fork should be used
 */
export function shouldUseFork(
  isCoordinator: boolean,
  isNonInteractive: boolean,
  messages: ForkMessage[],
): boolean {
  if (!isForkSubagentEnabled(isCoordinator, isNonInteractive)) {
    return false;
  }
  if (isInForkChild(messages)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper around buildForkConversationMessages.
 *
 * Builds fork messages from parent history with the given directive.
 * All fork children from the same parent produce byte-identical prefixes
 * for prompt cache sharing.
 *
 * @param parentMessages - Parent's full conversation history
 * @param directive - What the fork should do (not background — context inherited)
 * @returns Fork conversation messages ready for API call
 */
export function buildForkMessages(
  parentMessages: ForkMessage[],
  directive: string,
): ForkMessage[] {
  return buildForkConversationMessages(parentMessages, directive);
}
