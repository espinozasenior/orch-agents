#!/usr/bin/env node
/**
 * CLI entry point for the setup wizard.
 *
 * Usage: npx tsx src/setup/cli.ts
 * Or via npm script: npm run setup
 */

import { runWizard } from './wizard';
import { createTerminalIO } from './renderer';

async function main(): Promise<void> {
  const io = createTerminalIO();
  try {
    const config = await runWizard(io);
    if (config) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }
}

main();
