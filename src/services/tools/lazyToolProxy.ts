/**
 * Phase 9G -- LazyToolProxy: wraps a DeferredToolDefinition,
 * delays schema resolution until first execution.
 */

import type { ToolDefinition, ToolResult } from './types';
import type { DeferredToolDefinition } from './deferredTypes';
import type { DeferredToolRegistry } from './deferredToolRegistry';

export class LazyToolProxy implements ToolDefinition {
  readonly name: string;
  private readonly registry: DeferredToolRegistry;
  private _resolved: ToolDefinition | undefined;

  constructor(def: DeferredToolDefinition, registry: DeferredToolRegistry) {
    this.name = def.name;
    this.registry = registry;
  }

  /**
   * Whether the underlying tool schema has been resolved.
   */
  isResolved(): boolean {
    return this._resolved !== undefined;
  }

  /**
   * Concurrency safety check -- delegates to the underlying definition.
   * Before resolution, returns the deferred definition's default.
   */
  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    const def = this.registry.get(this.name);
    return def?.concurrencySafe ?? true;
  }

  /**
   * Execute the tool. On first invocation, resolves the full schema
   * from the registry, caches it, then delegates execution.
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this._resolved) {
      this._resolved = this.registry.resolve(this.name);
    }
    return this._resolved.execute(input);
  }
}
