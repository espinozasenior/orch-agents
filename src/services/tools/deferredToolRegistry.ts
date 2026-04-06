/**
 * Phase 9G -- DeferredToolRegistry: lazy schema resolution with caching.
 */

import type { ToolDefinition } from './types';
import type { DeferredToolDefinition, ToolRegistryMetrics } from './deferredTypes';

/** Average schema size in bytes for memory-saved estimate. */
const AVG_SCHEMA_BYTES = 3_500;

/**
 * Optional provider to fetch full schemas for deferred tools.
 * When not supplied, the registry returns the definition as-is on resolve
 * (useful when the caller populates `parameters` externally).
 */
export interface ToolSchemaProvider {
  fetchSchema(name: string): Promise<Record<string, unknown>>;
}

export class DeferredToolRegistry {
  private readonly tools = new Map<string, DeferredToolDefinition>();
  private readonly resolved = new Set<string>();
  private readonly resolving = new Map<string, Promise<ToolDefinition>>();
  private readonly schemaProvider?: ToolSchemaProvider;

  constructor(schemaProvider?: ToolSchemaProvider) {
    this.schemaProvider = schemaProvider;
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  register(name: string, def: DeferredToolDefinition): void {
    if (def.shouldDefer) {
      // Strip parameters for deferred tools
      this.tools.set(name, { ...def, parameters: null });
    } else {
      this.tools.set(name, { ...def });
      this.resolved.add(name);
    }
  }

  // -----------------------------------------------------------------------
  // Resolution
  // -----------------------------------------------------------------------

  resolve(name: string): ToolDefinition {
    const def = this.tools.get(name);
    if (!def) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (!this.resolved.has(name)) {
      // Synchronous resolve: if a schema provider could supply it async,
      // callers should use resolveAsync. For synchronous resolve we mark
      // as resolved and return the definition with whatever parameters exist.
      if (this.schemaProvider) {
        // Cannot do async here -- callers needing async should use resolveAsync
        throw new Error(`Tool '${name}' is deferred and requires async resolution. Use resolveAsync().`);
      }
      def.resolvedAt = Date.now();
      this.resolved.add(name);
    }

    return def;
  }

  async resolveAsync(name: string): Promise<ToolDefinition> {
    const def = this.tools.get(name);
    if (!def) {
      throw new Error(`Unknown tool: ${name}`);
    }

    if (this.resolved.has(name)) {
      return def;
    }

    // Dedup concurrent resolutions
    const inflight = this.resolving.get(name);
    if (inflight) {
      return inflight;
    }

    const promise = (async () => {
      if (this.schemaProvider) {
        def.parameters = await this.schemaProvider.fetchSchema(name);
      }
      def.resolvedAt = Date.now();
      this.resolved.add(name);
      this.resolving.delete(name);
      return def as ToolDefinition;
    })();

    this.resolving.set(name, promise);
    return promise;
  }

  resolveMany(names: string[]): ToolDefinition[] {
    return names.map((n) => this.resolve(n));
  }

  async resolveManyAsync(names: string[]): Promise<ToolDefinition[]> {
    return Promise.all(names.map((n) => this.resolveAsync(n)));
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  shouldDefer(name: string): boolean {
    const def = this.tools.get(name);
    if (!def) return false;
    return def.shouldDefer && !this.resolved.has(name);
  }

  listDeferred(): string[] {
    return Array.from(this.tools.entries())
      .filter(([name, def]) => def.shouldDefer && !this.resolved.has(name))
      .map(([name]) => name);
  }

  get(name: string): DeferredToolDefinition | undefined {
    return this.tools.get(name);
  }

  listAll(): DeferredToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  getMetrics(): ToolRegistryMetrics {
    let deferredCount = 0;
    let eagerCount = 0;

    for (const [name, def] of this.tools) {
      if (def.shouldDefer && !this.resolved.has(name)) {
        deferredCount++;
      } else {
        eagerCount++;
      }
    }

    return {
      deferredCount,
      eagerCount,
      resolvedCount: this.resolved.size,
      memorySavedEstimate: deferredCount * AVG_SCHEMA_BYTES,
    };
  }
}
