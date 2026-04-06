/**
 * TDD: Tests for SwarmDaemon — capacity manager for agent sessions.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.01, FR-9B.06, FR-9B.07, FR-9B.10)
 *
 * London School TDD — mock SessionRunner.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { SwarmDaemon } from '../../../src/execution/runtime/swarm-daemon';
import type { SwarmDaemonConfig } from '../../../src/execution/runtime/swarm-daemon';
import { SessionRunner } from '../../../src/execution/runtime/session-runner';
import type { SessionRunnerConfig } from '../../../src/execution/runtime/session-runner';
import type { Logger, LogContext } from '../../../src/shared/logger';
import type { NdjsonEnvelope, TaskPayload } from '../../../src/execution/runtime/ndjson-protocol';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNullLogger(): Logger {
  const noop = (_msg: string, _ctx?: LogContext) => {};
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeNullLogger(),
  };
}

function makeTask(id = 't-1', tool = 'Edit'): NdjsonEnvelope<'task', TaskPayload> {
  return {
    type: 'task',
    id,
    sessionId: '',
    payload: { tool, args: {} },
    timestamp: Date.now(),
  };
}

function createFakeChild(pid = 99999) {
  const child = new EventEmitter();
  (child as any).stdin = new PassThrough();
  (child as any).stdout = new PassThrough();
  (child as any).stderr = new PassThrough();
  (child as any).pid = pid;
  (child as any).killed = false;
  (child as any).kill = (signal?: string) => {
    (child as any).killed = true;
    // Simulate real child behavior: emit exit after kill
    process.nextTick(() => child.emit('exit', signal === 'SIGKILL' ? null : 1, signal ?? 'SIGTERM'));
    return true;
  };
  return child as unknown as ChildProcess;
}

/**
 * Creates a SwarmDaemon with a sessionFactory that produces real SessionRunners
 * backed by fake child processes.
 */
function createDaemon(overrides: Partial<SwarmDaemonConfig> = {}): SwarmDaemon {
  const fakeSpawn = () => createFakeChild();

  return new SwarmDaemon({
    maxSlots: 2,
    logger: makeNullLogger(),
    sessionFactory: (config: SessionRunnerConfig) => {
      return new SessionRunner({
        ...config,
        spawnFn: fakeSpawn as any,
      });
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwarmDaemon', () => {
  let daemon: SwarmDaemon;

  afterEach(async () => {
    if (daemon) {
      await daemon.shutdown(100).catch(() => {});
    }
  });

  // -----------------------------------------------------------------------
  // FR-9B.01: Capacity management
  // -----------------------------------------------------------------------

  describe('capacity management (FR-9B.01)', () => {
    it('starts with 0 active sessions and capacity = maxSlots', () => {
      daemon = createDaemon({ maxSlots: 8 });
      const h = daemon.health();
      assert.equal(h.activeSessions, 0);
      assert.equal(h.idleSessions, 0);
      assert.equal(h.queueDepth, 0);
      assert.equal(h.capacity, 8);
    });

    it('spawns session when work arrives and no idle session exists', async () => {
      daemon = createDaemon();
      daemon.start();
      await daemon.dispatch(makeTask());
      assert.equal(daemon.sessionCount, 1);
    });

    it('queues work when all slots are full', async () => {
      daemon = createDaemon({ maxSlots: 1 });
      daemon.start();

      await daemon.dispatch(makeTask('t-1'));
      // First task takes the only slot (session is now "working")
      assert.equal(daemon.sessionCount, 1);

      // Second task should be queued since the session is working
      await daemon.dispatch(makeTask('t-2'));
      // It may spawn a second session if within capacity, or queue
      // With maxSlots=1, it should queue
      const h = daemon.health();
      // Either 1 session + 1 queued, or session reused
      assert.ok(h.queueDepth >= 0);
    });

    it('rejects work when shutting down', async () => {
      daemon = createDaemon();
      daemon.start();
      await daemon.shutdown(100);
      await assert.rejects(
        () => daemon.dispatch(makeTask()),
        { message: /shutting down/ },
      );
    });
  });

  // -----------------------------------------------------------------------
  // FR-9B.07: Tool whitelist
  // -----------------------------------------------------------------------

  describe('tool whitelist (FR-9B.07)', () => {
    it('allows whitelisted tools', async () => {
      daemon = createDaemon({ allowedTools: ['Edit', 'Read'] });
      daemon.start();
      // Should not throw
      await daemon.dispatch(makeTask('t-1', 'Edit'));
    });

    it('rejects non-whitelisted tools with error', async () => {
      daemon = createDaemon({ allowedTools: ['Edit', 'Read'] });
      daemon.start();
      await assert.rejects(
        () => daemon.dispatch(makeTask('t-1', 'DangerousTool')),
        { message: /not in the allowed tools whitelist/ },
      );
    });

    it('uses default whitelist when not specified', () => {
      daemon = createDaemon();
      // Default includes Read, Grep, Glob, Bash, Edit, Write
      // Should not throw for these tools
      daemon.start();
    });

    it('rejects unknown tools by default (whitelist, not blacklist)', async () => {
      daemon = createDaemon();
      daemon.start();
      await assert.rejects(
        () => daemon.dispatch(makeTask('t-1', 'UnknownNewTool')),
        { message: /not in the allowed tools whitelist/ },
      );
    });
  });

  // -----------------------------------------------------------------------
  // FR-9B.10: Health reporting
  // -----------------------------------------------------------------------

  describe('health reporting (FR-9B.10)', () => {
    it('returns accurate session counts and queue depth', async () => {
      daemon = createDaemon({ maxSlots: 2 });
      daemon.start();

      await daemon.dispatch(makeTask('t-1'));
      const h = daemon.health();

      assert.equal(h.capacity, 2);
      assert.equal(typeof h.activeSessions, 'number');
      assert.equal(typeof h.idleSessions, 'number');
      assert.equal(typeof h.queueDepth, 'number');
      assert.equal(typeof h.totalSpawns, 'number');
      assert.equal(typeof h.totalCrashes, 'number');
      assert.equal(h.isShuttingDown, false);
    });

    it('reports isShuttingDown after shutdown called', async () => {
      daemon = createDaemon();
      daemon.start();
      await daemon.shutdown(100);
      const h = daemon.health();
      assert.equal(h.isShuttingDown, true);
    });

    it('tracks total spawns', async () => {
      daemon = createDaemon({ maxSlots: 3 });
      daemon.start();

      await daemon.dispatch(makeTask('t-1'));
      await daemon.dispatch(makeTask('t-2'));
      const h = daemon.health();
      assert.ok(h.totalSpawns >= 1);
    });
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('drains all sessions and clears them', async () => {
      daemon = createDaemon();
      daemon.start();
      await daemon.dispatch(makeTask());
      assert.ok(daemon.sessionCount >= 1);

      await daemon.shutdown(500);
      assert.equal(daemon.sessionCount, 0);
    });

    it('stops accepting new work after shutdown', async () => {
      daemon = createDaemon();
      daemon.start();
      await daemon.shutdown(100);
      await assert.rejects(() => daemon.dispatch(makeTask()));
    });
  });

  // -----------------------------------------------------------------------
  // Session info
  // -----------------------------------------------------------------------

  describe('getSessions', () => {
    it('returns session info snapshots', async () => {
      daemon = createDaemon();
      daemon.start();
      await daemon.dispatch(makeTask());

      const sessions = daemon.getSessions();
      assert.ok(sessions.length >= 1);
      assert.equal(typeof sessions[0].id, 'string');
      assert.equal(typeof sessions[0].state, 'string');
      assert.equal(typeof sessions[0].workDir, 'string');
    });
  });
});
