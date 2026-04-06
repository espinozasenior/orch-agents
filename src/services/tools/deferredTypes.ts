/**
 * Phase 9G -- Deferred Tool Loading: type definitions.
 */

import type { ToolDefinition, ToolResult } from './types';

// ---------------------------------------------------------------------------
// Extended tool definition with deferred-loading metadata
// ---------------------------------------------------------------------------

export interface DeferredToolDefinition extends ToolDefinition {
  /** Description shown before schema is loaded. */
  description: string;
  /** When true, full parameter schema is not loaded until first use. */
  shouldDefer: boolean;
  /** Whether the tool can safely run in parallel with others. */
  concurrencySafe: boolean;
  /** How the tool behaves on user interrupt. */
  interruptBehavior: 'cancel' | 'wait' | 'ignore';
  /** When true, results >1 MB are spilled to disk. */
  persistResultToDisk: boolean;
  /** JSONSchema for parameters -- null when deferred and unresolved. */
  parameters?: Record<string, unknown> | null;
  /** Timestamp of first resolution (set by registry). */
  resolvedAt?: number;
}

// ---------------------------------------------------------------------------
// Search query
// ---------------------------------------------------------------------------

export interface ToolSearchQuery {
  mode: 'select' | 'keyword' | 'required';
  /** For 'select' mode: comma-separated tool names. */
  names?: string[];
  /** For 'keyword' mode: search terms. */
  keywords?: string[];
  /** For 'required' mode: the required keyword that must appear in the name. */
  requiredKeyword?: string;
  /** Maximum results to return (default 5). */
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// Registry metrics
// ---------------------------------------------------------------------------

export interface ToolRegistryMetrics {
  deferredCount: number;
  eagerCount: number;
  resolvedCount: number;
  memorySavedEstimate: number; // bytes
}

// ---------------------------------------------------------------------------
// Spilled result reference
// ---------------------------------------------------------------------------

export interface SpilledResult {
  type: 'disk_ref';
  path: string;
  size: number;
}

// ---------------------------------------------------------------------------
// Re-export ToolResult for convenience
// ---------------------------------------------------------------------------

export type { ToolResult };
