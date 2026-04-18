/**
 * .env File Reader/Writer.
 *
 * Reads and writes .env files with merge semantics:
 * existing variables are preserved, new/updated ones are upserted.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Parse a .env file into a key-value map.
 * Handles comments, empty lines, and quoted values.
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key.length > 0) {
      vars[key] = value;
    }
  }

  return vars;
}

/**
 * Write variables to a .env file, merging with existing content.
 * Preserves comments and ordering of existing variables.
 * New variables are appended at the end.
 */
export function writeEnvFile(path: string, newVars: Record<string, string>): void {
  const pending = { ...newVars };
  const outputLines: string[] = [];

  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        outputLines.push(line);
        continue;
      }

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) {
        outputLines.push(line);
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      if (key in pending) {
        outputLines.push(`${key}=${quoteIfNeeded(pending[key])}`);
        delete pending[key];
      } else {
        outputLines.push(line);
      }
    }
  }

  // Append remaining new variables
  for (const [key, value] of Object.entries(pending)) {
    outputLines.push(`${key}=${quoteIfNeeded(value)}`);
  }

  // Ensure trailing newline
  const output = outputLines.join('\n');
  writeFileSync(path, output.endsWith('\n') ? output : output + '\n', 'utf-8');
}

function quoteIfNeeded(value: string): string {
  if (value.includes(' ') || value.includes('#') || value.includes('"')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
