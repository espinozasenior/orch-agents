/**
 * TDD: Tests for workspace-provisioner — composes WorktreeManager +
 * LifecycleResolver + ScriptRunner into a single provision() call.
 *
 * London School: all deps are mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceProvisioner } from '../../../src/execution/workspace/workspace-provisioner';
import type { WorktreeManager } from '../../../src/execution/workspace/worktree-manager';
import type { WorktreeHandle } from '../../../src/types';
import type { Logger, LogContext } from '../../../src/shared/logger';
import type { EventBus } from '../../../src/kernel/event-bus';
import type { WorkflowConfig } from '../../../src/config/workflow-config';
import type { PlanId } from '../../../src/kernel/branded-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubLogger(): Logger {
  const noop = (_msg: string, _ctx?: LogContext) => {};
  return { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => stubLogger() };
}

function stubHandle(planId = 'plan-1'): WorktreeHandle {
  return {
    planId: planId as PlanId,
    path: `/tmp/orch-agents/${planId}`,
    branch: `agent/${planId}/coordinator`,
    baseBranch: 'main',
    status: 'active',
  };
}

function stubWorktreeManager(handle?: WorktreeHandle): WorktreeManager {
  const h = handle ?? stubHandle();
  return {
    create: async () => h,
    commit: async () => 'abc1234',
    push: async () => {},
    diff: async () => '',
    dispose: async () => {},
  };
}

function minimalWorkflowConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    repos: {},
    defaults: { agents: { maxConcurrentPerOrg: 8 }, stall: { timeoutMs: 300_000 }, polling: { intervalMs: 30_000, enabled: false } },
    agents: { maxConcurrent: 8 },
    agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 300_000, maxTurns: 20 },
    polling: { intervalMs: 30_000, enabled: false },
    stall: { timeoutMs: 300_000 },
    agentRunner: { stallTimeoutMs: 300_000, command: 'claude', turnTimeoutMs: 3_600_000 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
    promptTemplate: '',
    ...overrides,
  };
}

function collectingEventBus(): EventBus & { published: Array<{ type: string; payload: unknown }> } {
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    published,
    publish(event: { type: string; payload: unknown }) { published.push(event); },
    subscribe() { return () => {}; },
    removeAllListeners() {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceProvisioner', () => {
  it('provisions with setup and start from workflow config', async () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'npm ci', start: 'npm run dev' },
        },
      },
    });

    const provisioner = createWorkspaceProvisioner({
      worktreeManager: stubWorktreeManager(),
      logger: stubLogger(),
      workflowConfig: config,
      scriptRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false }),
      fileExists: () => false,
    });

    const result = await provisioner.provision('plan-1', 'main', 'agent/plan-1/coordinator', 'acme/api');

    assert.strictEqual(result.setupStatus, 'success');
    assert.strictEqual(result.startStatus, 'success');
    assert.strictEqual(result.setupSource, 'workflow');
    assert.strictEqual(result.startSource, 'workflow');
    assert.ok(typeof result.setupDurationMs === 'number');
    assert.ok(typeof result.startDurationMs === 'number');
  });

  it('aborts when setup script fails', async () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'npm ci' },
        },
      },
    });

    const bus = collectingEventBus();
    const provisioner = createWorkspaceProvisioner({
      worktreeManager: stubWorktreeManager(),
      logger: stubLogger(),
      eventBus: bus,
      workflowConfig: config,
      scriptRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'ENOMEM', durationMs: 50, timedOut: false }),
      fileExists: () => false,
    });

    await assert.rejects(
      () => provisioner.provision('plan-1', 'main', 'agent/plan-1/coordinator', 'acme/api'),
      (err: Error) => {
        assert.ok(err.message.includes('setup'));
        return true;
      },
    );

    // WorkspaceSetupFailed should have been emitted
    const failEvent = bus.published.find((e) => e.type === 'WorkspaceSetupFailed');
    assert.ok(failEvent, 'Expected WorkspaceSetupFailed event');
  });

  it('degrades when start script fails (does not abort)', async () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'npm ci', start: 'npm run dev' },
        },
      },
    });

    let callCount = 0;
    const provisioner = createWorkspaceProvisioner({
      worktreeManager: stubWorktreeManager(),
      logger: stubLogger(),
      workflowConfig: config,
      scriptRunner: async () => {
        callCount++;
        // First call (setup) succeeds, second call (start) fails
        if (callCount === 1) return { exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false };
        return { exitCode: 1, stdout: '', stderr: 'port in use', durationMs: 50, timedOut: false };
      },
      fileExists: () => false,
    });

    const result = await provisioner.provision('plan-1', 'main', 'agent/plan-1/coordinator', 'acme/api');

    assert.strictEqual(result.setupStatus, 'success');
    assert.strictEqual(result.startStatus, 'failed');
  });

  it('skips both when no lifecycle scripts configured', async () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': { url: 'https://github.com/acme/api', defaultBranch: 'main' },
      },
    });

    const provisioner = createWorkspaceProvisioner({
      worktreeManager: stubWorktreeManager(),
      logger: stubLogger(),
      workflowConfig: config,
      scriptRunner: async () => { throw new Error('should not be called'); },
      fileExists: () => false,
    });

    const result = await provisioner.provision('plan-1', 'main', 'agent/plan-1/coordinator', 'acme/api');

    assert.strictEqual(result.setupStatus, 'skipped');
    assert.strictEqual(result.startStatus, 'skipped');
    assert.strictEqual(result.setupSource, undefined);
    assert.strictEqual(result.startSource, undefined);
  });

  it('emits WorkspaceSetupStarted and WorkspaceSetupCompleted events', async () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'npm ci' },
        },
      },
    });

    const bus = collectingEventBus();
    const provisioner = createWorkspaceProvisioner({
      worktreeManager: stubWorktreeManager(),
      logger: stubLogger(),
      eventBus: bus,
      workflowConfig: config,
      scriptRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false }),
      fileExists: () => false,
    });

    await provisioner.provision('plan-1', 'main', 'agent/plan-1/coordinator', 'acme/api');

    const startEvent = bus.published.find((e) => e.type === 'WorkspaceSetupStarted');
    const completedEvent = bus.published.find((e) => e.type === 'WorkspaceSetupCompleted');
    assert.ok(startEvent, 'Expected WorkspaceSetupStarted event');
    assert.ok(completedEvent, 'Expected WorkspaceSetupCompleted event');
  });

  it('dispose delegates to worktreeManager', async () => {
    let disposed = false;
    const wm = stubWorktreeManager();
    wm.dispose = async () => { disposed = true; };

    const provisioner = createWorkspaceProvisioner({
      worktreeManager: wm,
      logger: stubLogger(),
      scriptRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
      fileExists: () => false,
    });

    await provisioner.dispose(stubHandle());
    assert.ok(disposed);
  });

  it('discovers repo .orch-agents scripts when workflow has no lifecycle', async () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': { url: 'https://github.com/acme/api', defaultBranch: 'main' },
      },
    });

    const provisioner = createWorkspaceProvisioner({
      worktreeManager: stubWorktreeManager(),
      logger: stubLogger(),
      workflowConfig: config,
      scriptRunner: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 50, timedOut: false }),
      fileExists: (path: string) => path.includes('.orch-agents'),
    });

    const result = await provisioner.provision('plan-1', 'main', 'agent/plan-1/coordinator', 'acme/api');

    assert.strictEqual(result.setupStatus, 'success');
    assert.strictEqual(result.setupSource, 'repo');
    assert.strictEqual(result.startStatus, 'success');
    assert.strictEqual(result.startSource, 'repo');
  });
});
