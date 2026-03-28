/**
 * Setup Presets.
 *
 * Pre-built configurations for common use cases.
 * Each preset defines which agents, events, topology, and limits to use.
 */

import type {
  SetupConfig, PresetKey, AgentToggle, EventToggle,
  TopologyChoice, ConsensusChoice, StrategyChoice,
} from './types';
import { getDefaultRegistry, createAgentRegistry, type AgentRegistry } from '../agent-registry';

// ---------------------------------------------------------------------------
// Agent type discovery from .claude/agents/**/*.md (via AgentRegistry)
// ---------------------------------------------------------------------------

const FALLBACK_AGENT_TYPES = [
  'architect', 'coder', 'researcher', 'reviewer',
  'security-architect', 'tester',
];

/**
 * Discover agent types by scanning .claude/agents/ Markdown frontmatter.
 * Falls back to hardcoded list if no agents are found.
 *
 * @param agentsDirOrRegistry - path to agents dir (for backward compat) or AgentRegistry instance
 */
export function discoverAgentTypes(agentsDirOrRegistry?: string | AgentRegistry): string[] {
  // Support legacy callers that pass a directory path
  if (typeof agentsDirOrRegistry === 'string') {
    const registry = createAgentRegistry({ agentsDir: agentsDirOrRegistry });
    const names = registry.getNames();
    return names.length > 0 ? names : [...FALLBACK_AGENT_TYPES];
  }

  const registry = agentsDirOrRegistry ?? getDefaultRegistry();
  const names = registry.getNames();
  return names.length > 0 ? names : [...FALLBACK_AGENT_TYPES];
}

let _cachedAgentTypes: string[] | undefined;

/**
 * Get available agent types (cached after first call).
 * Discovers from .claude/agents/ via AgentRegistry.
 */
export function getAgentTypes(): string[] {
  if (!_cachedAgentTypes) {
    _cachedAgentTypes = discoverAgentTypes();
  }
  return _cachedAgentTypes;
}

/**
 * Reset cached agent types (for testing).
 */
export function resetAgentTypesCache(): void {
  _cachedAgentTypes = undefined;
}

/** @deprecated Use getAgentTypes() for dynamic discovery */
export const ALL_AGENT_TYPES = FALLBACK_AGENT_TYPES;

// ---------------------------------------------------------------------------
// All GitHub event IDs (from github-routing.json)
// ---------------------------------------------------------------------------

export const ALL_EVENT_IDS = [
  { id: 'push:default_branch',         label: 'Push to default branch' },
  { id: 'push:other_branch',           label: 'Push to feature branch' },
  { id: 'pull_request:opened',         label: 'PR opened' },
  { id: 'pull_request:synchronize',    label: 'PR updated (new commits)' },
  { id: 'pull_request:closed:merged',  label: 'PR merged' },
  { id: 'pull_request:ready_for_review', label: 'PR ready for review' },
  { id: 'issues:opened',               label: 'Issue opened' },
  { id: 'issues:labeled:bug',          label: 'Issue labeled "bug"' },
  { id: 'issues:labeled:enhancement',  label: 'Issue labeled "enhancement"' },
  { id: 'issue_comment:created',       label: 'Bot mentioned in comment' },
  { id: 'pull_request_review:submitted', label: 'Changes requested on PR' },
  { id: 'workflow_run:completed:failure', label: 'CI workflow failed' },
  { id: 'release:published',           label: 'Release published' },
  { id: 'deployment_status:failure',   label: 'Deployment failed' },
] as const;

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface PresetDef {
  key: PresetKey;
  name: string;
  description: string;
  agents: string[];
  events: string[];
  topology: TopologyChoice;
  consensus: ConsensusChoice;
  swarmStrategy: StrategyChoice;
  maxAgents: number;
}

const PRESETS: Record<Exclude<PresetKey, 'custom'>, PresetDef> = {
  minimal: {
    key: 'minimal',
    name: 'Minimal',
    description: 'Lean setup: coder + tester, basic CI events only',
    agents: ['coder', 'tester'],
    events: ['push:default_branch', 'pull_request:opened'],
    topology: 'star',
    consensus: 'none',
    swarmStrategy: 'minimal',
    maxAgents: 3,
  },
  standard: {
    key: 'standard',
    name: 'Standard',
    description: 'Balanced team with core GitHub events',
    agents: ['coder', 'tester', 'reviewer', 'architect'],
    events: [
      'push:default_branch',
      'pull_request:opened', 'pull_request:synchronize',
      'pull_request:closed:merged',
      'issues:opened',
      'workflow_run:completed:failure',
    ],
    topology: 'hierarchical',
    consensus: 'raft',
    swarmStrategy: 'specialized',
    maxAgents: 6,
  },
  'full-sparc': {
    key: 'full-sparc',
    name: 'Full SPARC',
    description: 'All agents, all events, full methodology',
    agents: [], // filled dynamically from getAgentTypes() at apply time
    events: ALL_EVENT_IDS.map(e => e.id),
    topology: 'hierarchical-mesh',
    consensus: 'raft',
    swarmStrategy: 'specialized',
    maxAgents: 8,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPresetDefs(): Array<{ key: PresetKey; name: string; description: string }> {
  return [
    ...Object.values(PRESETS).map(p => ({ key: p.key, name: p.name, description: p.description })),
    { key: 'custom' as PresetKey, name: 'Custom', description: 'Pick your own agents, events, and topology' },
  ];
}

export function buildAgentToggles(enabledTypes: string[]): AgentToggle[] {
  const enabled = new Set(enabledTypes);
  return getAgentTypes().map(type => ({
    type,
    enabled: enabled.has(type),
  }));
}

export function buildEventToggles(enabledIds: string[]): EventToggle[] {
  const enabled = new Set(enabledIds);
  return ALL_EVENT_IDS.map(evt => ({
    id: evt.id,
    label: evt.label,
    enabled: enabled.has(evt.id),
  }));
}

export function applyPreset(key: Exclude<PresetKey, 'custom'>): SetupConfig {
  const p = PRESETS[key];
  // full-sparc enables all discovered agents dynamically
  const agents = key === 'full-sparc' ? getAgentTypes() : p.agents;
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    preset: p.key,
    activeAgents: buildAgentToggles(agents),
    githubEvents: buildEventToggles(p.events),
    topology: p.topology,
    consensus: p.consensus,
    swarmStrategy: p.swarmStrategy,
    maxAgents: p.maxAgents,
  };
}

export function getPreset(key: Exclude<PresetKey, 'custom'>): PresetDef {
  return PRESETS[key];
}
