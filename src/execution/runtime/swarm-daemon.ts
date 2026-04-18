/**
 * SwarmDaemon -- capacity manager for agent sessions.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.01, FR-9B.06, FR-9B.07,
 * FR-9B.08, FR-9B.10)
 *
 * Responsibilities:
 * - Manage session capacity with configurable max slots (default 8)
 * - Work queue for pending tasks when at capacity
 * - Dispatch tasks to idle sessions or queue them
 * - Permission resolution (auto-approve or escalate)
 * - Crash recovery with exponential backoff
 * - Bridge-safe tool whitelist filtering
 * - Health reporting: active sessions, queue depth, capacity
 * - Graceful shutdown: stop accepting, drain sessions, exit
 */

import { randomUUID } from 'node:crypto';

import type { Logger } from '../../shared/logger';
import type {
  NdjsonEnvelope,
  TaskPayload,
  ResultMessage,
  PermissionRequestMessage,
  StatusMessage,
  ErrorMessage,
} from './ndjson-protocol';
import {
  SessionRunner,
  calculateBackoff,
} from './session-runner';
import type {
  SessionRunnerConfig,
  SessionRunnerCallbacks,
  SessionInfo,
} from './session-runner';
import {
  evaluatePermission,
  buildSessionPolicy,
  type SessionPermissionPolicy,
} from './permission-evaluator';
import { CapacityWake } from './capacity-wake';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonHealth {
  readonly activeSessions: number;
  readonly idleSessions: number;
  readonly queueDepth: number;
  readonly capacity: number;
  readonly totalSpawns: number;
  readonly totalCrashes: number;
  readonly isShuttingDown: boolean;
}

export interface SwarmDaemonConfig {
  readonly maxSlots?: number;              // default 8
  readonly logger: Logger;
  readonly allowedTools?: readonly string[]; // FR-9B.07
  readonly onPermissionEscalate?: (sessionId: string, request: PermissionRequestMessage) => void;
  readonly autoApprovePermissions?: boolean; // default true
  /** For testing: inject a SessionRunner factory */
  readonly sessionFactory?: (config: SessionRunnerConfig) => SessionRunner;
  readonly workDirBase?: string;           // default os.tmpdir()
}

interface QueuedTask {
  readonly task: NdjsonEnvelope<'task', TaskPayload>;
  readonly enqueuedAt: number;
}

// ---------------------------------------------------------------------------
// Default tool whitelist (FR-9B.07)
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write',
];

// ---------------------------------------------------------------------------
// SwarmDaemon
// ---------------------------------------------------------------------------

export class SwarmDaemon {
  private readonly maxSlots: number;
  private readonly logger: Logger;
  private readonly allowedTools: ReadonlySet<string>;
  private readonly sessions = new Map<string, SessionRunner>();
  private readonly workQueue: QueuedTask[] = [];
  private readonly onPermissionEscalate?: (sessionId: string, request: PermissionRequestMessage) => void;
  private readonly sessionFactory: (config: SessionRunnerConfig) => SessionRunner;
  private readonly workDirBase: string;
  private readonly sessionPolicies = new Map<string, SessionPermissionPolicy>();
  // 9D: Capacity-aware wake with two-tier polling
  private readonly capacityWake: CapacityWake;

  private _isShuttingDown = false;
  private _totalSpawns = 0;
  private _totalCrashes = 0;
  private _zombieReaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: SwarmDaemonConfig) {
    this.maxSlots = config.maxSlots ?? 8;
    this.logger = config.logger.child({ component: 'SwarmDaemon' });
    this.allowedTools = new Set(config.allowedTools ?? DEFAULT_ALLOWED_TOOLS);
    this.onPermissionEscalate = config.onPermissionEscalate;
    this.sessionFactory = config.sessionFactory ?? ((c) => new SessionRunner(c));
    this.workDirBase = config.workDirBase ?? '/tmp';

    // 9D: CapacityWake for intelligent slot management
    this.capacityWake = new CapacityWake({
      maxSlotsTotal: this.maxSlots,
      seekingIntervalMs: 2_000,
      atCapacityIntervalMs: 600_000,
      heartbeatIntervalMs: 30_000,
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start the daemon: enable zombie reaper and shutdown handlers.
   */
  start(): void {
    this._zombieReaperInterval = setInterval(() => this.reapZombies(), 60_000);
    this.logger.info('SwarmDaemon started', { maxSlots: this.maxSlots });
  }

  /**
   * Dispatch a task to an idle session or enqueue if at capacity.
   * FR-9B.01: capacity management
   * FR-9B.07: tool whitelist filtering
   */
  async dispatch(task: NdjsonEnvelope<'task', TaskPayload>): Promise<void> {
    if (this._isShuttingDown) {
      throw new Error('SwarmDaemon is shutting down, not accepting new work');
    }

    // FR-9B.07: tool whitelist check
    if (task.payload.tool && !this.allowedTools.has(task.payload.tool)) {
      this.logger.warn('Blocked tool rejected', {
        tool: task.payload.tool,
        taskId: task.id,
      });
      throw new Error(`Tool "${task.payload.tool}" is not in the allowed tools whitelist`);
    }

    const idle = this.findIdleSession();
    if (idle) {
      idle.dispatch(task);
      this.logger.debug('Task dispatched to idle session', {
        taskId: task.id,
        sessionId: idle.id,
      });
      return;
    }

    if (this.sessions.size < this.maxSlots) {
      const session = await this.spawnNewSession();
      session.dispatch(task);
      this.logger.debug('Task dispatched to new session', {
        taskId: task.id,
        sessionId: session.id,
      });
      return;
    }

    // At capacity: queue the work
    this.workQueue.push({ task, enqueuedAt: Date.now() });
    this.logger.info('Task queued (at capacity)', {
      taskId: task.id,
      queueDepth: this.workQueue.length,
    });
  }

  /**
   * FR-9B.10: health reporting
   */
  health(): DaemonHealth {
    let idle = 0;
    let active = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'idle') idle++;
      else active++;
    }

    // 9D: Capacity metrics available via capacityWake.slotsUsed
    void this.capacityWake.slotsUsed; // access to suppress unused warning

    return {
      activeSessions: active,
      idleSessions: idle,
      queueDepth: this.workQueue.length,
      capacity: this.maxSlots,
      totalSpawns: this._totalSpawns,
      totalCrashes: this._totalCrashes,
      isShuttingDown: this._isShuttingDown,
    };
  }

  /**
   * Graceful shutdown: stop accepting work, drain all sessions, exit.
   */
  async shutdown(drainTimeoutMs = 30_000): Promise<void> {
    this._isShuttingDown = true;
    this.logger.info('Shutdown initiated');

    if (this._zombieReaperInterval) {
      clearInterval(this._zombieReaperInterval);
      this._zombieReaperInterval = null;
    }

    // Drain all sessions in parallel
    const drainPromises = [...this.sessions.values()].map((session) =>
      session.drain(drainTimeoutMs).catch((err) => {
        this.logger.error('Drain error for session', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );

    await Promise.all(drainPromises);

    // Force-kill any remaining children
    for (const session of this.sessions.values()) {
      session.killChild('SIGKILL');
    }
    this.sessions.clear();

    this.logger.info('Shutdown complete');
  }

  /**
   * Get session info snapshots.
   */
  getSessions(): readonly SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  /**
   * Get current queue depth.
   */
  get queueDepth(): number {
    return this.workQueue.length;
  }

  /**
   * Get number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // -----------------------------------------------------------------------
  // Internal: session lifecycle
  // -----------------------------------------------------------------------

  private findIdleSession(): SessionRunner | undefined {
    for (const session of this.sessions.values()) {
      if (session.state === 'idle') return session;
    }
    return undefined;
  }

  private async spawnNewSession(): Promise<SessionRunner> {
    const sessionId = `session-${randomUUID().slice(0, 8)}`;
    const workDir = `${this.workDirBase}/orch-session-${sessionId}`;

    const callbacks: SessionRunnerCallbacks = {
      onResult: (sid, msg) => this.handleResult(sid, msg),
      onPermission: (sid, req) => this.handlePermission(sid, req),
      onCrash: (sid) => this.handleCrash(sid),
      onStatus: (sid, msg) => this.handleStatus(sid, msg),
      onError: (sid, msg) => this.handleError(sid, msg),
    };

    const session = this.sessionFactory({
      id: sessionId,
      workDir,
      callbacks,
      logger: this.logger,
    });

    await session.spawn();
    this.sessions.set(sessionId, session);
    this._totalSpawns++;

    // Build a default permissive policy for this session
    this.sessionPolicies.set(sessionId, buildSessionPolicy('implementer', workDir));

    this.logger.info('Session spawned', { sessionId });
    return session;
  }

  // -----------------------------------------------------------------------
  // Internal: callbacks from SessionRunner (FR-9B.08: DI via callbacks)
  // -----------------------------------------------------------------------

  private handleResult(sessionId: string, _message: ResultMessage): void {
    this.logger.debug('Result received', { sessionId });
    this.drainQueue();
  }

  private handlePermission(sessionId: string, request: PermissionRequestMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.error('Permission request for unknown session', { sessionId });
      return;
    }

    // FR-P7-001: evaluate permission against session policy
    const policy = this.sessionPolicies.get(sessionId)
      ?? buildSessionPolicy('implementer', this.workDirBase);
    const result = evaluatePermission(request.payload, policy);

    if (result.approved) {
      session.sendPermissionResponse(request.id, { approved: true });
      this.logger.debug('Permission approved by policy', { sessionId, requestId: request.id });
    } else if (this.onPermissionEscalate) {
      // Escalate denied requests if handler is configured
      this.onPermissionEscalate(sessionId, request);
    } else {
      session.sendPermissionResponse(request.id, {
        approved: false,
        reason: result.reason ?? 'Denied by session policy',
      });
      this.logger.debug('Permission denied by policy', {
        sessionId,
        requestId: request.id,
        reason: result.reason,
      });
    }
  }

  private handleStatus(sessionId: string, message: StatusMessage): void {
    this.logger.debug('Session status update', {
      sessionId,
      tokensUsed: message.payload.tokensUsed,
      state: message.payload.state,
    });
  }

  private handleError(sessionId: string, message: ErrorMessage): void {
    this.logger.warn('Session error received', {
      sessionId,
      code: message.payload.code,
      message: message.payload.message,
    });
  }

  private async handleCrash(sessionId: string): Promise<void> {
    this._totalCrashes++;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.warn('Session crash detected', {
      sessionId,
      crashCount: session.crashCount,
    });

    // FR-9B.06: max retries
    if (session.crashCount >= this.maxRetries()) {
      this.logger.error('Session exceeded max retries, marking failed', { sessionId });
      this.sessions.delete(sessionId);
      return;
    }

    // FR-9B.06: exponential backoff
    const backoff = calculateBackoff(session.crashCount, 30_000);
    this.logger.info('Respawning session after backoff', {
      sessionId,
      backoffMs: backoff,
      crashCount: session.crashCount,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, backoff));

    if (this._isShuttingDown) return;

    try {
      await session.respawn();
    } catch (err) {
      this.logger.error('Failed to respawn session', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sessions.delete(sessionId);
    }
  }

  private maxRetries(): number {
    return 5;
  }

  // -----------------------------------------------------------------------
  // Internal: queue management
  // -----------------------------------------------------------------------

  private drainQueue(): void {
    if (this.workQueue.length === 0) return;

    const idle = this.findIdleSession();
    if (!idle) return;

    const queued = this.workQueue.shift();
    if (!queued) return;

    try {
      idle.dispatch(queued.task);
      this.logger.debug('Queued task dispatched', {
        taskId: queued.task.id,
        sessionId: idle.id,
        waitMs: Date.now() - queued.enqueuedAt,
      });
    } catch (err) {
      this.logger.error('Failed to dispatch queued task', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-queue at front
      this.workQueue.unshift(queued);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: zombie reaper
  // -----------------------------------------------------------------------

  private reapZombies(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.state === 'failed') {
        this.logger.info('Reaping failed session', { sessionId });
        session.killChild('SIGKILL');
        this.sessions.delete(sessionId);
      }
    }
  }
}
