/**
 * Agent Registry.
 *
 * Single source of truth for agent definitions in the system.
 * Reads from .claude/agents/ Markdown frontmatter and provides
 * typed lookup, filtering, and validation APIs.
 *
 * Cached after first scan. Call refresh() to re-read from disk.
 */

import { resolve, basename } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { scanAgentDirectory, type AgentDefinition } from './directory-scanner';
import { parseFrontmatter } from './frontmatter-parser';

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

  /** Look up a single agent by relative file path (resolved against project root) */
  getByPath(relativePath: string): AgentDefinition | undefined;

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

    getByPath(relativePath: string): AgentDefinition | undefined {
      const absPath = resolve(process.cwd(), relativePath);
      if (!existsSync(absPath)) {
        logger?.warn('Agent file not found', { path: absPath });
        return undefined;
      }

      try {
        const content = readFileSync(absPath, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        if (!frontmatter) {
          logger?.warn('Agent file has no frontmatter', { path: absPath });
          return undefined;
        }

        // Derive category from path structure (e.g., .claude/agents/core/coder.md → "core")
        const parts = relativePath.split('/');
        const agentsDirIdx = parts.indexOf('agents');
        const category = agentsDirIdx >= 0 && agentsDirIdx + 1 < parts.length - 1
          ? parts[agentsDirIdx + 1]
          : 'uncategorized';

        // Extract markdown body (everything after frontmatter closing ---)
        const bodyMatch = content.match(/^---[\s\S]*?---\s*\n([\s\S]*)$/);
        const body = bodyMatch?.[1]?.trim() ?? '';

        return {
          name: frontmatter.name ?? basename(absPath, '.md'),
          type: frontmatter.type ?? 'generic',
          description: frontmatter.description ?? '',
          capabilities: frontmatter.capabilities,
          color: frontmatter.color ?? '#888888',
          category,
          filePath: absPath,
          version: frontmatter.version ?? '1.0.0',
          body,
        };
      } catch (err) {
        logger?.warn('Failed to read agent file', {
          path: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
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
