/**
 * TDD: Tests for the harness integration layer.
 *
 * Covers:
 * - HarnessSession: passthrough, token estimation, compaction, budget
 * - CoordinatorSession: prompt prepend when mode active, passthrough when off
 * - EnhancedExecutor: composition
 *
 * London School TDD — mock the base executor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InteractiveTaskExecutor,
  InteractiveExecutionRequest,
} from '../../../src/execution/runtime/interactive-executor';
import type { TaskExecutionResult } from '../../../src/execution/runtime/task-executor';
import type { Logger, LogContext } from '../../../src/shared/logger';
import { createHarnessSession } from '../../../src/execution/runtime/harness-session';
import { createCoordinatorSession } from '../../../src/execution/runtime/coordinator-session';
import { createEnhancedExecutor } from '../../../src/execution/runtime/enhanced-executor';
import { buildExecutor } from '../../../src/execution/runtime/executor-factory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides: Partial<InteractiveExecutionRequest> = {},
): InteractiveExecutionRequest {
  return {
    prompt: 'Implement auth middleware in src/auth.ts',
    agentRole: 'implementer',
    agentType: 'coder',
    tier: 3,
    phaseType: 'refinement',
    timeout: 60_000,
    metadata: { planId: 'plan-001' },
    worktreePath: '/tmp/orch-agents/plan-001',
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult {
  return {
    status: 'completed',
    output: 'done',
    duration: 100,
    ...overrides,
  };
}

function makeSpyLogger(): Logger & { calls: { level: string; msg: string; ctx?: LogContext }[] } {
  const calls: { level: string; msg: string; ctx?: LogContext }[] = [];
  const spy: Logger & { calls: typeof calls } = {
    calls,
    trace: (msg: string, ctx?: LogContext) => calls.push({ level: 'trace', msg, ctx }),
    debug: (msg: string, ctx?: LogContext) => calls.push({ level: 'debug', msg, ctx }),
    info: (msg: string, ctx?: LogContext) => calls.push({ level: 'info', msg, ctx }),
    warn: (msg: string, ctx?: LogContext) => calls.push({ level: 'warn', msg, ctx }),
    error: (msg: string, ctx?: LogContext) => calls.push({ level: 'error', msg, ctx }),
    fatal: (msg: string, ctx?: LogContext) => calls.push({ level: 'fatal', msg, ctx }),
    child: () => spy,
  };
  return spy;
}

function makeStubExecutor(result?: TaskExecutionResult): InteractiveTaskExecutor & { calls: InteractiveExecutionRequest[] } {
  const calls: InteractiveExecutionRequest[] = [];
  return {
    calls,
    async execute(request: InteractiveExecutionRequest): Promise<TaskExecutionResult> {
      calls.push(request);
      return result ?? makeResult();
    },
  };
}

// ---------------------------------------------------------------------------
// HarnessSession
// ---------------------------------------------------------------------------

describe('HarnessSession', () => {
  describe('passthrough when compaction disabled and no budget', () => {
    it('should delegate directly to base executor', async () => {
      const expected = makeResult({ output: 'passthrough' });
      const base = makeStubExecutor(expected);
      const executor = createHarnessSession({
        baseExecutor: base,
        enableCompaction: false,
      });

      const req = makeRequest();
      const result = await executor.execute(req);

      assert.equal(result.output, 'passthrough');
      assert.equal(base.calls.length, 1);
      assert.equal(base.calls[0].prompt, req.prompt);
    });
  });

  describe('query loop integration (enhanced path)', () => {
    it('should log query loop start when compaction enabled', async () => {
      const logger = makeSpyLogger();
      const base = makeStubExecutor();
      const executor = createHarnessSession({
        baseExecutor: base,
        logger,
        enableCompaction: true,
      });

      await executor.execute(makeRequest());

      const debugCalls = logger.calls.filter(
        (c) => c.level === 'debug' && c.msg.includes('query loop'),
      );
      assert.equal(debugCalls.length, 1);
      assert.ok(
        (debugCalls[0].ctx as Record<string, unknown>).compactionEnabled === true,
        'should include compactionEnabled in context',
      );
    });

    it('should complete successfully via query loop when compaction enabled', async () => {
      const base = makeStubExecutor(makeResult({ output: 'loop-output' }));
      const executor = createHarnessSession({
        baseExecutor: base,
        enableCompaction: true,
      });

      const result = await executor.execute(makeRequest());

      assert.equal(result.status, 'completed');
      assert.ok(result.output.includes('loop-output'));
    });

    it('should use query loop when budget enabled (even without compaction)', async () => {
      const logger = makeSpyLogger();
      const base = makeStubExecutor();
      const executor = createHarnessSession({
        baseExecutor: base,
        logger,
        tokenBudget: 10_000,
        enableCompaction: false,
      });

      await executor.execute(makeRequest());

      const debugCalls = logger.calls.filter(
        (c) => c.level === 'debug' && c.msg.includes('query loop'),
      );
      assert.equal(debugCalls.length, 1);
      assert.ok(
        (debugCalls[0].ctx as Record<string, unknown>).budgetEnabled === true,
        'should include budgetEnabled in context',
      );
    });

    it('should return failed status when base executor fails with model error', async () => {
      const base: InteractiveTaskExecutor = {
        async execute(): Promise<TaskExecutionResult> {
          return makeResult({
            status: 'failed',
            error: 'Connection refused',
          });
        },
      };
      const executor = createHarnessSession({
        baseExecutor: base,
        enableCompaction: true,
      });

      const result = await executor.execute(makeRequest());

      assert.equal(result.status, 'failed');
      assert.ok(result.error?.includes('model_error'));
    });
  });
});

// ---------------------------------------------------------------------------
// CoordinatorSession
// ---------------------------------------------------------------------------

describe('CoordinatorSession', () => {
  describe('coordinator mode on', () => {
    it('should prepend coordinator system prompt to the agent prompt', async () => {
      const base = makeStubExecutor();
      const executor = createCoordinatorSession({ baseExecutor: base });
      const req = makeRequest({ prompt: 'Do the task' });
      await executor.execute(req);

      const sentPrompt = base.calls[0].prompt;
      assert.ok(
        sentPrompt.includes('COORDINATOR SYSTEM PROMPT'),
        'should include coordinator header',
      );
      assert.ok(
        sentPrompt.includes('You are a coordinator'),
        'should include coordinator system prompt content',
      );
      assert.ok(
        sentPrompt.includes('Do the task'),
        'should include original prompt',
      );
    });

    it('should include worker context with MCP clients', async () => {
      const base = makeStubExecutor();
      const executor = createCoordinatorSession({
        baseExecutor: base,
        mcpClients: [{ name: 'my-server' }],
        scratchpadDir: '/tmp/scratchpad',
      });

      await executor.execute(makeRequest());

      const sentPrompt = base.calls[0].prompt;
      assert.ok(sentPrompt.includes('my-server'), 'should include MCP server name');
      assert.ok(sentPrompt.includes('/tmp/scratchpad'), 'should include scratchpad dir');
    });
  });
});

// ---------------------------------------------------------------------------
// EnhancedExecutor composition
// ---------------------------------------------------------------------------

describe('EnhancedExecutor', () => {
  it('should compose harness and coordinator layers', async () => {
    const expected = makeResult({ output: 'composed' });
    const base = makeStubExecutor(expected);
    const executor = createEnhancedExecutor({
      baseExecutor: base,
      enableCompaction: false,
    });

    const result = await executor.execute(makeRequest());
    assert.equal(result.output, 'composed');
  });

  it('should apply coordinator enhancement', async () => {
    const base = makeStubExecutor();
    const executor = createEnhancedExecutor({
      baseExecutor: base,
      enableCompaction: false,
    });

    await executor.execute(makeRequest({ prompt: 'test-task' }));

    const sentPrompt = base.calls[0].prompt;
    assert.ok(sentPrompt.includes('COORDINATOR SYSTEM PROMPT'));
    assert.ok(sentPrompt.includes('test-task'));
  });
});

// ---------------------------------------------------------------------------
// ExecutorFactory (buildExecutor)
// ---------------------------------------------------------------------------

describe('buildExecutor', () => {
  it('should return a working InteractiveTaskExecutor', async () => {
    const expected = makeResult({ output: 'factory-built' });
    const base = makeStubExecutor(expected);
    const executor = buildExecutor({ baseExecutor: base, enableCompaction: false });

    const result = await executor.execute(makeRequest());
    assert.equal(result.output, 'factory-built');
  });
});
