/**
 * Config Writer & Merge Logic.
 *
 * Pure merge functions to apply setup.json overrides onto
 * the default config (workflow-templates, github-routing, topology).
 *
 * Also handles reading/writing config/setup.json to disk.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { SetupConfig, AgentToggle, EventToggle, TopologyChoice, ConsensusChoice, StrategyChoice } from './types';
import type { PlannedAgent } from '../types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SETUP_PATH = resolve(__dirname, '..', '..', 'config', 'setup.json');

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function loadSetup(): SetupConfig | null {
  if (!existsSync(SETUP_PATH)) return null;
  const raw = readFileSync(SETUP_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  const { valid, errors } = validateSetupConfig(parsed);
  if (!valid) {
    throw new Error(`Invalid setup.json: ${errors.join('; ')}`);
  }
  return parsed as SetupConfig;
}

export function saveSetup(config: SetupConfig): string {
  const dir = dirname(SETUP_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SETUP_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return SETUP_PATH;
}

export function getSetupPath(): string {
  return SETUP_PATH;
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

const VALID_PRESETS = new Set(['minimal', 'standard', 'full-sparc', 'custom']);
const VALID_TOPOLOGIES = new Set(['mesh', 'hierarchical', 'hierarchical-mesh', 'ring', 'star', 'adaptive']);
const VALID_CONSENSUS_VALS = new Set(['raft', 'pbft', 'none']);
const VALID_STRATEGIES = new Set(['specialized', 'balanced', 'minimal']);

export function validateSetupConfig(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) errors.push(`unsupported version: ${obj.version}`);
  if (!obj.preset || !VALID_PRESETS.has(obj.preset as string)) errors.push(`invalid or missing preset`);
  if (typeof obj.maxAgents !== 'number' || obj.maxAgents < 1) errors.push(`maxAgents must be a positive number`);
  if (!Array.isArray(obj.activeAgents)) errors.push(`activeAgents must be an array`);
  if (!Array.isArray(obj.githubEvents)) errors.push(`githubEvents must be an array`);
  if (!VALID_TOPOLOGIES.has(obj.topology as string)) errors.push(`invalid topology`);
  if (!VALID_CONSENSUS_VALS.has(obj.consensus as string)) errors.push(`invalid consensus`);
  if (!VALID_STRATEGIES.has(obj.swarmStrategy as string)) errors.push(`invalid swarmStrategy`);

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Pure merge functions
// ---------------------------------------------------------------------------

/**
 * Filter agent list: keep only agents whose type is enabled in setup.
 * Returns original list if no setup or all agents enabled.
 */
export function applyAgentOverrides(
  agents: PlannedAgent[],
  toggles: AgentToggle[],
): PlannedAgent[] {
  const enabled = new Set(
    toggles.filter(t => t.enabled).map(t => t.type),
  );
  // If all are enabled, no filtering needed
  if (enabled.size === toggles.length) return agents;
  return agents.filter(a => enabled.has(a.type));
}

/**
 * Build a routing event ID from a github-routing.json rule.
 */
export function buildEventId(rule: { event: string; action: string | null; condition: string | null }): string {
  const parts = [rule.event];
  if (rule.action) parts.push(rule.action);
  if (rule.condition) parts.push(rule.condition);
  return parts.join(':');
}

/**
 * Filter routing rules: keep only events enabled in setup.
 */
export function applyEventOverrides<T extends { event: string; action: string | null; condition: string | null }>(
  rules: T[],
  toggles: EventToggle[],
): T[] {
  const enabled = new Set(
    toggles.filter(t => t.enabled).map(t => t.id),
  );
  if (enabled.size === toggles.length) return rules;
  return rules.filter(r => enabled.has(buildEventId(r)));
}

/**
 * Constrain topology selection with user overrides.
 */
export function applyTopologyOverrides(
  selection: { topology: string; consensus: string; maxAgents: number; swarmStrategy: string },
  setup: { topology: TopologyChoice; consensus: ConsensusChoice; swarmStrategy: StrategyChoice; maxAgents: number },
): { topology: string; consensus: string; maxAgents: number; swarmStrategy: string } {
  return {
    topology: setup.topology,
    consensus: setup.consensus,
    maxAgents: Math.min(selection.maxAgents, setup.maxAgents),
    swarmStrategy: setup.swarmStrategy,
  };
}

// ---------------------------------------------------------------------------
// Summary formatter (for review step)
// ---------------------------------------------------------------------------

export function formatSummary(config: SetupConfig): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  \x1b[1m\x1b[36mSetup Summary\x1b[0m');
  lines.push('  ─────────────────────────────────');
  lines.push(`  Preset:        \x1b[32m${config.preset}\x1b[0m`);
  lines.push(`  Topology:      \x1b[32m${config.topology}\x1b[0m`);
  lines.push(`  Consensus:     \x1b[32m${config.consensus}\x1b[0m`);
  lines.push(`  Strategy:      \x1b[32m${config.swarmStrategy}\x1b[0m`);
  lines.push(`  Max Agents:    \x1b[32m${config.maxAgents}\x1b[0m`);
  lines.push('');
  lines.push('  \x1b[1mActive Agents:\x1b[0m');
  for (const a of config.activeAgents) {
    const icon = a.enabled ? '\x1b[32m[x]\x1b[0m' : '\x1b[2m[ ]\x1b[0m';
    lines.push(`    ${icon} ${a.type}`);
  }
  lines.push('');
  lines.push('  \x1b[1mGitHub Events:\x1b[0m');
  for (const e of config.githubEvents) {
    const icon = e.enabled ? '\x1b[32m[x]\x1b[0m' : '\x1b[2m[ ]\x1b[0m';
    lines.push(`    ${icon} ${e.label}`);
  }
  lines.push('');
  return lines.join('\n');
}
