/**
 * Prompt construction and model selection for Claude diff review.
 *
 * Extracted from claude-diff-reviewer.ts to keep files under 500 lines.
 * All functions are pure (no side effects).
 *
 * Bounded context: Review
 */

import type { Finding } from '../types';
import type { ReviewContext } from './review-gate';

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Build the diff review prompt with boundary markers to separate
 * instructions from user content. Covers all 5 review categories.
 */
export function buildDiffReviewPrompt(diff: string, context: ReviewContext, _model: string): string {
  const sections: string[] = [];

  sections.push('You are a code reviewer. Analyze the following diff for issues.');
  sections.push('');
  sections.push('## Review Categories');
  sections.push('Check for:');
  sections.push('1. Logic errors — incorrect conditions, off-by-one, null handling');
  sections.push('2. Security issues — injection, auth bypass, data exposure');
  sections.push('3. Style problems — naming, formatting, dead code');
  sections.push('4. Performance concerns — N+1 queries, unnecessary allocations, blocking I/O');
  sections.push('5. Test coverage gaps — untested branches, missing edge cases');
  sections.push('');

  // Context
  sections.push('## Context');
  if (context.repo) sections.push(`- Repository: ${context.repo}`);
  if (context.branch) sections.push(`- Branch: ${context.branch}`);
  if (context.prNumber) sections.push(`- PR: #${context.prNumber}`);
  sections.push(`- Commit: ${context.commitSha}`);
  sections.push(`- Attempt: ${context.attempt}`);
  sections.push('');

  // Boundary-marked diff (prevents prompt injection from diff content)
  sections.push('## Diff');
  sections.push('<<<DIFF_START>>>');
  sections.push(diff);
  sections.push('<<<DIFF_END>>>');
  sections.push('');

  // Output format
  sections.push('## Output Format');
  sections.push('Respond with a JSON object:');
  sections.push('```json');
  sections.push('{');
  sections.push('  "findings": [');
  sections.push('    {');
  sections.push('      "severity": "info|warning|error|critical",');
  sections.push('      "category": "logic|security|style|performance|test-coverage",');
  sections.push('      "message": "Description of the issue",');
  sections.push('      "location": "file:line (if applicable)"');
  sections.push('    }');
  sections.push('  ]');
  sections.push('}');
  sections.push('```');
  sections.push('');
  sections.push('If no issues are found, return {"findings": []}.');

  return sections.join('\n');
}

/**
 * Build a prompt for batch confidence classification via Haiku.
 */
export function buildConfidencePrompt(findings: Finding[]): string {
  const sections: string[] = [];

  sections.push('You are a code review confidence classifier.');
  sections.push('For each finding below, rate your confidence that it is a real issue (0.0 to 1.0).');
  sections.push('');
  sections.push('## Findings');

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    sections.push(`${i + 1}. [${f.severity}] ${f.category}: ${f.message}`);
  }

  sections.push('');
  sections.push('## Output Format');
  sections.push('Respond with a JSON object:');
  sections.push('```json');
  sections.push('{"scores": [0.9, 0.5, ...]}');
  sections.push('```');
  sections.push('Return one score per finding, in order.');

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Select model tier based on diff line count.
 * <500 lines -> Haiku (Tier 2), >=500 lines -> Sonnet (Tier 3).
 */
export function selectModel(diff: string): { model: string; timeout: number } {
  const lineCount = diff.split('\n').length;
  if (lineCount < 500) {
    return { model: 'haiku', timeout: 60_000 };
  }
  return { model: 'sonnet', timeout: 120_000 };
}
