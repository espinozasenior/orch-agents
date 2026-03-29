/**
 * Symphony orchestrator for Linear-driven execution.
 *
 * This replaces the old polling loop for Linear issues with a bounded
 * state machine: fetch candidate issues, dispatch per-issue workers,
 * reconcile tracker state, and retry with exponential backoff.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Logger } from '../../shared/logger';
import type { WorkflowConfig } from '../../integration/linear/workflow-parser';
import type { LinearClient, LinearIssueResponse } from '../../integration/linear/linear-client';
import type { TokenUsage } from '../../types';

export interface SymphonyOrchestratorDeps {
  workflowConfig: WorkflowConfig;
  workflowConfigProvider?: () => WorkflowConfig;
  workflowState?: () => { valid: boolean; error?: string };
  linearClient: LinearClient;
  logger: Logger;
  worktreeBasePath?: string;
  defaultRepo?: string;
  defaultBranch?: string;
  workerFactory?: (workerPath: string, workerData: Record<string, unknown>) => WorkerLike;
}

export interface WorkerLike {
  on(event: 'message', listener: (message: unknown) => void): WorkerLike;
  on(event: 'error', listener: (error: Error) => void): WorkerLike;
  on(event: 'exit', listener: (code: number) => void): WorkerLike;
  terminate(): Promise<number>;
}

interface RunningEntry {
  worker: WorkerLike;
  issue: LinearIssueResponse;
  startedAt: number;
  lastEventTimestamp: number;
  attempt: number;
  sessionId?: string;
  lastEventType?: string;
  lastActivityAt?: string;
  tokenUsage?: TokenUsage;
  workspacePath: string;
  workerHost: string;
  turnCount: number;
  workerResultStatus?: 'completed' | 'failed' | 'paused';
}

interface RetryEntry {
  attempt: number;
  timer: ReturnType<typeof setTimeout>;
  dueAt: number;
  reason: 'retry' | 'continuation';
  token: number;
  runtime?: Pick<
    RunningEntry,
    'sessionId' | 'lastEventType' | 'lastActivityAt' | 'tokenUsage' | 'workspacePath' | 'workerHost' | 'turnCount'
  >;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
}

export interface SymphonyOrchestrator {
  start(): void;
  stop(): Promise<void>;
  onTick(): Promise<void>;
  getState(): OrchestratorState;
  getSnapshot(): OrchestratorSnapshot;
}

const MAX_RETRY_ATTEMPTS = 10;

export interface OrchestratorRunningSnapshot {
  issueId: string;
  issueIdentifier: string;
  state: string;
  startedAt: number;
  lastEventTimestamp: number;
  sessionId?: string;
  lastEventType?: string;
  lastActivityAt?: string;
  tokenUsage?: TokenUsage;
  workspacePath: string;
  workerHost: string;
  turnCount: number;
  attempt: number;
}

export interface OrchestratorRetrySnapshot {
  issueId: string;
  attempt: number;
  dueAt: number;
  reason: 'retry' | 'continuation';
}

export interface OrchestratorSnapshot {
  starting: boolean;
  workflow: {
    valid: boolean;
    error?: string;
  };
  running: OrchestratorRunningSnapshot[];
  retries: OrchestratorRetrySnapshot[];
  claimed: string[];
  completed: string[];
  startup: {
    cleanedWorkspaces: string[];
    checkedAt?: number;
  };
  nextPollAt?: number;
}

export function createSymphonyOrchestrator(deps: SymphonyOrchestratorDeps): SymphonyOrchestrator {
  const logger = deps.logger.child({ module: 'symphony-orchestrator' });
  const worktreeBasePath = deps.worktreeBasePath ?? '/tmp/orch-agents';
  const state: OrchestratorState = {
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
  };

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let nextPollAt: number | undefined;
  let stopped = false;
  let starting = false;
  let startupInitialized = false;
  let retryTokenCounter = 0;
  const startupState: OrchestratorSnapshot['startup'] = {
    cleanedWorkspaces: [],
  };

  function getWorkflowConfig(): WorkflowConfig {
    return deps.workflowConfigProvider?.() ?? deps.workflowConfig;
  }

  async function onTick(): Promise<void> {
    if (stopped) {
      return;
    }

    if (!startupInitialized) {
      await runStartupCleanup();
      startupInitialized = true;
      starting = false;
    }

    await reconcileRunningIssues();

    const workflowState = deps.workflowState?.();
    if (workflowState && !workflowState.valid) {
      logger.warn('Skipping dispatch because WORKFLOW.md is invalid', {
        error: workflowState.error,
      });
      scheduleNextTick();
      return;
    }

    let candidates: LinearIssueResponse[] = [];
    try {
      const workflowConfig = getWorkflowConfig();
      candidates = await deps.linearClient.fetchIssuesByStates(
        workflowConfig.tracker.team,
        workflowConfig.tracker.activeStates,
      );
    } catch (err) {
      logger.error('Failed to fetch Linear candidate issues', {
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleNextTick();
      return;
    }

    dispatchEligibleCandidates(candidates);

    scheduleNextTick();
  }

  function start(): void {
    if (pollTimer) {
      return;
    }
    stopped = false;
    starting = true;
    logger.info('Starting Symphony orchestrator', {
      pollIntervalMs: getWorkflowConfig().polling.intervalMs,
      maxConcurrentAgents: getWorkflowConfig().agent.maxConcurrentAgents,
    });
    void onTick();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    for (const retryEntry of state.retryAttempts.values()) {
      clearTimeout(retryEntry.timer);
    }
    state.retryAttempts.clear();

    await Promise.all(
      Array.from(state.running.values()).map(async (entry) => {
        await entry.worker.terminate().catch(() => {});
      }),
    );
    state.running.clear();
    state.claimed.clear();
  }

  function getState(): OrchestratorState {
    return state;
  }

  function getSnapshot(): OrchestratorSnapshot {
    const workflow = deps.workflowState?.() ?? { valid: true as const, error: undefined };
    return {
      starting,
      workflow,
      running: Array.from(state.running.entries()).map(([issueId, entry]) => ({
        issueId,
        issueIdentifier: entry.issue.identifier,
        state: entry.issue.state.name,
        startedAt: entry.startedAt,
        lastEventTimestamp: entry.lastEventTimestamp,
        sessionId: entry.sessionId,
        lastEventType: entry.lastEventType,
        lastActivityAt: entry.lastActivityAt,
        tokenUsage: entry.tokenUsage,
        workspacePath: entry.workspacePath,
        workerHost: entry.workerHost,
        turnCount: entry.turnCount,
        attempt: entry.attempt,
      })),
      retries: Array.from(state.retryAttempts.entries()).map(([issueId, entry]) => ({
        issueId,
        attempt: entry.attempt,
        dueAt: entry.dueAt,
        reason: entry.reason,
      })),
      claimed: Array.from(state.claimed.values()),
      completed: Array.from(state.completed.values()),
      startup: {
        cleanedWorkspaces: [...startupState.cleanedWorkspaces],
        checkedAt: startupState.checkedAt,
      },
      nextPollAt,
    };
  }

  function scheduleNextTick(): void {
    if (stopped) {
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    nextPollAt = Date.now() + getWorkflowConfig().polling.intervalMs;
    pollTimer = setTimeout(() => {
      nextPollAt = undefined;
      void onTick();
    }, getWorkflowConfig().polling.intervalMs);
    if (pollTimer.unref) {
      pollTimer.unref();
    }
  }

  function availableSlots(): number {
    return Math.max(0, getWorkflowConfig().agent.maxConcurrentAgents - state.running.size);
  }

  function isEligible(issue: LinearIssueResponse): boolean {
    const workflowConfig = getWorkflowConfig();
    if (!issue.id || !issue.identifier || !issue.title || !issue.state?.name) {
      return false;
    }
    if (!workflowConfig.tracker.activeStates.includes(issue.state.name)) {
      return false;
    }
    if (workflowConfig.tracker.terminalStates.includes(issue.state.name)) {
      return false;
    }
    if (isBlockedIssue(issue)) {
      return false;
    }
    if (state.running.has(issue.id) || state.claimed.has(issue.id)) {
      return false;
    }
    if (!hasAvailableStateSlot(issue.state.name)) {
      return false;
    }
    return availableSlots() > 0;
  }

  function dispatch(
    issue: LinearIssueResponse,
    attempt: number,
    previousRuntime?: RetryEntry['runtime'],
  ): void {
    const workflowConfig = getWorkflowConfig();
    const workerPath = pathResolve(__dirname, 'issue-worker.js');
    const worker = deps.workerFactory
      ? deps.workerFactory(workerPath, {
        issue,
        attempt,
        workflowConfig,
        worktreeBasePath,
        defaultRepo: deps.defaultRepo,
        defaultBranch: deps.defaultBranch,
      })
      : new Worker(workerPath, {
        workerData: {
          issue,
          attempt,
          workflowConfig,
          worktreeBasePath,
          defaultRepo: deps.defaultRepo,
          defaultBranch: deps.defaultBranch,
        },
      });

    state.claimed.add(issue.id);
    state.retryAttempts.delete(issue.id);
    state.running.set(issue.id, {
      worker,
      issue,
      startedAt: Date.now(),
      lastEventTimestamp: Date.now(),
      attempt,
      sessionId: previousRuntime?.sessionId,
      lastEventType: previousRuntime?.lastEventType,
      lastActivityAt: previousRuntime?.lastActivityAt,
      tokenUsage: previousRuntime?.tokenUsage,
      workspacePath: previousRuntime?.workspacePath ?? pathResolve(worktreeBasePath, sanitizePlanId(issue.id)),
      workerHost: previousRuntime?.workerHost ?? 'local',
      turnCount: previousRuntime?.turnCount ?? 0,
    });

    worker.on('message', (message: unknown) => {
      const entry = state.running.get(issue.id);
      if (!entry || !message || typeof message !== 'object') {
        return;
      }
      const payload = message as {
        type?: string;
        sessionId?: string;
        usage?: TokenUsage;
        timestamp?: number;
        status?: 'completed' | 'failed' | 'paused';
        workspacePath?: string;
        lastActivityAt?: string;
      };
      entry.lastEventTimestamp = payload.timestamp ?? Date.now();
      entry.lastEventType = payload.type;
      entry.turnCount += 1;
      entry.sessionId = payload.sessionId ?? entry.sessionId;
      entry.lastActivityAt = payload.lastActivityAt ?? entry.lastActivityAt;
      entry.workspacePath = payload.workspacePath ?? entry.workspacePath;
      if (payload.type === 'tokenUsage' && payload.usage) {
        entry.tokenUsage = payload.usage;
      }
      if (payload.type === 'completed' && payload.status) {
        entry.workerResultStatus = payload.status;
      }
    });

    worker.on('error', (err) => {
      logger.warn('Issue worker emitted error', {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        error: err.message,
      });
    });

    worker.on('exit', (code) => {
      const entry = state.running.get(issue.id);
      if (!entry) {
        return;
      }

      state.running.delete(issue.id);
      if (code === 0) {
        void handleCleanWorkerExit(issue, entry);
        return;
      }

      const nextAttempt = entry.attempt + 1;
      state.claimed.delete(issue.id);
      logger.warn('Issue worker exited abnormally', {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt: nextAttempt,
        exitCode: code,
      });
      scheduleRetry(issue.id, nextAttempt, 'retry', undefined, entry);
    });
  }

  function scheduleRetry(
    issueId: string,
    attempt: number,
    reason: 'retry' | 'continuation',
    delayOverrideMs?: number,
    runtime?: RetryEntry['runtime'],
  ): void {
    if (attempt > MAX_RETRY_ATTEMPTS) {
      state.claimed.delete(issueId);
      state.retryAttempts.delete(issueId);
      logger.warn('Retry attempts exhausted', { issueId, attempt });
      return;
    }

    const existing = state.retryAttempts.get(issueId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const delayMs = delayOverrideMs ?? Math.min(
      10_000 * Math.pow(2, Math.max(attempt - 1, 0)),
      getWorkflowConfig().agent.maxRetryBackoffMs,
    );
    const dueAt = Date.now() + delayMs;
    const token = ++retryTokenCounter;

    const timer = setTimeout(async () => {
      const currentRetry = state.retryAttempts.get(issueId);
      if (!currentRetry || currentRetry.token !== token) {
        return;
      }
      state.retryAttempts.delete(issueId);
      if (stopped) {
        return;
      }

      try {
        const workflowConfig = getWorkflowConfig();
        const issues = await deps.linearClient.fetchIssuesByStates(
          workflowConfig.tracker.team,
          workflowConfig.tracker.activeStates,
        );
        const issue = issues.find((candidate) => candidate.id === issueId);
        if (!issue) {
          state.claimed.delete(issueId);
          state.completed.delete(issueId);
          return;
        }
        if (availableSlots() <= 0 || !isEligible(issue)) {
          scheduleRetry(issueId, attempt + 1, reason, undefined, currentRetry.runtime);
          return;
        }
        dispatch(issue, attempt, currentRetry.runtime);
      } catch (err) {
        logger.warn('Retry fetch failed', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        });
        scheduleRetry(issueId, attempt + 1, reason, undefined, currentRetry.runtime);
      }
    }, delayMs);

    if (timer.unref) {
      timer.unref();
    }

    state.retryAttempts.set(issueId, { attempt, timer, dueAt, reason, token, runtime });
  }

  async function reconcileRunningIssues(): Promise<void> {
    reconcileStalledWorkers();

    const runningIds = Array.from(state.running.keys());
    if (runningIds.length === 0) {
      return;
    }

    let refreshed: Array<{ id: string; state: string }>;
    try {
      refreshed = await deps.linearClient.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      logger.warn('Failed to refresh running issue states', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const issue of refreshed) {
      const entry = state.running.get(issue.id);
      if (!entry) {
        continue;
      }

      const workflowConfig = getWorkflowConfig();
      if (workflowConfig.tracker.terminalStates.includes(issue.state)) {
        await terminateIssue(issue.id, true);
        continue;
      }

      if (!workflowConfig.tracker.activeStates.includes(issue.state)) {
        await terminateIssue(issue.id, false);
      }
    }
  }

  function reconcileStalledWorkers(): void {
    const stallTimeoutMs = getWorkflowConfig().agentRunner.stallTimeoutMs;
    if (stallTimeoutMs <= 0) {
      return;
    }

    for (const [issueId, entry] of state.running.entries()) {
      const elapsed = Date.now() - entry.lastEventTimestamp;
      if (elapsed <= stallTimeoutMs) {
        continue;
      }

      logger.warn('Issue worker stalled; scheduling retry', {
        issueId,
        issueIdentifier: entry.issue.identifier,
        elapsedMs: elapsed,
        stallTimeoutMs,
      });
      state.running.delete(issueId);
      void entry.worker.terminate().catch(() => {});
      cleanupIssueWorkspace(issueId);
      scheduleRetry(issueId, entry.attempt + 1, 'retry', undefined, entry);
    }
  }

  async function terminateIssue(issueId: string, markCompleted: boolean): Promise<void> {
    const entry = state.running.get(issueId);
    if (!entry) {
      return;
    }

    state.running.delete(issueId);
    state.claimed.delete(issueId);
    if (markCompleted) {
      state.completed.add(issueId);
    } else {
      state.completed.delete(issueId);
    }
    await entry.worker.terminate().catch(() => {});
    cleanupIssueWorkspace(issueId);
  }

  function cleanupIssueWorkspace(issueId: string): void {
    const planId = sanitizePlanId(issueId);
    const workspacePath = pathResolve(worktreeBasePath, planId);
    const basePath = pathResolve(worktreeBasePath);
    if (!workspacePath.startsWith(`${basePath}/`)) {
      return;
    }
    if (!existsSync(workspacePath)) {
      return;
    }
    rmSync(workspacePath, { recursive: true, force: true });
  }

  return {
    start,
    stop,
    onTick,
    getState,
    getSnapshot,
  };

  async function handleCleanWorkerExit(issue: LinearIssueResponse, entry: RunningEntry): Promise<void> {
    state.claimed.delete(issue.id);

    try {
      const refreshed = await deps.linearClient.fetchIssuesByStates(
        getWorkflowConfig().tracker.team,
        getWorkflowConfig().tracker.activeStates,
      );
      const activeIssue = refreshed.find((candidate) => candidate.id === issue.id);

      if (activeIssue && entry.workerResultStatus !== 'paused') {
        logger.info('Queueing issue continuation after clean worker exit', {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          nextAttempt: entry.attempt + 1,
        });
        scheduleRetry(issue.id, entry.attempt + 1, 'continuation', 0, entry);
        return;
      }

      if (entry.workerResultStatus === 'completed') {
        state.completed.add(issue.id);
      } else {
        state.completed.delete(issue.id);
      }

      logger.info('Issue worker completed', {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        durationMs: Date.now() - entry.startedAt,
        workerResultStatus: entry.workerResultStatus,
      });
    } catch (err) {
      logger.warn('Failed to revalidate clean worker exit; scheduling retry', {
        issueId: issue.id,
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleRetry(issue.id, entry.attempt + 1, 'retry', undefined, entry);
    }
  }

  function dispatchEligibleCandidates(candidates: LinearIssueResponse[]): void {
    const workflowConfig = getWorkflowConfig();
    const unblocked = candidates.filter((issue) => !isBlockedIssue(issue));

    for (const stateName of workflowConfig.tracker.activeStates) {
      const stateCandidates = sortForDispatch(
        unblocked.filter((issue) => issue.state.name === stateName),
      );
      for (const issue of stateCandidates) {
        if (availableSlots() <= 0) {
          return;
        }
        if (isEligible(issue)) {
          dispatch(issue, 0);
        }
      }
    }
  }

  function hasAvailableStateSlot(stateName: string): boolean {
    const runningInState = Array.from(state.running.values())
      .filter((entry) => entry.issue.state.name === stateName)
      .length;
    return runningInState < getPerStateLimit(stateName);
  }

  function getPerStateLimit(stateName: string): number {
    const workflowConfig = getWorkflowConfig();
    const firstActiveState = workflowConfig.tracker.activeStates[0];
    if (stateName === firstActiveState) {
      return workflowConfig.agent.maxConcurrentAgents;
    }
    return Math.max(1, Math.min(workflowConfig.agent.maxConcurrentAgents, 1));
  }

  async function runStartupCleanup(): Promise<void> {
    starting = true;
    startupState.cleanedWorkspaces = [];
    startupState.checkedAt = Date.now();

    if (!existsSync(worktreeBasePath)) {
      return;
    }

    const entries = readdirSync(worktreeBasePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    if (entries.length === 0) {
      return;
    }

    try {
      const states = await deps.linearClient.fetchIssueStatesByIds(entries);
      const stateByIssueId = new Map(states.map((entry) => [entry.id, entry.state]));

      for (const issueId of entries) {
        const issueState = stateByIssueId.get(issueId);
        if (issueState && getWorkflowConfig().tracker.activeStates.includes(issueState)) {
          continue;
        }
        cleanupIssueWorkspace(issueId);
        startupState.cleanedWorkspaces.push(issueId);
      }
    } catch (err) {
      logger.warn('Startup workspace cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function sortForDispatch(issues: LinearIssueResponse[]): LinearIssueResponse[] {
  return [...issues].sort((left, right) => {
    const priorityDelta = (left.priority ?? 999) - (right.priority ?? 999);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const updatedAtDelta = (left.updatedAt ?? '').localeCompare(right.updatedAt ?? '');
    if (updatedAtDelta !== 0) {
      return updatedAtDelta;
    }
    return left.identifier.localeCompare(right.identifier);
  });
}

function sanitizePlanId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function isBlockedIssue(issue: LinearIssueResponse): boolean {
  if (issue.state.name.toLowerCase() !== 'todo') {
    return false;
  }

  return issue.labels.nodes.some((label) => {
    const normalized = label.name.toLowerCase();
    return normalized === 'blocked' || normalized === 'blocker';
  });
}
