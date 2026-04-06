/**
 * TDD: Tests for PromptBuilder — builds contextual prompts for task-tool agents.
 *
 * Pure function module: takes (phase, agent, intakeEvent, plan) → prompt string.
 * The prompt must include real webhook context so agents can do actual work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFixPrompt,
} from '../../src/execution/prompt-builder';
import type { IntakeEvent, PlannedAgent, WorkflowPlan, Finding } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-pb-001',
    timestamp: '2026-03-12T00:00:00Z',
    source: 'github',
    sourceMetadata: { prNumber: 42 },
    intent: 'review-pr',
    entities: {
      repo: 'test-org/test-repo',
      branch: 'feature/auth',
      prNumber: 42,
      files: ['src/auth.ts', 'src/middleware.ts'],
      labels: ['security', 'bug'],
      author: 'dev-user',
      severity: 'high',
    },
    rawText: 'Fix authentication bypass in session middleware',
    ...overrides,
  };
}

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-pb-001',
    workItemId: 'intake-pb-001',
    methodology: 'sparc-full',
    template: 'feature-build',
    maxAgents: 6,
    agentTeam: [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<PlannedAgent> = {}): PlannedAgent {
  return {
    role: 'lead',
    type: 'architect',
    tier: 3,
    required: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptBuilder', () => {
  describe('buildFixPrompt()', () => {
    const sampleFindings: Finding[] = [
      { id: 'f1', severity: 'error', category: 'security', message: 'SQL injection risk', location: 'src/db.ts:42' },
      { id: 'f2', severity: 'warning', category: 'style', message: 'Unused import' },
    ];

    it('includes fix instructions with attempt count', () => {
      const prompt = buildFixPrompt(
        makeIntakeEvent(),
        makePlan(),
        {
          worktreePath: '/tmp/wt',
          findings: sampleFindings,
          feedback: 'Fix the security issues',
          attempt: 2,
          maxAttempts: 3,
        },
      );
      assert.ok(prompt.includes('attempt 2 of 3'), 'Should include attempt count');
      assert.ok(prompt.includes('## Role: Fix Agent'), 'Should include fix agent role');
    });

    it('includes all findings with severity', () => {
      const prompt = buildFixPrompt(
        makeIntakeEvent(),
        makePlan(),
        {
          worktreePath: '/tmp/wt',
          findings: sampleFindings,
          feedback: 'Fix issues',
          attempt: 1,
          maxAttempts: 3,
        },
      );
      assert.ok(prompt.includes('[error]'), 'Should include error severity');
      assert.ok(prompt.includes('[warning]'), 'Should include warning severity');
      assert.ok(prompt.includes('SQL injection risk'), 'Should include finding message');
      assert.ok(prompt.includes('Unused import'), 'Should include second finding');
      assert.ok(prompt.includes('src/db.ts:42'), 'Should include location');
    });

    it('includes feedback text', () => {
      const prompt = buildFixPrompt(
        makeIntakeEvent(),
        makePlan(),
        {
          worktreePath: '/tmp/wt',
          findings: sampleFindings,
          feedback: 'Critical security flaws must be addressed',
          attempt: 1,
          maxAttempts: 3,
        },
      );
      assert.ok(
        prompt.includes('Critical security flaws must be addressed'),
        'Should include feedback',
      );
      assert.ok(prompt.includes('## Review Feedback'), 'Should include feedback section');
    });

    it('includes worktree path', () => {
      const prompt = buildFixPrompt(
        makeIntakeEvent(),
        makePlan(),
        {
          worktreePath: '/tmp/orch-agents/plan-fix',
          findings: sampleFindings,
          feedback: 'Fix it',
          attempt: 1,
          maxAttempts: 3,
        },
      );
      assert.ok(
        prompt.includes('/tmp/orch-agents/plan-fix'),
        'Should include worktree path',
      );
    });

    it('includes "Edit files directly" instruction', () => {
      const prompt = buildFixPrompt(
        makeIntakeEvent(),
        makePlan(),
        {
          worktreePath: '/tmp/wt',
          findings: sampleFindings,
          feedback: 'Fix it',
          attempt: 1,
          maxAttempts: 3,
        },
      );
      assert.ok(
        prompt.includes('Edit files directly'),
        'Should instruct direct file editing',
      );
    });
  });
});
