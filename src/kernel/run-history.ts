/**
 * In-memory run history — last 500 runs, keyed by correlationId.
 *
 * Subscribes to the EventBus and folds domain events into RunSummary records
 * the web UI can list and inspect. Linear and GitHub remain the canonical
 * record; this is a *live operational view*, not the system of record. After
 * a process restart the buffer is empty until new webhooks fire — the SSE
 * layer surfaces this honestly via gap-frames.
 *
 * Eviction policy: bounded ring (default 500). On overflow the oldest *fully
 * settled* run (completed/failed/cancelled) is evicted first; if all 500 are
 * still active the absolute oldest by `startedAt` is evicted.
 */

import type { EventBus, EventHandler } from './event-bus';
import type { DomainEventMap, DomainEventType } from './event-types';
import type { PlanId } from './branded-types';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunPhase {
  phaseId: string;
  phaseType: string;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  artifactCount: number;
}

export interface RunAgentActivity {
  execId: string;
  agentRole: string;
  status: 'spawned' | 'completed' | 'failed' | 'cancelled';
  spawnedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: { input: number; output: number };
  error?: string;
}

export interface RunSummary {
  /** Stable across the lifetime of a run; the only id available before PlanCreated fires. */
  correlationId: string;
  /** Assigned when PlanCreated fires; undefined before that. */
  planId?: PlanId;
  status: RunStatus;
  /** Human-readable label derived from intake source (PR #X, issue #Y, automation name, …). */
  title: string;
  source: string;
  repo?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  failureReason?: string;
  phases: RunPhase[];
  agents: RunAgentActivity[];
  /** Total events the history saw for this run (capped at 200 stored). */
  eventCount: number;
}

export interface RunHistory {
  list(): RunSummary[];
  get(idOrPlanId: string): RunSummary | undefined;
  /** Number of runs currently held (≤ capacity). */
  size(): number;
  capacity(): number;
  /** Detach all event-bus subscriptions. Called on shutdown. */
  close(): void;
}

export interface RunHistoryOptions {
  /** Maximum number of runs to retain. Default 500. */
  capacity?: number;
}

/**
 * Subset of event types the run-history actually folds. Anything else is
 * ignored (we don't want every chunk to bloat the summary).
 */
const HANDLED_EVENTS: DomainEventType[] = [
  'IntakeCompleted',
  'PlanCreated',
  'PhaseStarted',
  'PhaseCompleted',
  'AgentSpawned',
  'AgentCompleted',
  'AgentFailed',
  'AgentCancelled',
  'WorkCompleted',
  'WorkFailed',
  'WorkCancelled',
  'AutomationTriggered',
  'AutomationCompleted',
  'AutomationFailed',
];

const DEFAULT_CAPACITY = 500;

export function createRunHistory(
  eventBus: EventBus,
  options: RunHistoryOptions = {},
): RunHistory {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  /** Insertion-ordered map, keyed by correlationId. */
  const runs = new Map<string, RunSummary>();
  /** planId → correlationId for O(1) lookup once a plan is created. */
  const planIdIndex = new Map<string, string>();

  function touch(summary: RunSummary, ts: string): void {
    summary.updatedAt = ts;
    summary.eventCount += 1;
  }

  function isSettled(s: RunSummary): boolean {
    return s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled';
  }

  function evictIfFull(): void {
    if (runs.size < capacity) return;
    // Prefer evicting the oldest settled run; if none settled, evict the absolute oldest.
    let evictKey: string | undefined;
    for (const [key, summary] of runs) {
      if (isSettled(summary)) { evictKey = key; break; }
    }
    if (!evictKey) {
      // All active — evict absolute oldest
      evictKey = runs.keys().next().value;
    }
    if (evictKey) {
      const evicted = runs.get(evictKey);
      runs.delete(evictKey);
      if (evicted?.planId) planIdIndex.delete(evicted.planId);
    }
  }

  function getOrCreate(correlationId: string, ts: string): RunSummary {
    let summary = runs.get(correlationId);
    if (!summary) {
      evictIfFull();
      summary = {
        correlationId,
        status: 'pending',
        title: correlationId, // overwritten by IntakeCompleted
        source: 'unknown',
        startedAt: ts,
        updatedAt: ts,
        phases: [],
        agents: [],
        eventCount: 0,
      };
      runs.set(correlationId, summary);
    }
    return summary;
  }

  function indexPlan(summary: RunSummary, planId: PlanId): void {
    summary.planId = planId;
    planIdIndex.set(planId, summary.correlationId);
  }

  function deriveTitle(intake: DomainEventMap['IntakeCompleted']['payload']['intakeEvent']): string {
    const e = intake.entities;
    if (e.prNumber !== undefined && e.repo) return `${e.repo} PR #${e.prNumber}`;
    if (e.issueNumber !== undefined && e.repo) return `${e.repo} issue #${e.issueNumber}`;
    if (e.requirementId) return `Linear ${e.requirementId}`;
    if (e.repo) return e.repo;
    return `${intake.source} event`;
  }

  // --- Subscriptions -------------------------------------------------------

  const unsubs: Array<() => void> = [];

  function on<T extends DomainEventType>(type: T, handler: EventHandler<T>): void {
    unsubs.push(eventBus.subscribe(type, handler));
  }

  on('IntakeCompleted', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    summary.title = deriveTitle(event.payload.intakeEvent);
    summary.source = event.payload.intakeEvent.source;
    summary.repo = event.payload.intakeEvent.entities.repo;
    if (summary.status === 'pending') summary.status = 'running';
    touch(summary, event.timestamp);
  });

  on('PlanCreated', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    indexPlan(summary, event.payload.workflowPlan.id);
    if (summary.status === 'pending') summary.status = 'running';
    touch(summary, event.timestamp);
  });

  on('PhaseStarted', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    if (!summary.planId) indexPlan(summary, event.payload.planId);
    summary.phases.push({
      phaseId: `${event.payload.planId}-${event.payload.phaseType}`,
      phaseType: event.payload.phaseType,
      status: 'started',
      startedAt: event.timestamp,
      artifactCount: 0,
    });
    touch(summary, event.timestamp);
  });

  on('PhaseCompleted', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    if (!summary.planId) indexPlan(summary, event.payload.phaseResult.planId);
    const phase = summary.phases.find((p) => p.phaseType === event.payload.phaseResult.phaseType);
    if (phase) {
      phase.status = event.payload.phaseResult.status;
      phase.completedAt = event.timestamp;
      phase.durationMs = event.payload.phaseResult.metrics.duration;
      phase.artifactCount = event.payload.phaseResult.artifacts.length;
    } else {
      summary.phases.push({
        phaseId: event.payload.phaseResult.phaseId,
        phaseType: event.payload.phaseResult.phaseType,
        status: event.payload.phaseResult.status,
        startedAt: event.timestamp,
        completedAt: event.timestamp,
        durationMs: event.payload.phaseResult.metrics.duration,
        artifactCount: event.payload.phaseResult.artifacts.length,
      });
    }
    touch(summary, event.timestamp);
  });

  on('AgentSpawned', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    if (!summary.planId) indexPlan(summary, event.payload.planId);
    summary.agents.push({
      execId: event.payload.execId,
      agentRole: event.payload.agentRole,
      status: 'spawned',
      spawnedAt: event.timestamp,
    });
    touch(summary, event.timestamp);
  });

  on('AgentCompleted', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    const agent = summary.agents.find((a) => a.execId === event.payload.execId);
    if (agent) {
      agent.status = 'completed';
      agent.completedAt = event.timestamp;
      agent.durationMs = event.payload.duration;
      agent.tokenUsage = event.payload.tokenUsage;
    }
    touch(summary, event.timestamp);
  });

  on('AgentFailed', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    const agent = summary.agents.find((a) => a.execId === event.payload.execId);
    if (agent) {
      agent.status = 'failed';
      agent.completedAt = event.timestamp;
      agent.durationMs = event.payload.duration;
      agent.error = event.payload.error;
    }
    touch(summary, event.timestamp);
  });

  on('AgentCancelled', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    const agent = summary.agents.find((a) => a.execId === event.payload.execId);
    if (agent) {
      agent.status = 'cancelled';
      agent.completedAt = event.timestamp;
      agent.durationMs = event.payload.duration;
    }
    touch(summary, event.timestamp);
  });

  on('WorkCompleted', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    if (!summary.planId) indexPlan(summary, event.payload.planId);
    summary.status = 'completed';
    summary.completedAt = event.timestamp;
    summary.durationMs = event.payload.totalDuration;
    touch(summary, event.timestamp);
  });

  on('WorkFailed', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    if (event.payload.planId && !summary.planId) indexPlan(summary, event.payload.planId);
    summary.status = 'failed';
    summary.failureReason = event.payload.failureReason;
    summary.completedAt = event.timestamp;
    touch(summary, event.timestamp);
  });

  on('WorkCancelled', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    summary.status = 'cancelled';
    summary.failureReason = event.payload.cancellationReason;
    summary.completedAt = event.timestamp;
    touch(summary, event.timestamp);
  });

  on('AutomationTriggered', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    summary.title = `automation: ${event.payload.automationId}`;
    summary.source = `automation/${event.payload.trigger}`;
    summary.repo = event.payload.repoName;
    if (summary.status === 'pending') summary.status = 'running';
    touch(summary, event.timestamp);
  });

  on('AutomationCompleted', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    summary.status = 'completed';
    summary.completedAt = event.timestamp;
    summary.durationMs = event.payload.durationMs;
    touch(summary, event.timestamp);
  });

  on('AutomationFailed', (event) => {
    const summary = getOrCreate(event.correlationId, event.timestamp);
    summary.status = 'failed';
    summary.failureReason = event.payload.error;
    summary.completedAt = event.timestamp;
    summary.durationMs = event.payload.durationMs;
    touch(summary, event.timestamp);
  });

  return {
    list(): RunSummary[] {
      // Most recent first
      return Array.from(runs.values()).reverse();
    },
    get(idOrPlanId: string): RunSummary | undefined {
      const direct = runs.get(idOrPlanId);
      if (direct) return direct;
      const correlationId = planIdIndex.get(idOrPlanId);
      return correlationId ? runs.get(correlationId) : undefined;
    },
    size(): number {
      return runs.size;
    },
    capacity(): number {
      return capacity;
    },
    close(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      runs.clear();
      planIdIndex.clear();
    },
  };
}

// --- Re-exports needed for the unused-marker on HANDLED_EVENTS ---
// (Exported so the v1 router can sanity-check it stays in sync if events change.)
export { HANDLED_EVENTS };
