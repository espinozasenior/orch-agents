/**
 * Output Parser — pure functions for detecting patterns in Claude CLI output chunks.
 *
 * Detects tool_use blocks, thinking markers, JSON fragments, and token usage
 * from stdout/stderr streams. All functions are pure with no side effects.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedSignals {
  toolUse: boolean;
  thinking: boolean;
  jsonComplete: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
}

// ---------------------------------------------------------------------------
// Chunk parsing
// ---------------------------------------------------------------------------

/**
 * Parse a stdout chunk for known Claude output patterns.
 *
 * Detects:
 * - tool_use blocks (JSON `"type": "tool_use"` or XML `<tool_use>`)
 * - thinking markers (JSON `"type": "thinking"` or XML `<thinking>`)
 * - JSON completion (chunk + buffer forms valid JSON object)
 */
export function parseChunk(chunk: string, accumulatedBuffer: string): ParsedSignals {
  const signals: ParsedSignals = {
    toolUse: false,
    thinking: false,
    jsonComplete: false,
  };

  // Detect tool_use patterns
  if (chunk.includes('"type": "tool_use"') || chunk.includes('"type":"tool_use"') || chunk.includes('<tool_use>')) {
    signals.toolUse = true;
  }

  // Detect thinking patterns
  if (chunk.includes('"type": "thinking"') || chunk.includes('"type":"thinking"') || chunk.includes('<thinking>')) {
    signals.thinking = true;
  }

  // Check if accumulated buffer + chunk forms valid JSON
  const combined = accumulatedBuffer + chunk;
  const trimmed = combined.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      JSON.parse(trimmed);
      signals.jsonComplete = true;
    } catch {
      // Not yet complete JSON
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Token extraction from stderr
// ---------------------------------------------------------------------------

/**
 * Attempt to extract token usage from Claude CLI stderr output.
 *
 * Supports two formats:
 * 1. JSON: `{"usage": {"input_tokens": N, "output_tokens": N}}`
 * 2. Text: `Input tokens: N` / `Output tokens: N` (line-based)
 *
 * Returns undefined if no token information is found.
 */
export function tryParseTokens(stderr: string): TokenUsage | undefined {
  // Try JSON format first (more structured)
  const jsonMatch = stderr.match(/"input_tokens"\s*:\s*(\d+)/);
  const jsonOutputMatch = stderr.match(/"output_tokens"\s*:\s*(\d+)/);
  if (jsonMatch && jsonOutputMatch) {
    return {
      input: parseInt(jsonMatch[1], 10),
      output: parseInt(jsonOutputMatch[1], 10),
    };
  }

  // Try text format
  const textInputMatch = stderr.match(/[Ii]nput\s+tokens?\s*:\s*(\d+)/);
  const textOutputMatch = stderr.match(/[Oo]utput\s+tokens?\s*:\s*(\d+)/);
  if (textInputMatch && textOutputMatch) {
    return {
      input: parseInt(textInputMatch[1], 10),
      output: parseInt(textOutputMatch[1], 10),
    };
  }

  return undefined;
}
