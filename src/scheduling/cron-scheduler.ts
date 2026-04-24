/**
 * Cron-based automation scheduler.
 *
 * On each tick (default 60 s) it reads the current WorkflowConfig,
 * checks which cron-based automations are due, and publishes
 * IntakeCompleted events for each. Supports manual trigger and
 * resume of paused automations.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../kernel/event-bus';
import type { Logger } from '../shared/logger';
import type { WorkflowConfig } from '../config/workflow-config';
import type { AutomationRunPersistence } from './automation-run-persistence';
import {
  createInitialState,
  recordSuccess,
  recordFailure,
  resume as resumeState,
  type AutomationState,
} from './automation-state-machine';
import { buildAutomationIntakeEvent } from './automation-intake-adapter';

// ---------------------------------------------------------------------------
// Cron expression matcher (~40 LOC)
// ---------------------------------------------------------------------------

/**
 * Check whether a single cron field matches a given numeric value.
 * Supports: `*`, specific number, `* /N` (step), and comma-separated lists.
 */
function fieldMatches(field: string, value: number, max: number): boolean {
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') return true;

    // Step: */N or N/M (start/step)
    const stepMatch = trimmed.match(/^(\*|\d+)\/(\d+)$/);
    if (stepMatch) {
      const start = stepMatch[1] === '*' ? 0 : parseInt(stepMatch[1], 10);
      const step = parseInt(stepMatch[2], 10);
      if (step <= 0 || step > max) continue;
      if (value >= start && (value - start) % step === 0) return true;
      continue;
    }

    // Exact number
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num === value) return true;
  }
  return false;
}

/**
 * Check if a 5-field cron expression matches a given date.
 * Fields: minute hour day-of-month month day-of-week (0=Sunday).
 */
export function matchesCronExpression(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // cron months are 1-12
  const dayOfWeek = date.getDay();    // 0=Sunday

  return (
    fieldMatches(fields[0], minute, 59) &&
    fieldMatches(fields[1], hour, 23) &&
    fieldMatches(fields[2], dayOfMonth, 31) &&
    fieldMatches(fields[3], month, 12) &&
    fieldMatches(fields[4], dayOfWeek, 7)
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CronSchedulerDeps {
  workflowConfigProvider: () => WorkflowConfig;
  eventBus: EventBus;
  logger: Logger;
  persistence: AutomationRunPersistence;
  tickIntervalMs?: number;
}

export interface SchedulerSnapshot {
  automations: Array<{
    automationId: string;
    repoName: string;
    schedule?: string;
    trigger?: string;
    state: AutomationState;
  }>;
}

export interface CronScheduler {
  start(): void;
  stop(): void;
  triggerManually(automationId: string): Promise<string>;
  triggerWebhook(automationId: string): Promise<string>;
  resumeAutomation(automationId: string): void;
  getSnapshot(): SchedulerSnapshot;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const {
    workflowConfigProvider,
    eventBus,
    logger,
    persistence,
    tickIntervalMs = 60_000,
  } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;

  // In-memory state cache keyed by `repoName::automationName`
  const stateCache = new Map<string, AutomationState>();

  // Track the last minute-key each automation was fired to prevent
  // double-firing within the same calendar minute.
  const lastFiredMinuteKey = new Map<string, string>();

  function automationKey(repoName: string, name: string): string {
    return `${repoName}::${name}`;
  }

  function getState(key: string): AutomationState {
    let state = stateCache.get(key);
    if (!state) {
      state = persistence.loadState(key) ?? createInitialState(key);
      stateCache.set(key, state);
    }
    return state;
  }

  function saveAndCache(state: AutomationState): void {
    stateCache.set(state.automationId, state);
    persistence.saveState(state);
  }

  /**
   * Fire an automation: create intake event, persist run, publish.
   */
  function fireAutomation(
    key: string,
    repoName: string,
    name: string,
    trigger: 'cron' | 'webhook' | 'manual',
  ): string {
    const config = workflowConfigProvider();
    const repoConfig = config.repos[repoName];
    const automationConfig = repoConfig?.automations?.[name];
    if (!automationConfig) {
      throw new Error(`Automation '${key}' not found in current config`);
    }

    const runId = randomUUID();
    const intakeEvent = buildAutomationIntakeEvent(key, repoName, automationConfig, trigger);

    // Persist the run record
    persistence.saveRun({
      runId,
      automationId: key,
      repoName,
      trigger,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    // Emit automation-triggered domain event
    eventBus.publish({
      type: 'AutomationTriggered',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: intakeEvent.id,
      payload: { automationId: key, repoName, trigger, runId },
    });

    // Publish IntakeCompleted so the pipeline picks it up
    eventBus.publish({
      type: 'IntakeCompleted',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: intakeEvent.id,
      payload: { intakeEvent },
    });

    logger.info('Automation fired', { automationId: key, trigger, runId });
    return runId;
  }

  /**
   * Find automation config by key (repoName::name).
   */
  function findAutomation(key: string): { repoName: string; name: string } | undefined {
    const config = workflowConfigProvider();
    for (const [repoName, repoConfig] of Object.entries(config.repos)) {
      if (!repoConfig.automations) continue;
      for (const name of Object.keys(repoConfig.automations)) {
        if (automationKey(repoName, name) === key) {
          return { repoName, name };
        }
      }
    }
    return undefined;
  }

  function tick(): void {
    const now = new Date();
    const config = workflowConfigProvider();

    for (const [repoName, repoConfig] of Object.entries(config.repos)) {
      if (!repoConfig.automations) continue;

      for (const [name, automationConfig] of Object.entries(repoConfig.automations)) {
        // Only cron-scheduled automations fire on tick
        if (!automationConfig.schedule) continue;

        const key = automationKey(repoName, name);
        const state = getState(key);

        if (state.paused) {
          logger.debug('Skipping paused automation', { automationId: key });
          continue;
        }

        if (!matchesCronExpression(automationConfig.schedule, now)) continue;

        // Deduplicate: skip if already fired in this calendar minute
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
        if (lastFiredMinuteKey.get(key) === minuteKey) continue;
        lastFiredMinuteKey.set(key, minuteKey);

        try {
          fireAutomation(key, repoName, name, 'cron');
        } catch (err) {
          logger.error('Failed to fire cron automation', {
            automationId: key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // Subscribe to completion/failure events to track state
  let unsubCompleted: (() => void) | undefined;
  let unsubFailed: (() => void) | undefined;

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(tick, tickIntervalMs);
      // Ensure the timer doesn't keep the process alive
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }

      // Listen for automation result events
      unsubCompleted = eventBus.subscribe('AutomationCompleted', (event) => {
        const { automationId } = event.payload;
        const state = getState(automationId);
        const newState = recordSuccess(state);
        saveAndCache(newState);
      });

      unsubFailed = eventBus.subscribe('AutomationFailed', (event) => {
        const { automationId } = event.payload;
        const state = getState(automationId);
        const result = recordFailure(state);
        saveAndCache(result.state);

        if (result.paused) {
          eventBus.publish({
            type: 'AutomationPaused',
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            correlationId: event.correlationId,
            payload: { automationId, consecutiveFailures: result.state.consecutiveFailures },
          });
          logger.warn('Automation auto-paused after consecutive failures', {
            automationId,
            consecutiveFailures: result.state.consecutiveFailures,
          });
        }
      });

      logger.info('Cron scheduler started', { tickIntervalMs });
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      unsubCompleted?.();
      unsubFailed?.();
      logger.info('Cron scheduler stopped');
    },

    async triggerManually(automationId: string): Promise<string> {
      const found = findAutomation(automationId);
      if (!found) throw new Error(`Unknown automation: ${automationId}`);
      return fireAutomation(automationId, found.repoName, found.name, 'manual');
    },

    async triggerWebhook(automationId: string): Promise<string> {
      const found = findAutomation(automationId);
      if (!found) throw new Error(`Unknown automation: ${automationId}`);
      return fireAutomation(automationId, found.repoName, found.name, 'webhook');
    },

    resumeAutomation(automationId: string): void {
      const state = getState(automationId);
      const newState = resumeState(state);
      saveAndCache(newState);

      eventBus.publish({
        type: 'AutomationResumed',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        correlationId: randomUUID(),
        payload: { automationId },
      });

      logger.info('Automation resumed', { automationId });
    },

    getSnapshot(): SchedulerSnapshot {
      const config = workflowConfigProvider();
      const automations: SchedulerSnapshot['automations'] = [];

      for (const [repoName, repoConfig] of Object.entries(config.repos)) {
        if (!repoConfig.automations) continue;
        for (const [name, automationConfig] of Object.entries(repoConfig.automations)) {
          const key = automationKey(repoName, name);
          automations.push({
            automationId: key,
            repoName,
            schedule: automationConfig.schedule,
            trigger: automationConfig.trigger,
            state: getState(key),
          });
        }
      }

      return { automations };
    },
  };
}
