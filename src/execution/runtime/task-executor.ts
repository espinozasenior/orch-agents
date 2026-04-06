/**
 * Task Executor — executes prompts and returns structured results.
 */

import type { ContinuationState, SPARCPhase, TokenUsage } from '../../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaskExecutionRequest {
  prompt: string;
  agentRole: string;
  agentType: string;
  tier: 1 | 2 | 3;
  phaseType: SPARCPhase;
  timeout: number;
  metadata: Record<string, unknown>;
}

export interface TaskExecutionResult {
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  duration: number;
  error?: string;
  tokenUsage?: TokenUsage;
  sessionId?: string;
  lastActivityAt?: string;
  continuationState?: ContinuationState;
}

export interface TaskExecutor {
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a line is hook output that should be stripped before JSON extraction.
 * Only matches standalone hook diagnostic lines, not JSON content.
 */
function isHookOutput(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // [hook: session-start], [hook: session-end], etc.
  if (trimmed.startsWith('[hook:')) return true;

  // [SessionEnd hook], [UserPromptSubmit hook], etc.
  if (/^\[.*hook.*\]/i.test(trimmed)) return true;

  // Known hook diagnostic messages
  if (trimmed.startsWith('Session restored')) return true;
  if (trimmed.startsWith('Memory imported')) return true;
  if (trimmed.startsWith('Intelligence consolidated')) return true;
  if (trimmed.startsWith('Auto-memory synced')) return true;

  return false;
}

/**
 * Strip known hook output lines from text before JSON extraction.
 * Only strips lines that are clearly hook diagnostic output.
 * Preserves any line that could be part of valid JSON.
 */
function stripHookOutput(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isHookOutput(line))
    .join('\n');
}

/**
 * Extract the first balanced JSON object from text using brace counting.
 * Handles nested objects correctly unlike regex approaches.
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

/**
 * Extract a JSON block from Claude's response text.
 * First strips known hook output patterns, then looks for
 * ```json ... ``` blocks or raw JSON objects.
 */
export function extractJson(text: string): string | undefined {
  // Step 1: Strip known hook output patterns (defense-in-depth)
  const cleaned = stripHookOutput(text);

  // Try fenced code block first
  const fenced = cleaned.match(/```json\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      JSON.parse(fenced[1].trim());
      return fenced[1].trim();
    } catch { /* not valid JSON */ }
  }

  // DESIGN-04 FIX: Use balanced brace matching instead of fragile regex
  const jsonStr = extractBalancedJson(cleaned);
  if (jsonStr) {
    try {
      JSON.parse(jsonStr);
      return jsonStr;
    } catch { /* not valid JSON */ }
  }

  return undefined;
}
