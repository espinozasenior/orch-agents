/**
 * TDD: Tests for AgentSandbox — isolates spawned agent processes from project hooks.
 *
 * Creates a clean temporary directory with no .claude/settings.json so that
 * spawned `claude --print -` processes do not inherit project hooks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAgentSandbox,
  getActiveSandboxes,
  type AgentSandbox,
} from '../../src/execution/runtime/agent-sandbox';

// ---------------------------------------------------------------------------
// Step 1: agent-sandbox.ts tests
// ---------------------------------------------------------------------------

describe('AgentSandbox', () => {
  it('createAgentSandbox() creates a temporary directory that exists', () => {
    const sandbox = createAgentSandbox();
    try {
      assert.ok(fs.existsSync(sandbox.cwd), 'Sandbox cwd should exist');
      assert.ok(
        fs.statSync(sandbox.cwd).isDirectory(),
        'Sandbox cwd should be a directory',
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it('temporary directory contains no .claude subdirectory', () => {
    const sandbox = createAgentSandbox();
    try {
      const claudeDir = path.join(sandbox.cwd, '.claude');
      assert.ok(
        !fs.existsSync(claudeDir),
        'Sandbox should not contain a .claude directory',
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it('cleanup() removes the directory', () => {
    const sandbox = createAgentSandbox();
    const dir = sandbox.cwd;
    assert.ok(fs.existsSync(dir), 'Directory should exist before cleanup');

    sandbox.cleanup();

    assert.ok(!fs.existsSync(dir), 'Directory should not exist after cleanup');
  });

  it('cleanup() on already-removed directory does not throw', () => {
    const sandbox = createAgentSandbox();
    const dir = sandbox.cwd;

    // Remove manually first
    fs.rmSync(dir, { recursive: true, force: true });

    // Second cleanup should not throw
    assert.doesNotThrow(() => sandbox.cleanup());
  });

  it('directory is created under os.tmpdir()', () => {
    const sandbox = createAgentSandbox();
    try {
      const tmpRoot = fs.realpathSync(os.tmpdir());
      const sandboxReal = fs.realpathSync(sandbox.cwd);
      assert.ok(
        sandboxReal.startsWith(tmpRoot),
        `Sandbox dir ${sandboxReal} should be under tmpdir ${tmpRoot}`,
      );
    } finally {
      sandbox.cleanup();
    }
  });

  // Step 4: Process exit cleanup (defense-in-depth)
  it('getActiveSandboxes() tracks created sandboxes', () => {
    const sandbox = createAgentSandbox();
    try {
      const active = getActiveSandboxes();
      assert.ok(active.has(sandbox.cwd), 'Active set should contain sandbox cwd');
    } finally {
      sandbox.cleanup();
    }
  });

  it('cleanup() removes sandbox from active set', () => {
    const sandbox = createAgentSandbox();
    const dir = sandbox.cwd;
    sandbox.cleanup();

    const active = getActiveSandboxes();
    assert.ok(!active.has(dir), 'Active set should not contain cleaned-up sandbox');
  });
});
