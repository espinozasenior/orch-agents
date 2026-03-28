/**
 * Agent Registry tests.
 *
 * Integration tests that scan the real `.claude/agents/` directory
 * and verify the registry works end-to-end.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createAgentRegistry } from '../../src/agent-registry/agent-registry';
import { parseWorkflowMd } from '../../src/integration/linear/workflow-parser';

const AGENTS_DIR = resolve(__dirname, '..', '..', '.claude', 'agents');
const WORKFLOW_MD = resolve(__dirname, '..', '..', 'WORKFLOW.md');

describe('AgentRegistry', () => {
  let registry: ReturnType<typeof createAgentRegistry>;

  beforeEach(() => {
    registry = createAgentRegistry({ agentsDir: AGENTS_DIR });
  });

  it('discovers agents from .claude/agents/', () => {
    const all = registry.getAll();
    assert.ok(all.length >= 20, `should find at least 20 agents, got ${all.length}`);
  });

  it('returns sorted names', () => {
    const names = registry.getNames();
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted, 'names should be sorted');
  });

  it('finds core agents by name', () => {
    assert.ok(registry.has('coder'), 'should find coder');
    assert.ok(registry.has('tester'), 'should find tester');
    assert.ok(registry.has('reviewer'), 'should find reviewer');
    assert.ok(registry.has('researcher'), 'should find researcher');
    assert.ok(registry.has('architect'), 'should find architect');
  });

  it('getByName returns full definition', () => {
    const coder = registry.getByName('coder');
    assert.notEqual(coder, undefined);
    assert.equal(coder!.name, 'coder');
    assert.ok(coder!.description.length > 0, 'should have description');
    assert.equal(coder!.category, 'core');
    assert.ok(coder!.filePath.endsWith('.md'));
  });

  it('getByName returns undefined for unknown agent', () => {
    const result = registry.getByName('nonexistent-agent-xyz');
    assert.equal(result, undefined);
  });

  it('has returns false for unknown agent', () => {
    assert.equal(registry.has('nonexistent-agent-xyz'), false);
  });

  it('getByCategory filters correctly', () => {
    const core = registry.getByCategory('core');
    assert.ok(core.length >= 4, 'core category should have at least 4 agents');
    assert.ok(core.every(a => a.category === 'core'));
  });

  it('derives category from subdirectory', () => {
    const sparc = registry.getByCategory('sparc');
    assert.ok(sparc.length >= 3, 'sparc category should have agents');

    const github = registry.getByCategory('github');
    assert.ok(github.length >= 5, 'github category should have agents');
  });

  it('refresh re-scans from disk', () => {
    const count1 = registry.getAll().length;
    registry.refresh();
    const count2 = registry.getAll().length;
    assert.equal(count1, count2, 'count should be the same after refresh');
  });

  it('returns empty array for nonexistent directory', () => {
    const empty = createAgentRegistry({ agentsDir: '/tmp/nonexistent-' + Date.now() });
    assert.deepEqual(empty.getAll(), []);
    assert.deepEqual(empty.getNames(), []);
  });
});

describe('AgentRegistry validates WORKFLOW.md template agent types', () => {
  it('all WORKFLOW.md template agent types exist in registry', () => {
    // WORKFLOW.md uses $LINEAR_TEAM_ID which must be set for parsing
    const origTeamId = process.env.LINEAR_TEAM_ID;
    process.env.LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || 'test-team';

    const registry = createAgentRegistry({ agentsDir: AGENTS_DIR });
    let config;
    try {
      config = parseWorkflowMd(WORKFLOW_MD);
    } finally {
      if (origTeamId === undefined) delete process.env.LINEAR_TEAM_ID;
      else process.env.LINEAR_TEAM_ID = origTeamId;
    }

    const missing: string[] = [];
    for (const [templateName, agentTypes] of Object.entries(config.templates)) {
      for (const agentType of agentTypes) {
        if (!registry.has(agentType)) {
          missing.push(`${templateName}: agent "${agentType}" not found in registry`);
        }
      }
    }

    assert.deepEqual(
      missing, [],
      `All WORKFLOW.md template agent types must exist in .claude/agents/: ${missing.join('; ')}`,
    );
  });
});
