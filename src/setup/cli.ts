#!/usr/bin/env node
/**
 * Setup CLI for orch-agents.
 *
 * Commander.js-based CLI with subcommands for configuring
 * GitHub, Linear, and repository integrations.
 */

import { Command } from 'commander';
import { createTerminalIO } from './renderer';
import { runGitHubSetup } from './commands/github';
import { runRepoAdd } from './commands/repo-add';
import { runRepoList } from './commands/repo-list';
import { runRepoEdit } from './commands/repo-edit';
import { runRepoRemove } from './commands/repo-remove';
import { runLinearSetup } from './commands/linear';

const program = new Command();

program
  .name('orch-setup')
  .description('Configure orch-agents repositories and integrations')
  .version('0.4.0');

// -- github ------------------------------------------------------------------

program
  .command('github')
  .description('Configure GitHub App or PAT credentials')
  .action(async () => {
    const io = createTerminalIO();
    try {
      await runGitHubSetup(io);
    } finally {
      io.close();
    }
  });

// -- repo --------------------------------------------------------------------

const repo = program
  .command('repo')
  .description('Manage repositories');

repo
  .command('add')
  .argument('<owner/repo>', 'Repository in owner/repo format')
  .description('Add repo with webhook + generate WORKFLOW.md template')
  .action(async (repoSlug: string) => {
    await runRepoAdd(repoSlug);
  });

repo
  .command('list')
  .description('List configured repositories')
  .action(() => {
    runRepoList();
  });

repo
  .command('edit')
  .argument('<owner/repo>', 'Repository in owner/repo format')
  .description('Edit a repository workflow config')
  .action(async (repoSlug: string) => {
    const io = createTerminalIO();
    try {
      await runRepoEdit(io, repoSlug);
    } finally {
      io.close();
    }
  });

repo
  .command('remove')
  .argument('<owner/repo>', 'Repository in owner/repo format')
  .description('Remove a repository')
  .action(async (repoSlug: string) => {
    const io = createTerminalIO();
    try {
      await runRepoRemove(io, repoSlug);
    } finally {
      io.close();
    }
  });

// -- tunnel ------------------------------------------------------------------

program
  .command('tunnel')
  .description('Enable or disable Cloudflare tunnel')
  .argument('<on|off>', '"on" to enable, "off" to disable')
  .action((state: string) => {
    const { resolve } = require('node:path');
    const { writeEnvFile } = require('./env-writer');
    const envPath = resolve(process.cwd(), '.env');
    if (state === 'on') {
      writeEnvFile(envPath, { ENABLE_TUNNEL: 'true' });
      console.log('  \x1b[32mTunnel enabled.\x1b[0m Next server start will open a Cloudflare tunnel.');
    } else if (state === 'off') {
      writeEnvFile(envPath, { ENABLE_TUNNEL: 'false' });
      console.log('  \x1b[33mTunnel disabled.\x1b[0m Server will not start a tunnel.');
    } else {
      console.error('  Error: Use "on" or "off". Example: orch-setup tunnel on');
      process.exit(1);
    }
  });

// -- linear ------------------------------------------------------------------

program
  .command('linear')
  .description('Configure Linear integration')
  .action(async () => {
    const io = createTerminalIO();
    try {
      await runLinearSetup(io);
    } finally {
      io.close();
    }
  });

// -- parse -------------------------------------------------------------------

program.parseAsync().catch((err: unknown) => {
  if (err instanceof Error && err.message === 'User cancelled') {
    console.log('\n  \x1b[2mSetup cancelled.\x1b[0m\n');
    process.exit(0);
  }
  console.error('Setup failed:', err);
  process.exit(1);
});
