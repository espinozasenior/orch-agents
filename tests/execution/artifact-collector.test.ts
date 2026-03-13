/**
 * TDD: Tests for ArtifactCollector — collects and normalizes agent results
 * into Artifact objects and stores checkpoints via memory.
 *
 * London School: CliClient and Logger are fully mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlannedPhase } from '../../src/types';
import type { CliClient, MemoryStoreOpts } from '../../src/execution/cli-client';
import type { Logger } from '../../src/shared/logger';
import {
  type ArtifactCollector,
  type ArtifactCollectorDeps,
  type TaskResultRef,
  createArtifactCollector,
} from '../../src/execution/artifact-collector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID v4 regex pattern. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makePhase(overrides: Partial<PlannedPhase> = {}): PlannedPhase {
  return {
    type: 'refinement',
    agents: ['coder', 'tester'],
    gate: 'tests-pass',
    skippable: false,
    ...overrides,
  };
}

function makeTaskResult(overrides: Partial<TaskResultRef> = {}): TaskResultRef {
  return {
    taskId: 'task-001',
    agentId: 'agent-coder-1',
    status: 'completed',
    output: 'All tests pass',
    ...overrides,
  };
}

/** Stub logger that records warn calls for assertion. */
function stubLogger(): Logger & { warnCalls: Array<{ msg: string; ctx?: unknown }> } {
  const warnCalls: Array<{ msg: string; ctx?: unknown }> = [];
  const noop = () => {};
  const logger: Logger & { warnCalls: Array<{ msg: string; ctx?: unknown }> } = {
    warnCalls,
    trace: noop,
    debug: noop,
    info: noop,
    warn: (msg: string, ctx?: unknown) => {
      warnCalls.push({ msg, ctx });
    },
    error: noop,
    fatal: noop,
    child: () => stubLogger(),
  };
  return logger;
}

/** Create a mock CliClient with spies for memory methods. */
function mockCliClient(overrides: Partial<CliClient> = {}): CliClient & {
  memoryStoreCalls: Array<{ key: string; value: string; opts?: MemoryStoreOpts }>;
} {
  const memoryStoreCalls: Array<{ key: string; value: string; opts?: MemoryStoreOpts }> = [];

  const noopAsync = async () => ({} as never);

  return {
    memoryStoreCalls,

    async memoryStore(key: string, value: string, opts?: MemoryStoreOpts) {
      memoryStoreCalls.push({ key, value, opts });
    },
    async memorySearch() {
      return [];
    },

    swarmInit: noopAsync,
    swarmShutdown: noopAsync,
    agentSpawn: noopAsync,
    agentStatus: noopAsync,
    agentTerminate: noopAsync,
    taskCreate: noopAsync,
    taskAssign: noopAsync,
    taskStatus: noopAsync,
    taskComplete: noopAsync,

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactCollector', () => {
  describe('createArtifactCollector()', () => {
    it('returns an ArtifactCollector object', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      assert.ok(collector);
      assert.equal(typeof collector.collect, 'function');
      assert.equal(typeof collector.storeCheckpoint, 'function');
    });
  });

  describe('collect()', () => {
    it('creates Artifact[] from TaskResultRef[] with correct fields', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const phase = makePhase();
      const results = [
        makeTaskResult({ taskId: 'task-001', agentId: 'agent-coder-1' }),
        makeTaskResult({ taskId: 'task-002', agentId: 'agent-tester-1', status: 'failed' }),
      ];

      const artifacts = collector.collect('phase-ref-1', phase, results);

      assert.equal(artifacts.length, 2);
    });

    it('artifact.id is a UUID', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const artifacts = collector.collect('phase-1', makePhase(), [makeTaskResult()]);

      assert.match(artifacts[0].id, UUID_RE);
    });

    it('artifact.phaseId matches the provided phaseId', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const artifacts = collector.collect('phase-ref-42', makePhase(), [makeTaskResult()]);

      assert.equal(artifacts[0].phaseId, 'phase-ref-42');
    });

    it('artifact.type matches the phase type', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const phase = makePhase({ type: 'refinement' });
      const artifacts = collector.collect('phase-1', phase, [makeTaskResult()]);

      assert.equal(artifacts[0].type, 'refinement');
    });

    it('artifact.type reflects different phase types', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const phase = makePhase({ type: 'architecture' });
      const artifacts = collector.collect('phase-1', phase, [makeTaskResult()]);

      assert.equal(artifacts[0].type, 'architecture');
    });

    it('artifact.url is memory:// URI with plan/phase path', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const artifacts = collector.collect('phase-ref-1', makePhase(), [
        makeTaskResult({ taskId: 'task-001' }),
      ]);

      assert.equal(artifacts[0].url, 'memory://phase-ref-1/task-001');
    });

    it('artifact.metadata includes agentId, taskId, status', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const artifacts = collector.collect('phase-1', makePhase(), [
        makeTaskResult({ taskId: 'task-007', agentId: 'agent-x', status: 'completed' }),
      ]);

      assert.equal(artifacts[0].metadata.agentId, 'agent-x');
      assert.equal(artifacts[0].metadata.taskId, 'task-007');
      assert.equal(artifacts[0].metadata.status, 'completed');
    });

    it('handles empty task results (returns empty array)', () => {
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mockCliClient(),
      });
      const artifacts = collector.collect('phase-1', makePhase(), []);

      assert.deepEqual(artifacts, []);
    });
  });

  describe('storeCheckpoint()', () => {
    it('calls cliClient.memoryStore with correct key/value/namespace', async () => {
      const mcp = mockCliClient();
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mcp,
      });
      const artifacts = collector.collect('phase-1', makePhase(), [makeTaskResult()]);

      await collector.storeCheckpoint('plan-abc', 'phase-1', artifacts);

      assert.equal(mcp.memoryStoreCalls.length, 1);
      const call = mcp.memoryStoreCalls[0];
      assert.equal(call.key, 'plan-abc/phase-1');
    });

    it('serializes artifacts as JSON', async () => {
      const mcp = mockCliClient();
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mcp,
      });
      const artifacts = collector.collect('phase-1', makePhase(), [makeTaskResult()]);

      await collector.storeCheckpoint('plan-abc', 'phase-1', artifacts);

      const stored = mcp.memoryStoreCalls[0];
      const parsed = JSON.parse(stored.value);
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].phaseId, 'phase-1');
    });

    it('uses namespace "artifacts:{planId}"', async () => {
      const mcp = mockCliClient();
      const collector = createArtifactCollector({
        logger: stubLogger(),
        cliClient: mcp,
      });
      const artifacts = collector.collect('phase-1', makePhase(), [makeTaskResult()]);

      await collector.storeCheckpoint('plan-xyz', 'phase-1', artifacts);

      const call = mcp.memoryStoreCalls[0];
      assert.equal(call.opts?.namespace, 'artifacts:plan-xyz');
    });

    it('handles cliClient failure gracefully (logs warning, does not throw)', async () => {
      const logger = stubLogger();
      const mcp = mockCliClient({
        memoryStore: async () => {
          throw new Error('Memory service unavailable');
        },
      });
      const collector = createArtifactCollector({ logger, cliClient: mcp });
      const artifacts = collector.collect('phase-1', makePhase(), [makeTaskResult()]);

      // Should not throw
      await collector.storeCheckpoint('plan-abc', 'phase-1', artifacts);

      assert.equal(logger.warnCalls.length, 1);
      assert.match(logger.warnCalls[0].msg, /checkpoint/i);
    });
  });
});
