/**
 * P12 — Deferred-tool prompt advertisement builder.
 *
 * Always-load tools are rendered with their full JSON schema inline.
 * Deferred tools are rendered as one-line `- name: description` summaries.
 * The output is hard-capped at PROMPT_BUDGET_BYTES (8 KB) — when the
 * deferred section would push past the cap, it is truncated and a
 * `+ N more tools available via ToolSearch` line is appended.
 *
 * See FR-P12-002 and FR-P12-007.
 */

import type { DeferredToolRegistry, DeferredToolDef } from './registry.js';

export const PROMPT_BUDGET_BYTES = 8 * 1024;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function renderAlwaysLoad(t: DeferredToolDef): string {
  return [
    `### ${t.name}`,
    t.description,
    '```json',
    JSON.stringify(t.schema, null, 2),
    '```',
    '',
  ].join('\n');
}

function renderDeferredLine(t: DeferredToolDef): string {
  return `- ${t.name}: ${t.description}`;
}

/**
 * Build the deferred-tool advertisement for the system prompt.
 *
 * @param registry The registry to read from
 * @param budget   Optional override for the byte cap (tests)
 */
export function buildPromptAdvertisement(
  registry: DeferredToolRegistry,
  budget: number = PROMPT_BUDGET_BYTES,
): string {
  const sections: string[] = [];
  sections.push('## Available Tools');
  sections.push('');

  const alwaysLoad = registry.listAlwaysLoad();
  for (const t of alwaysLoad) {
    sections.push(renderAlwaysLoad(t));
  }

  const deferred = registry.listDeferred();
  if (deferred.length === 0) {
    return sections.join('\n');
  }

  sections.push('## Deferred Tools (use ToolSearch to expand)');

  let truncatedAt = -1;
  for (let i = 0; i < deferred.length; i++) {
    const line = renderDeferredLine(deferred[i]!);
    const candidate = [...sections, line].join('\n');
    if (byteLength(candidate) > budget) {
      truncatedAt = i;
      break;
    }
    sections.push(line);
  }

  if (truncatedAt >= 0) {
    const remaining = deferred.length - truncatedAt;
    sections.push(`+ ${remaining} more tools available via ToolSearch`);
  }

  return sections.join('\n');
}
