/**
 * P4 — Default concurrency classification for known tool names.
 *
 * Read-only tools are safe for concurrent execution.
 * Write / side-effect tools must run serially.
 */

export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'ListMcpResources',
  'ReadMcpResource',
  'TaskList',
  'TaskGet',
  'TaskOutput',
]);

export const WRITE_TOOLS = new Set([
  'Edit',
  'Write',
  'Bash',
  'Agent',
  'SendMessage',
  'NotebookEdit',
  'TaskCreate',
  'TaskUpdate',
  'TaskStop',
]);

export const DEFAULT_MAX_CONCURRENCY = 10;

/**
 * Returns a Map<toolName, isConcurrencySafe> covering the built-in tool set.
 */
export function getDefaultConcurrencyClassifier(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const name of READ_ONLY_TOOLS) {
    map.set(name, true);
  }
  for (const name of WRITE_TOOLS) {
    map.set(name, false);
  }
  return map;
}
