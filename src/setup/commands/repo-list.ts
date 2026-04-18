/**
 * Repo List Command.
 *
 * Reads WORKFLOW.md and prints all configured repositories
 * with their subscribed events.
 */

import { createWorkflowEditor } from '../workflow-editor';

export function runRepoList(): void {
  const editor = createWorkflowEditor();
  const repos = editor.listRepos();

  if (repos.length === 0) {
    console.log('\n  No repositories configured in WORKFLOW.md.\n');
    console.log('  Run `setup repo add <owner/repo>` to add one.\n');
    return;
  }

  console.log(`\n  \x1b[1m\x1b[36mConfigured Repositories\x1b[0m (${repos.length})\n`);
  console.log('  ─────────────────────────────────');

  for (const { name, config } of repos) {
    console.log(`\n  \x1b[1m${name}\x1b[0m`);
    console.log(`    URL:    ${config.url}`);
    console.log(`    Branch: ${config.defaultBranch}`);

    if (config.teams && config.teams.length > 0) {
      console.log(`    Teams:  ${config.teams.join(', ')}`);
    }
    if (config.labels && config.labels.length > 0) {
      console.log(`    Labels: ${config.labels.join(', ')}`);
    }

    if (config.github?.events) {
      console.log('    Events:');
      for (const [event, skill] of Object.entries(config.github.events)) {
        console.log(`      \x1b[32m${event}\x1b[0m -> ${skill}`);
      }
    } else {
      console.log('    Events: \x1b[2m(none configured)\x1b[0m');
    }

    if (config.tracker?.team) {
      console.log(`    Tracker Team: ${config.tracker.team}`);
    }
  }

  console.log('');
}
