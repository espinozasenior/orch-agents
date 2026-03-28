/**
 * Setup Wizard.
 *
 * Step sequencer that drives the interactive setup flow.
 * All terminal IO goes through the TerminalIO interface for testability.
 */

import type { TerminalIO, SetupConfig, SelectItem, PresetKey, TopologyChoice, ConsensusChoice, StrategyChoice } from './types';
import { getPresetDefs, applyPreset, getAgentTypes, ALL_EVENT_IDS } from './presets';
import { singleSelect, multiSelect, numericInput } from './renderer';
import { loadSetup, saveSetup, formatSummary } from './config-writer';
import { getDefaultRegistry } from '../agent-registry';

// ---------------------------------------------------------------------------
// Wizard entry point
// ---------------------------------------------------------------------------

export async function runWizard(io: TerminalIO): Promise<SetupConfig | null> {
  try {
    io.clearScreen();
    io.write('\n  \x1b[1m\x1b[36mOrch-Agents Setup Wizard\x1b[0m\n');
    io.write('  \x1b[2mConfigure agents, events, and topology\x1b[0m\n\n');

    // Check for existing config
    const existing = loadSetup();
    if (existing) {
      const action = await singleSelect<'edit' | 'fresh'>(io, 'Existing setup found', [
        { value: 'edit', label: 'Edit current setup', description: `preset: ${existing.preset}`, selected: true },
        { value: 'fresh', label: 'Start fresh', description: 'reset all settings', selected: false },
      ]);
      if (action === 'edit') {
        return await runCustomFlow(io, existing);
      }
    }

    // Step 1: Choose preset
    const presetDefs = getPresetDefs();
    const presetItems: SelectItem<PresetKey>[] = presetDefs.map((p, i) => ({
      value: p.key,
      label: p.name,
      description: p.description,
      selected: i === 1, // default to Standard
    }));

    const presetKey = await singleSelect(io, 'Choose a preset', presetItems);

    // Non-custom presets: apply and confirm
    if (presetKey !== 'custom') {
      const config = applyPreset(presetKey as Exclude<PresetKey, 'custom'>);
      io.write(formatSummary(config));

      const confirm = await singleSelect<'save' | 'customize' | 'cancel'>(
        io, 'What next?', [
          { value: 'save', label: 'Save and exit', selected: true, description: '' },
          { value: 'customize', label: 'Customize this preset', selected: false, description: '' },
          { value: 'cancel', label: 'Cancel', selected: false, description: '' },
        ],
      );

      if (confirm === 'cancel') {
        io.write('\n  \x1b[2mSetup cancelled.\x1b[0m\n');
        return null;
      }
      if (confirm === 'save') {
        const path = saveSetup(config);
        io.write(`\n  \x1b[32mSaved to ${path}\x1b[0m\n`);
        return config;
      }
      // customize: fall through to custom flow with preset as base
      return await runCustomFlow(io, config);
    }

    // Custom flow from scratch
    return await runCustomFlow(io);

  } catch (err) {
    if (err instanceof Error && err.message === 'User cancelled') {
      io.write('\n  \x1b[2mSetup cancelled.\x1b[0m\n');
      return null;
    }
    throw err;
  } finally {
    io.close();
  }
}

// ---------------------------------------------------------------------------
// Custom configuration flow
// ---------------------------------------------------------------------------

async function runCustomFlow(
  io: TerminalIO,
  base?: SetupConfig,
): Promise<SetupConfig | null> {
  // Step 2: Select agents
  const agentItems: SelectItem<string>[] = getAgentTypes().map(type => ({
    value: type,
    label: type,
    description: agentDescription(type),
    selected: base
      ? base.activeAgents.some(a => a.type === type && a.enabled)
      : true, // default all on for fresh custom
  }));

  const selectedAgents = await multiSelect(io, 'Select active agents', agentItems);

  // Step 3: Toggle GitHub events
  const eventItems: SelectItem<string>[] = ALL_EVENT_IDS.map(evt => ({
    value: evt.id,
    label: evt.label,
    selected: base
      ? base.githubEvents.some(e => e.id === evt.id && e.enabled)
      : true,
  }));

  const selectedEvents = await multiSelect(io, 'Toggle GitHub events', eventItems);

  // Step 4: Topology
  const topologyItems: SelectItem<TopologyChoice>[] = [
    { value: 'star', label: 'Star', description: 'Simple, fast, low overhead', selected: false },
    { value: 'hierarchical', label: 'Hierarchical', description: 'Leader-based coordination', selected: false },
    { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', description: 'Complex features, max flexibility', selected: false },
    { value: 'mesh', label: 'Mesh', description: 'Peer-to-peer, decentralized', selected: false },
    { value: 'ring', label: 'Ring', description: 'Sequential pipeline', selected: false },
    { value: 'adaptive', label: 'Adaptive', description: 'Auto-selects based on task', selected: false },
  ];
  const baseTopology = base?.topology ?? 'hierarchical';
  const topoIdx = topologyItems.findIndex(i => i.value === baseTopology);
  if (topoIdx >= 0) topologyItems[topoIdx].selected = true;
  else topologyItems[1].selected = true;

  const topology = await singleSelect(io, 'Choose topology', topologyItems);

  // Step 5: Consensus
  const consensusItems: SelectItem<ConsensusChoice>[] = [
    { value: 'raft', label: 'Raft', description: 'Leader election, strong consistency', selected: false },
    { value: 'pbft', label: 'PBFT', description: 'Byzantine fault tolerant', selected: false },
    { value: 'none', label: 'None', description: 'No consensus (fastest)', selected: false },
  ];
  const baseCon = base?.consensus ?? 'raft';
  const conIdx = consensusItems.findIndex(i => i.value === baseCon);
  if (conIdx >= 0) consensusItems[conIdx].selected = true;
  else consensusItems[0].selected = true;

  const consensus = await singleSelect(io, 'Choose consensus protocol', consensusItems);

  // Step 6: Strategy
  const strategyItems: SelectItem<StrategyChoice>[] = [
    { value: 'specialized', label: 'Specialized', description: 'Clear role boundaries', selected: false },
    { value: 'balanced', label: 'Balanced', description: 'Flexible agent assignment', selected: false },
    { value: 'minimal', label: 'Minimal', description: 'Fewest agents possible', selected: false },
  ];
  const baseStrat = base?.swarmStrategy ?? 'specialized';
  const stratIdx = strategyItems.findIndex(i => i.value === baseStrat);
  if (stratIdx >= 0) strategyItems[stratIdx].selected = true;
  else strategyItems[0].selected = true;

  const swarmStrategy = await singleSelect(io, 'Choose swarm strategy', strategyItems);

  // Step 7: Max agents
  const maxAgents = await numericInput(
    io, 'Max concurrent agents', 2, 15, base?.maxAgents ?? 6,
  );

  // Build config
  const config: SetupConfig = {
    version: 1,
    createdAt: new Date().toISOString(),
    preset: 'custom',
    activeAgents: getAgentTypes().map(type => ({
      type,
      enabled: selectedAgents.includes(type),
    })),
    githubEvents: ALL_EVENT_IDS.map(evt => ({
      id: evt.id,
      label: evt.label,
      enabled: selectedEvents.includes(evt.id),
    })),
    topology,
    consensus,
    swarmStrategy,
    maxAgents,
  };

  // Review
  io.write(formatSummary(config));

  const confirm = await singleSelect<'save' | 'cancel'>(io, 'Save this configuration?', [
    { value: 'save', label: 'Save and exit', selected: true, description: '' },
    { value: 'cancel', label: 'Cancel', selected: false, description: '' },
  ]);

  if (confirm === 'cancel') {
    io.write('\n  \x1b[2mSetup cancelled.\x1b[0m\n');
    return null;
  }

  const path = saveSetup(config);
  io.write(`\n  \x1b[32mSaved to ${path}\x1b[0m\n`);
  return config;
}

// ---------------------------------------------------------------------------
// Agent descriptions
// ---------------------------------------------------------------------------

function agentDescription(type: string): string {
  const registry = getDefaultRegistry();
  const def = registry.getByName(type);
  if (def?.description) return def.description;

  // Fallback for agents not yet in registry
  const descs: Record<string, string> = {
    'coder': 'Writes and modifies code',
    'tester': 'Creates and runs tests',
    'reviewer': 'Reviews code and PRs',
    'architect': 'Designs system architecture',
    'security-architect': 'Security audits and threat modeling',
    'researcher': 'Investigates and gathers context',
  };
  return descs[type] ?? '';
}
