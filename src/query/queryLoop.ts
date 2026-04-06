// ---------------------------------------------------------------------------
// P1 — Core Query Loop State Machine
// ---------------------------------------------------------------------------

import type { Terminal, Continue } from './transitions.js';
import type { QueryLoopState, QueryMessage } from './state.js';
import type { QueryDeps } from './deps.js';
import { createInitialState } from './state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TURNS = 200;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
export const OUTPUT_RECOVERY_MESSAGE =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.';

// ---------------------------------------------------------------------------
// Query events yielded to callers
// ---------------------------------------------------------------------------

export interface StreamRequestStartEvent {
  type: 'stream_request_start';
}

export interface AssistantMessageEvent {
  type: 'assistant_message';
  message: QueryMessage;
}

export interface ToolResultEvent {
  type: 'tool_result';
  message: QueryMessage;
}

export interface ErrorMessageEvent {
  type: 'error_message';
  message: QueryMessage;
}

export interface InterruptionEvent {
  type: 'interruption';
  message: QueryMessage;
}

export type QueryEvent =
  | StreamRequestStartEvent
  | AssistantMessageEvent
  | ToolResultEvent
  | ErrorMessageEvent
  | InterruptionEvent;

// ---------------------------------------------------------------------------
// Integration point stubs (typed for future P0/P3/P4 integration)
// ---------------------------------------------------------------------------

export interface CompactionResult {
  compacted: boolean;
  messages: QueryMessage[];
}

export interface StopHookResult {
  preventContinuation: boolean;
  blockingErrors: QueryMessage[];
}

export interface BudgetDecision {
  action: 'continue' | 'stop';
  nudgeMessage?: string;
}

export interface ToolExecutionResult {
  messages: QueryMessage[];
}

/** No-op compaction — passes messages through unchanged. */
async function noopCompact(messages: QueryMessage[]): Promise<CompactionResult> {
  return { compacted: false, messages };
}

/** No-op blocking limit check — never blocks. */
function noopBlockingLimit(_messages: QueryMessage[], _estimateTokens: QueryDeps['estimateTokens']): boolean {
  return false;
}

/** No-op stop hooks — never blocks. */
async function noopStopHooks(): Promise<StopHookResult> {
  return { preventContinuation: false, blockingErrors: [] };
}

/** No-op budget check — always stops (normal completion). */
function noopBudgetCheck(): BudgetDecision {
  return { action: 'stop' };
}

/** No-op tool execution — returns empty results. */
async function noopToolExecution(
  _toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): Promise<ToolExecutionResult> {
  return { messages: [] };
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

export interface QueryParams {
  messages: QueryMessage[];
  systemPrompt: string;
  deps: QueryDeps;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /** Integration point: P0 compaction. */
  compact?: (messages: QueryMessage[]) => Promise<CompactionResult>;
  /** Integration point: blocking limit check. */
  isAtBlockingLimit?: (messages: QueryMessage[], estimateTokens: QueryDeps['estimateTokens']) => boolean;
  /** Integration point: stop hooks. */
  handleStopHooks?: (messages: QueryMessage[], assistantMessages: QueryMessage[]) => Promise<StopHookResult>;
  /** Integration point: P3 budget check. */
  checkBudget?: () => BudgetDecision;
  /** Integration point: P4 tool execution. */
  executeTool?: (
    toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ) => Promise<ToolExecutionResult>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface QueryResult {
  terminal: Terminal;
  transitions: Continue[];
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

export async function* queryLoop(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const {
    systemPrompt,
    deps,
    maxTurns = DEFAULT_MAX_TURNS,
    abortSignal,
    compact = noopCompact,
    isAtBlockingLimit = noopBlockingLimit,
    handleStopHooks = noopStopHooks,
    checkBudget = noopBudgetCheck,
    executeTool = noopToolExecution,
  } = params;

  let state: QueryLoopState = createInitialState(params.messages);

  while (true) {
    // 1. Destructure state (read-only within iteration)
    const {
      messages,
      turnCount,
      maxOutputRecoveryCount,
    } = state;

    // 2. Check turn limit
    if (turnCount > maxTurns) {
      return { reason: 'max_turns' };
    }

    // 3. Run compaction pipeline (P0 integration point)
    const compactionResult = await compact(messages);
    if (compactionResult.compacted) {
      state = {
        ...state,
        messages: compactionResult.messages,
        transition: { reason: 'compact_retry' },
      };
      continue;
    }

    // 4. Check blocking limit
    if (isAtBlockingLimit(messages, deps.estimateTokens)) {
      const errorMsg: QueryMessage = {
        uuid: deps.uuid(),
        type: 'system',
        content: 'Prompt too long — context window exceeded.',
      };
      yield { type: 'error_message', message: errorMsg };
      return { reason: 'blocking_limit' };
    }

    // 5. Call model with streaming
    yield { type: 'stream_request_start' };

    const assistantMessages: QueryMessage[] = [];
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let needsFollowUp = false;
    let lastApiError: string | undefined;

    try {
      const stream = deps.callModel(messages, systemPrompt);

      for await (const event of stream) {
        // Check abort
        if (abortSignal?.aborted) {
          const interruptMsg: QueryMessage = {
            uuid: deps.uuid(),
            type: 'system',
            content: 'Operation interrupted by user.',
            isMeta: true,
          };
          yield { type: 'interruption', message: interruptMsg };
          return { reason: 'aborted_streaming' };
        }

        if (event.type === 'text') {
          const msg: QueryMessage = {
            uuid: deps.uuid(),
            type: 'assistant',
            content: event.content,
          };
          assistantMessages.push(msg);
          yield { type: 'assistant_message', message: msg };
        } else if (event.type === 'tool_use') {
          const msg: QueryMessage = {
            uuid: deps.uuid(),
            type: 'assistant',
            content: '',
            toolUseBlocks: [{ id: event.id, name: event.name }],
          };
          assistantMessages.push(msg);
          toolUseBlocks.push({ id: event.id, name: event.name, input: event.input });
          needsFollowUp = true;
          yield { type: 'assistant_message', message: msg };
        } else if (event.type === 'error') {
          lastApiError = event.apiError;
          const msg: QueryMessage = {
            uuid: deps.uuid(),
            type: 'assistant',
            content: '',
            apiError: event.apiError,
          };
          assistantMessages.push(msg);
        }
      }
    } catch (error: unknown) {
      const errorContent = error instanceof Error ? error.message : String(error);
      const errorMsg: QueryMessage = {
        uuid: deps.uuid(),
        type: 'system',
        content: errorContent,
      };
      yield { type: 'error_message', message: errorMsg };
      return { reason: 'model_error', error };
    }

    // 6. Process tool_use blocks (main continue path)
    if (needsFollowUp) {
      const toolResult = await executeTool(toolUseBlocks);

      // Check abort during tools
      if (abortSignal?.aborted) {
        const interruptMsg: QueryMessage = {
          uuid: deps.uuid(),
          type: 'system',
          content: 'Operation interrupted during tool execution.',
          isMeta: true,
        };
        yield { type: 'interruption', message: interruptMsg };
        return { reason: 'aborted_tools' };
      }

      for (const msg of toolResult.messages) {
        yield { type: 'tool_result', message: msg };
      }

      state = {
        ...state,
        messages: [...messages, ...assistantMessages, ...toolResult.messages],
        turnCount: turnCount + 1,
        maxOutputRecoveryCount: 0,
        transition: { reason: 'tool_use' },
      };
      continue;
    }

    // 7. No tool_use — check for recoverable errors

    // 7a. Max output tokens recovery
    if (lastApiError === 'max_output_tokens') {
      if (maxOutputRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        const recoveryMsg: QueryMessage = {
          uuid: deps.uuid(),
          type: 'user',
          content: OUTPUT_RECOVERY_MESSAGE,
          isMeta: true,
        };
        state = {
          ...state,
          messages: [...messages, ...assistantMessages, recoveryMsg],
          maxOutputRecoveryCount: maxOutputRecoveryCount + 1,
          turnCount: turnCount + 1,
          transition: { reason: 'error_recovery' },
        };
        continue;
      }
      // Surface error after exhausting retries — yield last assistant message
      const lastMsg = assistantMessages[assistantMessages.length - 1];
      if (lastMsg) {
        yield { type: 'error_message', message: lastMsg };
      }
    }

    // 7b. Stop hooks
    const stopResult = await handleStopHooks(messages, assistantMessages);
    if (stopResult.preventContinuation) {
      return { reason: 'stop_hook_prevented' };
    }
    if (stopResult.blockingErrors.length > 0) {
      state = {
        ...state,
        messages: [...messages, ...assistantMessages, ...stopResult.blockingErrors],
        turnCount: turnCount + 1,
        transition: { reason: 'stop_hook_blocking' },
      };
      continue;
    }

    // 7c. Token budget continuation (P3 integration point)
    const budgetDecision = checkBudget();
    if (budgetDecision.action === 'continue' && budgetDecision.nudgeMessage) {
      const nudgeMsg: QueryMessage = {
        uuid: deps.uuid(),
        type: 'user',
        content: budgetDecision.nudgeMessage,
        isMeta: true,
      };
      state = {
        ...state,
        messages: [...messages, ...assistantMessages, nudgeMsg],
        turnCount: turnCount + 1,
        transition: { reason: 'budget_continuation' },
      };
      continue;
    }

    // 8. Normal completion
    return { reason: 'completed' };
  }
}
