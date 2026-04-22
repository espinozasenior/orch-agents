/**
 * DirectSpawnToolDef -- a DeferredToolDef named 'Agent' that routes
 * tool calls to DirectSpawnStrategy instead of the SDK's built-in handler.
 *
 * Registered via deferredToolRegistry.override() when AGENT_SPAWN_MODE=direct.
 */

import type { DeferredToolDef } from '../../services/deferred-tools/registry.js';
import type { DirectSpawnStrategy } from './direct-spawn-strategy';

// ---------------------------------------------------------------------------
// Schema matching the Claude Code Agent tool expectations
// ---------------------------------------------------------------------------

const AGENT_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The task prompt for the sub-agent',
    },
    subagent_type: {
      type: 'string',
      description: 'The type of sub-agent to spawn (e.g. "coder", "researcher")',
    },
    description: {
      type: 'string',
      description: 'A short description of what the sub-agent should do',
    },
    isolation: {
      type: 'string',
      enum: ['worktree'],
      description: 'Isolation mode for the sub-agent (currently only "worktree")',
    },
  },
  required: ['prompt'],
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDirectSpawnToolDef(
  strategy: DirectSpawnStrategy,
): DeferredToolDef {
  return {
    name: 'Agent',
    description: 'Spawn a sub-agent for a focused task (direct mode)',
    schema: AGENT_TOOL_SCHEMA,
    execute: async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      const subagent_type = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
      const description = typeof input.description === 'string' ? input.description : undefined;
      const isolation = input.isolation === 'worktree' ? 'worktree' as const : undefined;

      const result = await strategy.executeAgentTool({
        prompt,
        subagent_type,
        description,
        isolation,
      });

      return { content: result, is_error: false };
    },
    shouldDefer: false,
    alwaysLoad: true,
    isConcurrencySafe: () => false,
  };
}
