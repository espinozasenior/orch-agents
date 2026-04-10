/**
 * Permission evaluator for NDJSON child sessions.
 *
 * Phase P7: NDJSON Permission Negotiation (FR-P7-001, FR-P7-002, FR-P7-003)
 *
 * Evaluates tool permission requests against a SessionPermissionPolicy.
 * Read-only tools are always approved. Write tools are checked against
 * allowedTools and writableRoots.
 */

import { realpathSync } from 'node:fs';
import { resolve as pathResolve, relative as pathRelative } from 'node:path';
import type { PermissionRequestPayload } from './ndjson-protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionPermissionPolicy {
  readonly allowedTools: string[];
  readonly writableRoots: string[];
}

export interface PermissionResult {
  readonly approved: boolean;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

const WRITE_TOOLS = new Set(['Edit', 'Write']);

const ROLE_TOOL_MAP: Record<string, string[]> = {
  researcher: ['Read', 'Grep', 'Glob', 'Bash'],
  implementer: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
  verifier: ['Read', 'Grep', 'Glob', 'Bash'],
};

const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];

// Finding 4 — Protected paths that must never be written to
const PROTECTED_PATHS = new Set([
  '.gitconfig', '.gitmodules', '.bashrc', '.zshrc', '.profile',
  '.npmrc', '.yarnrc', '.env', '.env.local', '.env.production',
]);

const PROTECTED_DIRS = new Set([
  '.git', '.github/workflows', '.claude', '.vscode', '.idea',
]);

// Finding 3 + Finding 6 — Dangerous command prefixes for Bash deny-list
const DANGEROUS_COMMAND_PREFIXES = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat',           // network exfil
  'ssh', 'scp', 'sftp', 'rsync',                     // remote access
  'python', 'python3', 'node', 'ruby', 'perl', 'php', 'lua', // code exec
  'bash', 'sh', 'zsh', 'dash', 'csh', 'fish',        // shell interpreters
  'eval', 'exec', 'sudo', 'su', 'doas', 'env',       // privilege escalation
  'rm -rf /', 'mkfs', 'dd',                           // destructive
  'base64', 'xxd',                                    // encoding (exfil prep)
  'docker', 'kubectl',                                // container escape
]);

// Shell metacharacter patterns that can chain dangerous commands
const SHELL_CHAIN_PATTERN = /\$\(|`|\|(?:\|)?|&&|;|\n/;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function evaluatePermission(
  request: PermissionRequestPayload,
  policy: SessionPermissionPolicy,
): PermissionResult {
  const { tool } = request;

  // Read-only tools always approved regardless of policy
  if (READ_ONLY_TOOLS.has(tool)) {
    return { approved: true };
  }

  // Tool whitelist check
  if (!policy.allowedTools.includes(tool)) {
    return { approved: false, reason: `Tool "${tool}" not permitted by policy` };
  }

  // Write tools: check file_path against writableRoots + protected paths
  if (WRITE_TOOLS.has(tool) && request.args?.file_path) {
    const rawPath = String(request.args.file_path);

    // Finding 9 — Null byte check
    if (rawPath.includes('\0')) {
      return { approved: false, reason: 'Path contains null byte' };
    }

    // Finding 9 — Symlink resolution: prefer realpathSync, fall back to pathResolve
    let filePath: string;
    try {
      filePath = realpathSync(rawPath);
    } catch {
      // File doesn't exist yet — fall back to resolve
      filePath = pathResolve(rawPath);
    }

    const matchedRoot = policy.writableRoots.find(
      (root) => filePath === root || filePath.startsWith(root + '/'),
    );
    if (!matchedRoot) {
      return { approved: false, reason: `Path "${filePath}" outside writable roots` };
    }

    // Finding 4 — Protected path check (relative to the matched writable root)
    const relPath = pathRelative(matchedRoot, filePath);
    if (PROTECTED_PATHS.has(relPath)) {
      return { approved: false, reason: `Write to protected path "${relPath}" denied` };
    }
    const protectedDir = [...PROTECTED_DIRS].find(
      (dir) => relPath === dir || relPath.startsWith(dir + '/'),
    );
    if (protectedDir) {
      return { approved: false, reason: `Write to protected directory "${protectedDir}" denied` };
    }
  }

  // Finding 3 + Finding 6 — Bash command deny-list
  if (tool === 'Bash') {
    const command = String(request.args?.command ?? '').trim();
    if (command) {
      const denial = analyzeBashCommand(command);
      if (denial) {
        return denial;
      }
    }
  }

  return { approved: true };
}

// ---------------------------------------------------------------------------
// Bash command analysis (Finding 3 + Finding 6)
// ---------------------------------------------------------------------------

function extractFirstWord(command: string): string {
  return command.split(/\s+/)[0] ?? '';
}

function isDangerousCommand(cmd: string): boolean {
  const firstWord = extractFirstWord(cmd.trim());
  // Direct match
  if (DANGEROUS_COMMAND_PREFIXES.has(firstWord)) return true;
  // Path-qualified commands: /usr/bin/curl, ./curl → extract basename
  const basename = firstWord.includes('/') ? firstWord.split('/').pop() ?? '' : '';
  if (basename && DANGEROUS_COMMAND_PREFIXES.has(basename)) return true;
  // Multi-word prefixes (e.g. "rm -rf /")
  for (const prefix of DANGEROUS_COMMAND_PREFIXES) {
    if (prefix.includes(' ') && cmd.trimStart().startsWith(prefix)) return true;
  }
  return false;
}

function analyzeBashCommand(command: string): PermissionResult | null {
  // Direct dangerous command check
  if (isDangerousCommand(command)) {
    const firstWord = extractFirstWord(command);
    return { approved: false, reason: `Dangerous command "${firstWord}" denied` };
  }

  // Check for shell metacharacters chaining to dangerous commands
  if (SHELL_CHAIN_PATTERN.test(command)) {
    // Split on chain operators and check each segment
    const segments = command.split(/\$\(|`|\|{1,2}|&&|;|\n/);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed && isDangerousCommand(trimmed)) {
        const firstWord = extractFirstWord(trimmed);
        return {
          approved: false,
          reason: `Dangerous command "${firstWord}" found after shell metacharacter`,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Policy factory
// ---------------------------------------------------------------------------

export function buildSessionPolicy(
  agentRole: string,
  worktreePath: string,
): SessionPermissionPolicy {
  const allowedTools = ROLE_TOOL_MAP[agentRole] ?? DEFAULT_TOOLS;
  return {
    allowedTools,
    writableRoots: [pathResolve(worktreePath)],
  };
}
