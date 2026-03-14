/**
 * Setup module public API.
 *
 * Entry point for the interactive setup wizard and config merge utilities.
 */

export { runWizard } from './wizard';
export { createTerminalIO } from './renderer';
export { loadSetup, saveSetup, validateSetupConfig, applyAgentOverrides, applyEventOverrides, applyTopologyOverrides, formatSummary, getSetupPath } from './config-writer';
export { getPresetDefs, applyPreset, buildAgentToggles, buildEventToggles, discoverAgentTypes, getAgentTypes } from './presets';
export type { SetupConfig, AgentToggle, EventToggle, TerminalIO, PresetKey } from './types';
