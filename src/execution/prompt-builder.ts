/**
 * Prompt Builder — builds contextual prompts for task-tool agents.
 *
 * Pure function module with no dependencies.
 * Takes (phase, agent, intakeEvent, plan) and returns a structured prompt
 * that gives agents real webhook context to work with.
 */

import type { IntakeEvent, WorkflowPlan, Finding } from '../types';
import { sanitize, wrapUserContent, wrapSystemInstructions } from '../shared/input-sanitizer';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a prompt for fix-it agents that address review findings.
 */
export function buildFixPrompt(
  intakeEvent: IntakeEvent,
  plan: WorkflowPlan,
  options: {
    worktreePath: string;
    findings: Finding[];
    feedback: string;
    attempt: number;
    maxAttempts: number;
  },
): string {
  const sections: string[] = [];

  // 1. Role
  sections.push('## Role: Fix Agent');

  // 2. Objective
  sections.push(
    '',
    '## Objective',
    `Fix the issues found during code review. This is attempt ${options.attempt} of ${options.maxAttempts}.`,
  );

  // 3. Instructions
  sections.push(
    '',
    '## Instructions',
    `You are working in directory: ${options.worktreePath}`,
    'Edit files directly. Fix ALL issues listed below.',
  );

  // 4. Work context
  sections.push('', '## Work Context');
  sections.push(`- Intent: ${intakeEvent.intent}`);
  if (plan.methodology) sections.push(`- Methodology: ${plan.methodology}`);
  const { entities } = intakeEvent;
  if (entities.repo) sections.push(`- Repository: ${entities.repo}`);
  if (entities.branch) sections.push(`- Branch: ${entities.branch}`);

  // 5. Issues to fix
  sections.push('', '## Issues to Fix');
  for (const finding of options.findings) {
    const loc = finding.location ? ` (${finding.location})` : '';
    sections.push(`- [${finding.severity}] ${finding.message}${loc}`);
  }

  // 6. Completion
  sections.push(
    '',
    '## Completion',
    'After fixing, run tests to verify. Provide a brief summary of fixes applied.',
  );

  // Wrap system instructions
  const systemContent = wrapSystemInstructions(sections.join('\n'));

  // 7. Review feedback as user content (sanitized)
  const sanitizedFeedback = sanitize(options.feedback);
  const feedbackSection = wrapUserContent('## Review Feedback\n' + sanitizedFeedback);

  return systemContent + '\n' + feedbackSection;
}


