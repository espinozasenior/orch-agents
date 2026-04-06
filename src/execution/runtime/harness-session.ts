/**
 * Harness-Wrapped Session
 *
 * Wraps a Claude Code executor with harness capabilities:
 * - P0: Context compaction (auto-compact when tokens exceed threshold)
 * - P1: Query loop integration (when enhancements enabled)
 * - P3: Token budget auto-continue (keep working until 90% budget used)
 *
 * Injected into simple-executor as an enhanced InteractiveTaskExecutor.
 */

import { randomUUID } from 'node:crypto';
import type {
  InteractiveTaskExecutor,
  InteractiveExecutionRequest,
} from './interactive-executor';
import type { TaskExecutionResult } from './task-executor';
import { queryLoop } from '../../query/queryLoop';
import type { QueryMessage } from '../../query/state';
import type { ModelEvent } from '../../query/deps';
import { createQueryLoopParams } from '../../query/queryLoopFactory';
import type { Logger } from '../../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessSessionDeps {
  /** The underlying executor (CLI or SDK) */
  baseExecutor: InteractiveTaskExecutor;
  logger?: Logger;
  /** Context window size in tokens. Default: 200_000 */
  contextWindowTokens?: number;
  /** Token budget per session. Default: undefined (no budget) */
  tokenBudget?: number;
  /** Enable compaction. Default: true */
  enableCompaction?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a harness-wrapped executor that adds compaction and budget
 * tracking around the base executor.
 */
export function createHarnessSession(
  deps: HarnessSessionDeps,
): InteractiveTaskExecutor {
  const {
    baseExecutor,
    logger,
    contextWindowTokens = 200_000,
    tokenBudget,
    enableCompaction = true,
  } = deps;

  return {
    async execute(
      request: InteractiveExecutionRequest,
    ): Promise<TaskExecutionResult> {
      // Fast path: no enhancements enabled
      if (!enableCompaction && tokenBudget === undefined) {
        return baseExecutor.execute(request);
      }

      // --- Enhanced path: use query loop with P0/P3 callbacks ---
      return executeWithQueryLoop(
        request,
        baseExecutor,
        contextWindowTokens,
        tokenBudget,
        enableCompaction,
        logger,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Query-loop-based execution (P1 integration)
// ---------------------------------------------------------------------------

async function executeWithQueryLoop(
  request: InteractiveExecutionRequest,
  baseExecutor: InteractiveTaskExecutor,
  contextWindowTokens: number,
  tokenBudget: number | undefined,
  enableCompaction: boolean,
  logger?: Logger,
): Promise<TaskExecutionResult> {
  const startTime = Date.now();
  let globalTurnTokens = 0;

  // Build QueryDeps that wraps the base executor as a model call
  const queryDeps = {
    async *callModel(
      messages: QueryMessage[],
      _systemPrompt: string,
    ): AsyncGenerator<ModelEvent> {
      // Build prompt from the latest user message (the query loop manages
      // message history; we only need the tail for the executor).
      const lastUserMsg = [...messages].reverse().find((m) => m.type === 'user');
      const prompt = lastUserMsg?.content ?? request.prompt;

      const result = await baseExecutor.execute({
        ...request,
        prompt,
      });

      // Track token usage for budget decisions
      if (result.tokenUsage) {
        globalTurnTokens +=
          (result.tokenUsage.input ?? 0) + (result.tokenUsage.output ?? 0);
      }

      if (result.status === 'failed') {
        if (result.error?.includes('prompt_too_long')) {
          yield { type: 'error', apiError: 'prompt_too_long' };
          return;
        }
        throw new Error(result.error ?? 'Executor failed');
      }

      // Yield the output as a text event
      yield { type: 'text', content: result.output };
    },
    uuid: randomUUID,
    estimateTokens: (messages: QueryMessage[]) =>
      messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
  };

  // Build integration callbacks from the factory
  const callbacks = createQueryLoopParams({
    contextWindowTokens,
    tokenBudget,
    enableCompaction,
    estimateTokens: queryDeps.estimateTokens,
    getGlobalTurnTokens: () => globalTurnTokens,
  });

  // Seed initial messages from the request prompt
  const initialMessages: QueryMessage[] = [
    {
      uuid: randomUUID(),
      type: 'user',
      content: request.prompt,
    },
  ];

  logger?.debug('Harness session: starting query loop', {
    contextWindowTokens,
    compactionEnabled: enableCompaction,
    budgetEnabled: tokenBudget !== undefined,
  });

  // Run the query loop and collect output
  const outputParts: string[] = [];

  const gen = queryLoop({
    messages: initialMessages,
    systemPrompt: '',
    deps: queryDeps,
    ...callbacks,
  });

  let terminal: import('../../query/transitions').Terminal | undefined;

  // Consume generator — collect assistant messages, propagate terminal
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const iterResult = await gen.next();

    if (iterResult.done) {
      terminal = iterResult.value;
      break;
    }

    const event = iterResult.value;
    if (event.type === 'assistant_message') {
      outputParts.push(event.message.content);
    } else if (event.type === 'error_message') {
      logger?.warn('Harness session: query loop error', {
        content: event.message.content.slice(0, 200),
      });
    }
  }

  const duration = Date.now() - startTime;

  logger?.info('Harness session: query loop completed', {
    terminalReason: terminal?.reason,
    durationMs: duration,
    outputParts: outputParts.length,
  });

  // Map terminal reason to TaskExecutionResult
  const isError = terminal?.reason === 'model_error'
    || terminal?.reason === 'blocking_limit'
    || terminal?.reason === 'prompt_too_long';

  return {
    status: isError ? 'failed' : 'completed',
    output: outputParts.join('\n'),
    duration,
    error: isError ? `Query loop terminal: ${terminal!.reason}` : undefined,
  };
}

