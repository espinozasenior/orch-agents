/**
 * TDD: Tests for AgentSandbox — isolates spawned agent processes with security controls.
 *
 * Creates a clean temporary directory with a restrictive .claude/settings.json
 * so that spawned `claude --print -` processes run under tight permissions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAgentSandbox,
  cleanupStaleSandboxes,
  getActiveSandboxes,
  type AgentSandbox,
} from '../../src/execution/runtime/agent-sandbox';

// ---------------------------------------------------------------------------
// Core sandbox tests
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

  it('writes restrictive .claude/settings.json into sandbox', () => {
    const sandbox = createAgentSandbox();
    try {
      const settingsPath = path.join(sandbox.cwd, '.claude', 'settings.json');
      assert.ok(fs.existsSync(settingsPath), '.claude/settings.json should exist');

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.ok(settings.permissions, 'settings should have permissions');
      assert.ok(Array.isArray(settings.permissions.allow), 'should have allow list');
      assert.ok(Array.isArray(settings.permissions.deny), 'should have deny list');
      assert.ok(
        settings.permissions.deny.some((d: string) => d.includes('curl')),
        'deny list should block curl',
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it('writes security CLAUDE.md into sandbox', () => {
    const sandbox = createAgentSandbox();
    try {
      const mdPath = path.join(sandbox.cwd, 'CLAUDE.md');
      assert.ok(fs.existsSync(mdPath), 'CLAUDE.md should exist');

      const content = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(content.includes('network commands'), 'CLAUDE.md should mention network');
      assert.ok(content.includes('secrets'), 'CLAUDE.md should mention secrets');
    } finally {
      sandbox.cleanup();
    }
  });

  it('networkRestricted defaults to true with proxy env vars', () => {
    const sandbox = createAgentSandbox();
    try {
      assert.equal(sandbox.networkRestricted, true);
      assert.equal(sandbox.env.no_proxy, '*');
      assert.equal(sandbox.env.HTTP_PROXY, 'http://0.0.0.0:0');
      assert.equal(sandbox.env.HTTPS_PROXY, 'http://0.0.0.0:0');
    } finally {
      sandbox.cleanup();
    }
  });

  it('networkRestricted: false omits proxy env vars', () => {
    const sandbox = createAgentSandbox({ networkRestricted: false });
    try {
      assert.equal(sandbox.networkRestricted, false);
      assert.equal(Object.keys(sandbox.env).length, 0);
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

  // Process exit cleanup (defense-in-depth)
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

// ---------------------------------------------------------------------------
// Stale sandbox cleanup tests
// ---------------------------------------------------------------------------

describe('cleanupStaleSandboxes', () => {
  it('removes sandbox directories older than maxAgeMs', () => {
    // Create a sandbox and artificially age it
    const sandbox = createAgentSandbox();
    const dir = sandbox.cwd;

    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(dir, twoHoursAgo, twoHoursAgo);

    // Clean sandboxes older than 1 hour
    cleanupStaleSandboxes(60 * 60 * 1000);

    assert.ok(!fs.existsSync(dir), 'Stale sandbox should be removed');
  });

  it('preserves sandbox directories newer than maxAgeMs', () => {
    const sandbox = createAgentSandbox();
    try {
      // Clean sandboxes older than 1 hour — this one is fresh
      cleanupStaleSandboxes(60 * 60 * 1000);

      assert.ok(fs.existsSync(sandbox.cwd), 'Fresh sandbox should be preserved');
    } finally {
      sandbox.cleanup();
    }
  });

  it('does not throw when tmpdir has no matching directories', () => {
    assert.doesNotThrow(() => cleanupStaleSandboxes(0));
  });
});
