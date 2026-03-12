/**
 * MCP Client adapter for claude-flow tool calls.
 *
 * This is the ONLY module that directly interacts with claude-flow MCP tools,
 * making all other execution components testable via mock injection.
 *
 * Two implementations:
 * - createMcpClient() — real implementation calling MCP tools
 * - For tests, inject a mock implementing the McpClient interface
 */

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
// McpClient interface
// ---------------------------------------------------------------------------

export interface McpClient {
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
// Real implementation (calls claude-flow MCP tools)
// ---------------------------------------------------------------------------

/**
 * Create a real MCP client that delegates to claude-flow MCP tools.
 *
 * In production, this calls the actual MCP tools via the claude-flow daemon.
 * The implementation uses dynamic tool invocation to avoid compile-time
 * coupling to the MCP tool definitions.
 */
export function createMcpClient(): McpClient {
  // The real implementation will call MCP tools via the daemon.
  // For now, this provides the concrete factory that pipeline.ts uses.
  // Each method maps 1:1 to a claude-flow MCP tool.

  return {
    async swarmInit(opts) {
      const result = await callMcpTool('swarm_init', {
        topology: opts.topology,
        'max-agents': opts.maxAgents,
        strategy: opts.strategy,
        consensus: opts.consensus ?? 'raft',
      });
      return { swarmId: result.swarmId ?? result.id ?? 'swarm-' + Date.now() };
    },

    async swarmShutdown(swarmId) {
      await callMcpTool('swarm_shutdown', { swarmId });
    },

    async agentSpawn(opts) {
      const result = await callMcpTool('agent_spawn', {
        type: opts.type,
        name: opts.name,
        swarmId: opts.swarmId,
      });
      return { agentId: result.agentId ?? result.id ?? 'agent-' + Date.now() };
    },

    async agentStatus(agentId) {
      const result = await callMcpTool('agent_status', { agentId });
      return {
        agentId,
        status: result.status ?? 'failed',
        output: result.output,
        error: result.error,
      };
    },

    async agentTerminate(agentId) {
      await callMcpTool('agent_terminate', { agentId });
    },

    async taskCreate(opts) {
      const result = await callMcpTool('task_create', {
        description: opts.description,
        metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
      });
      return { taskId: result.taskId ?? result.id ?? 'task-' + Date.now() };
    },

    async taskAssign(taskId, agentId) {
      await callMcpTool('task_assign', { taskId, agentId });
    },

    async taskStatus(taskId) {
      const result = await callMcpTool('task_status', { taskId });
      return {
        taskId,
        status: result.status ?? 'failed',
        output: result.output,
      };
    },

    async taskComplete(taskId) {
      await callMcpTool('task_complete', { taskId });
    },

    async memoryStore(key, value, opts) {
      await callMcpTool('memory_store', {
        key,
        value,
        namespace: opts?.namespace,
        ttl: opts?.ttl,
        tags: opts?.tags?.join(','),
      });
    },

    async memorySearch(query, opts) {
      const result = await callMcpTool('memory_search', {
        query,
        namespace: opts?.namespace,
        limit: opts?.limit,
        threshold: opts?.threshold,
      });
      return (result.results ?? []) as MemoryResult[];
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helper: call a claude-flow MCP tool
// ---------------------------------------------------------------------------

/**
 * Call a claude-flow MCP tool by name.
 * Wraps the tool invocation with error handling.
 */
async function callMcpTool(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  try {
    // Dynamic import of the claude-flow CLI to invoke MCP tools
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const args = ['mcp-call', `claude-flow__${toolName}`];
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        args.push(`--${key}`, String(value));
      }
    }

    const { stdout } = await exec('npx', ['@claude-flow/cli@latest', ...args], {
      timeout: 60000,
    });

    return JSON.parse(stdout.trim() || '{}');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP tool ${toolName} failed: ${message}`);
  }
}
