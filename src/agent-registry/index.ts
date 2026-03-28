/**
 * Agent Registry — public API.
 *
 * Single source of truth for agent definitions.
 * Scans .claude/agents/ Markdown frontmatter.
 */

export { parseFrontmatter, type AgentFrontmatter } from './frontmatter-parser';
export { scanAgentDirectory, type AgentDefinition } from './directory-scanner';
export {
  createAgentRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  type AgentRegistry,
  type AgentRegistryOptions,
} from './agent-registry';
