/**
 * LocalShellTask — CC-aligned subprocess executor for `TaskType.local_bash`.
 *
 * Mirrors Claude Code's `src/tasks/LocalShellTask/LocalShellTask.tsx` location
 * convention but strips the React/Ink UI bits — orch-agents is a headless
 * server, so this file owns task lifecycle logic only.
 *
 * Single responsibility: spawn ONE subprocess for ONE Task end-to-end —
 *   1. Validate cwd is inside an allowed worktree root (FR-P13-006)
 *   2. Build env from allowlist + payload overrides minus secret keys (FR-P13-007)
 *   3. spawn(command, args, { shell: false }) — argv array, no interpolation (FR-P13-001)
 *   4. Stream stdout/stderr to TaskOutputWriter as JSONL records (FR-P13-002)
 *   5. SIGTERM → 15s grace → SIGKILL on timeout or external abort (FR-P13-003)
 *   6. Map exit code/signal to terminal TaskStatus deterministically (FR-P13-004)
 *   7. Drive transitions through the P6 task state machine (NFR-P13-003)
 *
 * Note: TaskRouter wiring is intentionally NOT done here. The current
 * `TaskRouter.dispatch(task: Task)` API cannot carry per-call payload
 * context. Callers acquire a `LocalShellTaskExecutor` from the factory and
 * invoke `execute(task, payload)` directly. See ./index.ts.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { TaskStatus, transition, type Task, type TaskRegistry, type TaskOutputWriter } from '../../execution/task';
import type { Logger } from '../../shared/logger';
import { assertCwdAllowed, buildEnv, CwdNotAllowedError } from './guards';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Payload supplied per-dispatch (not part of the persisted Task shape). */
export interface ShellTaskPayload {
  /** Argv[0] — the command to spawn. NEVER interpreted by a shell. */
  command: string;
  /** Argv[1..] — argument vector. Each element is a separate argv slot. */
  args: string[];
  /** Working directory. MUST resolve inside one of the configured allowed roots. */
  cwd: string;
  /** Optional env overrides merged on top of the allowlist. */
  env?: Record<string, string>;
  /** Hard timeout in ms. Defaults to 600_000 (10 min). */
  timeoutMs?: number;
}

/** Result returned by `execute()` after the subprocess reaches a terminal state. */
export interface ShellTaskResult {
  status: 'completed' | 'failed' | 'killed';
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  durationMs: number;
  outputBytes: number;
  /** Reason metadata for failed/killed outcomes — surfaces to callers/logs. */
  reason?: 'cwd-not-allowed' | 'spawn-error' | 'timeout' | 'abort' | 'exit-nonzero' | 'killed-by-signal';
  /** Source of the kill signal, when status === 'killed'. */
  killSource?: 'timeout' | 'abort';
  /** PID of the spawned subprocess (undefined if spawn never succeeded). */
  pid?: number;
}

export interface LocalShellTaskDeps {
  taskOutputWriter: TaskOutputWriter;
  taskRegistry?: TaskRegistry;
  logger: Logger;
  /** Worktree roots inside which `payload.cwd` must resolve (FR-P13-006). */
  allowedRoots: readonly string[];
  /** Env allowlist override. Defaults to DEFAULT_ENV_ALLOWLIST from guards. */
  envAllowlist?: readonly string[];
  /** Override default 10-minute timeout. */
  defaultTimeoutMs?: number;
  /** Override default 15s SIGTERM grace before SIGKILL. */
  killGraceMs?: number;
  /** Hard cap on total bytes captured to JSONL per task (default 10MB). */
  maxOutputBytes?: number;
  /** Test seam: replacement for `child_process.spawn`. */
  spawnFn?: typeof spawn;
}

export interface LocalShellTaskExecutor {
  /**
   * Execute a single shell task end-to-end.
   *
   * Returns once the subprocess has reached a terminal state and the
   * JSONL writer has flushed. Never throws for normal exit/timeout/kill
   * paths — those flow through the returned `ShellTaskResult`.
   */
  execute(task: Task, payload: ShellTaskPayload): Promise<ShellTaskResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 600_000; // 10 min — CC parity
const DEFAULT_KILL_GRACE_MS = 15_000; // 15 s — CC parity
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalShellTaskExecutor(deps: LocalShellTaskDeps): LocalShellTaskExecutor {
  const spawnFn = deps.spawnFn ?? spawn;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  /** Helper: persist the new task object back to the registry, if wired. */
  function commit(task: Task): Task {
    if (deps.taskRegistry) {
      try {
        deps.taskRegistry.update(task.id, task);
      } catch {
        // Task may not have been pre-registered by the caller; that's fine.
      }
    }
    return task;
  }

  return {
    async execute(initialTask: Task, payload: ShellTaskPayload): Promise<ShellTaskResult> {
      const startedAt = Date.now();
      let task = initialTask;

      // -------------------------------------------------------------------
      // 1. Pre-spawn cwd validation (FR-P13-006)
      // -------------------------------------------------------------------
      try {
        assertCwdAllowed(payload.cwd, deps.allowedRoots);
      } catch (err) {
        if (err instanceof CwdNotAllowedError) {
          deps.logger.warn('LocalShellTask cwd rejected', {
            taskId: task.id,
            cwd: payload.cwd,
            resolvedCwd: err.resolvedCwd,
          });
          // pending → cancelled (TaskStatus enum has no `failed` from pending,
          // and no `killed` state — kill outcomes map to cancelled with
          // reason metadata, per the iron rules in the P13 spec).
          task = commit(transition(task, TaskStatus.cancelled));
          return {
            status: 'failed',
            exitCode: null,
            signal: null,
            durationMs: Date.now() - startedAt,
            outputBytes: 0,
            reason: 'cwd-not-allowed',
          };
        }
        throw err;
      }

      // -------------------------------------------------------------------
      // 2. Build env (FR-P13-007)
      // -------------------------------------------------------------------
      const env = buildEnv(payload.env, deps.envAllowlist);

      // -------------------------------------------------------------------
      // 3. Spawn subprocess (FR-P13-001)
      // -------------------------------------------------------------------
      const spawnOpts: SpawnOptions = {
        cwd: payload.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false, // NEVER true — argv-only, no shell interpolation
        detached: false,
      };

      let child: ChildProcess;
      try {
        child = spawnFn(payload.command, payload.args, spawnOpts);
      } catch (err) {
        // Synchronous spawn failure (very rare — most ENOENT comes async).
        deps.logger.error('LocalShellTask spawn threw synchronously', {
          taskId: task.id,
          command: payload.command,
          error: err instanceof Error ? err.message : String(err),
        });
        task = commit(transition(task, TaskStatus.cancelled));
        return {
          status: 'failed',
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          outputBytes: 0,
          reason: 'spawn-error',
        };
      }

      // pending → running, store pid on metadata
      task = commit(transition(task, TaskStatus.running));
      const pid = child.pid;

      // -------------------------------------------------------------------
      // 4. Stream stdout/stderr to JSONL writer (FR-P13-002)
      // -------------------------------------------------------------------
      let outputBytes = 0;
      let truncated = false;

      const writeChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (truncated) return;
        const remaining = maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          truncated = true;
          deps.taskOutputWriter.append(task.id, {
            stream: 'stderr',
            data: `[orch-agents] output truncated at ${maxOutputBytes} bytes`,
          });
          return;
        }
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        outputBytes += slice.length;
        deps.taskOutputWriter.append(task.id, {
          stream,
          data: slice.toString('utf8'),
        });
      };

      child.stdout?.on('data', (chunk: Buffer) => writeChunk('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => writeChunk('stderr', chunk));

      // -------------------------------------------------------------------
      // 5. Timeout / kill escalation (FR-P13-003)
      // -------------------------------------------------------------------
      let killSource: 'timeout' | 'abort' | undefined;
      let killTimer: NodeJS.Timeout | null = null;

      const escalateKill = (source: 'timeout' | 'abort'): void => {
        if (killSource) return; // Already killing
        killSource = source;
        try {
          child.kill('SIGTERM');
        } catch (err) {
          deps.logger.warn('LocalShellTask SIGTERM failed', {
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (err) {
            deps.logger.warn('LocalShellTask SIGKILL failed', {
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, killGraceMs);
        // Don't keep the event loop alive solely for the kill timer.
        if (typeof killTimer.unref === 'function') killTimer.unref();
      };

      const timeoutMs = payload.timeoutMs ?? defaultTimeoutMs;
      const timeoutHandle = setTimeout(() => escalateKill('timeout'), timeoutMs);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

      // -------------------------------------------------------------------
      // 6. Wait for exit (FR-P13-004)
      // -------------------------------------------------------------------
      const exitInfo = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        spawnError?: NodeJS.ErrnoException;
      }>((resolveExit) => {
        let resolved = false;
        const finish = (info: { code: number | null; signal: NodeJS.Signals | null; spawnError?: NodeJS.ErrnoException }): void => {
          if (resolved) return;
          resolved = true;
          resolveExit(info);
        };
        child.on('error', (err: NodeJS.ErrnoException) => {
          // Async ENOENT/EACCES land here. Treat as terminal failure.
          finish({ code: null, signal: null, spawnError: err });
        });
        child.on('exit', (code, signal) => {
          finish({ code, signal });
        });
      });

      clearTimeout(timeoutHandle);
      if (killTimer) clearTimeout(killTimer);

      const durationMs = Date.now() - startedAt;

      // -------------------------------------------------------------------
      // 7. Map exit → terminal TaskStatus
      // -------------------------------------------------------------------
      if (exitInfo.spawnError) {
        deps.logger.error('LocalShellTask spawn errored', {
          taskId: task.id,
          command: payload.command,
          code: exitInfo.spawnError.code,
          message: exitInfo.spawnError.message,
        });
        task = commit(transition(task, TaskStatus.failed));
        return {
          status: 'failed',
          exitCode: null,
          signal: null,
          durationMs,
          outputBytes,
          reason: 'spawn-error',
          pid,
        };
      }

      if (killSource) {
        // We initiated the kill (timeout or abort). TaskStatus enum has no
        // `killed` — map to cancelled per spec adaptation, but report
        // `status: 'killed'` in the result so callers can distinguish.
        task = commit(transition(task, TaskStatus.cancelled));
        return {
          status: 'killed',
          exitCode: exitInfo.code,
          signal: exitInfo.signal,
          durationMs,
          outputBytes,
          reason: killSource,
          killSource,
          pid,
        };
      }

      if (exitInfo.signal !== null) {
        // External signal (someone else killed it). Treat as cancelled.
        task = commit(transition(task, TaskStatus.cancelled));
        return {
          status: 'killed',
          exitCode: exitInfo.code,
          signal: exitInfo.signal,
          durationMs,
          outputBytes,
          reason: 'killed-by-signal',
          pid,
        };
      }

      if (exitInfo.code === 0) {
        task = commit(transition(task, TaskStatus.completed));
        return {
          status: 'completed',
          exitCode: 0,
          signal: null,
          durationMs,
          outputBytes,
          pid,
        };
      }

      task = commit(transition(task, TaskStatus.failed));
      return {
        status: 'failed',
        exitCode: exitInfo.code,
        signal: null,
        durationMs,
        outputBytes,
        reason: 'exit-nonzero',
        pid,
      };
    },
  };
}
