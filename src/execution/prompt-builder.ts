/**
 * Prompt Builder — builds contextual prompts for task-tool agents.
 *
 * Pure function module with no dependencies.
 * Takes (phase, agent, intakeEvent, plan) and returns a structured prompt
 * that gives agents real webhook context to work with.
 */

import type { IntakeEvent, PlannedPhase, PlannedAgent, WorkflowPlan, Finding } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILES_IN_PROMPT = 20;
const MAX_RAW_TEXT_LENGTH = 4000;
const MAX_DIFF_LENGTH = 8000;

// ---------------------------------------------------------------------------
// Phase-specific objectives
// ---------------------------------------------------------------------------

const PHASE_OBJECTIVES: Record<string, string> = {
  specification:
    'Analyze the work item and produce a specification document. Identify requirements, constraints, risks, and acceptance criteria.',
  pseudocode:
    'Design the algorithmic approach and data flow. Produce pseudocode or high-level logic for the implementation.',
  architecture:
    'Review the system architecture implications. Identify affected components, integration points, and design decisions.',
  refinement:
    'Implement and refine the changes. Review code quality, apply fixes, and ensure tests pass.',
  completion:
    'Produce a final summary of all findings, code review comments, and recommended actions.',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a contextual prompt for a task-tool agent.
 *
 * The prompt includes:
 * - Phase objective and agent role expectations
 * - Actual webhook context (repo, branch, PR, files, labels, rawText)
 * - Output format instructions (structured JSON)
 */
export function buildPrompt(
  phase: PlannedPhase,
  agent: PlannedAgent,
  intakeEvent: IntakeEvent,
  plan: WorkflowPlan,
): string {
  const sections: string[] = [];

  // 1. Role and objective
  const objective = PHASE_OBJECTIVES[phase.type] ?? `Execute the ${phase.type} phase.`;
  sections.push(
    `## Role: ${agent.role} (${agent.type})`,
    `## Phase: ${phase.type}`,
    `## Objective`,
    objective,
  );

  // 2. Work context
  sections.push('', '## Work Context');
  sections.push(`- Intent: ${intakeEvent.intent}`);
  sections.push(`- Methodology: ${plan.methodology}`);
  sections.push(`- Gate: ${phase.gate}`);

  const { entities } = intakeEvent;

  if (entities.repo) {
    sections.push(`- Repository: ${entities.repo}`);
  }
  if (entities.branch) {
    sections.push(`- Branch: ${entities.branch}`);
  }
  if (entities.prNumber) {
    sections.push(`- PR: #${entities.prNumber}`);
  }
  if (entities.issueNumber) {
    sections.push(`- Issue: #${entities.issueNumber}`);
  }
  if (entities.author) {
    sections.push(`- Author: ${entities.author}`);
  }
  if (entities.severity) {
    sections.push(`- Severity: ${entities.severity}`);
  }

  // 3. Labels
  if (entities.labels?.length) {
    sections.push(`- Labels: ${entities.labels.join(', ')}`);
  }

  // 4. Files changed
  if (entities.files?.length) {
    const files = entities.files;
    if (files.length > MAX_FILES_IN_PROMPT) {
      const shown = files.slice(0, MAX_FILES_IN_PROMPT);
      sections.push('', '## Files Changed (truncated)');
      sections.push(shown.map((f) => `- ${f}`).join('\n'));
      sections.push(`... and ${files.length - MAX_FILES_IN_PROMPT} more files`);
    } else {
      sections.push('', '## Files Changed');
      sections.push(files.map((f) => `- ${f}`).join('\n'));
    }
  }

  // 5. Description / rawText
  if (intakeEvent.rawText) {
    const text = intakeEvent.rawText.length > MAX_RAW_TEXT_LENGTH
      ? intakeEvent.rawText.slice(0, MAX_RAW_TEXT_LENGTH) + '\n... (truncated)'
      : intakeEvent.rawText;
    sections.push('', '## Description', text);
  }

  // 6. Output format
  sections.push('', '## Output Format');
  sections.push(
    'Respond with a JSON object containing:',
    '```json',
    '{',
    `  "phaseType": "${phase.type}",`,
    `  "agentRole": "${agent.role}",`,
    '  "summary": "Brief summary of findings/work done",',
    '  "artifacts": [',
    '    {',
    '      "type": "code|review|analysis|test|documentation",',
    '      "content": "The artifact content",',
    '      "path": "Optional file path if applicable"',
    '    }',
    '  ],',
    '  "issues": [',
    '    {',
    '      "severity": "info|warning|error|critical",',
    '      "message": "Description of the issue",',
    '      "location": "Optional file:line reference"',
    '    }',
    '  ],',
    '  "status": "completed|needs-review"',
    '}',
    '```',
  );

  return sections.join('\n');
}

/**
 * Build a prompt for interactive implementation agents that edit files directly.
 *
 * Unlike buildPrompt(), this instructs agents to make file edits in the worktree
 * rather than returning JSON reports.
 */
export function buildImplementationPrompt(
  phase: PlannedPhase,
  agent: PlannedAgent,
  intakeEvent: IntakeEvent,
  plan: WorkflowPlan,
  options: {
    worktreePath: string;
    targetFiles?: string[];
    priorPhaseOutputs?: string[];
  },
): string {
  const sections: string[] = [];

  // 1. Role and phase
  const objective = PHASE_OBJECTIVES[phase.type] ?? `Execute the ${phase.type} phase.`;
  sections.push(
    `## Role: ${agent.role} (${agent.type})`,
    `## Phase: ${phase.type}`,
    `## Objective`,
    objective,
  );

  // 2. Instructions
  sections.push(
    '',
    '## Instructions',
    `You are working in directory: ${options.worktreePath}`,
    'Edit files directly using your tools. Do NOT return JSON reports. Make the changes, run tests, and verify your work.',
  );

  // 3. Work context
  appendWorkContext(sections, intakeEvent, plan, phase);

  // 4. Target files
  if (options.targetFiles?.length) {
    sections.push('', '## Target Files', 'Focus on:');
    for (const f of options.targetFiles) {
      sections.push(`- ${f}`);
    }
  }

  // 5. Prior phase outputs
  if (options.priorPhaseOutputs?.length) {
    sections.push('', '## Prior Analysis');
    for (const output of options.priorPhaseOutputs) {
      sections.push('---', output);
    }
  }

  // 6. Files changed
  appendFilesChanged(sections, intakeEvent);

  // 7. Description
  appendDescription(sections, intakeEvent);

  // 8. Completion
  sections.push('', '## Completion');
  sections.push('When done, provide a brief summary of changes made.');

  return sections.join('\n');
}

/**
 * Build a prompt for --print mode review agents that inspect a diff.
 */
export function buildReviewPrompt(
  intakeEvent: IntakeEvent,
  plan: WorkflowPlan,
  options: {
    diff: string;
    commitSha: string;
    attempt: number;
  },
): string {
  const sections: string[] = [];

  // 1. Role
  sections.push('## Role: Code Reviewer');

  // 2. Objective
  sections.push(
    '',
    '## Objective',
    'Review the following code changes for correctness, security issues, and test coverage.',
  );

  // 3. Work context (no phase needed, use a minimal context)
  sections.push('', '## Work Context');
  sections.push(`- Intent: ${intakeEvent.intent}`);
  sections.push(`- Methodology: ${plan.methodology}`);
  const { entities } = intakeEvent;
  if (entities.repo) sections.push(`- Repository: ${entities.repo}`);
  if (entities.branch) sections.push(`- Branch: ${entities.branch}`);
  if (entities.prNumber) sections.push(`- PR: #${entities.prNumber}`);

  // 4. Diff
  const diff = options.diff.length > MAX_DIFF_LENGTH
    ? options.diff.slice(0, MAX_DIFF_LENGTH) + '\n... (truncated)'
    : options.diff;
  sections.push('', '## Diff', '```diff', diff, '```');

  // 5. Commit
  sections.push('', `## Commit: ${options.commitSha}`);

  // 6. Attempt
  sections.push('', `## Review Attempt: ${options.attempt}`);

  // 7. Output format
  sections.push(
    '',
    '## Output Format',
    'Respond with a JSON object containing:',
    '```json',
    '{',
    '  "findings": [',
    '    {',
    '      "severity": "info|warning|error|critical",',
    '      "message": "Description of the issue",',
    '      "location": "file:line reference"',
    '    }',
    '  ]',
    '}',
    '```',
  );

  return sections.join('\n');
}

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
  sections.push(`- Methodology: ${plan.methodology}`);
  const { entities } = intakeEvent;
  if (entities.repo) sections.push(`- Repository: ${entities.repo}`);
  if (entities.branch) sections.push(`- Branch: ${entities.branch}`);

  // 5. Review feedback
  sections.push('', '## Review Feedback', options.feedback);

  // 6. Issues to fix
  sections.push('', '## Issues to Fix');
  for (const finding of options.findings) {
    const loc = finding.location ? ` (${finding.location})` : '';
    sections.push(`- [${finding.severity}] ${finding.message}${loc}`);
  }

  // 7. Completion
  sections.push(
    '',
    '## Completion',
    'After fixing, run tests to verify. Provide a brief summary of fixes applied.',
  );

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function appendWorkContext(
  sections: string[],
  intakeEvent: IntakeEvent,
  plan: WorkflowPlan,
  phase: PlannedPhase,
): void {
  sections.push('', '## Work Context');
  sections.push(`- Intent: ${intakeEvent.intent}`);
  sections.push(`- Methodology: ${plan.methodology}`);
  sections.push(`- Gate: ${phase.gate}`);

  const { entities } = intakeEvent;
  if (entities.repo) sections.push(`- Repository: ${entities.repo}`);
  if (entities.branch) sections.push(`- Branch: ${entities.branch}`);
  if (entities.prNumber) sections.push(`- PR: #${entities.prNumber}`);
  if (entities.issueNumber) sections.push(`- Issue: #${entities.issueNumber}`);
  if (entities.author) sections.push(`- Author: ${entities.author}`);
  if (entities.severity) sections.push(`- Severity: ${entities.severity}`);
  if (entities.labels?.length) sections.push(`- Labels: ${entities.labels.join(', ')}`);
}

function appendFilesChanged(sections: string[], intakeEvent: IntakeEvent): void {
  const files = intakeEvent.entities.files;
  if (!files?.length) return;

  if (files.length > MAX_FILES_IN_PROMPT) {
    const shown = files.slice(0, MAX_FILES_IN_PROMPT);
    sections.push('', '## Files Changed (truncated)');
    sections.push(shown.map((f) => `- ${f}`).join('\n'));
    sections.push(`... and ${files.length - MAX_FILES_IN_PROMPT} more files`);
  } else {
    sections.push('', '## Files Changed');
    sections.push(files.map((f) => `- ${f}`).join('\n'));
  }
}

function appendDescription(sections: string[], intakeEvent: IntakeEvent): void {
  if (!intakeEvent.rawText) return;
  const text = intakeEvent.rawText.length > MAX_RAW_TEXT_LENGTH
    ? intakeEvent.rawText.slice(0, MAX_RAW_TEXT_LENGTH) + '\n... (truncated)'
    : intakeEvent.rawText;
  sections.push('', '## Description', text);
}
