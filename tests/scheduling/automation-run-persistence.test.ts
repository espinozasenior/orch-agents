import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationRunPersistence, type AutomationRunPersistence } from '../../src/scheduling/automation-run-persistence';

describe('automation-run-persistence', () => {
  const instances: AutomationRunPersistence[] = [];

  function createTestPersistence(): AutomationRunPersistence {
    const p = createAutomationRunPersistence({ dbPath: ':memory:' });
    instances.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of instances) {
      try { p.close(); } catch { /* already closed */ }
    }
    instances.length = 0;
  });

  it('saves and loads automation state round-trip', () => {
    const p = createTestPersistence();
    p.saveState({
      automationId: 'acme/app::health',
      consecutiveFailures: 2,
      paused: false,
      lastRunAt: '2026-01-01T00:00:00Z',
    });

    const loaded = p.loadState('acme/app::health');
    assert.ok(loaded);
    assert.equal(loaded.automationId, 'acme/app::health');
    assert.equal(loaded.consecutiveFailures, 2);
    assert.equal(loaded.paused, false);
    assert.equal(loaded.lastRunAt, '2026-01-01T00:00:00Z');
  });

  it('returns undefined for unknown automation state', () => {
    const p = createTestPersistence();
    assert.equal(p.loadState('nonexistent'), undefined);
  });

  it('saves paused state with pausedAt', () => {
    const p = createTestPersistence();
    p.saveState({
      automationId: 'x::y',
      consecutiveFailures: 3,
      paused: true,
      pausedAt: '2026-04-20T12:00:00Z',
    });

    const loaded = p.loadState('x::y');
    assert.ok(loaded);
    assert.equal(loaded.paused, true);
    assert.equal(loaded.pausedAt, '2026-04-20T12:00:00Z');
  });

  it('saves a run and retrieves run history', () => {
    const p = createTestPersistence();
    p.saveRun({
      runId: 'run-1',
      automationId: 'acme/app::deploy',
      repoName: 'acme/app',
      trigger: 'cron',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 5000,
    });
    p.saveRun({
      runId: 'run-2',
      automationId: 'acme/app::deploy',
      repoName: 'acme/app',
      trigger: 'manual',
      status: 'failed',
      startedAt: '2026-01-02T00:00:00Z',
      durationMs: 1000,
      error: 'timeout',
    });

    const history = p.getRunHistory('acme/app::deploy');
    assert.equal(history.length, 2);
    // Most recent first
    assert.equal(history[0].runId, 'run-2');
    assert.equal(history[0].error, 'timeout');
    assert.equal(history[1].runId, 'run-1');
    assert.equal(history[1].durationMs, 5000);
  });

  it('respects history limit', () => {
    const p = createTestPersistence();
    for (let i = 0; i < 5; i++) {
      p.saveRun({
        runId: `run-${i}`,
        automationId: 'x::y',
        repoName: 'x',
        trigger: 'cron',
        status: 'completed',
        startedAt: `2026-01-0${i + 1}T00:00:00Z`,
      });
    }

    const limited = p.getRunHistory('x::y', 2);
    assert.equal(limited.length, 2);
  });

  it('upserts run status on conflict', () => {
    const p = createTestPersistence();
    p.saveRun({
      runId: 'run-1',
      automationId: 'a::b',
      repoName: 'a',
      trigger: 'cron',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
    });

    // Update status to completed
    p.saveRun({
      runId: 'run-1',
      automationId: 'a::b',
      repoName: 'a',
      trigger: 'cron',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 3000,
    });

    const history = p.getRunHistory('a::b');
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'completed');
    assert.equal(history[0].durationMs, 3000);
  });
});
