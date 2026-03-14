/**
 * TDD: Tests for CliClient — CLI adapter for claude-flow commands.
 *
 * London School: runCli is injected so we test command construction,
 * output parsing, status mapping, and error handling in isolation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCliClient,
  createCliClientWithRunner,
  normalizeStrategy,
  mapAgentStatus,
  mapTaskStatus,
  parseTableValue,
  SAFE_ENV_KEYS,
  buildSafeEnv,
  type CliClient,
} from '../../src/execution/cli-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock runner that records calls and returns canned output. */
function mockRunner(stdout = '', shouldThrow?: Error) {
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (shouldThrow) throw shouldThrow;
    return stdout;
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Tests: normalizeStrategy
// ---------------------------------------------------------------------------

describe('normalizeStrategy', () => {
  it('returns valid strategies unchanged', () => {
    assert.equal(normalizeStrategy('specialized'), 'specialized');
    assert.equal(normalizeStrategy('balanced'), 'balanced');
    assert.equal(normalizeStrategy('adaptive'), 'adaptive');
    assert.equal(normalizeStrategy('research'), 'research');
    assert.equal(normalizeStrategy('development'), 'development');
  });

  it('maps "minimal" to "specialized"', () => {
    assert.equal(normalizeStrategy('minimal'), 'specialized');
  });

  it('defaults unknown strategies to "balanced"', () => {
    assert.equal(normalizeStrategy('foobar'), 'balanced');
    assert.equal(normalizeStrategy(''), 'balanced');
  });
});

// ---------------------------------------------------------------------------
// Tests: mapAgentStatus
// ---------------------------------------------------------------------------

describe('mapAgentStatus', () => {
  it('maps completed/done to completed', () => {
    assert.equal(mapAgentStatus('completed'), 'completed');
    assert.equal(mapAgentStatus('done'), 'completed');
  });

  it('maps running/active/busy to running', () => {
    assert.equal(mapAgentStatus('running'), 'running');
    assert.equal(mapAgentStatus('active'), 'running');
    assert.equal(mapAgentStatus('busy'), 'running');
  });

  it('maps spawned/idle/ready/waiting to spawned', () => {
    assert.equal(mapAgentStatus('spawned'), 'spawned');
    assert.equal(mapAgentStatus('idle'), 'spawned');
    assert.equal(mapAgentStatus('ready'), 'spawned');
  });

  it('maps terminated/stopped to terminated', () => {
    assert.equal(mapAgentStatus('terminated'), 'terminated');
    assert.equal(mapAgentStatus('stopped'), 'terminated');
  });

  it('maps failed/error to failed', () => {
    assert.equal(mapAgentStatus('failed'), 'failed');
    assert.equal(mapAgentStatus('error'), 'failed');
  });

  it('defaults unknown status to "spawned" (not "completed")', () => {
    assert.equal(mapAgentStatus('initializing'), 'spawned');
    assert.equal(mapAgentStatus('queued'), 'spawned');
    assert.equal(mapAgentStatus('unknown'), 'spawned');
  });
});

// ---------------------------------------------------------------------------
// Tests: mapTaskStatus
// ---------------------------------------------------------------------------

describe('mapTaskStatus', () => {
  it('maps completed/done to completed', () => {
    assert.equal(mapTaskStatus('completed'), 'completed');
    assert.equal(mapTaskStatus('done'), 'completed');
  });

  it('maps in-progress/running to in-progress', () => {
    assert.equal(mapTaskStatus('in-progress'), 'in-progress');
    assert.equal(mapTaskStatus('running'), 'in-progress');
  });

  it('defaults unknown to failed', () => {
    assert.equal(mapTaskStatus('unknown'), 'failed');
  });
});

// ---------------------------------------------------------------------------
// Tests: parseTableValue
// ---------------------------------------------------------------------------

describe('parseTableValue', () => {
  it('extracts value from CLI table output', () => {
    const output = '| Swarm ID   | swarm-12345 |';
    assert.equal(parseTableValue(output, 'Swarm ID'), 'swarm-12345');
  });

  it('returns undefined for missing key', () => {
    const output = '| Swarm ID   | swarm-12345 |';
    assert.equal(parseTableValue(output, 'Agent ID'), undefined);
  });

  it('trims whitespace from values', () => {
    const output = '| Agent ID   |   agent-abc   |';
    assert.equal(parseTableValue(output, 'Agent ID'), 'agent-abc');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildSafeEnv
// ---------------------------------------------------------------------------

describe('buildSafeEnv', () => {
  it('includes only safe keys from process.env', () => {
    const env = buildSafeEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      SECRET_KEY: 'should-not-appear',
      API_TOKEN: 'should-not-appear',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/user');
    assert.equal(env.SECRET_KEY, undefined);
    assert.equal(env.API_TOKEN, undefined);
  });

  it('always sets FORCE_COLOR=0', () => {
    const env = buildSafeEnv({});
    assert.equal(env.FORCE_COLOR, '0');
  });

  it('includes NODE_ENV and LANG', () => {
    const env = buildSafeEnv({ NODE_ENV: 'test', LANG: 'en_US.UTF-8' });
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.LANG, 'en_US.UTF-8');
  });
});

// ---------------------------------------------------------------------------
// Tests: CliClient commands (with injected runner)
// ---------------------------------------------------------------------------

describe('CliClient (with injected runner)', () => {
  describe('swarmInit', () => {
    it('builds correct CLI args', async () => {
      const { runner, calls } = mockRunner('| Swarm ID | swarm-123 |');
      const client = createCliClientWithRunner(runner);

      const result = await client.swarmInit({
        topology: 'hierarchical',
        maxAgents: 8,
        strategy: 'specialized',
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], [
        'swarm', 'init',
        '--topology', 'hierarchical',
        '--max-agents', '8',
        '--strategy', 'specialized',
      ]);
      assert.equal(result.swarmId, 'swarm-123');
    });

    it('appends --consensus flag when provided', async () => {
      const { runner, calls } = mockRunner('| Swarm ID | swarm-456 |');
      const client = createCliClientWithRunner(runner);

      await client.swarmInit({
        topology: 'mesh',
        maxAgents: 4,
        strategy: 'balanced',
        consensus: 'raft',
      });

      assert.ok(calls[0].includes('--consensus'));
      assert.ok(calls[0].includes('raft'));
    });

    it('normalizes unknown strategy', async () => {
      const { runner, calls } = mockRunner('| Swarm ID | swarm-789 |');
      const client = createCliClientWithRunner(runner);

      await client.swarmInit({
        topology: 'star',
        maxAgents: 3,
        strategy: 'minimal',
      });

      assert.ok(calls[0].includes('specialized')); // minimal -> specialized
    });
  });

  describe('swarmShutdown', () => {
    it('calls swarm shutdown (not stop)', async () => {
      const { runner, calls } = mockRunner('');
      const client = createCliClientWithRunner(runner);

      await client.swarmShutdown('swarm-123');

      assert.deepEqual(calls[0], ['swarm', 'shutdown', 'swarm-123']);
    });

    it('ignores errors silently', async () => {
      const { runner } = mockRunner('', new Error('already stopped'));
      const client = createCliClientWithRunner(runner);

      await assert.doesNotReject(() => client.swarmShutdown('swarm-123'));
    });
  });

  describe('agentTerminate', () => {
    it('calls agent terminate (not stop)', async () => {
      const { runner, calls } = mockRunner('');
      const client = createCliClientWithRunner(runner);

      await client.agentTerminate('agent-abc');

      assert.deepEqual(calls[0], ['agent', 'terminate', 'agent-abc']);
    });
  });

  describe('taskComplete', () => {
    it('calls task complete (not status)', async () => {
      const { runner, calls } = mockRunner('');
      const client = createCliClientWithRunner(runner);

      await client.taskComplete('task-123');

      assert.deepEqual(calls[0], ['task', 'complete', 'task-123']);
    });
  });

  describe('taskStatus', () => {
    it('returns failed (not completed) on error', async () => {
      const { runner } = mockRunner('', new Error('connection refused'));
      const client = createCliClientWithRunner(runner);

      const result = await client.taskStatus('task-123');

      assert.equal(result.status, 'failed');
      assert.ok(result.output?.includes('connection refused'));
    });
  });

  describe('memorySearch', () => {
    it('parses JSON results from CLI output', async () => {
      const jsonOutput = JSON.stringify({
        results: [
          { key: 'auth-pattern', value: 'JWT', score: 0.95, namespace: 'patterns' },
        ],
      });
      const { runner } = mockRunner(jsonOutput);
      const client = createCliClientWithRunner(runner);

      const results = await client.memorySearch('auth');

      assert.equal(results.length, 1);
      assert.equal(results[0].key, 'auth-pattern');
      assert.equal(results[0].score, 0.95);
    });

    it('returns empty array for unparseable output', async () => {
      const { runner } = mockRunner('No results found');
      const client = createCliClientWithRunner(runner);

      const results = await client.memorySearch('nonexistent');

      assert.deepEqual(results, []);
    });
  });
});
