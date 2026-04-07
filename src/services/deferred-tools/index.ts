/**
 * P12 — Deferred tool loading: public API barrel.
 *
 * See docs/sparc/P12-deferred-tool-loading-spec.md.
 */

export {
  DeferredToolRegistry,
  DuplicateToolError,
} from './registry.js';
export type { DeferredToolDef } from './registry.js';

export { ToolSearch } from './tool-search.js';
export type {
  ToolSearchInput,
  ToolSearchMatch,
  ToolSearchResult,
} from './tool-search.js';

export { buildPromptAdvertisement, PROMPT_BUDGET_BYTES } from './prompt-builder.js';

export { buildApiToolList } from './api-schema-filter.js';
export type { ApiToolEntry } from './api-schema-filter.js';

export { createDefaultDeferredToolRegistry } from './bootstrap.js';
