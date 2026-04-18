/**
 * Slack Setup Command.
 *
 * Interactive flow to configure Slack webhook notifications.
 * Prompts for a webhook URL, validates the format, and writes
 * SLACK_WEBHOOK_URL to .env.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { TerminalIO } from '../types';
import { readEnvFile, writeEnvFile } from '../env-writer';

const ENV_PATH = resolve(process.cwd(), '.env');

// ---------------------------------------------------------------------------
// Text input helper
// ---------------------------------------------------------------------------

async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<string>((resolvePromise) => {
    rl.question(`  ${question}: `, (answer) => {
      rl.close();
      resolvePromise(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function runSlackSetup(io: TerminalIO): Promise<void> {
  io.write('\n  \x1b[1m\x1b[36mSlack Notification Setup\x1b[0m\n\n');
  io.write('  \x1b[2mConfigure an incoming webhook to receive agent result notifications.\x1b[0m\n\n');

  // Close raw-mode before text prompt
  io.close();

  const webhookUrl = await promptText('Slack Webhook URL (https://hooks.slack.com/...)');

  if (!webhookUrl) {
    console.error('  Error: Webhook URL is required');
    process.exit(1);
  }

  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    console.error('  Error: URL must start with https://hooks.slack.com/');
    process.exit(1);
  }

  const existing = readEnvFile(ENV_PATH);
  writeEnvFile(ENV_PATH, { ...existing, SLACK_WEBHOOK_URL: webhookUrl });

  console.log(`\n  \x1b[32mSlack webhook URL saved to ${ENV_PATH}\x1b[0m`);
  console.log('  \x1b[2mAgent completion and failure notifications will be sent on next server start.\x1b[0m\n');
}
