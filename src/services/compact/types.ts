/**
 * Types for the Multi-Tier Context Compaction Engine (Phase P0).
 *
 * All configuration objects are frozen at construction to prevent
 * accidental mutation during the compaction pipeline.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 50_000;
export const DEFAULT_PRESERVE_RECENT = 4;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type CompactContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

export interface CompactMessage {
  readonly uuid: string;
  readonly type: 'user' | 'assistant' | 'system';
  readonly content: readonly CompactContentBlock[];
  readonly timestamp?: number;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  readonly preserveRecent: number;
  readonly autoCompactBufferTokens: number;
  readonly maxOutputForSummary: number;
  readonly maxConsecutiveFailures: number;
  readonly microcompactBudgetChars: number;
  readonly contextWindowTokens: number;
}

export function createDefaultConfig(
  contextWindowTokens = 200_000,
): Readonly<CompactionConfig> {
  return Object.freeze({
    preserveRecent: DEFAULT_PRESERVE_RECENT,
    autoCompactBufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
    maxOutputForSummary: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    maxConsecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    microcompactBudgetChars: DEFAULT_TOOL_RESULT_BUDGET_CHARS,
    contextWindowTokens,
  });
}

// ---------------------------------------------------------------------------
// Tracking state
// ---------------------------------------------------------------------------

export interface AutoCompactTrackingState {
  compacted: boolean;
  turnCounter: number;
  turnId: string;
  consecutiveFailures: number;
}

export function createTrackingState(
  overrides: Partial<AutoCompactTrackingState> = {},
): AutoCompactTrackingState {
  return {
    compacted: false,
    turnCounter: 0,
    turnId: '',
    consecutiveFailures: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Content replacement tracking
// ---------------------------------------------------------------------------

export interface ContentReplacementRecord {
  readonly toolUseId: string;
  readonly originalSize: number;
  readonly replacementMarker: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface CompactionResult {
  readonly summaryMessages: readonly CompactMessage[];
  readonly preCompactTokenCount: number;
  readonly postCompactTokenCount: number;
  readonly compactionUsage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

export interface CompactionPipelineResult {
  readonly compactionResult?: CompactionResult;
  readonly consecutiveFailures?: number;
  readonly toolResultReplacements: readonly ContentReplacementRecord[];
  readonly snipTokensFreed: number;
}

// ---------------------------------------------------------------------------
// Snip result
// ---------------------------------------------------------------------------

export interface SnipCompactResult {
  readonly messages: CompactMessage[];
  readonly tokensFreed: number;
  readonly boundaryMessage?: CompactMessage;
}

// ---------------------------------------------------------------------------
// Token warning state
// ---------------------------------------------------------------------------

export interface TokenWarningState {
  readonly currentTokens: number;
  readonly threshold: number;
  readonly exceeded: boolean;
  readonly buffer: number;
}
