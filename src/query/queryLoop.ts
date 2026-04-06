// ---------------------------------------------------------------------------
// P1 — Core Query Loop State Machine
// ---------------------------------------------------------------------------

import type { Terminal, Continue } from './transitions.js';
import type { QueryLoopState, QueryMessage } from './state.js';
import type { QueryDeps } from './deps.js';
import { createInitialState } from './state.js';
import type {
  CompactMessage,
  CompactionConfig,
  AutoCompactTrackingState,
  ForkedLLMCall,
  QuerySource,
} from '../services/compact/index.js';
import {
  createDefaultConfig,
  createTrackingState,
  snipCompactIfNeeded,
  autoCompactIfNeeded,
  generateCompactionMessages,
  computeWarningState,
  decideWarningEmission,
  runPostCompactCleanup,
  AUTOCOMPACT_BUFFER_TOKENS,
} from '../services/compact/index.js';

/** API error string emitted on 413 / prompt_too_long. */
export const PROMPT_TOO_LONG_ERROR = 'prompt_too_long';

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
// Compaction integration (P10)
// ---------------------------------------------------------------------------

export type CompactionEventType =
  | 'ContextPressureWarning'
  | 'ContextPressureError'
  | 'CompactionTriggered'
  | 'CompactionCompleted';

export interface CompactionEventPayload {
  readonly type: CompactionEventType;
  readonly cause?: 'auto' | 'reactive';
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly ratio?: number;
  readonly latencyMs?: number;
  readonly currentTokens?: number;
  readonly threshold?: number;
  readonly percentLeft?: number;
  readonly recommended?: 'snip' | 'compact' | 'block';
}

export interface CompactionHooks {
  /** Session id used for cleanup state + warning suppression. */
  readonly sessionId: string;
  /** 'main' or 'subagent' (FR-P10-005). */
  readonly querySource?: QuerySource;
  /** Compaction config — defaults to 200K context. */
  readonly config?: CompactionConfig;
  /** Mutable tracking state (carries circuit-breaker counter). */
  readonly tracking?: AutoCompactTrackingState;
  /** Forked LLM call (FR-P10-004). Falls back to deterministic structured summary. */
  readonly forkedLLM?: ForkedLLMCall;
  /** Tail rounds preserved verbatim (default 2). */
  readonly tailRounds?: number;
  /** Snip boundary — number of recent messages to keep when snipping. */
  readonly snipBoundary?: number;
  /** Disable proactive auto-compact entirely (reactive still runs). */
  readonly disableAutoCompact?: boolean;
  /** Disable BOTH auto and reactive (DISABLE_COMPACT). */
  readonly disableAll?: boolean;
  /** Event emitter for the harness — receives compaction + pressure events. */
  readonly emit?: (event: CompactionEventPayload) => void;
}

/** Convert a queryLoop QueryMessage to a compact-pipeline CompactMessage. */
function toCompactMessage(msg: QueryMessage): CompactMessage {
  return {
    uuid: msg.uuid,
    type: msg.type,
    content: [{ type: 'text', text: msg.content }],
  };
}

/** Convert back — preserves text content. Tool blocks roundtrip via content. */
function fromCompactMessage(msg: CompactMessage): QueryMessage {
  const text = msg.content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return b.content;
      if (b.type === 'tool_use') return `[tool_use:${b.name}]`;
      return '';
    })
    .join('\n');
  return {
    uuid: msg.uuid,
    type: msg.type,
    content: text,
  };
}

interface CompactionContext {
  readonly hooks: CompactionHooks;
  readonly config: CompactionConfig;
  readonly tracking: AutoCompactTrackingState;
}

function ensureCompactionContext(
  hooks: CompactionHooks,
): CompactionContext {
  return {
    hooks,
    config: hooks.config ?? createDefaultConfig(),
    tracking: hooks.tracking ?? createTrackingState(),
  };
}

/** Run snip + auto-compact pre-model-call (FR-P10-001 + FR-P10-003). */
async function runProactiveCompaction(
  messages: QueryMessage[],
  ctx: CompactionContext,
): Promise<{ messages: QueryMessage[]; compacted: boolean }> {
  if (ctx.hooks.disableAll || ctx.hooks.disableAutoCompact) {
    return { messages, compacted: false };
  }

  const compactMsgs = messages.map(toCompactMessage);

  // Warning hook (FR-P10-006).
  const warningState = computeWarningState(
    compactMsgs,
    ctx.config.contextWindowTokens,
  );
  const emission = decideWarningEmission(ctx.hooks.sessionId, warningState);
  if (emission.kind === 'warning' && ctx.hooks.emit) {
    ctx.hooks.emit({
      type: 'ContextPressureWarning',
      currentTokens: warningState.currentTokens,
      threshold: warningState.warningThreshold,
      percentLeft: warningState.percentLeft,
      recommended:
        warningState.recommended === 'none'
          ? 'snip'
          : warningState.recommended,
    });
  } else if (emission.kind === 'error' && ctx.hooks.emit) {
    ctx.hooks.emit({
      type: 'ContextPressureError',
      currentTokens: warningState.currentTokens,
      threshold: warningState.errorThreshold,
      percentLeft: warningState.percentLeft,
    });
  }

  // Tier 2 — snip (cheap, no LLM).
  const snipBoundary = ctx.hooks.snipBoundary ?? compactMsgs.length;
  const snipResult = snipCompactIfNeeded(compactMsgs, snipBoundary);

  // Tier 3 — auto-compact threshold check. We compute the trigger
  // ourselves rather than relying on autoCompactIfNeeded's internal
  // structured-summary fallback, because the queryLoop wiring drives
  // its own (potentially LLM-backed) summary path below.
  if (ctx.tracking.consecutiveFailures >= ctx.config.maxConsecutiveFailures) {
    return { messages, compacted: false };
  }
  // Run autoCompactIfNeeded to honour env/test-only overrides and to
  // bump the consecutiveFailures counter when its internal validator
  // would have refused the compaction.
  const autoResult = autoCompactIfNeeded(
    snipResult.messages,
    ctx.config,
    ctx.tracking,
    snipResult.tokensFreed,
  );
  if (autoResult.consecutiveFailures !== undefined) {
    ctx.tracking.consecutiveFailures = autoResult.consecutiveFailures;
  }

  if (!warningState.isAboveAutoCompactThreshold) {
    return { messages, compacted: false };
  }

  // Threshold met → generate the real summary (LLM if injected).
  const tokensBefore =
    autoResult.compactionResult?.preCompactTokenCount ??
    warningState.currentTokens;
  ctx.hooks.emit?.({
    type: 'CompactionTriggered',
    cause: 'auto',
    tokensBefore,
  });

  const t0 = Date.now();
  const generated = await generateCompactionMessages(snipResult.messages, {
    tailRounds: ctx.hooks.tailRounds ?? 2,
    forkedLLM: ctx.hooks.forkedLLM,
  });
  const latencyMs = Date.now() - t0;

  // Approximate post-compact tokens via the same chars/4 estimator
  // the autoCompact pipeline uses.
  const tokensAfter = generated.messages.reduce(
    (sum, m) =>
      sum +
      4 +
      m.content.reduce((s, b) => {
        if (b.type === 'text') return s + Math.ceil(b.text.length / 4);
        if (b.type === 'tool_result') return s + Math.ceil(b.content.length / 4);
        return s;
      }, 0),
    0,
  );
  const ratio = tokensBefore > 0 ? 1 - tokensAfter / tokensBefore : 0;

  // Refuse to declare success if compaction didn't actually shrink the
  // conversation — bump the circuit-breaker counter instead. Without
  // this guard the loop would re-trigger compaction every iteration
  // on a single oversized message.
  if (tokensAfter >= tokensBefore) {
    ctx.tracking.consecutiveFailures += 1;
    return { messages, compacted: false };
  }

  ctx.tracking.compacted = true;
  ctx.tracking.consecutiveFailures = 0;

  // Post-compact cleanup (FR-P10-005).
  const newAnchor = generated.messages[generated.messages.length - 1]?.uuid;
  runPostCompactCleanup(
    ctx.hooks.sessionId,
    ctx.hooks.querySource ?? 'main',
    newAnchor,
  );

  ctx.hooks.emit?.({
    type: 'CompactionCompleted',
    cause: 'auto',
    tokensBefore,
    tokensAfter,
    ratio,
    latencyMs,
  });

  return {
    messages: generated.messages.map(fromCompactMessage),
    compacted: true,
  };
}

/** Run reactive compaction after a PROMPT_TOO_LONG (FR-P10-002). */
async function runReactiveCompactionForLoop(
  messages: QueryMessage[],
  ctx: CompactionContext,
): Promise<{ messages: QueryMessage[]; success: boolean }> {
  if (ctx.hooks.disableAll) {
    return { messages, success: false };
  }

  const compactMsgs = messages.map(toCompactMessage);
  const tokensBefore = compactMsgs.reduce(
    (s, m) =>
      s +
      4 +
      m.content.reduce(
        (a, b) => (b.type === 'text' ? a + Math.ceil(b.text.length / 4) : a),
        0,
      ),
    0,
  );

  ctx.hooks.emit?.({
    type: 'CompactionTriggered',
    cause: 'reactive',
    tokensBefore,
  });

  const t0 = Date.now();
  let generated;
  try {
    generated = await generateCompactionMessages(compactMsgs, {
      tailRounds: ctx.hooks.tailRounds ?? 2,
      forkedLLM: ctx.hooks.forkedLLM,
    });
  } catch {
    return { messages, success: false };
  }
  const latencyMs = Date.now() - t0;

  const tokensAfter = generated.messages.reduce(
    (sum, m) =>
      sum +
      4 +
      m.content.reduce((s, b) => {
        if (b.type === 'text') return s + Math.ceil(b.text.length / 4);
        if (b.type === 'tool_result') return s + Math.ceil(b.content.length / 4);
        return s;
      }, 0),
    0,
  );
  const ratio = tokensBefore > 0 ? 1 - tokensAfter / tokensBefore : 0;

  ctx.tracking.compacted = true;

  const newAnchor = generated.messages[generated.messages.length - 1]?.uuid;
  runPostCompactCleanup(
    ctx.hooks.sessionId,
    ctx.hooks.querySource ?? 'main',
    newAnchor,
  );

  ctx.hooks.emit?.({
    type: 'CompactionCompleted',
    cause: 'reactive',
    tokensBefore,
    tokensAfter,
    ratio,
    latencyMs,
  });

  return {
    messages: generated.messages.map(fromCompactMessage),
    success: true,
  };
}

// Re-export AUTOCOMPACT_BUFFER_TOKENS so callers can size context windows.
export { AUTOCOMPACT_BUFFER_TOKENS };

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
  /** Integration point: P10 compaction wiring. When provided, the loop runs
   *  proactive snip+autoCompact each turn and reactive compact on
   *  prompt_too_long errors. When omitted, behaviour is unchanged. */
  compaction?: CompactionHooks;
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
    compaction,
  } = params;

  const compactionCtx = compaction
    ? ensureCompactionContext(compaction)
    : undefined;

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

    // 3b. P10 — proactive snip + auto-compact (FR-P10-001/003/004/005/006)
    if (compactionCtx) {
      const proactive = await runProactiveCompaction(messages, compactionCtx);
      if (proactive.compacted) {
        state = {
          ...state,
          messages: proactive.messages,
          transition: { reason: 'compact_retry' },
        };
        continue;
      }
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

    // 7a-pre. P10 — Reactive compaction on prompt_too_long (FR-P10-002).
    if (
      compactionCtx &&
      lastApiError === PROMPT_TOO_LONG_ERROR &&
      !state.hasAttemptedReactiveCompact
    ) {
      const reactive = await runReactiveCompactionForLoop(
        messages,
        compactionCtx,
      );
      if (reactive.success) {
        state = {
          ...state,
          messages: reactive.messages,
          hasAttemptedReactiveCompact: true,
          turnCount: turnCount + 1,
          transition: { reason: 'compact_retry' },
        };
        continue;
      }
      // Reactive failed — surface the error.
      const errorMsg: QueryMessage = {
        uuid: deps.uuid(),
        type: 'system',
        content: 'Prompt too long — reactive compaction failed.',
      };
      yield { type: 'error_message', message: errorMsg };
      return { reason: 'prompt_too_long' };
    }

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
