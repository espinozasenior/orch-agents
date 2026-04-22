/**
 * Tests for executor-factory feature flag branching (AGENT_SPAWN_MODE).
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { buildExecutor } from '../../../src/execution/runtime/executor-factory';
import { DeferredToolRegistry, type DeferredToolDef } from '../../../src/services/deferred-tools/registry.js';
import type { InteractiveTaskExecutor } from '../../../src/execution/runtime/interactive-executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noop() { /* intentional */ }

function createMockLogger() {
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => createMockLogger(),
  } as unknown as Parameters<typeof buildExecutor>[0]['logger'];
}

function createMockBaseExecutor(): InteractiveTaskExecutor {
  return {
    execute: mock.fn(async () => ({
      status: 'completed' as const,
      output: 'mock',
      duration: 100,
    })),
  };
}

function createMockSwarmDaemon() {
  return {
    dispatch: mock.fn(async () => {}),
    health: mock.fn(() => ({
      activeSessions: 0, idleSessions: 0, queueDepth: 0,
      capacity: 8, totalSpawns: 0, totalCrashes: 0, isShuttingDown: false,
    })),
    getSessions: mock.fn(() => []),
    start: mock.fn(),
    shutdown: mock.fn(async () => {}),
  };
}

function createMockWorktreeManager() {
  return {
    create: mock.fn(async () => ({ path: '/tmp/wt', planId: 'p', branch: 'b' })),
    commit: mock.fn(async () => 'sha'),
    push: mock.fn(async () => {}),
    diff: mock.fn(async () => ''),
    dispose: mock.fn(async () => {}),
  };
}

function createRegistryWithAgent(): DeferredToolRegistry {
  const registry = new DeferredToolRegistry();
  registry.register({
    name: 'Agent',
    description: 'NOOP Agent',
    schema: { type: 'object' },
    execute: async () => ({ content: 'noop', is_error: false }),
    shouldDefer: false,
    alwaysLoad: true,
  });
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildExecutor — agentSpawnMode', () => {
  it('sdk mode (default) does not override Agent tool', () => {
    const registry = createRegistryWithAgent();
    const originalAgent = registry.get('Agent')!;

    buildExecutor({
      baseExecutor: createMockBaseExecutor(),
      logger: createMockLogger(),
      agentSpawnMode: 'sdk',
      deferredToolRegistry: registry,
    });

    // Agent tool should be unchanged
    const agentAfter = registry.get('Agent')!;
    assert.equal(agentAfter.description, originalAgent.description);
  });

  it('direct mode overrides Agent tool in registry', () => {
    const registry = createRegistryWithAgent();

    buildExecutor({
      baseExecutor: createMockBaseExecutor(),
      logger: createMockLogger(),
      agentSpawnMode: 'direct',
      swarmDaemon: createMockSwarmDaemon() as unknown as Parameters<typeof buildExecutor>[0]['swarmDaemon'],
      worktreeManager: createMockWorktreeManager() as unknown as Parameters<typeof buildExecutor>[0]['worktreeManager'],
      deferredToolRegistry: registry,
    });

    const agentAfter = registry.get('Agent')!;
    assert.ok(agentAfter.description.includes('direct mode'), 'Agent description updated to direct mode');
  });

  it('direct mode without swarmDaemon does not override Agent', () => {
    const registry = createRegistryWithAgent();

    buildExecutor({
      baseExecutor: createMockBaseExecutor(),
      logger: createMockLogger(),
      agentSpawnMode: 'direct',
      // no swarmDaemon or worktreeManager
      deferredToolRegistry: registry,
    });

    const agentAfter = registry.get('Agent')!;
    assert.equal(agentAfter.description, 'NOOP Agent', 'Agent not overridden without deps');
  });

  it('direct mode without worktreeManager does not override Agent', () => {
    const registry = createRegistryWithAgent();

    buildExecutor({
      baseExecutor: createMockBaseExecutor(),
      logger: createMockLogger(),
      agentSpawnMode: 'direct',
      swarmDaemon: createMockSwarmDaemon() as unknown as Parameters<typeof buildExecutor>[0]['swarmDaemon'],
      // no worktreeManager
      deferredToolRegistry: registry,
    });

    const agentAfter = registry.get('Agent')!;
    assert.equal(agentAfter.description, 'NOOP Agent', 'Agent not overridden without worktreeManager');
  });

  it('returns an executor regardless of spawn mode', () => {
    const result = buildExecutor({
      baseExecutor: createMockBaseExecutor(),
    });

    assert.ok(result.executor, 'executor returned');
    assert.equal(typeof result.executor.execute, 'function');
  });

  it('direct mode Agent tool execute is a function wired to strategy', () => {
    const registry = createRegistryWithAgent();

    buildExecutor({
      baseExecutor: createMockBaseExecutor(),
      logger: createMockLogger(),
      agentSpawnMode: 'direct',
      swarmDaemon: createMockSwarmDaemon() as unknown as Parameters<typeof buildExecutor>[0]['swarmDaemon'],
      worktreeManager: createMockWorktreeManager() as unknown as Parameters<typeof buildExecutor>[0]['worktreeManager'],
      deferredToolRegistry: registry,
    });

    const agentTool = registry.get('Agent')!;
    // execute() is now wired to the DirectSpawnStrategy (not the NOOP)
    assert.equal(typeof agentTool.execute, 'function');
    // The description confirms it's the direct spawn version
    assert.ok(agentTool.description.includes('direct mode'));
    // isConcurrencySafe should return false (spawns child processes)
    assert.equal(agentTool.isConcurrencySafe!({} as Record<string, unknown>), false);
  });
});

describe('DeferredToolRegistry.override', () => {
  it('replaces an existing tool', () => {
    const registry = new DeferredToolRegistry();
    const toolA: DeferredToolDef = {
      name: 'TestTool',
      description: 'original',
      schema: {},
      execute: async () => ({ content: 'a', is_error: false }),
      shouldDefer: false,
      alwaysLoad: true,
    };
    const toolB: DeferredToolDef = {
      ...toolA,
      description: 'replaced',
    };

    registry.register(toolA);
    assert.equal(registry.get('TestTool')!.description, 'original');

    registry.override(toolB);
    assert.equal(registry.get('TestTool')!.description, 'replaced');
  });

  it('inserts if not present', () => {
    const registry = new DeferredToolRegistry();
    const tool: DeferredToolDef = {
      name: 'NewTool',
      description: 'fresh',
      schema: {},
      execute: async () => ({ content: '', is_error: false }),
      shouldDefer: false,
      alwaysLoad: false,
    };

    registry.override(tool);
    assert.equal(registry.get('NewTool')!.description, 'fresh');
  });
});
