/**
 * Agent Registry.
 *
 * Single source of truth for agent definitions in the system.
 * Reads from .claude/agents/ Markdown frontmatter and provides
 * typed lookup, filtering, and validation APIs.
 *
 * Cached after first scan. Call refresh() to re-read from disk.
 */

import { resolve } from 'node:path';
import { scanAgentDirectory, type AgentDefinition } from './directory-scanner';

// ---------------------------------------------------------------------------
// Re-export AgentDefinition for consumers
// ---------------------------------------------------------------------------

export type { AgentDefinition } from './directory-scanner';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AgentRegistry {
  /** Get all registered agent definitions (sorted by name) */
  getAll(): AgentDefinition[];

  /** Get agent names only (sorted) */
  getNames(): string[];

  /** Look up a single agent by name */
  getByName(name: string): AgentDefinition | undefined;

  /** Filter agents by category (core, sparc, github, v3, etc.) */
  getByCategory(category: string): AgentDefinition[];

  /** Check if a name resolves to a known agent */
  has(name: string): boolean;

  /** Force re-scan from disk (invalidate cache) */
  refresh(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentRegistryOptions {
  /** Base directory to scan (defaults to .claude/agents relative to project root) */
  agentsDir?: string;
  /** Optional logger for warnings during scan */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

const DEFAULT_AGENTS_DIR = resolve(__dirname, '..', '..', '.claude', 'agents');

/**
 * Create an AgentRegistry instance.
 *
 * Scans lazily on first access and caches results.
 */
export function createAgentRegistry(options: AgentRegistryOptions = {}): AgentRegistry {
  const agentsDir = options.agentsDir ?? DEFAULT_AGENTS_DIR;
  const logger = options.logger;

  let _cache: AgentDefinition[] | undefined;
  let _nameIndex: Map<string, AgentDefinition> | undefined;

  function ensureLoaded(): void {
    if (!_cache) {
      _cache = scanAgentDirectory(agentsDir, logger);
      _nameIndex = new Map(_cache.map(a => [a.name, a]));
    }
  }

  return {
    getAll(): AgentDefinition[] {
      ensureLoaded();
      return _cache!;
    },

    getNames(): string[] {
      ensureLoaded();
      return _cache!.map(a => a.name);
    },

    getByName(name: string): AgentDefinition | undefined {
      ensureLoaded();
      return _nameIndex!.get(name);
    },

    getByCategory(category: string): AgentDefinition[] {
      ensureLoaded();
      return _cache!.filter(a => a.category === category);
    },

    has(name: string): boolean {
      ensureLoaded();
      return _nameIndex!.has(name);
    },

    refresh(): void {
      _cache = undefined;
      _nameIndex = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

let _defaultRegistry: AgentRegistry | undefined;

/**
 * Get the default singleton registry.
 * Uses the standard `.claude/agents` directory.
 */
export function getDefaultRegistry(): AgentRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = createAgentRegistry();
  }
  return _defaultRegistry;
}

/**
 * Reset the default singleton (for testing).
 */
export function resetDefaultRegistry(): void {
  _defaultRegistry = undefined;
}
