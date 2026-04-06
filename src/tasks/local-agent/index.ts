/**
 * src/tasks/local-agent — barrel.
 *
 * Mirrors Claude Code's `src/tasks/LocalAgentTask/` directory convention.
 * Re-exports the LocalAgentTask factory and types.
 *
 * Note: TaskRouter wiring is intentionally NOT done here. The current
 * TaskRouter API (`dispatch(task: Task)`) cannot carry per-call plan +
 * intakeEvent context. Until that API evolves, callers instantiate this
 * executor directly and call `execute(plan, intakeEvent)`. See the
 * follow-up PRs noted in the refactor report.
 */

export {
  createLocalAgentTaskExecutor,
  type LocalAgentTaskDeps,
  type LocalAgentTaskExecutor,
  type ExecutionResult,
  type AgentResult,
} from './LocalAgentTask';
