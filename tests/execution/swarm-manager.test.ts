/**
 * TDD: Tests for SwarmManager — initializes and shuts down claude-flow swarms.
 *
 * London School: CliClient and Logger are fully mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowPlan } from '../../src/types';
import type { CliClient, SwarmInitOpts } from '../../src/execution/cli-client';
import type { Logger, LogContext } from '../../src/shared/logger';
import {
  type SwarmHandle,
  type SwarmManager,
  type SwarmManagerDeps,
  createSwarmManager,
} from '../../src/execution/swarm-manager';
import { SwarmError } from '../../src/shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-001',
    workItemId: 'work-001',
    methodology: 'sparc-partial',
    template: 'github-ops',
    topology: 'hierarchical',
    swarmStrategy: 'specialized',
    consensus: 'raft',
    maxAgents: 6,
    phases: [
      { type: 'specification', agents: ['architect'], gate: 'spec-approved', skippable: true },
      { type: 'refinement', agents: ['coder', 'tester'], gate: 'tests-pass', skippable: false },
    ],
    agentTeam: [
      { role: 'lead', type: 'architect', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
    ],
    estimatedDuration: 15,
    estimatedCost: 0.02,
    ...overrides,
  };
}

/** Stub logger that records nothing. */
function stubLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => stubLogger(),
  };
}

/** Create a mock CliClient with spies for swarm methods. */
function mockCliClient(overrides: Partial<CliClient> = {}): CliClient & {
  swarmInitCalls: SwarmInitOpts[];
  swarmShutdownCalls: string[];
} {
  const swarmInitCalls: SwarmInitOpts[] = [];
  const swarmShutdownCalls: string[] = [];

  const noopAsync = async () => ({} as never);

  return {
    swarmInitCalls,
    swarmShutdownCalls,

    async swarmInit(opts: SwarmInitOpts) {
      swarmInitCalls.push(opts);
      return { swarmId: 'swarm-abc-123' };
    },
    async swarmShutdown(swarmId: string) {
      swarmShutdownCalls.push(swarmId);
    },

    agentSpawn: noopAsync,
    agentStatus: noopAsync,
    agentTerminate: noopAsync,
    taskCreate: noopAsync,
    taskAssign: noopAsync,
    taskStatus: noopAsync,
    taskComplete: noopAsync,
    memoryStore: noopAsync,
    memorySearch: async () => [],

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwarmManager', () => {
  describe('createSwarmManager()', () => {
    it('returns a SwarmManager object', () => {
      const manager = createSwarmManager({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      assert.ok(manager);
      assert.equal(typeof manager.initSwarm, 'function');
      assert.equal(typeof manager.shutdownSwarm, 'function');
    });
  });

  describe('initSwarm()', () => {
    it('calls cliClient.swarmInit with correct params from WorkflowPlan', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });
      const plan = makePlan();

      await manager.initSwarm(plan);

      assert.equal(mcp.swarmInitCalls.length, 1);
      const call = mcp.swarmInitCalls[0];
      assert.equal(call.topology, 'hierarchical');
      assert.equal(call.maxAgents, 6);
      assert.equal(call.strategy, 'specialized');
      assert.equal(call.consensus, 'raft');
    });

    it('returns SwarmHandle with swarmId, topology, maxAgents, status active', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });
      const plan = makePlan();

      const handle = await manager.initSwarm(plan);

      assert.equal(handle.swarmId, 'swarm-abc-123');
      assert.equal(handle.topology, 'hierarchical');
      assert.equal(handle.maxAgents, 6);
      assert.equal(handle.status, 'active');
    });

    it('maps plan topology, strategy, consensus to swarm init opts', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });
      const plan = makePlan({
        topology: 'mesh',
        swarmStrategy: 'balanced',
        consensus: 'pbft',
        maxAgents: 10,
      });

      const handle = await manager.initSwarm(plan);

      const call = mcp.swarmInitCalls[0];
      assert.equal(call.topology, 'mesh');
      assert.equal(call.strategy, 'balanced');
      assert.equal(call.consensus, 'pbft');
      assert.equal(call.maxAgents, 10);
      assert.equal(handle.topology, 'mesh');
      assert.equal(handle.maxAgents, 10);
    });

    it('throws SwarmError when cliClient fails', async () => {
      const mcp = mockCliClient({
        swarmInit: async () => {
          throw new Error('MCP connection refused');
        },
      });
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });

      await assert.rejects(
        () => manager.initSwarm(makePlan()),
        (err: unknown) => {
          assert.ok(err instanceof SwarmError);
          assert.match(err.message, /MCP connection refused/);
          return true;
        },
      );
    });
  });

  describe('shutdownSwarm()', () => {
    it('calls cliClient.swarmShutdown with the swarmId', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });
      const plan = makePlan();

      const handle = await manager.initSwarm(plan);
      await manager.shutdownSwarm(handle.swarmId);

      assert.equal(mcp.swarmShutdownCalls.length, 1);
      assert.equal(mcp.swarmShutdownCalls[0], 'swarm-abc-123');
    });

    it('updates handle status to shutdown', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });
      const plan = makePlan();

      const handle = await manager.initSwarm(plan);
      assert.equal(handle.status, 'active');

      await manager.shutdownSwarm(handle.swarmId);
      assert.equal(handle.status, 'shutdown');
    });

    it('is idempotent - calling twice does not throw', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });
      const plan = makePlan();

      const handle = await manager.initSwarm(plan);
      await manager.shutdownSwarm(handle.swarmId);
      await manager.shutdownSwarm(handle.swarmId);

      // Only one actual MCP call since second is a no-op
      assert.equal(mcp.swarmShutdownCalls.length, 1);
      assert.equal(handle.status, 'shutdown');
    });

    it('is a no-op for unknown swarmId', async () => {
      const mcp = mockCliClient();
      const manager = createSwarmManager({ logger: stubLogger(), cliClient: mcp });

      // Should not throw for an unknown swarmId
      await manager.shutdownSwarm('unknown-swarm');
      assert.equal(mcp.swarmShutdownCalls.length, 0);
    });
  });
});
