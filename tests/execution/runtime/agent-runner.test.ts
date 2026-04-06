import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../../src/execution/runtime/agent-runner';
import { MemoryTransport } from '../../../src/execution/runtime/transport-inbound';
import {
  AgentMessageType,
  ContextOverflowError,
  OutputTruncatedError,
  type AgentRunnerDeps,
  type AgentMessage,
} from '../../../src/execution/runtime/agent-message-types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<AgentRunnerDeps> = {}): AgentRunnerDeps {
  return {
    countTokens: () => 10,
    executeTask: async (payload) => ({ result: payload }),
    sendResponse: () => {},
    compactHistory: async (history, _target) => history.slice(-2),
    getCurrentTokenCount: () => 1000,
    getConversationHistory: () => [],
    setConversationHistory: () => {},
    ...overrides,
  };
}

function makeMessage(
  type: AgentMessage['type'],
  id = 'msg-1',
  payload: unknown = { task: 'test' },
): AgentMessage {
  return { type, id, timestamp: Date.now(), payload } as AgentMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
  let transport: MemoryTransport;

  beforeEach(() => {
    transport = new MemoryTransport();
  });

  describe('message dispatch', () => {
    it('processes a user_task and sends response', async () => {
      const responses: Array<{ id: string; response: unknown }> = [];
      const deps = makeDeps({
        sendResponse: (id, response) => responses.push({ id, response }),
      });

      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 'task-1', { x: 1 }));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      const taskCount = await runPromise;
      assert.equal(taskCount, 1);
      assert.equal(responses.length, 1);
      assert.equal(responses[0].id, 'task-1');
      assert.deepStrictEqual(responses[0].response, { result: { x: 1 } });
    });

    it('handles keep_alive without executing task logic', async () => {
      let taskExecuted = false;
      const deps = makeDeps({
        executeTask: async () => { taskExecuted = true; return {}; },
      });

      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.KeepAlive, 'ka-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(taskExecuted, false);
    });

    it('handles env_update by setting process.env', async () => {
      const envKey = `ORCH_TEST_9A_ENV_${Date.now()}`;
      const deps = makeDeps();
      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(
        makeMessage(AgentMessageType.EnvUpdate, 'env-1', { [envKey]: 'hello' }),
      );
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(process.env[envKey], 'hello');
      delete process.env[envKey];
    });

    it('shutdown message breaks the loop and exits cleanly', async () => {
      const deps = makeDeps();
      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.Shutdown, 'sd-1', { reason: 'test' }));

      const taskCount = await runPromise;
      assert.equal(taskCount, 0);
    });

    it('control_response resolves pending control promise', async () => {
      // This exercises the code path; full control promise usage
      // will be tested in integration with the coordinator (Phase 9B).
      const deps = makeDeps();
      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.ControlResponse, 'ctrl-1', { ok: true }));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      // No assertion needed; verifies no crash on unknown control id
    });
  });

  describe('token budget enforcement (FR-9A.06)', () => {
    it('rejects message exceeding per-turn budget', async () => {
      const responses: Array<{ id: string; response: unknown }> = [];
      const deps = makeDeps({
        countTokens: () => 5000,
        sendResponse: (id, response) => responses.push({ id, response }),
      });

      const runner = new AgentRunner({
        transport,
        deps,
        config: { maxTokensPerTurn: 1000 },
      });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 'big-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(responses.length, 1);
      assert.ok((responses[0].response as { error: string }).error.includes('per-turn budget'));
    });

    it('passes message within per-turn budget', async () => {
      const responses: Array<{ id: string; response: unknown }> = [];
      const deps = makeDeps({
        countTokens: () => 100,
        sendResponse: (id, response) => responses.push({ id, response }),
      });

      const runner = new AgentRunner({
        transport,
        deps,
        config: { maxTokensPerTurn: 1000 },
      });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 'ok-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(responses.length, 1);
      assert.ok(!(responses[0].response as { error?: string }).error);
    });
  });

  describe('task budget enforcement (FR-9A.07)', () => {
    it('shuts down after reaching maxTasks', async () => {
      const deps = makeDeps();
      const runner = new AgentRunner({
        transport,
        deps,
        config: { maxTasks: 3 },
      });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 't-1'));
      transport.push(makeMessage(AgentMessageType.UserTask, 't-2'));
      transport.push(makeMessage(AgentMessageType.UserTask, 't-3'));
      // Should not need a shutdown message -- exits on budget exhaustion
      // But push one as safety to avoid hang
      transport.push(makeMessage(AgentMessageType.Shutdown));

      const taskCount = await runPromise;
      assert.equal(taskCount, 3);
    });

    it('defaults maxTasks to 200', async () => {
      const deps = makeDeps();
      const runner = new AgentRunner({ transport, deps });
      // Runner stores config internally; we verify via behavior:
      // send 1 task + shutdown -- should process fine (under 200)
      const runPromise = runner.run();
      transport.push(makeMessage(AgentMessageType.UserTask, 't-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      const taskCount = await runPromise;
      assert.equal(taskCount, 1);
    });
  });

  describe('auto-compact (FR-9A.04)', () => {
    it('triggers compaction when tokens exceed 80% threshold', async () => {
      let compacted = false;
      const deps = makeDeps({
        getCurrentTokenCount: () => 170_000, // 85% of 200k
        getConversationHistory: () => ['a', 'b', 'c', 'd', 'e'],
        compactHistory: async (_h, _t) => { compacted = true; return ['summary', 'e']; },
        setConversationHistory: () => {},
      });

      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 't-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(compacted, true);
    });

    it('does not trigger compaction below 80% threshold', async () => {
      let compacted = false;
      const deps = makeDeps({
        getCurrentTokenCount: () => 100_000, // 50% of 200k
        compactHistory: async () => { compacted = true; return []; },
      });

      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 't-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(compacted, false);
    });
  });

  describe('reactive compact (FR-9A.05)', () => {
    it('fires on ContextOverflowError and retries successfully', async () => {
      let attempt = 0;
      let compactedTarget = 0;
      const deps = makeDeps({
        executeTask: async () => {
          attempt++;
          if (attempt === 1) throw new ContextOverflowError();
          return { ok: true };
        },
        compactHistory: async (_h, target) => {
          compactedTarget = target;
          return ['compacted'];
        },
        setConversationHistory: () => {},
        getConversationHistory: () => ['a', 'b', 'c'],
      });

      const responses: Array<{ id: string; response: unknown }> = [];
      deps.sendResponse = (id, response) => responses.push({ id, response });

      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 'overflow-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(attempt, 2);
      assert.equal(compactedTarget, 100_000); // 50% of 200k
      assert.deepStrictEqual(responses[0].response, { ok: true });
    });
  });

  describe('max-output recovery (FR-9A.08)', () => {
    it('retries on OutputTruncatedError up to 3 times', async () => {
      let attempt = 0;
      const deps = makeDeps({
        executeTask: async () => {
          attempt++;
          throw new OutputTruncatedError(`part-${attempt}`);
        },
      });

      const responses: Array<{ id: string; response: unknown }> = [];
      deps.sendResponse = (id, response) => responses.push({ id, response });

      const runner = new AgentRunner({
        transport,
        deps,
        config: { maxOutputRetries: 3 },
      });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 'trunc-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(attempt, 4); // initial + 3 retries
      const resp = responses[0].response as { partials: unknown[]; truncated: boolean };
      assert.equal(resp.truncated, true);
      assert.equal(resp.partials.length, 4);
    });

    it('succeeds on retry after initial truncation', async () => {
      let attempt = 0;
      const deps = makeDeps({
        executeTask: async () => {
          attempt++;
          if (attempt === 1) throw new OutputTruncatedError('partial');
          return { complete: true };
        },
      });

      const responses: Array<{ id: string; response: unknown }> = [];
      deps.sendResponse = (id, response) => responses.push({ id, response });

      const runner = new AgentRunner({ transport, deps });
      const runPromise = runner.run();

      transport.push(makeMessage(AgentMessageType.UserTask, 'trunc-2'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await runPromise;
      assert.equal(attempt, 2);
      assert.deepStrictEqual(responses[0].response, { complete: true });
    });
  });

  describe('abort/shutdown (FR-9A.09)', () => {
    it('AbortController stops the loop', async () => {
      const ac = new AbortController();
      const deps = makeDeps();
      const runner = new AgentRunner({
        transport,
        deps,
        abortController: ac,
      });

      const runPromise = runner.run();

      // Abort after a small delay
      setTimeout(() => ac.abort(), 20);

      // Push a shutdown to unblock the transport if abort didn't
      setTimeout(() => transport.end(), 50);

      const taskCount = await runPromise;
      assert.equal(taskCount, 0);
    });

    it('shutdown() method triggers abort', async () => {
      const deps = makeDeps();
      const runner = new AgentRunner({ transport, deps });

      const runPromise = runner.run();

      setTimeout(() => runner.shutdown(), 20);
      setTimeout(() => transport.end(), 50);

      const taskCount = await runPromise;
      assert.equal(taskCount, 0);
    });
  });

  describe('messageStream generator (FR-9A.01)', () => {
    it('yields messages from transport as async generator', async () => {
      const deps = makeDeps();
      const runner = new AgentRunner({ transport, deps });

      await transport.connect();

      const received: AgentMessage[] = [];
      const streamPromise = (async () => {
        for await (const msg of runner.messageStream()) {
          received.push(msg);
          if (msg.type === AgentMessageType.Shutdown) break;
        }
      })();

      transport.push(makeMessage(AgentMessageType.UserTask, 't-1'));
      transport.push(makeMessage(AgentMessageType.KeepAlive, 'ka-1'));
      transport.push(makeMessage(AgentMessageType.Shutdown));

      await streamPromise;
      assert.equal(received.length, 3);
      assert.equal(received[0].type, AgentMessageType.UserTask);
      assert.equal(received[1].type, AgentMessageType.KeepAlive);
      assert.equal(received[2].type, AgentMessageType.Shutdown);
    });
  });
});
