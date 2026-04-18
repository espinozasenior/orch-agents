/**
 * TDD: Tests for CoordinatorSession (P9).
 *
 * London School — mock the baseExecutor via dependency injection
 * and verify behaviour indirectly through the enhanced prompt
 * that reaches the mock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InteractiveTaskExecutor,
  InteractiveExecutionRequest,
} from '../../../src/execution/runtime/interactive-executor';
import type { TaskExecutionResult } from '../../../src/execution/runtime/task-executor';
import { createCoordinatorSession } from '../../../src/execution/runtime/coordinator-session';

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

interface CapturedCall {
  request: InteractiveExecutionRequest;
}

function makeCapturingExecutor(
  result?: TaskExecutionResult,
): InteractiveTaskExecutor & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    async execute(request: InteractiveExecutionRequest): Promise<TaskExecutionResult> {
      calls.push({ request });
      return result ?? makeResult();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoordinatorSession', () => {
  it('execute() enhances prompt with coordinator system context', async () => {
    const baseExecutor = makeCapturingExecutor();
    const session = createCoordinatorSession({ baseExecutor });

    await session.execute(makeRequest({ prompt: 'Do something' }));

    assert.equal(baseExecutor.calls.length, 1);
    const enhanced = baseExecutor.calls[0].request.prompt;
    assert.ok(enhanced.includes('COORDINATOR SYSTEM PROMPT'), 'should contain coordinator system prompt header');
    assert.ok(enhanced.includes('WORKER CONTEXT'), 'should contain worker context header');
    assert.ok(enhanced.includes('Do something'), 'should contain original prompt');
  });

  it('enqueueTask adds task, reflected in prompt context', async () => {
    const baseExecutor = makeCapturingExecutor();
    const session = createCoordinatorSession({ baseExecutor });

    session.enqueueTask({
      id: 'task-1',
      source: 'api',
      description: 'Fix the login page',
      priority: 1,
    });

    await session.execute(makeRequest());

    const enhanced = baseExecutor.calls[0].request.prompt;
    assert.ok(enhanced.includes('QUEUED TASKS'), 'should show queued tasks section');
    assert.ok(enhanced.includes('Fix the login page'), 'should include task description');
    assert.ok(enhanced.includes('priority: 1'), 'should include task priority');
  });

  it('multiple tasks queued maintain order', async () => {
    const baseExecutor = makeCapturingExecutor();
    const session = createCoordinatorSession({ baseExecutor });

    session.enqueueTask({ id: 't-1', source: 'api', description: 'First task', priority: 1 });
    session.enqueueTask({ id: 't-2', source: 'direct', description: 'Second task', priority: 2 });
    session.enqueueTask({ id: 't-3', source: 'linear-webhook', description: 'Third task', priority: 3 });

    await session.execute(makeRequest());

    const enhanced = baseExecutor.calls[0].request.prompt;
    const firstIdx = enhanced.indexOf('First task');
    const secondIdx = enhanced.indexOf('Second task');
    const thirdIdx = enhanced.indexOf('Third task');

    assert.ok(firstIdx < secondIdx, 'First task should appear before Second task');
    assert.ok(secondIdx < thirdIdx, 'Second task should appear before Third task');
  });

  it('execute passes through to baseExecutor with enhanced prompt', async () => {
    const expectedResult = makeResult({ status: 'completed', output: 'all good', duration: 42 });
    const baseExecutor = makeCapturingExecutor(expectedResult);
    const session = createCoordinatorSession({ baseExecutor });

    const result = await session.execute(makeRequest());

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'all good');
    assert.equal(result.duration, 42);
  });

  it('coordinator context includes MCP client names when provided', async () => {
    const baseExecutor = makeCapturingExecutor();
    const session = createCoordinatorSession({
      baseExecutor,
      mcpClients: [{ name: 'slack-mcp' }, { name: 'jira-mcp' }],
    });

    await session.execute(makeRequest());

    const enhanced = baseExecutor.calls[0].request.prompt;
    assert.ok(enhanced.includes('slack-mcp'), 'should include first MCP client name');
    assert.ok(enhanced.includes('jira-mcp'), 'should include second MCP client name');
  });

  it('worker state tracking via prompt inspection after notification processing', async () => {
    // The coordinator processes notifications embedded in the prompt text.
    // Without a real notification XML, the prompt should not contain an
    // action directive (since processNotification returns 'wait').
    const baseExecutor = makeCapturingExecutor();
    const session = createCoordinatorSession({ baseExecutor });

    await session.execute(makeRequest({ prompt: 'Regular task without notification XML' }));

    const enhanced = baseExecutor.calls[0].request.prompt;
    // No COORDINATOR ACTION section when there is no notification
    assert.ok(!enhanced.includes('ACTION REQUIRED'), 'should not contain action directive for plain text');
    assert.ok(enhanced.includes('Regular task without notification XML'), 'original prompt preserved');
  });

  it('empty queue state is handled cleanly', async () => {
    const baseExecutor = makeCapturingExecutor();
    const session = createCoordinatorSession({ baseExecutor });

    // Execute with no tasks enqueued
    await session.execute(makeRequest());

    const enhanced = baseExecutor.calls[0].request.prompt;
    assert.ok(!enhanced.includes('QUEUED TASKS'), 'should not show queued tasks section when queue is empty');
  });

  it('session respects mcpClients option', async () => {
    const baseExecutor = makeCapturingExecutor();

    // With no mcpClients
    const sessionNoClients = createCoordinatorSession({ baseExecutor });
    await sessionNoClients.execute(makeRequest());

    const promptNoClients = baseExecutor.calls[0].request.prompt;

    // With mcpClients
    const baseExecutor2 = makeCapturingExecutor();
    const sessionWithClients = createCoordinatorSession({
      baseExecutor: baseExecutor2,
      mcpClients: [{ name: 'github-mcp' }],
    });
    await sessionWithClients.execute(makeRequest());

    const promptWithClients = baseExecutor2.calls[0].request.prompt;

    // The prompt with MCP clients should contain the client name
    assert.ok(promptWithClients.includes('github-mcp'), 'prompt with clients should include client name');
    assert.ok(!promptNoClients.includes('github-mcp'), 'prompt without clients should not include client name');
  });
});
