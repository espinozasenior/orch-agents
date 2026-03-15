/**
 * Agent Registry tests.
 *
 * Integration tests that scan the real `.claude/agents/` directory
 * and verify the registry works end-to-end.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createAgentRegistry } from '../../src/agent-registry/agent-registry';

const AGENTS_DIR = resolve(__dirname, '..', '..', '.claude', 'agents');

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

describe('AgentRegistry validates tech-lead-router agent types', () => {
  it('all router TEAM_TEMPLATE agent types exist in registry', () => {
    const registry = createAgentRegistry({ agentsDir: AGENTS_DIR });

    // Load team-templates.json and extract all agent type strings
    const templatesPath = resolve(__dirname, '..', '..', 'config', 'team-templates.json');
    const templates = JSON.parse(readFileSync(templatesPath, 'utf-8')) as Array<{
      key: string;
      agents: Array<{ type: string; role: string }>;
    }>;

    const missing: string[] = [];
    for (const template of templates) {
      for (const agent of template.agents) {
        if (!registry.has(agent.type)) {
          missing.push(`${template.key}/${agent.role}: type "${agent.type}" not found in registry`);
        }
      }
    }

    assert.deepEqual(
      missing, [],
      `All template agent types must exist in .claude/agents/: ${missing.join('; ')}`,
    );
  });

  it('all phase agent references exist in registry', () => {
    const registry = createAgentRegistry({ agentsDir: AGENTS_DIR });

    const templatesPath = resolve(__dirname, '..', '..', 'config', 'team-templates.json');
    const templates = JSON.parse(readFileSync(templatesPath, 'utf-8')) as Array<{
      key: string;
      phases: Array<{ type: string; agents: string[] }>;
    }>;

    const missing: string[] = [];
    for (const template of templates) {
      for (const phase of template.phases) {
        for (const agentType of phase.agents) {
          if (!registry.has(agentType)) {
            missing.push(`${template.key}/${phase.type}: agent "${agentType}" not found`);
          }
        }
      }
    }

    assert.deepEqual(
      missing, [],
      `All phase agent refs must exist in .claude/agents/: ${missing.join('; ')}`,
    );
  });
});
