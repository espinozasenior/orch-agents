/**
 * Tests for the Template Library.
 *
 * Covers: JSON loading, setTemplates/resetTemplates, validation,
 * cross-reference validation, and existing public API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getTemplate,
  listTemplateKeys,
  registerTemplate,
  unregisterTemplate,
  getDefaultTemplate,
  setTemplates,
  resetTemplates,
  validateTemplates,
  validateRoutingTemplateRefs,
  type WorkflowTemplate,
} from '../src/planning/template-library';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    key: 'test-tpl',
    name: 'Test Template',
    description: 'A test template',
    methodology: 'adhoc',
    phases: [{ type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false }],
    defaultAgents: [{ role: 'coder', type: 'coder', tier: 2, required: true }],
    topology: 'star',
    consensus: 'none',
    swarmStrategy: 'minimal',
    maxAgents: 2,
    estimatedDuration: 5,
    estimatedCost: 0.01,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ensure templates are loaded from disk before each suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetTemplates();
});

afterEach(() => {
  resetTemplates();
});

// ---------------------------------------------------------------------------
// 1. Existing public API tests (must still pass)
// ---------------------------------------------------------------------------

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
      assert.ok(t.maxAgents >= 4);
    });

    it('returns release-pipeline template', () => {
      const t = getTemplate('release-pipeline');
      assert.ok(t);
      assert.equal(t.phases.length, 2);
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
    it('returns all built-in templates', () => {
      const keys = listTemplateKeys();
      assert.ok(keys.length >= 7, `expected >= 7 templates, got ${keys.length}`);
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
      const custom: WorkflowTemplate = makeValidTemplate({ key: 'custom-test', name: 'Custom Test' });
      registerTemplate(custom);
      const retrieved = getTemplate('custom-test');
      assert.ok(retrieved);
      assert.equal(retrieved.name, 'Custom Test');

      // Cleanup: remove custom template to avoid contaminating other tests
      unregisterTemplate('custom-test');
      assert.equal(getTemplate('custom-test'), undefined);
    });
  });

  describe('getDefaultTemplate()', () => {
    it('sparc-full -> feature-build', () => {
      assert.equal(getDefaultTemplate('sparc-full').key, 'feature-build');
    });

    it('tdd -> tdd-workflow', () => {
      assert.equal(getDefaultTemplate('tdd').key, 'tdd-workflow');
    });

    it('sparc-partial -> github-ops', () => {
      assert.equal(getDefaultTemplate('sparc-partial').key, 'github-ops');
    });

    it('adhoc -> quick-fix', () => {
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

  // -------------------------------------------------------------------------
  // 2. JSON loading tests
  // -------------------------------------------------------------------------

  describe('JSON loading', () => {
    it('templates are loaded from config/team-templates.json', () => {
      // Read the unified JSON file directly and compare with loaded templates
      const unifiedPath = resolve(__dirname, '..', 'config', 'team-templates.json');
      const legacyPath = resolve(__dirname, '..', 'config', 'workflow-templates.json');
      const filePath = existsSync(unifiedPath) ? unifiedPath : legacyPath;
      const raw = readFileSync(filePath, 'utf-8');
      const jsonTemplates = JSON.parse(raw) as Array<{ key: string; name: string; methodology: string }>;

      const keys = listTemplateKeys();
      for (const jt of jsonTemplates) {
        assert.ok(keys.includes(jt.key), `JSON template ${jt.key} not found in loaded templates`);
        const loaded = getTemplate(jt.key);
        assert.ok(loaded);
        assert.equal(loaded.name, jt.name);
        assert.equal(loaded.methodology, jt.methodology);
      }
    });

    it('JSON file contains at least 7 templates', () => {
      const unifiedPath = resolve(__dirname, '..', 'config', 'team-templates.json');
      const legacyPath = resolve(__dirname, '..', 'config', 'workflow-templates.json');
      const filePath = existsSync(unifiedPath) ? unifiedPath : legacyPath;
      const raw = readFileSync(filePath, 'utf-8');
      const jsonTemplates = JSON.parse(raw) as unknown[];
      assert.ok(jsonTemplates.length >= 7, `expected >= 7 templates, got ${jsonTemplates.length}`);
    });

    it('each JSON template has estimatedCost field', () => {
      const unifiedPath = resolve(__dirname, '..', 'config', 'team-templates.json');
      const legacyPath = resolve(__dirname, '..', 'config', 'workflow-templates.json');
      const filePath = existsSync(unifiedPath) ? unifiedPath : legacyPath;
      const raw = readFileSync(filePath, 'utf-8');
      const jsonTemplates = JSON.parse(raw) as Array<{ key: string; estimatedCost?: number }>;
      for (const jt of jsonTemplates) {
        assert.ok(
          typeof jt.estimatedCost === 'number',
          `${jt.key}: missing or non-numeric estimatedCost`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. setTemplates / resetTemplates tests
  // -------------------------------------------------------------------------

  describe('setTemplates() / resetTemplates()', () => {
    it('setTemplates overrides loaded templates', () => {
      const custom = makeValidTemplate({ key: 'only-one', name: 'Only One' });
      setTemplates([custom]);

      const keys = listTemplateKeys();
      assert.equal(keys.length, 1);
      assert.equal(keys[0], 'only-one');
      assert.equal(getTemplate('cicd-pipeline'), undefined);
    });

    it('resetTemplates reloads from disk', () => {
      setTemplates([makeValidTemplate({ key: 'tmp' })]);
      assert.equal(listTemplateKeys().length, 1);

      resetTemplates();
      const keys = listTemplateKeys();
      assert.ok(keys.length >= 7, 'should reload all 7 templates from disk');
      assert.ok(keys.includes('cicd-pipeline'));
    });

    it('setTemplates with empty array results in no templates', () => {
      setTemplates([]);
      assert.equal(listTemplateKeys().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Validation tests
  // -------------------------------------------------------------------------

  describe('validateTemplates()', () => {
    it('passes for valid templates loaded from JSON', () => {
      const errors = validateTemplates();
      assert.equal(errors.length, 0, `Unexpected errors: ${errors.join('; ')}`);
    });

    it('catches invalid tier values', () => {
      setTemplates([
        makeValidTemplate({
          key: 'bad-tier',
          defaultAgents: [{ role: 'x', type: 'coder', tier: 5 as unknown as 1, required: true }],
        }),
      ]);
      const errors = validateTemplates();
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('tier')), `Expected tier error, got: ${errors}`);
    });

    it('catches missing required fields', () => {
      setTemplates([
        {
          key: 'missing-fields',
          name: '',
          description: '',
          methodology: 'adhoc',
          phases: [],
          defaultAgents: [],
          topology: 'star',
          consensus: 'none',
          swarmStrategy: 'minimal',
          maxAgents: 0,
          estimatedDuration: 0,
          estimatedCost: 0,
        } as WorkflowTemplate,
      ]);
      const errors = validateTemplates();
      assert.ok(errors.length > 0);
      assert.ok(
        errors.some((e) => e.includes('name') || e.includes('phases') || e.includes('maxAgents')),
        `Expected field errors, got: ${errors}`,
      );
    });

    it('catches invalid phase types', () => {
      setTemplates([
        makeValidTemplate({
          key: 'bad-phase',
          phases: [{ type: 'invalid-phase' as never, agents: ['coder'], gate: 'g', skippable: false }],
        }),
      ]);
      const errors = validateTemplates();
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('phase')), `Expected phase error, got: ${errors}`);
    });

    it('catches invalid topology values', () => {
      setTemplates([
        makeValidTemplate({
          key: 'bad-topo',
          topology: 'invalid-topo' as never,
        }),
      ]);
      const errors = validateTemplates();
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('topology')), `Expected topology error, got: ${errors}`);
    });

    it('catches invalid consensus values', () => {
      setTemplates([
        makeValidTemplate({
          key: 'bad-consensus',
          consensus: 'paxos' as never,
        }),
      ]);
      const errors = validateTemplates();
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('consensus')), `Expected consensus error, got: ${errors}`);
    });

    it('catches invalid swarmStrategy values', () => {
      setTemplates([
        makeValidTemplate({
          key: 'bad-strategy',
          swarmStrategy: 'aggressive' as never,
        }),
      ]);
      const errors = validateTemplates();
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => e.includes('swarmStrategy')), `Expected strategy error, got: ${errors}`);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Cross-reference validation tests
  // -------------------------------------------------------------------------

  describe('validateRoutingTemplateRefs()', () => {
    it('passes when all routing templates exist', () => {
      // Default state: all 7 templates loaded, routing references them
      const errors = validateRoutingTemplateRefs();
      assert.equal(errors.length, 0, `Unexpected errors: ${errors.join('; ')}`);
    });

    it('catches orphan template references from routing config', () => {
      // Remove some templates so routing refs become orphaned
      setTemplates([makeValidTemplate({ key: 'cicd-pipeline' })]);
      const errors = validateRoutingTemplateRefs();
      assert.ok(errors.length > 0, 'should detect orphan template references');
      // Routing config references quick-fix, github-ops, etc. which are now missing
      assert.ok(
        errors.some((e) => e.includes('quick-fix') || e.includes('github-ops')),
        `Expected orphan ref error, got: ${errors}`,
      );
    });
  });
});
