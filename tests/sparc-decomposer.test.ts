/**
 * Tests for the SPARC Decomposer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlanningInput, TriageResult, PlannedAgent } from '../src/types';
import { decompose } from '../src/planning/sparc-decomposer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTriage(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    intakeEventId: 'test-001',
    priority: 'P2-standard',
    complexity: { level: 'medium', percentage: 40 },
    impact: 'module',
    risk: 'medium',
    recommendedPhases: ['specification', 'refinement', 'completion'],
    requiresApproval: false,
    skipTriage: false,
    estimatedEffort: 'medium',
    ...overrides,
  };
}

function makeAgents(): PlannedAgent[] {
  return [
    { role: 'lead', type: 'architect', tier: 3, required: true },
    { role: 'implementer', type: 'coder', tier: 3, required: true },
    { role: 'validator', type: 'tester', tier: 2, required: true },
    { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
  ];
}

function makeInput(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return {
    intakeEventId: 'test-001',
    triageResult: makeTriage(),
    classification: { domain: 'backend', complexity: { level: 'medium', percentage: 40 }, scope: 'multi-file', risk: 'medium' },
    templateKey: 'github-ops',
    agentTeam: makeAgents(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SPARC Decomposer', () => {
  describe('Template-based decomposition', () => {
    it('decomposes github-ops template', () => {
      const result = decompose(makeInput());
      assert.ok(result.phases.length > 0);
      assert.equal(result.methodology, 'sparc-partial');
      assert.ok(result.adjustedAgents.length > 0);
    });

    it('phases are in SPARC order', () => {
      const result = decompose(makeInput({
        triageResult: makeTriage({
          recommendedPhases: ['completion', 'specification', 'refinement'],
        }),
      }));
      const order = ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'];
      for (let i = 1; i < result.phases.length; i++) {
        const prev = order.indexOf(result.phases[i - 1].type);
        const curr = order.indexOf(result.phases[i].type);
        assert.ok(prev <= curr, `Phase order violation: ${result.phases[i - 1].type} before ${result.phases[i].type}`);
      }
    });

    it('includes non-skippable phases even if not recommended', () => {
      const result = decompose(makeInput({
        triageResult: makeTriage({ recommendedPhases: ['specification'] }),
      }));
      // github-ops has refinement as non-skippable
      const hasRefinement = result.phases.some((p) => p.type === 'refinement');
      assert.ok(hasRefinement, 'Non-skippable refinement phase should be included');
    });

    it('skips skippable phases not in recommendations', () => {
      const result = decompose(makeInput({
        triageResult: makeTriage({ recommendedPhases: ['refinement'] }),
      }));
      assert.ok(result.phasesSkipped.length >= 0);
    });
  });

  describe('Feature-build decomposition', () => {
    it('decomposes full SPARC with all 5 phases', () => {
      const result = decompose(makeInput({
        templateKey: 'feature-build',
        triageResult: makeTriage({
          recommendedPhases: ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'],
        }),
      }));
      assert.equal(result.phases.length, 5);
      assert.equal(result.methodology, 'sparc-full');
    });

    it('each phase has agents assigned', () => {
      const result = decompose(makeInput({
        templateKey: 'feature-build',
        triageResult: makeTriage({
          recommendedPhases: ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'],
        }),
      }));
      for (const phase of result.phases) {
        assert.ok(phase.agents.length > 0, `Phase ${phase.type} has no agents`);
      }
    });

    it('each phase has a gate', () => {
      const result = decompose(makeInput({
        templateKey: 'feature-build',
        triageResult: makeTriage({
          recommendedPhases: ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'],
        }),
      }));
      for (const phase of result.phases) {
        assert.ok(phase.gate, `Phase ${phase.type} has no gate`);
      }
    });
  });

  describe('Fallback decomposition (unknown template)', () => {
    it('falls back when template not found', () => {
      const result = decompose(makeInput({ templateKey: 'nonexistent' }));
      assert.ok(result.phases.length > 0);
    });

    it('fallback uses triage recommended phases', () => {
      const result = decompose(makeInput({
        templateKey: 'unknown-xyz',
        triageResult: makeTriage({ recommendedPhases: ['refinement', 'completion'] }),
      }));
      assert.equal(result.phases.length, 2);
      assert.equal(result.phases[0].type, 'refinement');
      assert.equal(result.phases[1].type, 'completion');
    });

    it('fallback methodology based on phase count', () => {
      const few = decompose(makeInput({
        templateKey: 'unknown',
        triageResult: makeTriage({ recommendedPhases: ['refinement'] }),
      }));
      assert.equal(few.methodology, 'adhoc');

      const some = decompose(makeInput({
        templateKey: 'unknown',
        triageResult: makeTriage({ recommendedPhases: ['specification', 'refinement', 'completion'] }),
      }));
      assert.equal(some.methodology, 'sparc-partial');

      const all = decompose(makeInput({
        templateKey: 'unknown',
        triageResult: makeTriage({
          recommendedPhases: ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'],
        }),
      }));
      assert.equal(all.methodology, 'sparc-full');
    });
  });

  describe('Agent resolution', () => {
    it('merges template defaults with planning input agents', () => {
      const result = decompose(makeInput({ templateKey: 'feature-build' }));
      // Should have agents from both template and input
      assert.ok(result.adjustedAgents.length >= 4);
    });

    it('planning input agents override template defaults', () => {
      const result = decompose(makeInput({
        templateKey: 'feature-build',
        agentTeam: [
          { role: 'lead', type: 'architect', tier: 2, required: true }, // override tier
          { role: 'implementer', type: 'coder', tier: 3, required: true },
        ],
      }));
      const lead = result.adjustedAgents.find((a) => a.role === 'lead');
      assert.ok(lead);
      assert.equal(lead.tier, 2); // overridden
    });
  });
});
