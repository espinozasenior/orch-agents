/**
 * P12 — DeferredToolRegistry
 *
 * Eager tool registry that mirrors Claude Code's tool architecture
 * (src/tools.ts:193-250). Tools are instantiated and stored whole at
 * register time. Deferral is purely a *schema serialization* concern
 * surfaced at API send time and during system-prompt construction —
 * there is no runtime lazy proxy.
 *
 * See docs/sparc/P12-deferred-tool-loading-spec.md FR-P12-001.
 */

import type { ToolDefinition as P4ToolDefinition, ToolResult } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fully-formed tool descriptor stored in the registry. */
export interface DeferredToolDef {
  /** Stable identifier — also the API name. */
  readonly name: string;
  /** One-line description shown in the deferred-tool advertisement. */
  readonly description: string;
  /** JSONSchema for the tool's input. Stored even when shouldDefer=true. */
  readonly schema: Record<string, unknown>;
  /** Tool execution implementation. */
  readonly execute: (input: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * When true, the tool's full input_schema is *not* sent inline in the API
   * tool list — only its name + description are advertised in the system
   * prompt. The model must invoke ToolSearch to retrieve the descriptor
   * before calling the tool. Mirrors CC `prompt.ts:62-107`.
   */
  readonly shouldDefer: boolean;
  /**
   * When true, the tool is always serialized with its full input_schema
   * inline regardless of `shouldDefer`. Used for the core tool set and
   * for ToolSearch itself. Mirrors CC's `alwaysLoad` flag.
   */
  readonly alwaysLoad: boolean;
  /**
   * Per-tool concurrency classifier consumed by P4's partitioner.
   * Defaults to "unsafe" when omitted.
   */
  readonly isConcurrencySafe?: (input: Record<string, unknown>) => boolean;
}

/** Thrown when register() is called with an already-registered name. */
export class DuplicateToolError extends Error {
  constructor(name: string) {
    super(`Tool already registered: ${name}`);
    this.name = 'DuplicateToolError';
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class DeferredToolRegistry {
  private readonly tools = new Map<string, DeferredToolDef>();

  /** Register a tool. Throws DuplicateToolError if name is already taken. */
  register(def: DeferredToolDef): void {
    if (this.tools.has(def.name)) {
      throw new DuplicateToolError(def.name);
    }
    this.tools.set(def.name, def);
  }

  /** Lookup by name. */
  get(name: string): DeferredToolDef | undefined {
    return this.tools.get(name);
  }

  /** Returns all registered tools in registration order. */
  list(): DeferredToolDef[] {
    return Array.from(this.tools.values());
  }

  /** Returns only tools whose schema is deferred from the system prompt. */
  listDeferred(): DeferredToolDef[] {
    return this.list().filter((t) => t.shouldDefer && !t.alwaysLoad);
  }

  /** Returns only tools whose full schema is always-loaded inline. */
  listAlwaysLoad(): DeferredToolDef[] {
    return this.list().filter((t) => t.alwaysLoad);
  }

  /** Number of registered tools. */
  size(): number {
    return this.tools.size;
  }

  /**
   * Convert this registry to a P4-compatible Map<name, ToolDefinition> so
   * the existing partitioner / executor / queryLoopAdapter can consume it
   * without modification (FR-P12-006).
   */
  toP4Registry(): Map<string, P4ToolDefinition> {
    const map = new Map<string, P4ToolDefinition>();
    for (const t of this.tools.values()) {
      const isSafe = t.isConcurrencySafe ?? (() => false);
      map.set(t.name, {
        name: t.name,
        isConcurrencySafe: isSafe,
        execute: t.execute,
      });
    }
    return map;
  }
}
