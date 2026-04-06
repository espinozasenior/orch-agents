/**
 * Query Loop Factory (P1 Integration)
 *
 * Builds QueryParams callbacks wired to real P0/P3/P4 implementations.
 * Bridges the QueryMessage (string content) world of the query loop with
 * the CompactMessage (block array content) world of the compaction pipeline.
 */

import type { QueryMessage } from './state.js';
import type { QueryDeps } from './deps.js';
import type {
  CompactionResult,
  StopHookResult,
  BudgetDecision,
  ToolExecutionResult,
} from './queryLoop.js';
import {
  runCompactionPipeline,
  type CompactMessage,
  type CompactContentBlock,
  type AutoCompactTrackingState,
  type CompactionConfig,
  createDefaultConfig,
  createTrackingState,
} from '../services/compact/index.js';
import {
  createBudgetTracker,
  checkTokenBudget,
  type BudgetTracker,
} from './tokenBudget.js';
import { type ToolDefinition } from '../services/tools/index.js';
import { createToolExecutionCallback } from '../services/tools/queryLoopAdapter.js';

// ---------------------------------------------------------------------------
// Factory dependencies
// ---------------------------------------------------------------------------

export interface QueryLoopFactoryDeps {
  /** Context window size in tokens. Default: 200_000 */
  contextWindowTokens?: number;
  /** Token budget for auto-continue. undefined = no budget. */
  tokenBudget?: number;
  /** Enable compaction pipeline. Default: true */
  enableCompaction?: boolean;
  /** Optional tool registry for P4 tool execution. */
  toolRegistry?: Map<string, ToolDefinition>;
  /** Token estimator for QueryMessage arrays. */
  estimateTokens: (messages: QueryMessage[]) => number;
  /** Global turn token counter (mutated externally, read here). */
  getGlobalTurnTokens?: () => number;
}

// ---------------------------------------------------------------------------
// Message adapters: QueryMessage <-> CompactMessage
// ---------------------------------------------------------------------------

/** Convert QueryMessage (string content) to CompactMessage (block array). */
export function queryMessageToCompact(msg: QueryMessage): CompactMessage {
  const blocks: CompactContentBlock[] = [];

  if (msg.content) {
    blocks.push({ type: 'text', text: msg.content });
  }

  if (msg.toolUseBlocks) {
    for (const tb of msg.toolUseBlocks) {
      blocks.push({
        type: 'tool_use',
        id: tb.id,
        name: tb.name,
        input: {},
      });
    }
  }

  return {
    uuid: msg.uuid,
    type: msg.type,
    content: blocks,
    timestamp: Date.now(),
  };
}

/** Convert CompactMessage (block array) back to QueryMessage (string content). */
export function compactMessageToQuery(msg: CompactMessage): QueryMessage {
  const textParts: string[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_result') {
      textParts.push(block.content);
    }
  }

  return {
    uuid: msg.uuid,
    type: msg.type,
    content: textParts.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Callback builders
// ---------------------------------------------------------------------------

function buildCompactCallback(
  config: CompactionConfig,
  tracking: AutoCompactTrackingState,
): (messages: QueryMessage[]) => Promise<CompactionResult> {
  return async (messages: QueryMessage[]): Promise<CompactionResult> => {
    const compactMessages = messages.map(queryMessageToCompact);

    const pipelineResult = runCompactionPipeline({
      messages: compactMessages,
      config,
      tracking,
    });

    if (pipelineResult.compactionResult) {
      const mappedMessages = pipelineResult.compactionResult.summaryMessages.map(
        compactMessageToQuery,
      );
      return { compacted: true, messages: mappedMessages };
    }

    return { compacted: false, messages };
  };
}

function buildCheckBudgetCallback(
  budget: number,
  getGlobalTurnTokens: () => number,
): () => BudgetDecision {
  const tracker: BudgetTracker = createBudgetTracker();

  return (): BudgetDecision => {
    const decision = checkTokenBudget(
      tracker,
      undefined, // not a subagent
      budget,
      getGlobalTurnTokens(),
    );

    if (decision.action === 'continue') {
      return {
        action: 'continue',
        nudgeMessage: decision.nudgeMessage,
      };
    }

    return { action: 'stop' };
  };
}

// P4 tool execution delegated to queryLoopAdapter which calls runTools
// with proper partitioning (concurrent reads, serial writes).

function buildIsAtBlockingLimitCallback(
  contextWindowTokens: number,
): (messages: QueryMessage[], estimateTokens: QueryDeps['estimateTokens']) => boolean {
  return (messages, estimateTokens): boolean => {
    const tokens = estimateTokens(messages);
    return tokens > contextWindowTokens * 0.95;
  };
}

function buildHandleStopHooksCallback(): (
  messages: QueryMessage[],
  assistantMessages: QueryMessage[],
) => Promise<StopHookResult> {
  return async (): Promise<StopHookResult> => {
    return { preventContinuation: false, blockingErrors: [] };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface QueryLoopCallbacks {
  compact: (messages: QueryMessage[]) => Promise<CompactionResult>;
  checkBudget: () => BudgetDecision;
  executeTool: (
    toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ) => Promise<ToolExecutionResult>;
  isAtBlockingLimit: (messages: QueryMessage[], estimateTokens: QueryDeps['estimateTokens']) => boolean;
  handleStopHooks: (
    messages: QueryMessage[],
    assistantMessages: QueryMessage[],
  ) => Promise<StopHookResult>;
}

/**
 * Create all QueryParams callbacks wired to real P0/P3/P4 implementations.
 *
 * Callers spread the result into QueryParams:
 * ```ts
 * const callbacks = createQueryLoopParams(deps);
 * const gen = queryLoop({ ...baseParams, ...callbacks });
 * ```
 */
export function createQueryLoopParams(
  deps: QueryLoopFactoryDeps,
): QueryLoopCallbacks {
  const {
    contextWindowTokens = 200_000,
    tokenBudget,
    enableCompaction = true,
    toolRegistry,
    getGlobalTurnTokens = () => 0,
  } = deps;

  const config = createDefaultConfig(contextWindowTokens);
  const tracking = createTrackingState();

  return {
    compact: enableCompaction
      ? buildCompactCallback(config, tracking)
      : async (messages: QueryMessage[]) => ({ compacted: false, messages }),

    checkBudget: tokenBudget !== undefined
      ? buildCheckBudgetCallback(tokenBudget, getGlobalTurnTokens)
      : () => ({ action: 'stop' as const }),

    executeTool: toolRegistry
      ? createToolExecutionCallback(toolRegistry)
      : async () => ({ messages: [] }),

    isAtBlockingLimit: buildIsAtBlockingLimitCallback(contextWindowTokens),
    handleStopHooks: buildHandleStopHooksCallback(),
  };
}
