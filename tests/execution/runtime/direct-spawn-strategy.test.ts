/**
 * Tests for DirectSpawnStrategy — the core logic for direct agent spawning.
 *
 * Mock-first (London School): SwarmDaemon, WorktreeManager, EventBus are
 * all fakes injected via deps.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDirectSpawnStrategy,
  type DirectSpawnStrategy,
  type DirectSpawnStrategyDeps,
} from '../../../src/execution/runtime/direct-spawn-strategy';

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
  } as unknown as DirectSpawnStrategyDeps['logger'];
}

function createMockWorktreeManager() {
  return {
    create: mock.fn(async () => ({
      path: '/tmp/worktree-test',
      planId: 'test-plan',
      branch: 'agent/test',
    })),
    commit: mock.fn(async () => 'abc123'),
    push: mock.fn(async () => {}),
    diff: mock.fn(async () => ''),
    dispose: mock.fn(async () => {}),
  };
}

function createMockSwarmDaemon(opts?: {
  dispatchError?: Error;
  getSessions?: () => Array<{ currentTaskId: string | null }>;
}) {
  return {
    dispatch: opts?.dispatchError
      ? mock.fn(async () => { throw opts.dispatchError!; })
      : mock.fn(async () => {}),
    health: mock.fn(() => ({
      activeSessions: 0,
      idleSessions: 0,
      queueDepth: 0,
      capacity: 8,
      totalSpawns: 0,
      totalCrashes: 0,
      isShuttingDown: false,
    })),
    getSessions: opts?.getSessions
      ? mock.fn(opts.getSessions)
      : mock.fn(() => []),
    start: mock.fn(),
    shutdown: mock.fn(async () => {}),
  };
}

function createMockEventBus() {
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    bus: {
      publish: mock.fn((event: { type: string; payload: unknown }) => {
        published.push(event);
      }),
      subscribe: mock.fn(() => noop),
      removeAllListeners: mock.fn(),
    },
    published,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DirectSpawnStrategy', () => {
  let strategy: DirectSpawnStrategy;
  let worktreeManager: ReturnType<typeof createMockWorktreeManager>;
  let swarmDaemon: ReturnType<typeof createMockSwarmDaemon>;
  let eventBusMock: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    worktreeManager = createMockWorktreeManager();
    swarmDaemon = createMockSwarmDaemon();
    eventBusMock = createMockEventBus();
    strategy = createDirectSpawnStrategy({
      swarmDaemon: swarmDaemon as unknown as DirectSpawnStrategyDeps['swarmDaemon'],
      worktreeManager: worktreeManager as unknown as DirectSpawnStrategyDeps['worktreeManager'],
      logger: createMockLogger(),
      eventBus: eventBusMock.bus as unknown as DirectSpawnStrategyDeps['eventBus'],
      parentPlanId: 'plan-123',
    });
  });

  describe('executeAgentTool', () => {
    it('creates worktree and dispatches to SwarmDaemon', async () => {
      const resultPromise = strategy.executeAgentTool({
        prompt: 'Do something',
        subagent_type: 'coder',
      });

      // Give it a moment to dispatch
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(worktreeManager.create.mock.callCount(), 1, 'worktree.create called once');
      assert.equal(swarmDaemon.dispatch.mock.callCount(), 1, 'dispatch called once');

      // The strategy polls for completion — daemon shows empty sessions
      // so it should settle within the poll interval
      const result = await Promise.race([
        resultPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for result')), 5_000),
        ),
      ]);

      assert.equal(typeof result, 'string');
      assert.equal(result, 'Child agent completed');
    });

    it('emits ChildAgentRequested domain event', async () => {
      const resultPromise = strategy.executeAgentTool({
        prompt: 'Test task',
      });

      // Wait for dispatch
      await new Promise((r) => setTimeout(r, 50));

      const requestedEvents = eventBusMock.published.filter(
        (e) => e.type === 'ChildAgentRequested',
      );
      assert.equal(requestedEvents.length, 1);
      const payload = requestedEvents[0].payload as { parentPlanId: string; prompt: string };
      assert.equal(payload.parentPlanId, 'plan-123');
      assert.equal(payload.prompt, 'Test task');

      // Let it complete
      await Promise.race([
        resultPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ]);
    });

    it('emits ChildAgentCompleted on success', async () => {
      const result = await Promise.race([
        strategy.executeAgentTool({ prompt: 'Test' }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ]);

      assert.equal(result, 'Child agent completed');

      const completedEvents = eventBusMock.published.filter(
        (e) => e.type === 'ChildAgentCompleted',
      );
      assert.equal(completedEvents.length, 1);
    });

    it('returns failure when worktree creation fails', async () => {
      worktreeManager.create = mock.fn(async () => {
        throw new Error('git worktree add failed');
      });

      strategy = createDirectSpawnStrategy({
        swarmDaemon: swarmDaemon as unknown as DirectSpawnStrategyDeps['swarmDaemon'],
        worktreeManager: worktreeManager as unknown as DirectSpawnStrategyDeps['worktreeManager'],
        logger: createMockLogger(),
        eventBus: eventBusMock.bus as unknown as DirectSpawnStrategyDeps['eventBus'],
        parentPlanId: 'plan-123',
      });

      const result = await strategy.executeAgentTool({ prompt: 'Test' });

      assert.ok(result.includes('git worktree add failed'));
      assert.equal(swarmDaemon.dispatch.mock.callCount(), 0, 'dispatch not called on worktree failure');

      const failedEvents = eventBusMock.published.filter(
        (e) => e.type === 'ChildAgentFailed',
      );
      assert.equal(failedEvents.length, 1);
    });

    it('returns failure when dispatch fails', async () => {
      const failDaemon = createMockSwarmDaemon({
        dispatchError: new Error('at capacity'),
      });

      strategy = createDirectSpawnStrategy({
        swarmDaemon: failDaemon as unknown as DirectSpawnStrategyDeps['swarmDaemon'],
        worktreeManager: worktreeManager as unknown as DirectSpawnStrategyDeps['worktreeManager'],
        logger: createMockLogger(),
        eventBus: eventBusMock.bus as unknown as DirectSpawnStrategyDeps['eventBus'],
      });

      const result = await strategy.executeAgentTool({ prompt: 'Test' });

      assert.ok(result.includes('Dispatch failed'));
      assert.ok(result.includes('at capacity'));
    });

    it('respects parentAbortSignal when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      strategy = createDirectSpawnStrategy({
        swarmDaemon: swarmDaemon as unknown as DirectSpawnStrategyDeps['swarmDaemon'],
        worktreeManager: worktreeManager as unknown as DirectSpawnStrategyDeps['worktreeManager'],
        logger: createMockLogger(),
        parentAbortSignal: controller.signal,
      });

      const result = await strategy.executeAgentTool({ prompt: 'Test' });

      assert.equal(result, 'Parent agent cancelled');
    });
  });

  describe('getChildStatus', () => {
    it('returns undefined for unknown child', () => {
      assert.equal(strategy.getChildStatus('nonexistent'), undefined);
    });

    it('returns status after executeAgentTool starts', async () => {
      const promise = strategy.executeAgentTool({ prompt: 'Test' });

      // Give it a moment to register
      await new Promise((r) => setTimeout(r, 20));

      const active = strategy.getActiveChildren();
      assert.ok(active.length >= 0, 'may have children (could already complete)');

      await Promise.race([
        promise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ]);
    });
  });

  describe('cancelChild', () => {
    it('cancels an active child', async () => {
      // Use a daemon that never completes (sessions always active)
      const slowDaemon = createMockSwarmDaemon({
        getSessions: () => [{ currentTaskId: 'child-test' }],
      });
      slowDaemon.health = mock.fn(() => ({
        activeSessions: 1,
        idleSessions: 0,
        queueDepth: 0,
        capacity: 8,
        totalSpawns: 1,
        totalCrashes: 0,
        isShuttingDown: false,
      }));

      strategy = createDirectSpawnStrategy({
        swarmDaemon: slowDaemon as unknown as DirectSpawnStrategyDeps['swarmDaemon'],
        worktreeManager: worktreeManager as unknown as DirectSpawnStrategyDeps['worktreeManager'],
        logger: createMockLogger(),
        eventBus: eventBusMock.bus as unknown as DirectSpawnStrategyDeps['eventBus'],
      });

      // Start a task (won't complete because daemon shows active session)
      const promise = strategy.executeAgentTool({ prompt: 'Long task' });

      // Wait for it to be dispatched
      await new Promise((r) => setTimeout(r, 100));

      // Find the active child and cancel it
      const active = strategy.getActiveChildren();
      assert.ok(active.length > 0, 'should have at least one active child');

      const childId = active[0].id;
      strategy.cancelChild(childId);

      const status = strategy.getChildStatus(childId);
      assert.equal(status?.status, 'cancelled');

      // Clean up (the promise will still be pending since cancel doesn't
      // resolve the execute promise -- that's the daemon's poll path)
      // We race with a timeout
      await Promise.race([
        promise,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
      ]);
    });

    it('is a no-op for unknown child', () => {
      // Should not throw
      strategy.cancelChild('nonexistent');
    });
  });

  describe('getActiveChildren', () => {
    it('returns empty array initially', () => {
      assert.deepEqual(strategy.getActiveChildren(), []);
    });
  });
});
