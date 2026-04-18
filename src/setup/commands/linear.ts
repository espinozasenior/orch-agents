/**
 * Linear Setup Command.
 *
 * Interactive flow to configure Linear integration credentials.
 * Writes to .env and updates WORKFLOW.md tracker section.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { TerminalIO, SelectItem } from '../types';
import { singleSelect } from '../renderer';
import { readEnvFile, writeEnvFile } from '../env-writer';
import { createWorkflowEditor } from '../workflow-editor';

const ENV_PATH = resolve(process.cwd(), '.env');

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

export async function runLinearSetup(io: TerminalIO): Promise<void> {
  io.write('\n  \x1b[1m\x1b[36mLinear Integration Setup\x1b[0m\n\n');

  const authItems: SelectItem<'api-key' | 'oauth'>[] = [
    { value: 'api-key', label: 'API Key', description: 'Direct API key authentication', selected: true },
    { value: 'oauth', label: 'OAuth', description: 'OAuth actor=app tokens', selected: false },
  ];

  const authMethod = await singleSelect(io, 'Authentication method', authItems);
  // Restore stdin to normal mode for text prompts
  io.close();

  const vars: Record<string, string> = {};

  if (authMethod === 'api-key') {
    io.write('\n  \x1b[2mConfigure Linear API Key:\x1b[0m\n\n');

    const apiKey = await promptText('Linear API Key (lin_api_...)');
    if (!apiKey) {
      console.error('  Error: LINEAR_API_KEY is required');
      process.exit(1);
    }
    vars.LINEAR_API_KEY = apiKey;
    vars.LINEAR_AUTH_MODE = 'apiKey';

  } else {
    io.write('\n  \x1b[2mConfigure Linear OAuth:\x1b[0m\n\n');

    const clientId = await promptText('OAuth Client ID');
    if (!clientId) {
      console.error('  Error: Client ID is required');
      process.exit(1);
    }
    vars.LINEAR_OAUTH_CLIENT_ID = clientId;

    const clientSecret = await promptText('OAuth Client Secret');
    if (!clientSecret) {
      console.error('  Error: Client Secret is required');
      process.exit(1);
    }
    vars.LINEAR_OAUTH_CLIENT_SECRET = clientSecret;

    vars.LINEAR_AUTH_MODE = 'oauth';
  }

  // Common Linear config
  io.write('\n');
  const teamId = await promptText('Linear Team ID');
  if (!teamId) {
    console.error('  Error: LINEAR_TEAM_ID is required');
    process.exit(1);
  }
  vars.LINEAR_TEAM_ID = teamId;
  vars.LINEAR_ENABLED = 'true';

  const webhookSecret = await promptText('Linear Webhook Secret (optional)');
  if (webhookSecret) {
    vars.LINEAR_WEBHOOK_SECRET = webhookSecret;
  }

  // Write to .env
  const existing = readEnvFile(ENV_PATH);
  writeEnvFile(ENV_PATH, { ...existing, ...vars });

  console.log(`\n  \x1b[32mLinear credentials saved to ${ENV_PATH}\x1b[0m`);

  // Update WORKFLOW.md tracker section
  try {
    const editor = createWorkflowEditor();
    editor.updateTracker({
      kind: 'linear',
      api_key: '$LINEAR_API_KEY',
      team: '$LINEAR_TEAM_ID',
    });
    console.log('  \x1b[32mWORKFLOW.md tracker section updated.\x1b[0m');
  } catch {
    console.log('  \x1b[33mNote: WORKFLOW.md not found. It will be created when you add a repo.\x1b[0m');
  }
}
