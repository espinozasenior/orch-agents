/**
 * Script Runner — shell execution with timeout, env vars, and cwd.
 *
 * Executes lifecycle scripts (setup.sh, start.sh) in a child bash process
 * with structured result capture.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScriptRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a lifecycle script in a child bash process.
 *
 * @param command   Shell command to execute (via `bash -c`)
 * @param cwd       Working directory for the child process
 * @param timeoutMs Maximum wall-clock time before SIGTERM
 * @param env       Additional environment variables (merged with process.env)
 * @param exec      Injectable exec function for testing
 */
export async function runLifecycleScript(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
  exec?: typeof defaultExecFile,
): Promise<ScriptRunResult> {
  const run = exec ?? defaultExecFile;
  const mergedEnv = { ...process.env, ORCH_BOOT_MODE: 'fresh', ...env };
  const startMs = Date.now();

  try {
    const { stdout, stderr } = await run('bash', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      env: mergedEnv,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });

    return {
      exitCode: 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      durationMs: Date.now() - startMs,
      timedOut: false,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs;
    const error = err as Error & { killed?: boolean; code?: number | string; stdout?: string; stderr?: string };

    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
      durationMs,
      timedOut: error.killed === true,
    };
  }
}
