/**
 * Permission evaluator for NDJSON child sessions.
 *
 * Phase P7: NDJSON Permission Negotiation (FR-P7-001, FR-P7-002, FR-P7-003)
 *
 * Evaluates tool permission requests against a SessionPermissionPolicy.
 * Read-only tools are always approved. Write tools are checked against
 * allowedTools and writableRoots.
 */

import { resolve as pathResolve } from 'node:path';
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

  // Write tools: check file_path against writableRoots
  if (WRITE_TOOLS.has(tool) && request.args?.file_path) {
    const filePath = pathResolve(String(request.args.file_path));
    const withinRoot = policy.writableRoots.some(
      (root) => filePath === root || filePath.startsWith(root + '/'),
    );
    if (!withinRoot) {
      return { approved: false, reason: `Path "${filePath}" outside writable roots` };
    }
  }

  // Bash with side effects: approve (can't statically verify)
  return { approved: true };
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
