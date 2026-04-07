/**
 * P12 — ToolSearch meta-tool
 *
 * Mirrors CC's `src/tools/ToolSearchTool/ToolSearchTool.ts`. Two query
 * forms:
 *
 *   - `select:Name[,Name2,...]` — direct selection by exact name
 *   - keyword search           — `+required` terms must appear in the name;
 *                                 bare terms are scored against name +
 *                                 description; results ranked descending
 *
 * MCP server prefix matching: a query containing `mcp__server__` filters
 * candidates whose names start with that prefix.
 *
 * The description cache is a process-local Map (FR-P12-005) — never
 * invalidated within a process lifetime, never an LRU.
 */

import type { DeferredToolRegistry, DeferredToolDef } from './registry.js';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ToolSearchMatch {
  readonly name: string;
  readonly description: string;
}

export interface ToolSearchResult {
  readonly matches: ToolSearchMatch[];
  readonly query: string;
  readonly total_deferred_tools: number;
}

export interface ToolSearchInput {
  readonly query: string;
  readonly max_results?: number;
}

// ---------------------------------------------------------------------------
// ToolSearch
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 10;

export class ToolSearch {
  private readonly descriptionCache = new Map<string, string>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(private readonly registry: DeferredToolRegistry) {}

  /**
   * Resolve a tool's description, hitting the cache when possible.
   * Returns undefined if the tool is not in the registry.
   */
  describe(name: string): string | undefined {
    const cached = this.descriptionCache.get(name);
    if (cached !== undefined) {
      this.cacheHits++;
      return cached;
    }
    const def = this.registry.get(name);
    if (!def) {
      return undefined;
    }
    this.cacheMisses++;
    this.descriptionCache.set(name, def.description);
    return def.description;
  }

  /** Cache statistics for tests. */
  getCacheStats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.descriptionCache.size,
    };
  }

  /** Main entry point — model invokes this with `{ query, max_results? }`. */
  search(input: ToolSearchInput): ToolSearchResult {
    const max = input.max_results ?? DEFAULT_MAX_RESULTS;
    const deferred = this.registry.listDeferred();
    const total = deferred.length;
    const query = input.query;

    if (query.startsWith('select:')) {
      return this.searchSelect(query, total);
    }

    return this.searchKeyword(query, deferred, max, total);
  }

  // -------------------------------------------------------------------------
  // select: form
  // -------------------------------------------------------------------------

  private searchSelect(query: string, total: number): ToolSearchResult {
    const names = query
      .slice('select:'.length)
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    const matches: ToolSearchMatch[] = [];
    for (const name of names) {
      const def = this.registry.get(name);
      if (!def) {
        continue;
      }
      const description = this.describe(name) ?? def.description;
      matches.push({ name: def.name, description });
    }

    return { matches, query, total_deferred_tools: total };
  }

  // -------------------------------------------------------------------------
  // keyword form
  // -------------------------------------------------------------------------

  private searchKeyword(
    query: string,
    deferred: DeferredToolDef[],
    max: number,
    total: number,
  ): ToolSearchResult {
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    const required: string[] = [];
    const optional: string[] = [];
    for (const token of tokens) {
      if (token.startsWith('+')) {
        const term = token.slice(1).toLowerCase();
        if (term.length > 0) {
          required.push(term);
        }
      } else {
        optional.push(token.toLowerCase());
      }
    }

    let candidates = deferred;

    // +required filtering — must appear in the *name*.
    for (const req of required) {
      candidates = candidates.filter((t) => t.name.toLowerCase().includes(req));
    }

    // MCP server prefix awareness — any optional token of the form
    // `mcp__server__` (with at least one trailing `__`) filters candidates
    // to that server's namespace.
    const mcpPrefix = optional.find(
      (t) => t.startsWith('mcp__') && t.split('__').length >= 3,
    );
    if (mcpPrefix) {
      candidates = candidates.filter((t) => t.name.toLowerCase().startsWith(mcpPrefix));
    }

    // Score candidates against the optional terms.
    const scored = candidates
      .map((tool) => ({ tool, score: this.scoreOptional(tool, optional) }))
      .filter((entry) => optional.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);

    const matches: ToolSearchMatch[] = scored.map((entry) => ({
      name: entry.tool.name,
      description: this.describe(entry.tool.name) ?? entry.tool.description,
    }));

    return { matches, query, total_deferred_tools: total };
  }

  private scoreOptional(tool: DeferredToolDef, optional: string[]): number {
    if (optional.length === 0) {
      return 1;
    }
    const name = tool.name.toLowerCase();
    const haystack = `${name} ${(tool.description ?? '').toLowerCase()}`;
    let score = 0;
    for (const term of optional) {
      if (name.includes(term)) {
        score += 2;
      } else if (haystack.includes(term)) {
        score += 1;
      }
    }
    return score;
  }
}
