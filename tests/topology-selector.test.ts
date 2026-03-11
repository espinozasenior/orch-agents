/**
 * Tests for the Topology Selector.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlanningInput, TriageResult, PlannedAgent } from '../src/types';
import { selectTopology } from '../src/planning/topology-selector';

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
    recommendedPhases: ['refinement', 'completion'],
    requiresApproval: false,
    skipTriage: false,
    estimatedEffort: 'medium',
    ...overrides,
  };
}

function makeInput(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return {
    intakeEventId: 'test-001',
    triageResult: makeTriage(),
    classification: { domain: 'backend', complexity: { level: 'medium', percentage: 40 }, scope: 'multi-file', risk: 'medium' },
    templateKey: 'github-ops',
    agentTeam: [
      { role: 'lead', type: 'architect', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Topology Selector', () => {
  describe('High complexity + system-wide', () => {
    it('selects hierarchical-mesh', () => {
      const result = selectTopology(makeInput({
        triageResult: makeTriage({
          complexity: { level: 'high', percentage: 75 },
          impact: 'system-wide',
        }),
      }));
      assert.equal(result.topology, 'hierarchical-mesh');
      assert.equal(result.consensus, 'raft');
      assert.equal(result.swarmStrategy, 'specialized');
    });

    it('caps maxAgents at 8', () => {
      const manyAgents: PlannedAgent[] = Array.from({ length: 10 }, (_, i) => ({
        role: `agent-${i}`, type: 'coder', tier: 2 as const, required: false,
      }));
      const result = selectTopology(makeInput({
        agentTeam: manyAgents,
        triageResult: makeTriage({
          complexity: { level: 'high', percentage: 80 },
          impact: 'system-wide',
        }),
      }));
      assert.ok(result.maxAgents <= 8);
    });
  });

  describe('Medium-high complexity', () => {
    it('selects hierarchical', () => {
      const result = selectTopology(makeInput({
        triageResult: makeTriage({
          complexity: { level: 'medium', percentage: 50 },
          impact: 'module',
        }),
      }));
      assert.equal(result.topology, 'hierarchical');
      assert.equal(result.consensus, 'raft');
    });
  });

  describe('Low complexity + isolated', () => {
    it('selects star with no consensus', () => {
      const result = selectTopology(makeInput({
        triageResult: makeTriage({
          complexity: { level: 'low', percentage: 15 },
          impact: 'isolated',
        }),
      }));
      assert.equal(result.topology, 'star');
      assert.equal(result.consensus, 'none');
      assert.equal(result.swarmStrategy, 'minimal');
    });
  });

  describe('P0-immediate (incident response)', () => {
    it('selects star for low latency', () => {
      const result = selectTopology(makeInput({
        triageResult: makeTriage({
          priority: 'P0-immediate',
          complexity: { level: 'medium', percentage: 35 },
          impact: 'cross-cutting',
        }),
      }));
      assert.equal(result.topology, 'star');
      assert.equal(result.consensus, 'none');
    });

    it('P0 takes precedence over high complexity + system-wide', () => {
      const result = selectTopology(makeInput({
        triageResult: makeTriage({
          priority: 'P0-immediate',
          complexity: { level: 'high', percentage: 80 },
          impact: 'system-wide',
        }),
      }));
      // P0 should always get star, even with high complexity
      assert.equal(result.topology, 'star');
      assert.equal(result.consensus, 'none');
      assert.ok(result.reasoning.includes('P0'));
    });
  });

  describe('Default case', () => {
    it('selects hierarchical with raft', () => {
      const result = selectTopology(makeInput({
        triageResult: makeTriage({
          complexity: { level: 'low', percentage: 28 },
          impact: 'module',
          priority: 'P2-standard',
        }),
      }));
      assert.equal(result.topology, 'hierarchical');
      assert.equal(result.consensus, 'raft');
    });
  });

  describe('Reasoning', () => {
    it('always provides a reasoning string', () => {
      const result = selectTopology(makeInput());
      assert.ok(result.reasoning.length > 0);
    });
  });

  describe('Agent count influence', () => {
    it('large team → specialized strategy', () => {
      const agents: PlannedAgent[] = Array.from({ length: 6 }, (_, i) => ({
        role: `agent-${i}`, type: 'coder', tier: 2 as const, required: false,
      }));
      const result = selectTopology(makeInput({
        agentTeam: agents,
        triageResult: makeTriage({
          complexity: { level: 'low', percentage: 28 },
          impact: 'module',
        }),
      }));
      assert.equal(result.swarmStrategy, 'specialized');
    });

    it('small team → balanced strategy', () => {
      const result = selectTopology(makeInput({
        agentTeam: [
          { role: 'lead', type: 'architect', tier: 3, required: true },
          { role: 'implementer', type: 'coder', tier: 3, required: true },
        ],
        triageResult: makeTriage({
          complexity: { level: 'low', percentage: 28 },
          impact: 'module',
        }),
      }));
      assert.equal(result.swarmStrategy, 'balanced');
    });
  });
});
