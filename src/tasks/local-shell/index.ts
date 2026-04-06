/**
 * src/tasks/local-shell — barrel.
 *
 * Mirrors Claude Code's `src/tasks/LocalShellTask/` directory convention.
 * Re-exports the LocalShellTask factory, types, and pure guards.
 *
 * Note: TaskRouter wiring is intentionally NOT done here. The current
 * `TaskRouter.dispatch(task: Task)` API takes only a Task and cannot
 * carry per-call ShellTaskPayload (command/args/cwd/env). Until that
 * API evolves, callers instantiate this executor directly via
 * `createLocalShellTaskExecutor` and call `execute(task, payload)`.
 *
 * This is the same pattern used by `src/tasks/local-agent/`.
 */

export {
  createLocalShellTaskExecutor,
  type LocalShellTaskDeps,
  type LocalShellTaskExecutor,
  type ShellTaskPayload,
  type ShellTaskResult,
} from './LocalShellTask';

export {
  assertCwdAllowed,
  buildEnv,
  CwdNotAllowedError,
  DEFAULT_ENV_ALLOWLIST,
  SECRET_KEY_PATTERN,
} from './guards';
