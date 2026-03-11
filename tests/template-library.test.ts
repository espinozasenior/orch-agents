/**
 * Tests for the Template Library.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTemplate,
  listTemplateKeys,
  registerTemplate,
  getDefaultTemplate,
  type WorkflowTemplate,
} from '../src/planning/template-library';

describe('Template Library', () => {
  describe('getTemplate()', () => {
    it('returns cicd-pipeline template', () => {
      const t = getTemplate('cicd-pipeline');
      assert.ok(t);
      assert.equal(t.key, 'cicd-pipeline');
      assert.equal(t.methodology, 'sparc-partial');
      assert.ok(t.phases.length > 0);
      assert.ok(t.defaultAgents.length > 0);
    });

    it('returns quick-fix template', () => {
      const t = getTemplate('quick-fix');
      assert.ok(t);
      assert.equal(t.methodology, 'adhoc');
      assert.equal(t.phases.length, 1);
    });

    it('returns github-ops template', () => {
      const t = getTemplate('github-ops');
      assert.ok(t);
      assert.equal(t.topology, 'hierarchical');
      assert.equal(t.consensus, 'raft');
    });

    it('returns tdd-workflow template', () => {
      const t = getTemplate('tdd-workflow');
      assert.ok(t);
      assert.equal(t.methodology, 'tdd');
      assert.equal(t.phases.length, 3);
    });

    it('returns feature-build template', () => {
      const t = getTemplate('feature-build');
      assert.ok(t);
      assert.equal(t.methodology, 'sparc-full');
      assert.equal(t.phases.length, 5);
      assert.ok(t.maxAgents >= 6);
    });

    it('returns release-pipeline template', () => {
      const t = getTemplate('release-pipeline');
      assert.ok(t);
      assert.equal(t.phases.length, 1);
    });

    it('returns monitoring-alerting template', () => {
      const t = getTemplate('monitoring-alerting');
      assert.ok(t);
      assert.equal(t.topology, 'star');
    });

    it('returns undefined for unknown key', () => {
      assert.equal(getTemplate('nonexistent'), undefined);
    });
  });

  describe('listTemplateKeys()', () => {
    it('returns all 7 built-in templates', () => {
      const keys = listTemplateKeys();
      assert.ok(keys.length >= 7);
      assert.ok(keys.includes('cicd-pipeline'));
      assert.ok(keys.includes('quick-fix'));
      assert.ok(keys.includes('github-ops'));
      assert.ok(keys.includes('tdd-workflow'));
      assert.ok(keys.includes('feature-build'));
      assert.ok(keys.includes('release-pipeline'));
      assert.ok(keys.includes('monitoring-alerting'));
    });
  });

  describe('registerTemplate()', () => {
    it('adds a custom template', () => {
      const custom: WorkflowTemplate = {
        key: 'custom-test',
        name: 'Custom Test',
        description: 'test template',
        methodology: 'adhoc',
        phases: [{ type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false }],
        defaultAgents: [{ role: 'coder', type: 'coder', tier: 2, required: true }],
        topology: 'star',
        consensus: 'none',
        swarmStrategy: 'minimal',
        maxAgents: 2,
        estimatedDuration: 5,
      };
      registerTemplate(custom);
      const retrieved = getTemplate('custom-test');
      assert.ok(retrieved);
      assert.equal(retrieved.name, 'Custom Test');
    });
  });

  describe('getDefaultTemplate()', () => {
    it('sparc-full → feature-build', () => {
      assert.equal(getDefaultTemplate('sparc-full').key, 'feature-build');
    });

    it('tdd → tdd-workflow', () => {
      assert.equal(getDefaultTemplate('tdd').key, 'tdd-workflow');
    });

    it('sparc-partial → github-ops', () => {
      assert.equal(getDefaultTemplate('sparc-partial').key, 'github-ops');
    });

    it('adhoc → quick-fix', () => {
      assert.equal(getDefaultTemplate('adhoc').key, 'quick-fix');
    });
  });

  describe('Template structure', () => {
    it('all templates have required fields', () => {
      for (const key of listTemplateKeys()) {
        const t = getTemplate(key)!;
        assert.ok(t.key, `${key}: missing key`);
        assert.ok(t.name, `${key}: missing name`);
        assert.ok(t.methodology, `${key}: missing methodology`);
        assert.ok(t.phases.length > 0, `${key}: no phases`);
        assert.ok(t.defaultAgents.length > 0, `${key}: no agents`);
        assert.ok(t.topology, `${key}: missing topology`);
        assert.ok(t.maxAgents > 0, `${key}: invalid maxAgents`);
      }
    });

    it('all phase agents are strings', () => {
      for (const key of listTemplateKeys()) {
        const t = getTemplate(key)!;
        for (const phase of t.phases) {
          for (const agent of phase.agents) {
            assert.equal(typeof agent, 'string', `${key}/${phase.type}: agent not a string`);
          }
        }
      }
    });

    it('all agents have valid tiers', () => {
      for (const key of listTemplateKeys()) {
        const t = getTemplate(key)!;
        for (const agent of t.defaultAgents) {
          assert.ok([1, 2, 3].includes(agent.tier), `${key}/${agent.role}: invalid tier ${agent.tier}`);
        }
      }
    });
  });
});
