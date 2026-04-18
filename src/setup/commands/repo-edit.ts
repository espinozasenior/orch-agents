/**
 * Repo Edit Command.
 *
 * Loads current config from WORKFLOW.md, presents current events
 * for multi-select update, and writes changes back.
 */

import { createInterface } from 'node:readline';
import type { TerminalIO, SelectItem } from '../types';
import { multiSelect } from '../renderer';
import { createWorkflowEditor } from '../workflow-editor';

// ---------------------------------------------------------------------------
// Event definitions (same as repo-add)
// ---------------------------------------------------------------------------

interface EventOption {
  value: string;
  label: string;
  description: string;
}

const EVENT_OPTIONS: EventOption[] = [
  { value: 'push', label: 'push', description: 'Push events' },
  { value: 'pull_request', label: 'pull_request', description: 'Pull request events' },
  { value: 'issues', label: 'issues', description: 'Issue events' },
  { value: 'issue_comment', label: 'issue_comment', description: 'Issue/PR comments' },
  { value: 'pull_request_review', label: 'pull_request_review', description: 'PR reviews' },
  { value: 'workflow_run', label: 'workflow_run', description: 'CI/CD runs' },
  { value: 'release', label: 'release', description: 'Releases' },
];

// ---------------------------------------------------------------------------
// Text input helper
// ---------------------------------------------------------------------------

async function promptText(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (default: ${defaultValue})` : '';

  return new Promise<string>((resolvePromise) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolvePromise(trimmed || defaultValue || '');
    });
  });
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function runRepoEdit(io: TerminalIO, repoFullName: string): Promise<void> {
  io.write('\n  \x1b[1m\x1b[36mEdit Repository\x1b[0m\n\n');

  if (!repoFullName.includes('/')) {
    console.error('  Error: Repository must be in owner/repo format');
    process.exit(1);
  }

  const editor = createWorkflowEditor();
  const repos = editor.listRepos();
  const entry = repos.find((r) => r.name === repoFullName);

  if (!entry) {
    console.error(`  Error: Repository ${repoFullName} not found in WORKFLOW.md`);
    process.exit(1);
  }

  // Determine currently subscribed event types from the stored events
  const currentEvents = entry.config.github?.events ?? {};
  const currentEventTypes = new Set<string>();
  for (const eventKey of Object.keys(currentEvents)) {
    // Event keys are like "pull_request.opened" — extract the base type
    const baseType = eventKey.split('.')[0];
    currentEventTypes.add(baseType);
  }

  io.write(`  Current events for \x1b[1m${repoFullName}\x1b[0m:\n`);
  if (currentEventTypes.size > 0) {
    for (const evt of currentEventTypes) {
      io.write(`    \x1b[32m- ${evt}\x1b[0m\n`);
    }
  } else {
    io.write('    \x1b[2m(none)\x1b[0m\n');
  }
  io.write('\n');

  // Multi-select with current selections pre-checked
  const eventItems: SelectItem<string>[] = EVENT_OPTIONS.map((e) => ({
    value: e.value,
    label: e.label,
    description: e.description,
    selected: currentEventTypes.has(e.value),
  }));

  const selectedEvents = await multiSelect(io, 'Update event subscriptions', eventItems);

  // Restore stdin for text prompts
  io.close();

  // Prompt for skill path per event
  const DEFAULT_SKILL = '.claude/skills/github-ops/SKILL.md';
  const eventsMap: Record<string, string> = {};

  for (const eventName of selectedEvents) {
    // Check if there's an existing skill path for this event type
    const existingKey = Object.keys(currentEvents).find((k) => k.startsWith(eventName));
    const existingSkill = existingKey ? currentEvents[existingKey] : undefined;

    const skillPath = await promptText(
      `Skill path for '${eventName}'`,
      existingSkill ?? DEFAULT_SKILL,
    );
    eventsMap[`${eventName}.opened`] = skillPath;
  }

  // Update WORKFLOW.md
  const updatedConfig = {
    ...entry.config,
    github: { events: eventsMap },
  };

  editor.updateRepo(repoFullName, updatedConfig);

  console.log(`\n  \x1b[32mRepository ${repoFullName} updated in WORKFLOW.md\x1b[0m`);
}
