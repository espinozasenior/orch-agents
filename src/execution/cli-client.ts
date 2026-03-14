/**
 * CLI Client adapter for claude-flow CLI commands.
 *
 * This is the ONLY module that shells out to the claude-flow CLI binary,
 * making all other execution components testable via mock injection.
 *
 * Three entry points:
 * - createCliClient()           — real implementation calling claude-flow CLI
 * - createCliClientWithRunner() — testable version with injected CLI runner
 * - For tests, inject a mock implementing the CliClient interface
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

// ---------------------------------------------------------------------------
// Option types for MCP tool calls
// ---------------------------------------------------------------------------

export interface SwarmInitOpts {
  topology: string;
  maxAgents: number;
  strategy: string;
  consensus?: string;
}

export interface AgentSpawnOpts {
  type: string;
  name: string;
  swarmId?: string;
}

export interface AgentStatusResult {
  agentId: string;
  status: 'spawned' | 'running' | 'completed' | 'failed' | 'terminated';
  output?: string;
  error?: string;
}

export interface TaskCreateOpts {
  description: string;
  metadata?: Record<string, unknown>;
}

export interface TaskStatusResult {
  taskId: string;
  status: 'created' | 'assigned' | 'in-progress' | 'completed' | 'failed';
  output?: string;
}

export interface MemoryStoreOpts {
  namespace?: string;
  ttl?: number;
  tags?: string[];
}

export interface MemorySearchOpts {
  namespace?: string;
  limit?: number;
  threshold?: number;
}

export interface MemoryResult {
  key: string;
  value: string;
  score: number;
  namespace?: string;
}

// ---------------------------------------------------------------------------
// CliClient interface
// ---------------------------------------------------------------------------

export interface CliClient {
  // Swarm lifecycle
  swarmInit(opts: SwarmInitOpts): Promise<{ swarmId: string }>;
  swarmShutdown(swarmId: string): Promise<void>;

  // Agent lifecycle
  agentSpawn(opts: AgentSpawnOpts): Promise<{ agentId: string }>;
  agentStatus(agentId: string): Promise<AgentStatusResult>;
  agentTerminate(agentId: string): Promise<void>;

  // Task lifecycle
  taskCreate(opts: TaskCreateOpts): Promise<{ taskId: string }>;
  taskAssign(taskId: string, agentId: string): Promise<void>;
  taskStatus(taskId: string): Promise<TaskStatusResult>;
  taskComplete(taskId: string): Promise<void>;

  // Memory / checkpoint storage
  memoryStore(key: string, value: string, opts?: MemoryStoreOpts): Promise<void>;
  memorySearch(query: string, opts?: MemorySearchOpts): Promise<MemoryResult[]>;
}

// ---------------------------------------------------------------------------
// Safe environment variable whitelist (QUALITY-10 fix)
// ---------------------------------------------------------------------------

/** Keys safe to pass to child processes. No secrets, tokens, or credentials. */
export const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
  'TMPDIR', 'TMP', 'TEMP',
  'EDITOR', 'VISUAL', 'PAGER',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'COLORTERM', 'TERM_PROGRAM', 'FORCE_COLOR',
  'CLAUDE_FLOW_V3_ENABLED', 'CLAUDE_FLOW_HOOKS_ENABLED',
  // npm/pnpm runtime
  'npm_config_prefix', 'npm_config_cache',
]);

/** Build a safe env object from a source (defaults to process.env). */
export function buildSafeEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) {
      safe[key] = source[key]!;
    }
  }
  safe.FORCE_COLOR = '0';
  return safe;
}

// ---------------------------------------------------------------------------
// Strategy normalization
// ---------------------------------------------------------------------------

const VALID_STRATEGIES = new Set([
  'specialized', 'balanced', 'adaptive', 'research',
  'development', 'testing', 'optimization', 'maintenance', 'analysis',
]);

export function normalizeStrategy(strategy: string): string {
  if (VALID_STRATEGIES.has(strategy)) return strategy;
  if (strategy === 'minimal') return 'specialized';
  return 'balanced';
}

// ---------------------------------------------------------------------------
// Output parsers (exported for testing)
// ---------------------------------------------------------------------------

export function parseTableValue(stdout: string, key: string): string | undefined {
  const regex = new RegExp(`\\|\\s*${escapeRegex(key)}\\s*\\|\\s*([^|]+)\\|`, 'i');
  const match = stdout.match(regex);
  return match?.[1]?.trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map raw CLI status to typed agent status. Defaults to 'spawned' for unknowns. */
export function mapAgentStatus(raw: string): AgentStatusResult['status'] {
  if (raw.includes('completed') || raw.includes('done')) return 'completed';
  if (raw.includes('running') || raw.includes('active') || raw.includes('busy')) return 'running';
  if (raw.includes('spawned') || raw.includes('idle') || raw.includes('ready') || raw.includes('waiting')) return 'spawned';
  if (raw.includes('terminated') || raw.includes('stopped')) return 'terminated';
  if (raw.includes('failed') || raw.includes('error')) return 'failed';
  // BUG-FIX: Unknown statuses default to 'spawned' (still pending), not 'completed'
  return 'spawned';
}

export function mapTaskStatus(raw: string): TaskStatusResult['status'] {
  if (raw.includes('completed') || raw.includes('done')) return 'completed';
  if (raw.includes('in-progress') || raw.includes('running')) return 'in-progress';
  if (raw.includes('assigned')) return 'assigned';
  if (raw.includes('created') || raw.includes('pending')) return 'created';
  return 'failed';
}

// ---------------------------------------------------------------------------
// CLI runner type (injectable for tests)
// ---------------------------------------------------------------------------

export type CliRunner = (args: string[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Client implementation (shared between real and test versions)
// ---------------------------------------------------------------------------

function buildClient(run: CliRunner): CliClient {
  return {
    async swarmInit(opts) {
      const args = [
        'swarm', 'init',
        '--topology', opts.topology,
        '--max-agents', String(opts.maxAgents),
        '--strategy', normalizeStrategy(opts.strategy),
      ];
      // BUG-04 FIX: Pass consensus flag when provided
      if (opts.consensus) {
        args.push('--consensus', opts.consensus);
      }
      const stdout = await run(args);
      const swarmId = parseTableValue(stdout, 'Swarm ID') ?? `swarm-${Date.now()}`;
      return { swarmId };
    },

    async swarmShutdown(swarmId) {
      try {
        // BUG-06 FIX: Use 'shutdown' not 'stop'
        await run(['swarm', 'shutdown', swarmId]);
      } catch {
        // Swarm may already be stopped or not exist; ignore
      }
    },

    async agentSpawn(opts) {
      const args = ['agent', 'spawn', '--type', opts.type, '--name', opts.name];
      const stdout = await run(args);
      const agentId = parseTableValue(stdout, 'Agent ID')
        ?? parseTableValue(stdout, 'ID')
        ?? `agent-${Date.now()}`;
      return { agentId };
    },

    async agentStatus(agentId) {
      const stdout = await run(['agent', 'status', agentId]);
      const status = parseTableValue(stdout, 'Status')?.toLowerCase() ?? 'failed';
      const mapped = mapAgentStatus(status);
      return { agentId, status: mapped, output: stdout };
    },

    async agentTerminate(agentId) {
      // BUG-01 FIX: Use 'terminate' not 'stop'
      await run(['agent', 'terminate', agentId]);
    },

    async taskCreate(opts) {
      const stdout = await run([
        'task', 'create',
        '--type', 'implementation',
        '--description', opts.description,
      ]);
      const taskId = parseTableValue(stdout, 'Task ID')
        ?? parseTableValue(stdout, 'ID')
        ?? `task-${Date.now()}`;
      return { taskId };
    },

    async taskAssign(taskId, agentId) {
      await run(['task', 'assign', taskId, '--agent', agentId]);
    },

    async taskStatus(taskId) {
      try {
        const stdout = await run(['task', 'status', taskId]);
        const status = parseTableValue(stdout, 'Status')?.toLowerCase() ?? 'completed';
        const mapped = mapTaskStatus(status);
        return { taskId, status: mapped, output: stdout };
      } catch (err) {
        // BUG-07 FIX: Return 'failed' on error, not 'completed'
        const message = err instanceof Error ? err.message : String(err);
        return { taskId, status: 'failed' as const, output: message };
      }
    },

    async taskComplete(taskId) {
      // BUG-02 FIX: Use 'task complete', not read-only 'task status'
      await run(['task', 'complete', taskId]);
    },

    async memoryStore(key, value, opts) {
      const args = ['memory', 'store', '--key', key, '--value', value];
      if (opts?.namespace) args.push('--namespace', opts.namespace);
      if (opts?.ttl) args.push('--ttl', String(opts.ttl));
      if (opts?.tags?.length) args.push('--tags', opts.tags.join(','));
      await run(args);
    },

    async memorySearch(query, opts) {
      const args = ['memory', 'search', '--query', query];
      if (opts?.namespace) args.push('--namespace', opts.namespace);
      if (opts?.limit) args.push('--limit', String(opts.limit));
      const stdout = await run(args);

      // BUG-03 FIX: Parse results from CLI output
      return parseMemorySearchResults(stdout);
    },
  };
}

// ---------------------------------------------------------------------------
// Memory search result parser (BUG-03 fix)
// ---------------------------------------------------------------------------

function parseMemorySearchResults(stdout: string): MemoryResult[] {
  // Try JSON parse first (structured output)
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results.map((r: Record<string, unknown>) => ({
        key: String(r.key ?? ''),
        value: String(r.value ?? ''),
        score: Number(r.score ?? 0),
        namespace: r.namespace ? String(r.namespace) : undefined,
      }));
    }
    if (Array.isArray(parsed)) {
      return parsed.map((r: Record<string, unknown>) => ({
        key: String(r.key ?? ''),
        value: String(r.value ?? ''),
        score: Number(r.score ?? 0),
        namespace: r.namespace ? String(r.namespace) : undefined,
      }));
    }
  } catch {
    // Not JSON — try table parsing below
  }

  // Try table parsing: | Key | Value | Score | Namespace |
  const results: MemoryResult[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 3 && !cells[0].includes('Key') && !cells[0].includes('---')) {
      const score = parseFloat(cells[2]);
      if (!isNaN(score)) {
        results.push({
          key: cells[0],
          value: cells[1],
          score,
          namespace: cells[3] || undefined,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

/**
 * Create a testable CliClient with an injected runner function.
 * Used in tests to avoid real CLI calls.
 */
export function createCliClientWithRunner(runner: CliRunner): CliClient {
  return buildClient(runner);
}

/**
 * Create a real CliClient that shells out to the claude-flow CLI.
 * Uses the locally-installed binary when available, falling back to npx.
 */
export function createCliClient(): CliClient {
  return buildClient(runCli);
}

// ---------------------------------------------------------------------------
// Real CLI runner
// ---------------------------------------------------------------------------

/** Resolve the CLI binary path. Prefers local install over npx. */
function resolveCliBin(): { bin: string; prefix: string[] } {
  // DESIGN-01 FIX: Use claude-flow directly (installed globally via pnpm)
  // This avoids the 2-5s npx startup penalty per call
  return { bin: 'claude-flow', prefix: [] };
}

const { bin: CLI_BIN, prefix: CLI_PREFIX } = resolveCliBin();

async function runCli(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      CLI_BIN,
      [...CLI_PREFIX, ...args],
      {
        timeout: 60000,
        env: buildSafeEnv(),
      },
    );
    if (stderr && stderr.includes('[ERROR]')) {
      throw new Error(stderr.trim());
    }
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`claude-flow ${args.slice(0, 2).join(' ')} failed: ${message}`);
  }
}
