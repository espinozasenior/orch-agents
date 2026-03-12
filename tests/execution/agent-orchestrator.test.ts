/**
 * TDD: Tests for AgentOrchestrator — spawns, monitors, and terminates agents.
 *
 * London School: McpClient is fully mocked so we test only orchestration
 * logic (exponential backoff, timeout, error propagation).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PlannedPhase, PlannedAgent, Artifact } from '../../src/types';
import type { McpClient, AgentSpawnOpts, AgentStatusResult } from '../../src/execution/mcp-client';
import type { Logger } from '../../src/shared/logger';
import { AgentSpawnError, AgentTimeoutError } from '../../src/shared/errors';
import {
  type AgentOrchestrator,
  type AgentOrchestratorDeps,
  type SpawnedAgent,
  type AgentOutcome,
  createAgentOrchestrator,
} from '../../src/execution/agent-orchestrator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op logger for tests. */
function createSilentLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createSilentLogger(),
  };
}

/** Counter to produce unique agent IDs across calls. */
let agentCounter = 0;

function makePhase(overrides: Partial<PlannedPhase> = {}): PlannedPhase {
  return {
    type: 'refinement',
    agents: ['coder', 'tester'],
    gate: 'tests-pass',
    skippable: false,
    ...overrides,
  };
}

function makeTeam(): PlannedAgent[] {
  return [
    { role: 'coder', type: 'coder', tier: 3, required: true },
    { role: 'tester', type: 'tester', tier: 2, required: true },
    { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
  ];
}

interface MockMcpClientOptions {
  spawnFn?: (opts: AgentSpawnOpts) => Promise<{ agentId: string }>;
  statusFn?: (agentId: string) => Promise<AgentStatusResult>;
  terminateFn?: (agentId: string) => Promise<void>;
}

function createMockMcpClient(options: MockMcpClientOptions = {}): McpClient {
  return {
    swarmInit: async () => ({ swarmId: 'swarm-1' }),
    swarmShutdown: async () => {},
    agentSpawn: options.spawnFn ?? (async () => ({ agentId: `agent-${++agentCounter}` })),
    agentStatus: options.statusFn ?? (async (id) => ({
      agentId: id,
      status: 'completed' as const,
    })),
    agentTerminate: options.terminateFn ?? (async () => {}),
    taskCreate: async () => ({ taskId: 'task-1' }),
    taskAssign: async () => {},
    taskStatus: async () => ({ taskId: 'task-1', status: 'completed' as const }),
    taskComplete: async () => {},
    memoryStore: async () => {},
    memorySearch: async () => [],
  };
}

function makeDeps(mcpClient: McpClient, overrides: Partial<AgentOrchestratorDeps> = {}): AgentOrchestratorDeps {
  return {
    logger: createSilentLogger(),
    mcpClient,
    pollIntervalMs: 1,       // fast tests
    backoffMultiplier: 1.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: spawnAgents
// ---------------------------------------------------------------------------

describe('AgentOrchestrator', () => {
  beforeEach(() => {
    agentCounter = 0;
  });

  describe('spawnAgents()', () => {
    it('calls mcpClient.agentSpawn for each agent role in phase.agents', async () => {
      const spawnedNames: string[] = [];
      const mockClient = createMockMcpClient({
        spawnFn: async (opts) => {
          spawnedNames.push(opts.name);
          return { agentId: `agent-${++agentCounter}` };
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const phase = makePhase({ agents: ['coder', 'tester'] });

      await orch.spawnAgents('swarm-1', phase, makeTeam());

      assert.equal(spawnedNames.length, 2);
      assert.ok(spawnedNames.some(n => n.includes('coder')));
      assert.ok(spawnedNames.some(n => n.includes('tester')));
    });

    it('resolves agent roles from the team to get type and tier', async () => {
      const spawnedTypes: string[] = [];
      const mockClient = createMockMcpClient({
        spawnFn: async (opts) => {
          spawnedTypes.push(opts.type);
          return { agentId: `agent-${++agentCounter}` };
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const phase = makePhase({ agents: ['coder'] });

      const spawned = await orch.spawnAgents('swarm-1', phase, makeTeam());

      assert.equal(spawnedTypes.length, 1);
      assert.equal(spawnedTypes[0], 'coder');
      assert.equal(spawned[0].tier, 3);
      assert.equal(spawned[0].role, 'coder');
    });

    it('returns SpawnedAgent[] with correct fields', async () => {
      const mockClient = createMockMcpClient();
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const phase = makePhase({ agents: ['coder', 'tester'] });

      const spawned = await orch.spawnAgents('swarm-1', phase, makeTeam());

      assert.equal(spawned.length, 2);
      for (const agent of spawned) {
        assert.ok(agent.agentId, 'should have agentId');
        assert.ok(agent.role, 'should have role');
        assert.ok(agent.type, 'should have type');
        assert.ok(typeof agent.tier === 'number', 'should have tier');
        assert.equal(agent.status, 'spawned');
      }
    });

    it('throws AgentSpawnError when mcpClient.agentSpawn fails', async () => {
      const mockClient = createMockMcpClient({
        spawnFn: async () => {
          throw new Error('daemon unreachable');
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const phase = makePhase({ agents: ['coder'] });

      await assert.rejects(
        () => orch.spawnAgents('swarm-1', phase, makeTeam()),
        (err: unknown) => {
          assert.ok(err instanceof AgentSpawnError);
          assert.ok(err.message.includes('coder'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: waitForAgents
  // ---------------------------------------------------------------------------

  describe('waitForAgents()', () => {
    it('polls agentStatus until all agents report completed', async () => {
      let pollCount = 0;
      const mockClient = createMockMcpClient({
        statusFn: async (agentId) => {
          pollCount++;
          // Complete on second poll round
          if (pollCount >= 2) {
            return { agentId, status: 'completed' as const, output: 'done' };
          }
          return { agentId, status: 'running' as const };
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const agents: SpawnedAgent[] = [
        { agentId: 'a-1', role: 'coder', type: 'coder', tier: 3, status: 'spawned' },
      ];

      const outcomes = await orch.waitForAgents(agents, 5000);

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].status, 'completed');
      assert.ok(pollCount >= 2, 'should have polled at least twice');
    });

    it('returns AgentOutcome[] with status and duration', async () => {
      const mockClient = createMockMcpClient({
        statusFn: async (agentId) => ({
          agentId,
          status: 'completed' as const,
          output: 'result data',
        }),
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const agents: SpawnedAgent[] = [
        { agentId: 'a-1', role: 'coder', type: 'coder', tier: 3, status: 'spawned' },
      ];

      const outcomes = await orch.waitForAgents(agents, 5000);

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].agentId, 'a-1');
      assert.equal(outcomes[0].role, 'coder');
      assert.equal(outcomes[0].status, 'completed');
      assert.ok(typeof outcomes[0].duration === 'number');
      assert.ok(outcomes[0].duration >= 0);
      assert.ok(Array.isArray(outcomes[0].artifacts));
    });

    it('terminates agents on timeout and throws AgentTimeoutError', async () => {
      const terminatedIds: string[] = [];
      const mockClient = createMockMcpClient({
        statusFn: async (agentId) => ({
          agentId,
          status: 'running' as const,
        }),
        terminateFn: async (agentId) => {
          terminatedIds.push(agentId);
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient, { pollIntervalMs: 1 }));
      const agents: SpawnedAgent[] = [
        { agentId: 'a-1', role: 'coder', type: 'coder', tier: 3, status: 'spawned' },
        { agentId: 'a-2', role: 'tester', type: 'tester', tier: 2, status: 'spawned' },
      ];

      await assert.rejects(
        () => orch.waitForAgents(agents, 50),
        (err: unknown) => {
          assert.ok(err instanceof AgentTimeoutError);
          return true;
        },
      );

      // Should have attempted to terminate running agents
      assert.ok(terminatedIds.length > 0, 'should terminate at least one agent');
    });

    it('handles mixed results (some complete, some fail)', async () => {
      const mockClient = createMockMcpClient({
        statusFn: async (agentId) => {
          if (agentId === 'a-1') {
            return { agentId, status: 'completed' as const, output: 'ok' };
          }
          return { agentId, status: 'failed' as const, error: 'segfault' };
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const agents: SpawnedAgent[] = [
        { agentId: 'a-1', role: 'coder', type: 'coder', tier: 3, status: 'spawned' },
        { agentId: 'a-2', role: 'tester', type: 'tester', tier: 2, status: 'spawned' },
      ];

      const outcomes = await orch.waitForAgents(agents, 5000);

      assert.equal(outcomes.length, 2);
      const completed = outcomes.find(o => o.agentId === 'a-1');
      const failed = outcomes.find(o => o.agentId === 'a-2');

      assert.ok(completed);
      assert.equal(completed!.status, 'completed');

      assert.ok(failed);
      assert.equal(failed!.status, 'failed');
      assert.equal(failed!.error, 'segfault');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: terminateAgents
  // ---------------------------------------------------------------------------

  describe('terminateAgents()', () => {
    it('calls mcpClient.agentTerminate for each agent', async () => {
      const terminatedIds: string[] = [];
      const mockClient = createMockMcpClient({
        terminateFn: async (agentId) => {
          terminatedIds.push(agentId);
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const agents: SpawnedAgent[] = [
        { agentId: 'a-1', role: 'coder', type: 'coder', tier: 3, status: 'spawned' },
        { agentId: 'a-2', role: 'tester', type: 'tester', tier: 2, status: 'spawned' },
        { agentId: 'a-3', role: 'reviewer', type: 'reviewer', tier: 2, status: 'spawned' },
      ];

      await orch.terminateAgents(agents);

      assert.deepEqual(terminatedIds.sort(), ['a-1', 'a-2', 'a-3']);
    });

    it('does not throw when agentTerminate fails for one agent', async () => {
      let callCount = 0;
      const mockClient = createMockMcpClient({
        terminateFn: async (agentId) => {
          callCount++;
          if (agentId === 'a-2') {
            throw new Error('already terminated');
          }
        },
      });
      const orch = createAgentOrchestrator(makeDeps(mockClient));
      const agents: SpawnedAgent[] = [
        { agentId: 'a-1', role: 'coder', type: 'coder', tier: 3, status: 'spawned' },
        { agentId: 'a-2', role: 'tester', type: 'tester', tier: 2, status: 'spawned' },
        { agentId: 'a-3', role: 'reviewer', type: 'reviewer', tier: 2, status: 'spawned' },
      ];

      // Should not reject
      await orch.terminateAgents(agents);

      assert.equal(callCount, 3, 'should attempt all three terminations');
    });
  });
});
