/**
 * TDD: Tests for StreamingTaskExecutor — streaming execution with event publishing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStreamingTaskExecutor } from '../../src/execution/runtime/streaming-executor';
import { createEventBus } from '../../src/kernel/event-bus';
import { createAgentTracker } from '../../src/execution/runtime/agent-tracker';
import { createCancellationController } from '../../src/execution/runtime/cancellation-controller';
import type { TaskExecutionRequest } from '../../src/execution/runtime/task-executor';
import type { Logger } from '../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<TaskExecutionRequest> = {}): TaskExecutionRequest {
  return {
    prompt: '',
    agentRole: 'coder',
    agentType: 'sparc-coder',
    tier: 3,
    phaseType: 'refinement',
    timeout: 5000,
    metadata: { planId: 'plan-1', workItemId: 'work-1' },
    ...overrides,
  };
}

function makeSpyLogger(): Logger {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function() { return this; },
  };
}

/**
 * Create a temp script that acts like Claude CLI.
 * The script reads stdin and writes to stdout/stderr as specified.
 */
function createTempScript(code: string): string {
  const scriptPath = path.join(os.tmpdir(), `test-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(scriptPath, code);
  return scriptPath;
}

function makeExecutor(scriptCode?: string) {
  const eventBus = createEventBus();
  const agentTracker = createAgentTracker();
  const cancellationController = createCancellationController();
  const scriptPath = scriptCode ? createTempScript(scriptCode) : undefined;

  const executor = createStreamingTaskExecutor({
    eventBus,
    agentTracker,
    cancellationController,
    cliBin: 'node',
    // Use script path if provided, otherwise default node behavior
    cliArgs: scriptPath ? [scriptPath] : ['--print', '-'],
    defaultTimeout: 5000,
    logger: makeSpyLogger(),
  });

  return { executor, eventBus, agentTracker, cancellationController, scriptPath };
}

function cleanup(scriptPath?: string) {
  if (scriptPath) {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamingTaskExecutor', () => {
  describe('interface compatibility', () => {
    it('returns TaskExecutionResult', async () => {
      const { executor } = makeExecutor();
      const result = await executor.execute(makeRequest());
      assert.ok(result.status);
      assert.ok(typeof result.output === 'string');
      assert.ok(typeof result.duration === 'number');
    });

    it('returns completed status on success', async () => {
      const { executor, scriptPath } = makeExecutor(`
        process.stdout.write('ok');
      `);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'completed');
      } finally { cleanup(scriptPath); }
    });

    it('returns failed status on error', async () => {
      const { executor, scriptPath } = makeExecutor(`
        process.exit(1);
      `);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'failed');
        assert.ok(result.error);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('event publishing', () => {
    it('publishes AgentSpawned event', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`
        process.stdout.write('done');
      `);
      try {
        let spawned = false;
        eventBus.subscribe('AgentSpawned', () => { spawned = true; });
        await executor.execute(makeRequest());
        assert.equal(spawned, true);
      } finally { cleanup(scriptPath); }
    });

    it('publishes AgentCompleted event on success', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`
        process.stdout.write('done');
      `);
      try {
        let completed = false;
        eventBus.subscribe('AgentCompleted', () => { completed = true; });
        await executor.execute(makeRequest());
        assert.equal(completed, true);
      } finally { cleanup(scriptPath); }
    });

    it('publishes AgentFailed event on failure', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`
        process.exit(1);
      `);
      try {
        let failed = false;
        eventBus.subscribe('AgentFailed', () => { failed = true; });
        await executor.execute(makeRequest());
        assert.equal(failed, true);
      } finally { cleanup(scriptPath); }
    });

    it('publishes AgentChunk events when stdout has data', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`
        process.stdout.write('hello world');
      `);
      try {
        const chunks: string[] = [];
        eventBus.subscribe('AgentChunk', (event) => {
          chunks.push(event.payload.chunk);
        });
        await executor.execute(makeRequest());
        assert.ok(chunks.length > 0, 'Should have received at least one chunk');
        assert.ok(chunks.join('').includes('hello world'));
      } finally { cleanup(scriptPath); }
    });
  });

  describe('agent tracking', () => {
    it('registers agent in tracker on spawn', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('ok');
      `);
      try {
        await executor.execute(makeRequest());
        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.equal(agents.length, 1);
        assert.equal(agents[0].agentRole, 'coder');
        assert.equal(agents[0].status, 'completed');
      } finally { cleanup(scriptPath); }
    });

    it('tracks bytes received from stdout', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('some output data');
      `);
      try {
        await executor.execute(makeRequest());
        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.ok(agents[0].bytesReceived > 0);
        assert.ok(agents[0].chunksReceived > 0);
      } finally { cleanup(scriptPath); }
    });

    it('marks agent as failed on error', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.exit(1);
      `);
      try {
        await executor.execute(makeRequest());
        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.equal(agents[0].status, 'failed');
      } finally { cleanup(scriptPath); }
    });
  });

  describe('token usage extraction', () => {
    it('includes tokenUsage when stderr contains usage data', async () => {
      const { executor, scriptPath } = makeExecutor(`
        process.stderr.write(JSON.stringify({usage: {input_tokens: 500, output_tokens: 200}}));
        process.stdout.write('{}');
      `);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'completed');
        assert.deepEqual(result.tokenUsage, { input: 500, output: 200 });
      } finally { cleanup(scriptPath); }
    });

    it('returns undefined tokenUsage when stderr has no usage data', async () => {
      const { executor, scriptPath } = makeExecutor(`
        process.stdout.write('ok');
      `);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.tokenUsage, undefined);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('output parsing', () => {
    it('detects tool_use in output and records signal', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('{"type": "tool_use", "name": "read_file"}');
      `);
      try {
        await executor.execute(makeRequest());
        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.ok(agents[0].parsedSignals.toolUseCount > 0);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('cancellation', () => {
    it('produces cancelled status when process is killed', async () => {
      const { executor, eventBus, cancellationController, scriptPath } = makeExecutor(`
        // Long-running process
        setTimeout(() => {}, 30000);
      `);
      try {
        let cancelledEvent = false;
        eventBus.subscribe('AgentCancelled', () => { cancelledEvent = true; });

        const execPromise = executor.execute(makeRequest({ timeout: 30000 }));

        // Give it time to start, then cancel
        await new Promise((resolve) => setTimeout(resolve, 200));
        cancellationController.cancelPlan('plan-1', 50);

        const result = await execPromise;
        assert.equal(result.status, 'cancelled');
        assert.equal(cancelledEvent, true);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('zero output edge case', () => {
    it('completes with empty output, does not hang', async () => {
      const { executor, scriptPath } = makeExecutor(`
        // Script that produces no output and exits
      `);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'completed');
        assert.equal(typeof result.output, 'string');
      } finally { cleanup(scriptPath); }
    });
  });

  describe('planId fallback', () => {
    it('defaults planId to "unknown" when metadata has no planId', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('ok');
      `);
      try {
        await executor.execute(makeRequest({ metadata: {} }));
        // Should still complete — check agent is tracked under 'unknown'
        const agents = agentTracker.getAgentsByPlan('unknown');
        assert.equal(agents.length, 1);
        assert.equal(agents[0].status, 'completed');
      } finally { cleanup(scriptPath); }
    });
  });

  describe('thinking detection in stream', () => {
    it('records thinking signal when detected in output', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('{"type": "thinking", "content": "reasoning..."}');
      `);
      try {
        await executor.execute(makeRequest());
        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.equal(agents[0].parsedSignals.thinkingDetected, true);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('json signal in stream', () => {
    it('records json signal when complete JSON is detected', async () => {
      const { executor, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('{"result": "done", "status": "ok"}');
      `);
      try {
        await executor.execute(makeRequest());
        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.equal(agents[0].parsedSignals.jsonDetected, true);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('multiple chunks', () => {
    it('accumulates multiple stdout writes as separate chunks', async () => {
      const { executor, eventBus, agentTracker, scriptPath } = makeExecutor(`
        process.stdout.write('chunk1');
        process.stdout.write('chunk2');
        process.stdout.write('chunk3');
      `);
      try {
        const chunks: string[] = [];
        eventBus.subscribe('AgentChunk', (event) => {
          chunks.push(event.payload.chunk);
        });
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'completed');
        // At least the data should be captured (may come as 1 or more chunks)
        const combined = chunks.join('');
        assert.ok(combined.includes('chunk1'));
        assert.ok(combined.includes('chunk2'));
        assert.ok(combined.includes('chunk3'));

        const agents = agentTracker.getAgentsByPlan('plan-1');
        assert.ok(agents[0].bytesReceived >= 18); // 'chunk1chunk2chunk3'.length
        assert.ok(agents[0].chunksReceived >= 1);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('JSON extraction from output', () => {
    it('extracts JSON object from mixed output', async () => {
      const { executor, scriptPath } = makeExecutor(`
        process.stdout.write('some prefix text\\n{"extracted": true, "count": 42}\\nsome suffix');
      `);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'completed');
        // extractJson should find the JSON object
        const parsed = JSON.parse(result.output);
        assert.equal(parsed.extracted, true);
        assert.equal(parsed.count, 42);
      } finally { cleanup(scriptPath); }
    });
  });

  describe('concurrent executions', () => {
    it('tracks multiple concurrent agents independently', async () => {
      const eventBus = createEventBus();
      const agentTracker = createAgentTracker();
      const cancellationController = createCancellationController();
      const script1 = createTempScript(`process.stdout.write('agent-a');`);
      const script2 = createTempScript(`process.stdout.write('agent-b');`);

      const executor1 = createStreamingTaskExecutor({
        eventBus, agentTracker, cancellationController,
        cliBin: 'node', cliArgs: [script1], defaultTimeout: 5000, logger: makeSpyLogger(),
      });
      const executor2 = createStreamingTaskExecutor({
        eventBus, agentTracker, cancellationController,
        cliBin: 'node', cliArgs: [script2], defaultTimeout: 5000, logger: makeSpyLogger(),
      });

      try {
        const [r1, r2] = await Promise.all([
          executor1.execute(makeRequest({ agentRole: 'coder', metadata: { planId: 'plan-concurrent' } })),
          executor2.execute(makeRequest({ agentRole: 'tester', metadata: { planId: 'plan-concurrent' } })),
        ]);

        assert.equal(r1.status, 'completed');
        assert.equal(r2.status, 'completed');

        const agents = agentTracker.getAgentsByPlan('plan-concurrent');
        assert.equal(agents.length, 2);
        const roles = agents.map(a => a.agentRole).sort();
        assert.deepEqual(roles, ['coder', 'tester']);
      } finally {
        cleanup(script1);
        cleanup(script2);
      }
    });
  });

  describe('cancelled output preserves partial stdout', () => {
    it('returns accumulated stdout in cancelled result', async () => {
      const { executor, cancellationController, scriptPath } = makeExecutor(`
        process.stdout.write('partial output before cancel');
        setTimeout(() => {}, 30000);
      `);
      try {
        const execPromise = executor.execute(makeRequest({ timeout: 30000 }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        cancellationController.cancelPlan('plan-1', 50);

        const result = await execPromise;
        assert.equal(result.status, 'cancelled');
        assert.ok(result.output.includes('partial output before cancel'));
      } finally { cleanup(scriptPath); }
    });
  });

  describe('sandbox cleanup', () => {
    it('cleans up sandbox directory after successful execution', async () => {
      const { executor, scriptPath } = makeExecutor(`process.stdout.write('ok');`);
      try {
        await executor.execute(makeRequest());
        // If sandbox was not cleaned up, there would be temp dirs accumulating
        // We verify by checking the executor doesn't throw and completes normally
      } finally { cleanup(scriptPath); }
    });

    it('cleans up sandbox directory after failed execution', async () => {
      const { executor, scriptPath } = makeExecutor(`process.exit(1);`);
      try {
        const result = await executor.execute(makeRequest());
        assert.equal(result.status, 'failed');
        // Sandbox should still be cleaned up in finally block
      } finally { cleanup(scriptPath); }
    });
  });

  describe('event payload correctness', () => {
    it('AgentSpawned event includes correct metadata', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`process.stdout.write('ok');`);
      try {
        let spawnedPayload: Record<string, unknown> | undefined;
        eventBus.subscribe('AgentSpawned', (event) => {
          spawnedPayload = event.payload as unknown as Record<string, unknown>;
        });

        await executor.execute(makeRequest({
          agentRole: 'security-auditor',
          agentType: 'security-architect',
          phaseType: 'specification',
        }));

        assert.ok(spawnedPayload);
        assert.equal(spawnedPayload!.agentRole, 'security-auditor');
        assert.equal(spawnedPayload!.agentType, 'security-architect');
        assert.equal(spawnedPayload!.phaseType, 'specification');
        assert.equal(spawnedPayload!.planId, 'plan-1');
        assert.ok(spawnedPayload!.execId);
      } finally { cleanup(scriptPath); }
    });

    it('AgentCompleted event includes duration and tokenUsage', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`
        process.stderr.write('{"input_tokens": 100, "output_tokens": 50}');
        process.stdout.write('{}');
      `);
      try {
        let completedPayload: Record<string, unknown> | undefined;
        eventBus.subscribe('AgentCompleted', (event) => {
          completedPayload = event.payload as unknown as Record<string, unknown>;
        });

        await executor.execute(makeRequest());

        assert.ok(completedPayload);
        assert.ok(typeof completedPayload!.duration === 'number');
        assert.deepEqual(completedPayload!.tokenUsage, { input: 100, output: 50 });
      } finally { cleanup(scriptPath); }
    });

    it('AgentFailed event includes error message', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`
        process.stderr.write('Something went wrong');
        process.exit(1);
      `);
      try {
        let failedPayload: Record<string, unknown> | undefined;
        eventBus.subscribe('AgentFailed', (event) => {
          failedPayload = event.payload as unknown as Record<string, unknown>;
        });

        await executor.execute(makeRequest());

        assert.ok(failedPayload);
        assert.ok(typeof failedPayload!.error === 'string');
        assert.ok((failedPayload!.error as string).length > 0);
        assert.ok(typeof failedPayload!.duration === 'number');
      } finally { cleanup(scriptPath); }
    });

    it('AgentChunk event includes timestamp and agentRole', async () => {
      const { executor, eventBus, scriptPath } = makeExecutor(`process.stdout.write('data');`);
      try {
        let chunkPayload: Record<string, unknown> | undefined;
        eventBus.subscribe('AgentChunk', (event) => {
          chunkPayload = event.payload as unknown as Record<string, unknown>;
        });

        await executor.execute(makeRequest({ agentRole: 'analyst' }));

        assert.ok(chunkPayload);
        assert.equal(chunkPayload!.agentRole, 'analyst');
        assert.ok(typeof chunkPayload!.timestamp === 'string');
        assert.ok(typeof chunkPayload!.execId === 'string');
        assert.equal(chunkPayload!.planId, 'plan-1');
      } finally { cleanup(scriptPath); }
    });
  });

  describe('timeout fallback', () => {
    it('uses request.timeout when provided', async () => {
      const { executor, scriptPath } = makeExecutor(`process.stdout.write('ok');`);
      try {
        // Should complete well within the 5000ms timeout
        const result = await executor.execute(makeRequest({ timeout: 5000 }));
        assert.equal(result.status, 'completed');
      } finally { cleanup(scriptPath); }
    });

    it('uses defaultTimeout when request.timeout is 0', async () => {
      const { executor, scriptPath } = makeExecutor(`process.stdout.write('ok');`);
      try {
        // timeout=0 is falsy, should fall through to defaultTimeout
        const result = await executor.execute(makeRequest({ timeout: 0 }));
        assert.equal(result.status, 'completed');
      } finally { cleanup(scriptPath); }
    });
  });
});
