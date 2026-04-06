// ---------------------------------------------------------------------------
// P1 — Query Loop Transition Types
// ---------------------------------------------------------------------------

/** Why the loop terminated (returned). */
export type TerminalReason =
  | 'completed'
  | 'blocking_limit'
  | 'model_error'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'prompt_too_long'     // reserved: reactive compact recovery
  | 'max_turns'
  | 'stop_hook_prevented'
  | 'hook_stopped';       // reserved: hook execution system

/** Why the loop continued (another iteration). */
export type ContinueReason =
  | 'tool_use'
  | 'compact_retry'
  | 'error_recovery'
  | 'budget_continuation'
  | 'stop_hook_blocking'
  | 'queued_command';     // reserved: command queue system

/** Returned from queryLoop when the loop exits. */
export interface Terminal {
  reason: TerminalReason;
  error?: unknown;
}

/** Carried on State.transition to indicate why the previous iteration continued. */
export interface Continue {
  reason: ContinueReason;
  [key: string]: unknown;
}
