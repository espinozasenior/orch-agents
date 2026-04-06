/**
 * Summary Generator
 *
 * Extracts structured information from old messages and builds a
 * compaction summary preserving key context for the agent.
 */

import type { CompactMessage, CompactContentBlock } from './types';

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
