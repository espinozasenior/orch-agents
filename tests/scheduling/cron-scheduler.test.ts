import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCronExpression, createCronScheduler, type CronScheduler } from '../../src/scheduling/cron-scheduler';
import { createAutomationRunPersistence, type AutomationRunPersistence } from '../../src/scheduling/automation-run-persistence';
import { createEventBus, type EventBus } from '../../src/kernel/event-bus';
import type { WorkflowConfig, RepoConfig } from '../../src/config/workflow-config';
import type { Logger } from '../../src/shared/logger';

// ---------------------------------------------------------------------------
// Cron expression matcher tests
// ---------------------------------------------------------------------------

describe('matchesCronExpression', () => {
  it('matches wildcard expression (every minute)', () => {
    assert.equal(matchesCronExpression('* * * * *', new Date('2026-04-20T10:30:00')), true);
  });

  it('matches specific minute and hour', () => {
    const date = new Date('2026-04-20T14:30:00');
    assert.equal(matchesCronExpression('30 14 * * *', date), true);
    assert.equal(matchesCronExpression('31 14 * * *', date), false);
    assert.equal(matchesCronExpression('30 15 * * *', date), false);
  });

  it('matches step expression */6 for hours', () => {
    assert.equal(matchesCronExpression('0 */6 * * *', new Date('2026-04-20T00:00:00')), true);
    assert.equal(matchesCronExpression('0 */6 * * *', new Date('2026-04-20T06:00:00')), true);
    assert.equal(matchesCronExpression('0 */6 * * *', new Date('2026-04-20T12:00:00')), true);
    assert.equal(matchesCronExpression('0 */6 * * *', new Date('2026-04-20T03:00:00')), false);
  });

  it('matches comma-separated list', () => {
    // Day-of-week: 1=Monday, 5=Friday
    const monday = new Date('2026-04-20T02:30:00'); // Monday
    const friday = new Date('2026-04-24T02:30:00'); // Friday
    const wednesday = new Date('2026-04-22T02:30:00'); // Wednesday

    assert.equal(matchesCronExpression('30 2 * * 1,5', monday), true);
    assert.equal(matchesCronExpression('30 2 * * 1,5', friday), true);
    assert.equal(matchesCronExpression('30 2 * * 1,5', wednesday), false);
  });

  it('matches day-of-month and month', () => {
    assert.equal(matchesCronExpression('0 0 25 12 *', new Date('2026-12-25T00:00:00')), true);
    assert.equal(matchesCronExpression('0 0 25 12 *', new Date('2026-12-26T00:00:00')), false);
  });

  it('rejects expressions with wrong number of fields', () => {
    assert.equal(matchesCronExpression('* * *', new Date()), false);
    assert.equal(matchesCronExpression('* * * * * *', new Date()), false);
  });

  it('matches step with start offset', () => {
    // 5/15 means start at 5, every 15: 5, 20, 35, 50
    assert.equal(matchesCronExpression('5/15 * * * *', new Date('2026-01-01T00:05:00')), true);
    assert.equal(matchesCronExpression('5/15 * * * *', new Date('2026-01-01T00:20:00')), true);
    assert.equal(matchesCronExpression('5/15 * * * *', new Date('2026-01-01T00:10:00')), false);
  });
});

// ---------------------------------------------------------------------------
// CronScheduler integration tests
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  const noopLogger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() { return noopLogger; },
  };

  let eventBus: EventBus;
  let persistence: AutomationRunPersistence;
  let scheduler: CronScheduler;

  function makeConfig(automations: Record<string, RepoConfig['automations']> = {}): WorkflowConfig {
    const repos: Record<string, RepoConfig> = {};
    for (const [name, autos] of Object.entries(automations)) {
      repos[name] = {
        url: `https://github.com/${name}`,
        defaultBranch: 'main',
        ...(autos ? { automations: autos } : {}),
      };
    }
    // Minimal valid WorkflowConfig
    return {
      repos,
      defaults: { agents: { maxConcurrentPerOrg: 8 }, stall: { timeoutMs: 300000 }, polling: { intervalMs: 30000, enabled: false } },
      agents: { maxConcurrent: 8 },
      agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 300000, maxTurns: 20 },
      polling: { intervalMs: 30000, enabled: false },
      stall: { timeoutMs: 300000 },
      agentRunner: { stallTimeoutMs: 300000, command: 'claude', turnTimeoutMs: 3600000 },
      hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60000 },
      promptTemplate: 'test',
    };
  }

  beforeEach(() => {
    eventBus = createEventBus();
    persistence = createAutomationRunPersistence({ dbPath: ':memory:' });
  });

  afterEach(() => {
    scheduler?.stop();
    persistence.close();
    eventBus.removeAllListeners();
  });

  it('triggerManually fires the automation and returns a runId', async () => {
    const config = makeConfig({
      'acme/app': {
        health: { schedule: '0 */6 * * *', instruction: 'Run tests' },
      },
    });

    const published: string[] = [];
    eventBus.subscribe('IntakeCompleted', (e) => published.push(e.payload.intakeEvent.source));
    eventBus.subscribe('AutomationTriggered', (e) => published.push(e.payload.trigger));

    scheduler = createCronScheduler({
      workflowConfigProvider: () => config,
      eventBus,
      logger: noopLogger,
      persistence,
      tickIntervalMs: 999999,
    });
    scheduler.start();

    const runId = await scheduler.triggerManually('acme/app::health');
    assert.ok(runId);
    assert.ok(published.includes('automation'));
    assert.ok(published.includes('manual'));
  });

  it('triggerWebhook fires with webhook trigger type', async () => {
    const config = makeConfig({
      'acme/app': {
        deploy: { trigger: 'webhook', instruction: 'Verify deploy' },
      },
    });

    let triggerType: string | undefined;
    eventBus.subscribe('AutomationTriggered', (e) => { triggerType = e.payload.trigger; });

    scheduler = createCronScheduler({
      workflowConfigProvider: () => config,
      eventBus,
      logger: noopLogger,
      persistence,
      tickIntervalMs: 999999,
    });
    scheduler.start();

    await scheduler.triggerWebhook('acme/app::deploy');
    assert.equal(triggerType, 'webhook');
  });

  it('throws on unknown automation for manual trigger', async () => {
    scheduler = createCronScheduler({
      workflowConfigProvider: () => makeConfig({}),
      eventBus,
      logger: noopLogger,
      persistence,
    });
    scheduler.start();

    await assert.rejects(
      () => scheduler.triggerManually('nonexistent::auto'),
      /Unknown automation/,
    );
  });

  it('resumeAutomation publishes AutomationResumed event', () => {
    const config = makeConfig({
      'acme/app': {
        health: { schedule: '0 * * * *', instruction: 'check' },
      },
    });

    let resumed = false;
    eventBus.subscribe('AutomationResumed', () => { resumed = true; });

    scheduler = createCronScheduler({
      workflowConfigProvider: () => config,
      eventBus,
      logger: noopLogger,
      persistence,
      tickIntervalMs: 999999,
    });
    scheduler.start();

    scheduler.resumeAutomation('acme/app::health');
    assert.equal(resumed, true);
  });

  it('getSnapshot returns all automations with their state', () => {
    const config = makeConfig({
      'acme/app': {
        health: { schedule: '0 */6 * * *', instruction: 'check' },
        deploy: { trigger: 'webhook', instruction: 'verify' },
      },
    });

    scheduler = createCronScheduler({
      workflowConfigProvider: () => config,
      eventBus,
      logger: noopLogger,
      persistence,
      tickIntervalMs: 999999,
    });

    const snapshot = scheduler.getSnapshot();
    assert.equal(snapshot.automations.length, 2);
    assert.ok(snapshot.automations.find((a) => a.automationId === 'acme/app::health'));
    assert.ok(snapshot.automations.find((a) => a.automationId === 'acme/app::deploy'));
  });

  it('records success from AutomationCompleted event', async () => {
    const config = makeConfig({
      'acme/app': {
        health: { schedule: '0 * * * *', instruction: 'check' },
      },
    });

    scheduler = createCronScheduler({
      workflowConfigProvider: () => config,
      eventBus,
      logger: noopLogger,
      persistence,
      tickIntervalMs: 999999,
    });
    scheduler.start();

    // Simulate a failure first
    eventBus.publish({
      type: 'AutomationFailed',
      id: 'e1',
      timestamp: new Date().toISOString(),
      correlationId: 'c1',
      payload: { automationId: 'acme/app::health', runId: 'r1', durationMs: 100, error: 'oops', consecutiveFailures: 1 },
    });

    // Then success
    eventBus.publish({
      type: 'AutomationCompleted',
      id: 'e2',
      timestamp: new Date().toISOString(),
      correlationId: 'c2',
      payload: { automationId: 'acme/app::health', runId: 'r2', durationMs: 200 },
    });

    const snapshot = scheduler.getSnapshot();
    const state = snapshot.automations.find((a) => a.automationId === 'acme/app::health')?.state;
    assert.ok(state);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.lastRunStatus, 'success');
  });

  it('auto-pauses after 3 consecutive AutomationFailed events', () => {
    const config = makeConfig({
      'acme/app': {
        health: { schedule: '0 * * * *', instruction: 'check' },
      },
    });

    let pausedEvent = false;
    eventBus.subscribe('AutomationPaused', () => { pausedEvent = true; });

    scheduler = createCronScheduler({
      workflowConfigProvider: () => config,
      eventBus,
      logger: noopLogger,
      persistence,
      tickIntervalMs: 999999,
    });
    scheduler.start();

    for (let i = 1; i <= 3; i++) {
      eventBus.publish({
        type: 'AutomationFailed',
        id: `e${i}`,
        timestamp: new Date().toISOString(),
        correlationId: `c${i}`,
        payload: { automationId: 'acme/app::health', runId: `r${i}`, durationMs: 100, error: 'fail', consecutiveFailures: i },
      });
    }

    assert.equal(pausedEvent, true);
    const snapshot = scheduler.getSnapshot();
    const state = snapshot.automations.find((a) => a.automationId === 'acme/app::health')?.state;
    assert.ok(state);
    assert.equal(state.paused, true);
    assert.equal(state.consecutiveFailures, 3);
  });
});
