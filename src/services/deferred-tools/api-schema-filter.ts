/**
 * P12 — API schema filter.
 *
 * Serializes the registry into the per-tool list shape consumed by the
 * Anthropic API request, applying the `defer_loading` marker on tools
 * whose schema should be omitted from the inline tool list.
 *
 * Mirrors CC `src/utils/api.ts:223-226`.
 */

import type { DeferredToolRegistry } from './registry.js';

export interface ApiToolEntry {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown> | null;
  readonly defer_loading: boolean;
}

/**
 * Pure function — does not mutate the registry. Preserves registration
 * order so callers can reason about ToolSearch position deterministically.
 */
export function buildApiToolList(registry: DeferredToolRegistry): ApiToolEntry[] {
  return registry.list().map((t) => {
    const inline = t.alwaysLoad || !t.shouldDefer;
    return {
      name: t.name,
      description: t.description,
      input_schema: inline ? t.schema : null,
      defer_loading: t.shouldDefer && !t.alwaysLoad,
    };
  });
}
