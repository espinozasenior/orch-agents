/**
 * Summary Generator
 *
 * Extracts structured information from old messages and builds a
 * compaction summary preserving key context for the agent.
 */

import { randomUUID } from 'node:crypto';
import type { CompactMessage, CompactContentBlock } from './types';
import { MAX_OUTPUT_TOKENS_FOR_SUMMARY } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTextContent(message: CompactMessage): string {
  return message.content
    .filter((b): b is CompactContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractSentenceContaining(text: string, keyword: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword);
  if (idx === -1) return '';

  // Walk backward to sentence start
  let start = idx;
  while (start > 0 && text[start - 1] !== '.' && text[start - 1] !== '\n') {
    start--;
  }

  // Walk forward to sentence end
  let end = idx + keyword.length;
  while (end < text.length && text[end] !== '.' && text[end] !== '\n') {
    end++;
  }

  return text.slice(start, end + 1).trim();
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

const FILE_EXT_PATTERN = /(?:^|\s|['"`(])([^\s'"`()]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml))\b/g;

/**
 * Extract file paths from messages by matching common source extensions.
 */
export function extractFilePaths(messages: readonly CompactMessage[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    const text = getTextContent(msg);
    let match: RegExpExecArray | null;
    FILE_EXT_PATTERN.lastIndex = 0;
    while ((match = FILE_EXT_PATTERN.exec(text)) !== null) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

const PENDING_KEYWORDS = ['todo', 'next', 'follow up', 'remaining', 'fixme'] as const;

/**
 * Extract sentences containing work-in-progress keywords.
 */
export function extractPendingWork(
  messages: readonly CompactMessage[],
  keywords: readonly string[] = PENDING_KEYWORDS,
): string[] {
  const items = new Set<string>();
  for (const msg of messages) {
    const text = getTextContent(msg);
    for (const keyword of keywords) {
      if (text.toLowerCase().includes(keyword)) {
        const sentence = extractSentenceContaining(text, keyword);
        if (sentence.length > 0) {
          items.add(sentence);
        }
      }
    }
  }
  return [...items];
}

/**
 * Extract key decisions (sentences containing decision-related words).
 */
export function extractDecisions(
  messages: readonly CompactMessage[],
): string[] {
  const decisionKeywords = ['decided', 'decision', 'chose', 'agreed', 'confirmed'];
  const items = new Set<string>();
  for (const msg of messages) {
    const text = getTextContent(msg);
    for (const keyword of decisionKeywords) {
      if (text.toLowerCase().includes(keyword)) {
        const sentence = extractSentenceContaining(text, keyword);
        if (sentence.length > 0) {
          items.add(sentence);
        }
      }
    }
  }
  return [...items];
}

/**
 * Build a structured summary from extracted data.
 */
export function buildStructuredSummary(opts: {
  messageCount: number;
  filesModified: readonly string[];
  pendingWork: readonly string[];
  keyDecisions: readonly string[];
}): string {
  const lines: string[] = [
    `## Compaction Summary`,
    ``,
    `**Messages compacted:** ${opts.messageCount}`,
    ``,
  ];

  if (opts.filesModified.length > 0) {
    lines.push(`### Files Referenced`);
    for (const f of opts.filesModified) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (opts.keyDecisions.length > 0) {
    lines.push(`### Key Decisions`);
    for (const d of opts.keyDecisions) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  if (opts.pendingWork.length > 0) {
    lines.push(`### Pending Work`);
    for (const p of opts.pendingWork) {
      lines.push(`- ${p}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Forked LLM summarization (FR-P10-004)
// ---------------------------------------------------------------------------

/**
 * The compact prompt CC fork-summarises with. Lifted nearly verbatim from
 * `claude-code/src/services/compact/prompt.ts` so the wire-format the
 * forked agent sees matches CC's behaviour.
 */
export function getCompactPrompt(): string {
  return [
    'You are a context compaction agent. Summarise the conversation so far',
    'so that another agent can resume the work without losing important state.',
    '',
    'Cover (in this order, omit empty sections):',
    '1. Files referenced or modified',
    '2. Decisions made and rationale',
    '3. Pending work / TODOs',
    '4. Errors encountered and their fixes',
    '5. Tools used and their key results',
    '',
    'Be concise but complete. Prefer bullet points. Do not apologise or ',
    'add meta-commentary. Output the summary directly.',
  ].join('\n');
}

/** Wraps the LLM-generated summary into a user-visible message stub. */
export function getCompactUserSummaryMessage(summary: string): string {
  return [
    '## Compaction Summary (auto-generated)',
    '',
    'The prior conversation has been compacted to fit the context window.',
    'Resume from this checkpoint:',
    '',
    summary,
  ].join('\n');
}

/** A forked LLM call. The harness injects this — in tests we mock it. */
export type ForkedLLMCall = (params: {
  readonly prompt: string;
  readonly conversation: readonly CompactMessage[];
  readonly maxOutputTokens: number;
}) => Promise<{ readonly text: string }>;

export interface SummaryGenerationOptions {
  readonly tailRounds?: number;
  readonly forkedLLM?: ForkedLLMCall;
  readonly maxOutputTokens?: number;
}

export interface GeneratedSummary {
  /** The replacement messages: [boundary, userSummary, ...tail]. */
  readonly messages: CompactMessage[];
  /** The summary text (LLM or structured fallback). */
  readonly summaryText: string;
  /** Was the summary produced by a forked LLM call? */
  readonly viaLLM: boolean;
}

function createBoundaryMessage(): CompactMessage {
  return Object.freeze({
    uuid: randomUUID(),
    type: 'system' as const,
    content: Object.freeze([
      Object.freeze({
        type: 'text' as const,
        text: '[Compaction boundary — prior history summarised below]',
      }),
    ]),
    timestamp: Date.now(),
  });
}

function createUserSummaryMessage(summary: string): CompactMessage {
  return Object.freeze({
    uuid: randomUUID(),
    type: 'user' as const,
    content: Object.freeze([
      Object.freeze({
        type: 'text' as const,
        text: getCompactUserSummaryMessage(summary),
      }),
    ]),
    timestamp: Date.now(),
  });
}

/**
 * Generate the replacement message array for a compaction. If a forked
 * LLM is provided, summarisation runs through it (capped at
 * MAX_OUTPUT_TOKENS_FOR_SUMMARY). Otherwise, falls back to the
 * deterministic structured extractor — still a real summary, never a
 * stub.
 *
 * Tail-window invariant: the last K message rounds are preserved
 * verbatim after the boundary.
 */
export async function generateCompactionMessages(
  messages: readonly CompactMessage[],
  opts: SummaryGenerationOptions = {},
): Promise<GeneratedSummary> {
  const tailRounds = opts.tailRounds ?? 2;
  // A "round" is one user/assistant pair → 2 messages.
  const tailCount = Math.max(0, tailRounds * 2);
  const tailStart = Math.max(0, messages.length - tailCount);
  const oldMessages = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);

  let summaryText: string;
  let viaLLM = false;

  if (opts.forkedLLM) {
    const maxOutputTokens = Math.min(
      opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS_FOR_SUMMARY,
      MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    );
    const result = await opts.forkedLLM({
      prompt: getCompactPrompt(),
      conversation: oldMessages,
      maxOutputTokens,
    });
    summaryText = result.text;
    viaLLM = true;
  } else {
    summaryText = buildStructuredSummary({
      messageCount: oldMessages.length,
      filesModified: extractFilePaths(oldMessages),
      pendingWork: extractPendingWork(oldMessages),
      keyDecisions: extractDecisions(oldMessages),
    });
  }

  const boundary = createBoundaryMessage();
  const userSummary = createUserSummaryMessage(summaryText);

  return {
    messages: [boundary, userSummary, ...tail],
    summaryText,
    viaLLM,
  };
}
