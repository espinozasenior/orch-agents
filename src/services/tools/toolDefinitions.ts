/**
 * P4 — Tool Definition Registry
 *
 * Creates a registry of ToolDefinition entries for all known tools.
 * Each entry declares its concurrency safety (from concurrencyClassifier)
 * and delegates execution to an injected ToolExecutionDelegate.
 *
 * The delegate pattern decouples registry creation from actual tool
 * implementations, allowing the query loop to inject its own execution
 * logic while still benefiting from P4's partitioning and concurrency.
 */

import { READ_ONLY_TOOLS, WRITE_TOOLS } from './concurrencyClassifier.js';
import type { ToolDefinition, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Delegate type
// ---------------------------------------------------------------------------

/**
 * Function that actually executes a tool by name.
 * Injected by the caller (e.g., query loop adapter) to bridge
 * P4's orchestration with the real tool implementations.
 */
export type ToolExecutionDelegate = (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Known tool names
// ---------------------------------------------------------------------------

/** All known tool names from both read-only and write sets. */
function getAllKnownToolNames(): string[] {
  const names: string[] = [];
  for (const name of READ_ONLY_TOOLS) {
    names.push(name);
  }
  for (const name of WRITE_TOOLS) {
    names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

/**
 * Creates a tool registry with the given execution delegate.
 *
 * Each tool's isConcurrencySafe is determined by membership in
 * READ_ONLY_TOOLS (safe) vs WRITE_TOOLS (unsafe). Unknown tools
 * added later default to unsafe.
 *
 * @param delegate - Function that executes tools by name
 * @returns Map of tool name to ToolDefinition
 */
export function createToolRegistry(
  delegate: ToolExecutionDelegate,
): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();

  for (const name of getAllKnownToolNames()) {
    const isSafe = READ_ONLY_TOOLS.has(name);
    registry.set(name, {
      name,
      isConcurrencySafe: () => isSafe,
      execute: (input) => delegate(name, input),
    });
  }

  return registry;
}

/**
 * Creates a default tool registry using READ_ONLY_TOOLS and WRITE_TOOLS.
 *
 * The returned registry has no-op execute() implementations that return
 * an error. Use createToolRegistry(delegate) for real execution.
 *
 * This is useful for testing partitioning/classification without
 * needing real tool implementations.
 */
export function createDefaultToolRegistry(): Map<string, ToolDefinition> {
  return createToolRegistry(async (name) => ({
    content: `No delegate configured for tool: ${name}`,
    is_error: true,
  }));
}

/**
 * Registers an additional tool in the registry.
 *
 * Use this to add MCP tools or custom tools that are not in the
 * built-in READ_ONLY_TOOLS / WRITE_TOOLS sets.
 *
 * @param registry - Existing tool registry to extend
 * @param name - Tool name
 * @param isConcurrencySafe - Whether the tool can run concurrently
 * @param delegate - Execution delegate for this tool
 */
export function registerTool(
  registry: Map<string, ToolDefinition>,
  name: string,
  isConcurrencySafe: boolean,
  delegate: ToolExecutionDelegate,
): void {
  registry.set(name, {
    name,
    isConcurrencySafe: () => isConcurrencySafe,
    execute: (input) => delegate(name, input),
  });
}
