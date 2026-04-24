/**
 * TDD: Tests for lifecycle-resolver — two-layer resolution of per-repo
 * setup.sh / start.sh scripts.
 *
 * London School: fileExists is injected for full isolation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLifecycle } from '../../../src/execution/workspace/lifecycle-resolver';
import type { WorkflowConfig } from '../../../src/config/workflow-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLifecycle', () => {
  it('returns workflow override for setup when configured in WORKFLOW.md', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'npm ci', start: 'npm run dev' },
        },
      },
    });

    const result = resolveLifecycle('acme/api', config, '/tmp/wt', () => true);

    assert.deepStrictEqual(result.setup, { command: 'npm ci', source: 'workflow' });
    assert.deepStrictEqual(result.start, { command: 'npm run dev', source: 'workflow' });
  });

  it('discovers repo .orch-agents/setup.sh when no workflow override', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': { url: 'https://github.com/acme/api', defaultBranch: 'main' },
      },
    });

    // fileExists returns true for setup.sh, false for start.sh
    const fileExists = (path: string) => path.endsWith('setup.sh');
    const result = resolveLifecycle('acme/api', config, '/tmp/wt', fileExists);

    assert.deepStrictEqual(result.setup, { command: 'bash .orch-agents/setup.sh', source: 'repo' });
    assert.strictEqual(result.start, undefined);
  });

  it('returns undefined setup and start when neither source present', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': { url: 'https://github.com/acme/api', defaultBranch: 'main' },
      },
    });

    const result = resolveLifecycle('acme/api', config, '/tmp/wt', () => false);

    assert.strictEqual(result.setup, undefined);
    assert.strictEqual(result.start, undefined);
  });

  it('applies default timeouts when not configured', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': { url: 'https://github.com/acme/api', defaultBranch: 'main' },
      },
    });

    const result = resolveLifecycle('acme/api', config, '/tmp/wt', () => false);

    assert.strictEqual(result.setupTimeout, 300_000);
    assert.strictEqual(result.startTimeout, 120_000);
  });

  it('uses custom timeouts from workflow config', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'make build', setupTimeout: 600_000, startTimeout: 60_000 },
        },
      },
    });

    const result = resolveLifecycle('acme/api', config, '/tmp/wt', () => false);

    assert.strictEqual(result.setupTimeout, 600_000);
    assert.strictEqual(result.startTimeout, 60_000);
  });

  it('workflow override wins over repo script when both present', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': {
          url: 'https://github.com/acme/api',
          defaultBranch: 'main',
          lifecycle: { setup: 'npm ci' },
        },
      },
    });

    // fileExists returns true — .orch-agents/setup.sh exists on disk
    const result = resolveLifecycle('acme/api', config, '/tmp/wt', () => true);

    // Workflow takes precedence
    assert.deepStrictEqual(result.setup, { command: 'npm ci', source: 'workflow' });
  });

  it('returns undefined lifecycle for unknown repo name', () => {
    const config = minimalWorkflowConfig({
      repos: {
        'acme/api': { url: 'https://github.com/acme/api', defaultBranch: 'main' },
      },
    });

    const result = resolveLifecycle('unknown/repo', config, '/tmp/wt', () => false);

    assert.strictEqual(result.setup, undefined);
    assert.strictEqual(result.start, undefined);
  });

  it('handles undefined workflowConfig gracefully', () => {
    const result = resolveLifecycle('acme/api', undefined, '/tmp/wt', () => false);

    assert.strictEqual(result.setup, undefined);
    assert.strictEqual(result.start, undefined);
    assert.strictEqual(result.setupTimeout, 300_000);
    assert.strictEqual(result.startTimeout, 120_000);
  });
});
