/**
 * Setup Wizard Types.
 *
 * Defines the configuration schema written to config/setup.json
 * and the UI abstractions for terminal interaction.
 */

// ---------------------------------------------------------------------------
// Setup config (persisted to config/setup.json)
// ---------------------------------------------------------------------------

export interface SetupConfig {
  version: 1;
  createdAt: string;
  preset: PresetKey;
  activeAgents: AgentToggle[];
  githubEvents: EventToggle[];
  topology: TopologyChoice;
  consensus: ConsensusChoice;
  swarmStrategy: StrategyChoice;
  maxAgents: number;
}

export type PresetKey = 'minimal' | 'standard' | 'full-sparc' | 'custom';
export type TopologyChoice = 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'ring' | 'star' | 'adaptive';
export type ConsensusChoice = 'raft' | 'pbft' | 'none';
export type StrategyChoice = 'specialized' | 'balanced' | 'minimal';

export interface AgentToggle {
  type: string;
  enabled: boolean;
}

export interface EventToggle {
  id: string;          // e.g. "push:default_branch" or "pull_request:opened"
  label: string;       // human-readable display
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Terminal IO abstraction (testability seam)
// ---------------------------------------------------------------------------

export interface KeyPress {
  name: string;       // 'up', 'down', 'space', 'return', 'escape', or character
  ctrl: boolean;
  shift: boolean;
}

export interface TerminalIO {
  write(text: string): void;
  readKey(): Promise<KeyPress>;
  clearScreen(): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Prompt descriptors (pure data structures)
// ---------------------------------------------------------------------------

export interface SelectItem<T = string> {
  value: T;
  label: string;
  description?: string;
  selected: boolean;
}

export interface PromptDescriptor {
  type: 'single-select' | 'multi-select' | 'numeric';
  title: string;
  hint?: string;
  items?: SelectItem[];
  min?: number;
  max?: number;
  defaultValue?: number;
}
