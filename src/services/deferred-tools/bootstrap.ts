/**
 * P12 — Default registry bootstrap.
 *
 * Registers the SDK's built-in tools with `alwaysLoad: true` (Read, Edit,
 * Write, Bash, Grep, Glob, Agent) plus the ToolSearch meta-tool. This is
 * the registry passed to createSdkExecutor at app startup.
 *
 * Per-tool execute() bodies are intentionally no-ops here — the SDK's
 * `claude_code` preset owns actual execution. The registry exists to
 * surface the names + schemas to the executor's allowedTools list and to
 * support out-of-band ToolSearch meta-tool calls.
 */

import { DeferredToolRegistry, type DeferredToolDef } from './registry.js';

const NOOP_SCHEMA: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: true };

const NOOP_EXECUTE = async () => ({
  content: 'Tool execution is owned by the Claude Agent SDK preset',
  is_error: false,
});

const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);

function builtin(name: string, description: string): DeferredToolDef {
  return {
    name,
    description,
    schema: NOOP_SCHEMA,
    execute: NOOP_EXECUTE,
    shouldDefer: false,
    alwaysLoad: true,
    isConcurrencySafe: () => READ_ONLY.has(name),
  };
}

const TOOL_SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Either `select:Name[,Name2]` to fetch specific tool descriptors, or a keyword search (use `+term` to require a term in the tool name).',
    },
    max_results: { type: 'number', default: 10 },
  },
  required: ['query'],
};

/**
 * Build the default registry with the SDK's built-in tools registered as
 * alwaysLoad and the ToolSearch meta-tool present (also alwaysLoad).
 */
export function createDefaultDeferredToolRegistry(): DeferredToolRegistry {
  const registry = new DeferredToolRegistry();

  registry.register(builtin('Read', 'Read a file from the local filesystem'));
  registry.register(builtin('Edit', 'Apply an exact-match edit to a file'));
  registry.register(builtin('Write', 'Create or overwrite a file'));
  registry.register(builtin('Bash', 'Run a shell command'));
  registry.register(builtin('Grep', 'Search file contents with ripgrep'));
  registry.register(builtin('Glob', 'Find files by glob pattern'));
  registry.register(builtin('Agent', 'Spawn a sub-agent for a focused task'));

  registry.register({
    name: 'ToolSearch',
    description:
      'Discover deferred tools by name or keyword. Use `select:Name` for direct selection or a keyword query for ranked search.',
    schema: TOOL_SEARCH_SCHEMA,
    execute: NOOP_EXECUTE,
    shouldDefer: false,
    alwaysLoad: true,
    isConcurrencySafe: () => true,
  });

  return registry;
}
