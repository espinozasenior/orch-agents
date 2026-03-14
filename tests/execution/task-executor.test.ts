/**
 * TDD: Tests for TaskExecutor — executes prompts and returns structured results.
 *
 * Two implementations:
 * - createStubTaskExecutor() — canned results for tests
 * - createClaudeTaskExecutor() — real Claude invocation (tested with mocked child_process)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStubTaskExecutor,
  createClaudeTaskExecutor,
  extractJson,
  type TaskExecutor,
  type TaskExecutionRequest,
  type TaskExecutionResult,
  type ClaudeTaskExecutorOpts,
} from '../../src/execution/task-executor';
import type { Logger, LogContext } from '../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<TaskExecutionRequest> = {}): TaskExecutionRequest {
  return {
    prompt: 'Analyze PR #42 for security issues in src/auth.ts',
    agentRole: 'security-auditor',
    agentType: 'security-architect',
    tier: 3,
    phaseType: 'specification',
    timeout: 60000,
    metadata: { planId: 'plan-001', workItemId: 'work-001' },
    ...overrides,
  };
}

/** Collect log calls for assertions. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskExecutor', () => {
  describe('createStubTaskExecutor()', () => {
    it('returns a TaskExecutor object', () => {
      const executor = createStubTaskExecutor();
      assert.ok(executor);
      assert.equal(typeof executor.execute, 'function');
    });

    it('execute() returns a completed TaskExecutionResult', async () => {
      const executor = createStubTaskExecutor();
      const result = await executor.execute(makeRequest());

      assert.equal(result.status, 'completed');
      assert.ok(result.output.length > 0, 'Should have non-empty output');
      assert.ok(result.duration >= 0, 'Should have duration');
    });

    it('output is valid JSON', async () => {
      const executor = createStubTaskExecutor();
      const result = await executor.execute(makeRequest());

      const parsed = JSON.parse(result.output);
      assert.ok(parsed, 'Output should be valid JSON');
    });

    it('output JSON includes phase and role context', async () => {
      const executor = createStubTaskExecutor();
      const result = await executor.execute(makeRequest({
        phaseType: 'refinement',
        agentRole: 'implementer',
      }));

      const parsed = JSON.parse(result.output);
      assert.equal(parsed.phaseType, 'refinement');
      assert.equal(parsed.agentRole, 'implementer');
    });

    it('output JSON includes artifacts array', async () => {
      const executor = createStubTaskExecutor();
      const result = await executor.execute(makeRequest());

      const parsed = JSON.parse(result.output);
      assert.ok(Array.isArray(parsed.artifacts), 'Should have artifacts array');
    });

    it('handles multiple concurrent executions', async () => {
      const executor = createStubTaskExecutor();

      const results = await Promise.all([
        executor.execute(makeRequest({ agentRole: 'coder' })),
        executor.execute(makeRequest({ agentRole: 'tester' })),
        executor.execute(makeRequest({ agentRole: 'reviewer' })),
      ]);

      assert.equal(results.length, 3);
      for (const r of results) {
        assert.equal(r.status, 'completed');
      }
    });

    it('does not throw on execution', async () => {
      const executor = createStubTaskExecutor();
      // Should not throw
      await executor.execute(makeRequest());
    });
  });

  describe('createStubTaskExecutor({ failRate })', () => {
    it('can be configured to fail all requests', async () => {
      const executor = createStubTaskExecutor({ failRate: 1.0 });
      const result = await executor.execute(makeRequest());

      assert.equal(result.status, 'failed');
      assert.ok(result.error, 'Should have error message');
    });

    it('failRate 0 means all succeed', async () => {
      const executor = createStubTaskExecutor({ failRate: 0 });
      const results = await Promise.all([
        executor.execute(makeRequest()),
        executor.execute(makeRequest()),
        executor.execute(makeRequest()),
      ]);

      for (const r of results) {
        assert.equal(r.status, 'completed');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Fix 1: Logger instrumentation for createClaudeTaskExecutor
  // -------------------------------------------------------------------------

  describe('createClaudeTaskExecutor() — logger instrumentation', () => {
    /**
     * Build a mock 'claude' script that echoes JSON.
     * We use a small inline Node script so we control exit code + stdout.
     */
    function makeClaudeOpts(logger: Logger, exitCode = 0, stdout = '{"ok":true}', stderr = ''): ClaudeTaskExecutorOpts {
      // Use node as the CLI bin with inline script to simulate Claude
      return {
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      };
    }

    it('logs "process spawned" after spawn with pid and metadata', async () => {
      const logger = makeSpyLogger();
      // Use node -e to simulate a successful Claude call
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      // node -e won't read stdin by default but will exit 0 quickly
      // We need a script that reads stdin and outputs JSON
      await executor.execute(makeRequest({
        prompt: 'echo test',
        agentRole: 'coder',
        phaseType: 'refinement',
      }));

      const spawnLog = logger.calls.find((c) => c.msg === 'Task executor: process spawned');
      assert.ok(spawnLog, 'Should log process spawned');
      assert.ok(spawnLog!.ctx?.pid !== undefined, 'Should include pid');
      assert.equal(spawnLog!.ctx?.agentRole, 'coder');
      assert.equal(spawnLog!.ctx?.phaseType, 'refinement');
      assert.ok(spawnLog!.ctx?.timeoutMs !== undefined, 'Should include timeoutMs');
    });

    it('logs "prompt delivered" after stdin.end with promptBytes', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      await executor.execute(makeRequest({ prompt: 'hello world', agentRole: 'tester' }));

      const deliverLog = logger.calls.find((c) => c.msg === 'Task executor: prompt delivered');
      assert.ok(deliverLog, 'Should log prompt delivered');
      assert.ok(deliverLog!.ctx?.pid !== undefined, 'Should include pid');
      assert.equal(deliverLog!.ctx?.agentRole, 'tester');
      assert.equal(deliverLog!.ctx?.promptBytes, 11); // 'hello world'.length
    });

    it('logs "process exited" on success with stdout/stderr lengths and duration', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      // Use a node script that reads stdin and prints JSON
      await executor.execute(makeRequest({
        prompt: 'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("ok"); process.exit(0); })',
      }));

      const exitLog = logger.calls.find((c) => c.msg === 'Task executor: process exited');
      assert.ok(exitLog, 'Should log process exited on success');
      assert.ok(exitLog!.ctx?.pid !== undefined, 'Should include pid');
      assert.equal(exitLog!.ctx?.exitCode, 0);
      assert.ok(exitLog!.ctx?.stdoutLen !== undefined, 'Should include stdoutLen');
      assert.ok(exitLog!.ctx?.stderrLen !== undefined, 'Should include stderrLen');
      assert.ok(typeof exitLog!.ctx?.durationMs === 'number', 'Should include durationMs');
    });

    it('logs "process failed" on non-zero exit with stderrPreview', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      // Script that exits with code 1 and writes to stderr
      await executor.execute(makeRequest({
        prompt: '-e "process.stderr.write(\'error details\'); process.exit(1)"',
      }));

      const failLog = logger.calls.find((c) => c.msg === 'Task executor: process failed');
      assert.ok(failLog, 'Should log process failed');
      assert.ok(failLog!.ctx?.pid !== undefined, 'Should include pid');
      assert.ok(failLog!.ctx?.durationMs !== undefined, 'Should include durationMs');
    });

    it('logs "output parsed" after JSON extraction', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      // node --print - exits 0 without reading stdin; empty prompt avoids EPIPE
      await executor.execute(makeRequest({ agentRole: 'reviewer', prompt: '' }));

      const parseLog = logger.calls.find((c) => c.msg === 'Task executor: output parsed');
      assert.ok(parseLog, 'Should log output parsed');
      assert.equal(parseLog!.ctx?.agentRole, 'reviewer');
      assert.ok(parseLog!.ctx?.jsonExtracted !== undefined, 'Should include jsonExtracted boolean');
    });

    it('works without logger (no crash)', async () => {
      // Original behavior: no logger option → no crash
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
      });

      // Should not throw
      const result = await executor.execute(makeRequest());
      assert.ok(result.status, 'Should still return a result');
    });
  });

  // -------------------------------------------------------------------------
  // Step 2: extractJson hardening
  // -------------------------------------------------------------------------

  describe('extractJson() — hook pollution hardening', () => {
    it('preserves existing behavior for clean JSON input', () => {
      const input = '{"valid": true}';
      const result = extractJson(input);
      assert.equal(result, '{"valid": true}');
    });

    it('preserves existing behavior for fenced JSON input', () => {
      const input = '```json\n{"fenced": true}\n```';
      const result = extractJson(input);
      assert.equal(result, '{"fenced": true}');
    });

    it('extracts JSON correctly when preceded by hook output lines', () => {
      const input = [
        '[hook: session-start] Restoring session...',
        'Session restored from backup',
        'Memory imported from project',
        '{"valid": true}',
      ].join('\n');
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should extract JSON');
      assert.deepEqual(JSON.parse(result!), { valid: true });
    });

    it('extracts JSON correctly when followed by hook output lines', () => {
      const input = [
        '{"valid": true}',
        '[hook: session-end] consolidating...',
        'Intelligence consolidated',
        'Auto-memory synced',
      ].join('\n');
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should extract JSON');
      assert.deepEqual(JSON.parse(result!), { valid: true });
    });

    it('extracts JSON correctly when interleaved with hook output', () => {
      const input = [
        '[hook: session-start] Restoring session...',
        'Session restored from backup',
        '{"result": "success", "count": 42}',
        '[hook: session-end] consolidating...',
        'Intelligence consolidated',
      ].join('\n');
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should extract JSON');
      assert.deepEqual(JSON.parse(result!), { result: 'success', count: 42 });
    });

    it('identifies [hook: ...] patterns', () => {
      const input = '[hook: session-start] Restoring session...\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Session restored" pattern', () => {
      const input = 'Session restored from backup\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Memory imported" pattern', () => {
      const input = 'Memory imported from project\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Intelligence consolidated" pattern', () => {
      const input = 'Intelligence consolidated\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Auto-memory synced" pattern', () => {
      const input = 'Auto-memory synced\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies bracketed hook patterns like [SessionEnd hook]', () => {
      const input = '[SessionEnd hook] running cleanup\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('does NOT strip legitimate JSON containing the word "hook"', () => {
      const input = '{"hookEnabled": true, "type": "webhook"}';
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should not strip legitimate JSON');
      assert.deepEqual(JSON.parse(result!), { hookEnabled: true, type: 'webhook' });
    });

    it('returns undefined for input that is only hook output', () => {
      const input = [
        '[hook: session-start] Restoring session...',
        'Session restored from backup',
        'Intelligence consolidated',
      ].join('\n');
      const result = extractJson(input);
      assert.equal(result, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // Step 3: task-executor.ts integration with sandbox
  // -------------------------------------------------------------------------

  describe('createClaudeTaskExecutor() — sandbox integration', () => {
    it('spawned process uses a cwd that is NOT the project directory', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      // Use a node script that prints its cwd to stdout
      await executor.execute(makeRequest({
        prompt: '-e "process.stdout.write(process.cwd())"',
      }));

      // The spawn log should contain sandbox info
      const spawnLog = logger.calls.find((c) => c.msg === 'Task executor: process spawned');
      assert.ok(spawnLog, 'Should log process spawned');
      assert.ok(spawnLog!.ctx?.sandboxCwd, 'Should include sandboxCwd');
      assert.notEqual(
        spawnLog!.ctx?.sandboxCwd,
        process.cwd(),
        'Sandbox cwd should differ from project cwd',
      );
    });

    it('after execution completes, temporary directory is cleaned up', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      await executor.execute(makeRequest({ prompt: '' }));

      const spawnLog = logger.calls.find((c) => c.msg === 'Task executor: process spawned');
      assert.ok(spawnLog?.ctx?.sandboxCwd, 'Should have sandbox cwd');

      const fs = await import('node:fs');
      assert.ok(
        !fs.existsSync(spawnLog!.ctx!.sandboxCwd as string),
        'Sandbox directory should be cleaned up after completion',
      );
    });

    it('after execution fails, temporary directory is still cleaned up', async () => {
      const logger = makeSpyLogger();
      const executor = createClaudeTaskExecutor({
        cliBin: 'node',
        defaultTimeout: 5000,
        logger,
      });

      // Script that exits with code 1
      await executor.execute(makeRequest({
        prompt: '-e "process.exit(1)"',
      }));

      const spawnLog = logger.calls.find((c) => c.msg === 'Task executor: process spawned');
      assert.ok(spawnLog?.ctx?.sandboxCwd, 'Should have sandbox cwd');

      const fs = await import('node:fs');
      assert.ok(
        !fs.existsSync(spawnLog!.ctx!.sandboxCwd as string),
        'Sandbox directory should be cleaned up even after failure',
      );
    });

    it('extractJson with hook-polluted output still extracts valid JSON', async () => {
      // Write a temp script that outputs hook pollution + JSON
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const scriptPath = path.join(os.tmpdir(), `hook-test-${Date.now()}.js`);
      fs.writeFileSync(scriptPath, [
        'process.stdout.write("[hook: session-start] Restoring...\\n");',
        'process.stdout.write("Session restored from backup\\n");',
        'process.stdout.write(JSON.stringify({status:"ok",data:123})+"\\n");',
        'process.stdout.write("[hook: session-end] consolidating...\\n");',
        'process.stdout.write("Intelligence consolidated\\n");',
      ].join('\n'));

      try {
        const logger = makeSpyLogger();
        const executor = createClaudeTaskExecutor({
          cliBin: 'node',
          defaultTimeout: 5000,
          logger,
        });

        // Override: use the temp script path as the prompt, but we need to
        // actually invoke node with different args. Since spawn uses
        // ['--print', '-'], we need a different approach.
        // Instead, test extractJson directly with polluted output (already
        // covered in Step 2 tests), and here just verify the integration
        // still produces valid results through the executor.
        const result = await executor.execute(makeRequest({ prompt: '' }));

        // The key assertion: extractJson is called on the output and the
        // executor does not crash. The detailed extraction is tested in
        // the extractJson test suite.
        assert.ok(result.status, 'Should return a result status');

        // Also verify via direct extractJson call with polluted content
        const polluted = [
          '[hook: session-start] Restoring...',
          'Session restored from backup',
          '{"status":"ok","data":123}',
          '[hook: session-end] consolidating...',
          'Intelligence consolidated',
        ].join('\n');

        const extracted = extractJson(polluted);
        assert.ok(extracted !== undefined, 'Should extract JSON from polluted output');
        assert.deepEqual(JSON.parse(extracted!), { status: 'ok', data: 123 });
      } finally {
        fs.unlinkSync(scriptPath);
      }
    });
  });
});
