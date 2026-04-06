/**
 * Phase 9G -- ToolSearchIndex: three-mode search over tool definitions.
 *
 * Modes:
 *   - select:  exact name match for comma-separated names
 *   - keyword: tokenize query, score against name+description, rank
 *   - required: require keyword in name, rank by remaining terms
 */

import type { DeferredToolDefinition, ToolSearchQuery } from './deferredTypes';

export class ToolSearchIndex {
  private readonly tools: DeferredToolDefinition[] = [];

  add(def: DeferredToolDefinition): void {
    this.tools.push(def);
  }

  // -----------------------------------------------------------------------
  // Query parsing
  // -----------------------------------------------------------------------

  parseQuery(raw: string, maxResults = 5): ToolSearchQuery {
    if (raw.startsWith('select:')) {
      const names = raw.slice(7).split(',').map((n) => n.trim()).filter(Boolean);
      return { mode: 'select', names, maxResults };
    }
    if (raw.startsWith('+')) {
      const parts = raw.slice(1).split(/\s+/).filter(Boolean);
      return {
        mode: 'required',
        requiredKeyword: parts[0],
        keywords: parts.slice(1),
        maxResults,
      };
    }
    return {
      mode: 'keyword',
      keywords: raw.split(/\s+/).filter(Boolean),
      maxResults,
    };
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  search(query: ToolSearchQuery): DeferredToolDefinition[] {
    switch (query.mode) {
      case 'select':
        return this.selectMode(query.names ?? []);

      case 'keyword':
        return this.keywordMode(query.keywords ?? [], query.maxResults ?? 5);

      case 'required':
        return this.requiredMode(
          query.requiredKeyword ?? '',
          query.keywords ?? [],
          query.maxResults ?? 5,
        );

      default:
        return [];
    }
  }

  // -----------------------------------------------------------------------
  // Mode implementations
  // -----------------------------------------------------------------------

  private selectMode(names: string[]): DeferredToolDefinition[] {
    const lower = new Set(names.map((n) => n.toLowerCase()));
    return this.tools.filter((t) => lower.has(t.name.toLowerCase()));
  }

  private keywordMode(keywords: string[], max: number): DeferredToolDefinition[] {
    if (keywords.length === 0) return this.tools.slice(0, max);

    const scored = this.tools.map((t) => ({
      tool: t,
      score: this.relevanceScore(`${t.name} ${t.description ?? ''}`, keywords),
    }));

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.tool);
  }

  private requiredMode(
    required: string,
    remaining: string[],
    max: number,
  ): DeferredToolDefinition[] {
    const reqLower = required.toLowerCase();
    const filtered = this.tools.filter(
      (t) => t.name.toLowerCase().includes(reqLower),
    );

    if (remaining.length === 0) return filtered.slice(0, max);

    const scored = filtered.map((t) => ({
      tool: t,
      score: this.relevanceScore(`${t.name} ${t.description ?? ''}`, remaining),
    }));

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => s.tool);
  }

  // -----------------------------------------------------------------------
  // Scoring
  // -----------------------------------------------------------------------

  private relevanceScore(text: string, keywords: string[]): number {
    const lower = text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (lower.includes(kwLower)) {
        // Name matches weighted 2x vs description
        score += 1;
      }
    }
    return score;
  }
}
