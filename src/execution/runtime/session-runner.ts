/**
 * SessionRunner -- manages a single agent child process with NDJSON I/O.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.02, FR-9B.03, FR-9B.04,
 * FR-9B.05, FR-9B.06, FR-9B.08, FR-9B.09)
 *
 * Responsibilities:
 * - Spawn child process with stream-json flags
 * - Parse NDJSON from child stdout
 * - Track activity state via state machine
 * - Crash recovery with exponential backoff
 * - Dependency injection via callbacks (no direct imports of SwarmDaemon)
 */

import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { spawn as cpSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { buildSafeEnv } from '../../shared/safe-env';
import type { Logger } from '../../shared/logger';
import type { SessionState, SessionTransitionResult } from './session-state-machine';
import { sessionTransition } from './session-state-machine';
import type {
  AnyMessage,
  NdjsonEnvelope,
  ResultMessage,
  PermissionRequestMessage,
  StatusMessage,
  ErrorMessage,
  TaskPayload,
  PermissionResponsePayload,
} from './ndjson-protocol';
import { encodeMessage, decodeMessage } from './ndjson-protocol';
import type { HeartbeatMonitor } from './heartbeat-monitor';
import { createHeartbeatMonitor } from './heartbeat-monitor';

// ---------------------------------------------------------------------------
// AgentRunnerHandle -- interface for what we need from Phase 9A
// (Will be wired together after both phases merge)
// ---------------------------------------------------------------------------

export interface AgentRunnerHandle {
  readonly pid: number | null;
  kill(signal?: string): void;
}

// ---------------------------------------------------------------------------
// Callback types (FR-9B.08: DI via callbacks)
// ---------------------------------------------------------------------------

export interface SessionRunnerCallbacks {
  onResult: (sessionId: string, message: ResultMessage) => void;
  onPermission: (sessionId: string, request: PermissionRequestMessage) => void;
  onCrash: (sessionId: string) => void;
  onStateChange?: (sessionId: string, transition: SessionTransitionResult) => void;
  /** P7: Called when a status message arrives from the child. */
  onStatus?: (sessionId: string, message: StatusMessage) => void;
  /** P7: Called when an error message arrives from the child. */
  onError?: (sessionId: string, message: ErrorMessage) => void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SessionRunnerConfig {
  readonly id?: string;
  readonly workDir: string;
  readonly callbacks: SessionRunnerCallbacks;
  readonly logger: Logger;
  readonly maxRetries?: number;          // default 5
  readonly maxBackoffMs?: number;        // default 30_000
  readonly spawnCommand?: string;        // default 'claude'
  readonly spawnArgs?: readonly string[];
  readonly env?: Record<string, string>;
  /** For testing: inject a spawn function instead of child_process.spawn */
  readonly spawnFn?: typeof cpSpawn;
  /** P7: Heartbeat interval in ms (default 60_000). */
  readonly heartbeatIntervalMs?: number;
  /** P7: Max consecutive missed heartbeats before kill (default 3). */
  readonly heartbeatMaxMissed?: number;
}

// ---------------------------------------------------------------------------
// Session info snapshot
// ---------------------------------------------------------------------------

export interface SessionInfo {
  readonly id: string;
  readonly state: SessionState;
  readonly pid: number | null;
  readonly workDir: string;
  readonly crashCount: number;
  readonly lastCrash: number | null;
  readonly currentTaskId: string | null;
}

// ---------------------------------------------------------------------------
// SessionRunner
// ---------------------------------------------------------------------------

export class SessionRunner {
  readonly id: string;
  private _state: SessionState = 'idle';
  private _child: ChildProcess | null = null;
  private _crashCount = 0;
  private _lastCrash: number | null = null;
  private _currentTaskId: string | null = null;
  private _currentTask: NdjsonEnvelope<'task', TaskPayload> | null = null;
  private _drainResolve: (() => void) | null = null;
  private _heartbeat: HeartbeatMonitor | null = null;
  private _heartbeatPingTimer: ReturnType<typeof setInterval> | null = null;

  private readonly workDir: string;
  private readonly callbacks: SessionRunnerCallbacks;
  private readonly logger: Logger;
  private readonly spawnCommand: string;
  private readonly spawnArgs: readonly string[];
  private readonly envOverrides: Record<string, string>;
  private readonly spawnFn: typeof cpSpawn;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMaxMissed: number;

  constructor(config: SessionRunnerConfig) {
    this.id = config.id ?? `session-${randomUUID().slice(0, 8)}`;
    this.workDir = config.workDir;
    this.callbacks = config.callbacks;
    this.logger = config.logger.child({ sessionId: this.id });
    this.spawnCommand = config.spawnCommand ?? 'claude';
    this.spawnArgs = config.spawnArgs ?? [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
    ];
    this.envOverrides = config.env ?? {};
    this.spawnFn = config.spawnFn ?? cpSpawn;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 60_000;
    this.heartbeatMaxMissed = config.heartbeatMaxMissed ?? 3;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  get state(): SessionState {
    return this._state;
  }

  get crashCount(): number {
    return this._crashCount;
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      state: this._state,
      pid: this._child?.pid ?? null,
      workDir: this.workDir,
      crashCount: this._crashCount,
      lastCrash: this._lastCrash,
      currentTaskId: this._currentTaskId,
    };
  }

  /**
   * Spawn the child agent process.
   * FR-9B.02: --input-format stream-json --output-format stream-json
   * FR-9B.09: isolated working directory and environment
   */
  async spawn(): Promise<void> {
    const env: Record<string, string> = {
      ...buildSafeEnv(),
      ...this.envOverrides,
      ORCH_SESSION_ID: this.id,
      ORCH_WORK_DIR: this.workDir,
    };

    this._child = this.spawnFn(
      this.spawnCommand,
      [...this.spawnArgs, '--working-dir', this.workDir],
      {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.workDir,
      },
    ) as ChildProcess;

    this._child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal);
    });

    if (this._child.stdout) {
      const rl = createInterface({ input: this._child.stdout });
      rl.on('line', (line: string) => {
        this.handleLine(line);
      });
    }

    if (this._child.stderr) {
      const rl = createInterface({ input: this._child.stderr });
      rl.on('line', (line: string) => {
        this.logger.warn('Child stderr', { line });
      });
    }

    // P7: Start heartbeat monitor
    this._heartbeat = createHeartbeatMonitor({
      intervalMs: this.heartbeatIntervalMs,
      maxMissed: this.heartbeatMaxMissed,
      onKill: () => {
        this.logger.error('Heartbeat timeout — killing child', { sessionId: this.id });
        this.stopHeartbeatPing();
        this.killChild('SIGTERM');
        this.callbacks.onCrash(this.id);
      },
    });
    this._heartbeat.start();

    // P7 FR-P7-007: Send actual heartbeat pings to child stdin
    this._heartbeatPingTimer = setInterval(() => {
      if (!this._heartbeat?.shouldPing(this._state)) return;
      if (!this._child?.stdin?.writable) return;

      const ping: StatusMessage = {
        type: 'status',
        id: `hb-${randomUUID().slice(0, 8)}`,
        sessionId: this.id,
        payload: { state: 'heartbeat_ping' },
        timestamp: Date.now(),
      };
      this._child.stdin.write(encodeMessage(ping));
    }, this.heartbeatIntervalMs);

    this.logger.info('Child process spawned', { pid: this._child.pid });
  }

  /**
   * Dispatch a task to the child process via NDJSON on stdin.
   * FR-9B.03: wire protocol
   * FR-9B.04: state transitions
   */
  dispatch(task: NdjsonEnvelope<'task', TaskPayload>): void {
    if (this._state === 'failed') {
      throw new Error(`Cannot dispatch to failed session ${this.id}`);
    }
    if (!this._child?.stdin?.writable) {
      throw new Error(`Session ${this.id} child stdin not writable`);
    }

    this.transitionTo('working');
    this._currentTaskId = task.id;
    this._currentTask = task;

    const line = encodeMessage(task as AnyMessage);
    this._child.stdin.write(line);

    this.logger.debug('Task dispatched', { taskId: task.id });
  }

  /**
   * Send a permission response back to the child.
   * FR-9B.05: permission request forwarding
   */
  sendPermissionResponse(requestId: string, response: PermissionResponsePayload): void {
    if (!this._child?.stdin?.writable) {
      this.logger.error('Cannot send permission response: stdin not writable');
      return;
    }

    const envelope: AnyMessage = {
      type: 'permission_response',
      id: requestId,
      sessionId: this.id,
      payload: response,
      timestamp: Date.now(),
    };

    this._child.stdin.write(encodeMessage(envelope));
    this.transitionTo('working');
    this.logger.debug('Permission response sent', { requestId, approved: response.approved });
  }

  /**
   * Respawn the child process after a crash.
   * FR-9B.06: automatic crash recovery
   */
  async respawn(): Promise<void> {
    if (this._child) {
      try {
        this._child.kill('SIGKILL');
      } catch {
        // Best-effort kill
      }
      this._child = null;
    }

    await this.spawn();

    // Re-dispatch pending work if any
    if (this._currentTask) {
      this.dispatch(this._currentTask);
    }
  }

  /**
   * Drain the session: wait for in-flight work, then terminate.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    this._heartbeat?.stop();
    this.stopHeartbeatPing();
    this.transitionTo('draining');

    if (this._currentTaskId) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this._drainResolve = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    this.killChild('SIGTERM');
    await this.waitForExit(5_000);
  }

  /**
   * Force kill the child process immediately.
   */
  killChild(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this._child) {
      try {
        this._child.kill(signal);
      } catch {
        // Best-effort
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private transitionTo(target: SessionState): void {
    const result = sessionTransition(this._state, target);
    this._state = target;
    this.callbacks.onStateChange?.(this.id, result);
  }

  private handleLine(line: string): void {
    let message: AnyMessage;
    try {
      message = decodeMessage(line);
    } catch (err) {
      this.logger.warn('Malformed NDJSON from child, skipping', {
        error: err instanceof Error ? err.message : String(err),
        line: line.slice(0, 200),
      });
      return;
    }

    // P7: Any valid message from child resets heartbeat
    this._heartbeat?.recordActivity();

    switch (message.type) {
      case 'result':
        this._currentTaskId = null;
        this._currentTask = null;
        this.transitionTo('idle');
        this.callbacks.onResult(this.id, message);
        if (this._drainResolve) {
          this._drainResolve();
          this._drainResolve = null;
        }
        break;

      case 'permission_request':
        this.transitionTo('requires_action');
        this.callbacks.onPermission(this.id, message);
        break;

      case 'status':
        this.logger.debug('Child status update', { payload: message.payload });
        this.callbacks.onStatus?.(this.id, message);
        break;

      case 'error':
        this.logger.error('Child error', { payload: message.payload });
        this.callbacks.onError?.(this.id, message);
        break;

      case 'task':
      case 'permission_response':
        // Outbound-only message types — unexpected from child
        this.logger.warn('Unexpected outbound message type from child', { type: message.type });
        break;

      default:
        this.logger.warn('Unknown message type from child — discarding', { type: (message as AnyMessage).type });
    }
  }

  private stopHeartbeatPing(): void {
    if (this._heartbeatPingTimer !== null) {
      clearInterval(this._heartbeatPingTimer);
      this._heartbeatPingTimer = null;
    }
  }

  private handleChildExit(code: number | null, signal: string | null): void {
    this._heartbeat?.stop();
    this.stopHeartbeatPing();
    this.logger.warn('Child process exited', { code, signal, pid: this._child?.pid });

    const wasNormalExit = code === 0 && signal === null;
    this._child = null;

    if (wasNormalExit) {
      if (this._state !== 'draining' && this._state !== 'failed') {
        this._currentTaskId = null;
        this._currentTask = null;
        this.transitionTo('idle');
      }
      return;
    }

    // Abnormal exit: crash recovery
    this._crashCount += 1;
    this._lastCrash = Date.now();
    this.callbacks.onCrash(this.id);
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this._child) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.killChild('SIGKILL');
        resolve();
      }, timeoutMs);
      this._child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * Calculate exponential backoff delay for crash recovery.
 * FR-9B.06: 1s, 2s, 4s, max 30s
 */
export function calculateBackoff(crashCount: number, maxMs = 30_000): number {
  const delay = Math.min(Math.pow(2, crashCount - 1) * 1000, maxMs);
  return delay;
}
