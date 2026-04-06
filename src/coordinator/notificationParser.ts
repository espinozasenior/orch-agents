/**
 * Parse task-notification XML emitted by workers.
 *
 * Workers report completion/failure via XML blocks embedded in
 * user-role messages. This module extracts structured
 * TaskNotification objects from that XML.
 */

import type { TaskNotification } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of an XML tag from a string.
 * Returns undefined if the tag is not found.
 */
function extractTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = regex.exec(xml);
  return match ? match[1].trim() : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a text block contains a task-notification XML element.
 */
export function isTaskNotification(text: string): boolean {
  return /<task-notification>[\s\S]*?<\/task-notification>/.test(text);
}

/**
 * Parse a task-notification XML block into a TaskNotification object.
 *
 * @throws {Error} If required fields (task-id, status, summary) are missing.
 */
export function parseTaskNotification(xmlText: string): TaskNotification {
  const block = extractTag(xmlText, 'task-notification');
  if (!block) {
    throw new Error('No <task-notification> element found');
  }

  const taskId = extractTag(block, 'task-id');
  const status = extractTag(block, 'status');
  const summary = extractTag(block, 'summary');

  if (!taskId) throw new Error('Missing required <task-id> in task-notification');
  if (!status) throw new Error('Missing required <status> in task-notification');
  if (!summary) throw new Error('Missing required <summary> in task-notification');

  if (status !== 'completed' && status !== 'failed' && status !== 'killed') {
    throw new Error(`Invalid status "${status}": expected completed, failed, or killed`);
  }

  const result = extractTag(block, 'result');

  // Parse optional usage block
  let usage: TaskNotification['usage'];
  const usageBlock = extractTag(block, 'usage');
  if (usageBlock) {
    const totalTokensStr = extractTag(usageBlock, 'total-tokens');
    const toolUsesStr = extractTag(usageBlock, 'tool-uses');
    const durationMsStr = extractTag(usageBlock, 'duration-ms');
    if (totalTokensStr && toolUsesStr && durationMsStr) {
      usage = {
        totalTokens: parseInt(totalTokensStr, 10),
        toolUses: parseInt(toolUsesStr, 10),
        durationMs: parseInt(durationMsStr, 10),
      };
    }
  }

  return { taskId, status, summary, result, usage };
}
