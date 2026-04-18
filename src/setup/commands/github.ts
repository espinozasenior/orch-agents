/**
 * GitHub Setup Command.
 *
 * Interactive flow to configure GitHub App or Personal Access Token credentials.
 * Writes credentials to .env file (merge, don't overwrite).
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { TerminalIO, SelectItem } from '../types';
import { singleSelect } from '../renderer';
import { readEnvFile, writeEnvFile } from '../env-writer';

const ENV_PATH = resolve(process.cwd(), '.env');

// ---------------------------------------------------------------------------
// Text input helper using node:readline
// ---------------------------------------------------------------------------

async function promptText(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : '';

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

export async function runGitHubSetup(io: TerminalIO): Promise<void> {
  io.write('\n  \x1b[1m\x1b[36mGitHub Credentials Setup\x1b[0m\n\n');

  const authItems: SelectItem<'app' | 'pat'>[] = [
    { value: 'app', label: 'GitHub App', description: 'Recommended for organizations', selected: true },
    { value: 'pat', label: 'Personal Access Token', description: 'Simpler, for personal repos', selected: false },
  ];

  const authMethod = await singleSelect(io, 'Authentication method', authItems);
  // Restore stdin to normal mode for text prompts
  io.close();

  const vars: Record<string, string> = {};

  if (authMethod === 'app') {
    io.write('\n  \x1b[2mConfigure GitHub App credentials:\x1b[0m\n\n');

    const appId = await promptText('GitHub App ID');
    if (!appId) {
      console.error('  Error: APP_ID is required');
      process.exit(1);
    }
    vars.GITHUB_APP_ID = appId;

    const privateKeyPath = await promptText('Private key path (.pem file)');
    if (!privateKeyPath) {
      console.error('  Error: Private key path is required');
      process.exit(1);
    }
    const resolvedPath = resolve(privateKeyPath);
    if (!existsSync(resolvedPath)) {
      console.error(`  Error: Private key file not found at ${resolvedPath}`);
      process.exit(1);
    }
    vars.GITHUB_APP_PRIVATE_KEY_PATH = resolvedPath;

    const installationId = await promptText('Installation ID');
    if (!installationId) {
      console.error('  Error: Installation ID is required');
      process.exit(1);
    }
    vars.GITHUB_APP_INSTALLATION_ID = installationId;

  } else {
    io.write('\n  \x1b[2mConfigure Personal Access Token:\x1b[0m\n\n');

    const token = await promptText('GitHub Token (ghp_...)');
    if (!token) {
      console.error('  Error: GITHUB_TOKEN is required');
      process.exit(1);
    }
    vars.GITHUB_TOKEN = token;
  }

  // Webhook secret
  io.write('\n');
  const defaultSecret = randomBytes(16).toString('hex');
  const webhookSecret = await promptText('Webhook secret', defaultSecret);
  vars.GITHUB_WEBHOOK_SECRET = webhookSecret;

  // Merge into .env
  const existing = readEnvFile(ENV_PATH);
  writeEnvFile(ENV_PATH, { ...existing, ...vars });

  console.log(`\n  \x1b[32mCredentials saved to ${ENV_PATH}\x1b[0m`);
}
