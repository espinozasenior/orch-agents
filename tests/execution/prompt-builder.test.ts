/**
 * TDD: Tests for PromptBuilder — builds contextual prompts for task-tool agents.
 *
 * Pure function module: takes (phase, agent, intakeEvent, plan) → prompt string.
 * The prompt must include real webhook context so agents can do actual work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  buildImplementationPrompt,
  buildReviewPrompt,
  buildFixPrompt,
} from '../../src/execution/prompt-builder';
import type { IntakeEvent, PlannedPhase, PlannedAgent, WorkflowPlan, Finding } from '../../src/types';

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
    topology: 'hierarchical',
    swarmStrategy: 'specialized',
    consensus: 'raft',
    maxAgents: 6,
    phases: [],
    agentTeam: [],
    estimatedDuration: 20,
    estimatedCost: 0.03,
    ...overrides,
  };
}

function makePhase(overrides: Partial<PlannedPhase> = {}): PlannedPhase {
  return {
    type: 'specification',
    agents: ['architect'],
    gate: 'spec-approved',
    skippable: false,
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
  describe('buildPrompt()', () => {
    it('returns a non-empty string', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.length > 0);
    });

    it('includes the phase type', () => {
      const prompt = buildPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('refinement'), 'Should include phase type');
    });

    it('includes the agent role', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent({ role: 'security-auditor', type: 'security-architect' }),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('security-auditor'), 'Should include agent role');
    });

    it('includes repo and branch from intakeEvent', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('test-org/test-repo'), 'Should include repo');
      assert.ok(prompt.includes('feature/auth'), 'Should include branch');
    });

    it('includes files changed', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('src/auth.ts'), 'Should include file path');
      assert.ok(prompt.includes('src/middleware.ts'), 'Should include file path');
    });

    it('includes rawText (issue/PR body)', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent({ rawText: 'Critical security fix for token validation' }),
        makePlan(),
      );
      assert.ok(prompt.includes('Critical security fix'), 'Should include rawText');
    });

    it('includes PR number when present', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('42'), 'Should include PR number');
    });

    it('includes labels when present', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('security'), 'Should include label');
      assert.ok(prompt.includes('bug'), 'Should include label');
    });

    it('includes methodology from plan', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan({ methodology: 'tdd' }),
      );
      assert.ok(prompt.includes('tdd'), 'Should include methodology');
    });

    it('includes output format instructions', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
      );
      assert.ok(prompt.includes('JSON'), 'Should instruct JSON output');
    });

    it('handles missing optional fields gracefully', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent({
          entities: { severity: 'low' },
          rawText: undefined,
        }),
        makePlan(),
      );
      assert.ok(prompt.length > 0, 'Should still produce a prompt');
    });

    it('truncates large file lists', () => {
      const files = Array.from({ length: 50 }, (_, i) => `dir${i}/file.ts`);
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent({ entities: { files, severity: 'medium' } }),
        makePlan(),
      );
      // Should mention truncation or limit
      assert.ok(prompt.includes('file'), 'Should include some files');
      // The prompt should not be excessively long for 50 files
      assert.ok(prompt.length < 10000, 'Should truncate large file lists');
    });

    it('truncates large rawText', () => {
      const longText = 'x'.repeat(10000);
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent({ rawText: longText }),
        makePlan(),
      );
      assert.ok(prompt.length < 15000, 'Should truncate long rawText');
    });

    it('includes intent from intake event', () => {
      const prompt = buildPrompt(
        makePhase(),
        makeAgent(),
        makeIntakeEvent({ intent: 'incident-response' }),
        makePlan(),
      );
      assert.ok(prompt.includes('incident-response'), 'Should include intent');
    });

    it('produces different prompts for different phases', () => {
      const intake = makeIntakeEvent();
      const plan = makePlan();
      const agent = makeAgent();

      const specPrompt = buildPrompt(makePhase({ type: 'specification' }), agent, intake, plan);
      const refPrompt = buildPrompt(makePhase({ type: 'refinement' }), agent, intake, plan);

      assert.notEqual(specPrompt, refPrompt, 'Different phases should produce different prompts');
    });
  });

  describe('buildImplementationPrompt()', () => {
    it('includes worktree path instruction', () => {
      const prompt = buildImplementationPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
        { worktreePath: '/tmp/orch-agents/plan-001' },
      );
      assert.ok(
        prompt.includes('/tmp/orch-agents/plan-001'),
        'Should include worktree path',
      );
      assert.ok(
        prompt.includes('You are working in directory:'),
        'Should include directory instruction',
      );
    });

    it('includes "Edit files directly" instruction', () => {
      const prompt = buildImplementationPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
        { worktreePath: '/tmp/wt' },
      );
      assert.ok(
        prompt.includes('Edit files directly'),
        'Should instruct direct file editing',
      );
    });

    it('does NOT include JSON output format', () => {
      const prompt = buildImplementationPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
        { worktreePath: '/tmp/wt' },
      );
      assert.ok(
        !prompt.includes('## Output Format'),
        'Should not include JSON output format section',
      );
      assert.ok(
        !prompt.includes('Respond with a JSON object'),
        'Should not instruct JSON response',
      );
    });

    it('includes target files when provided', () => {
      const prompt = buildImplementationPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
        { worktreePath: '/tmp/wt', targetFiles: ['src/auth.ts', 'src/handler.ts'] },
      );
      assert.ok(prompt.includes('## Target Files'), 'Should include target files section');
      assert.ok(prompt.includes('src/auth.ts'), 'Should include first target file');
      assert.ok(prompt.includes('src/handler.ts'), 'Should include second target file');
    });

    it('includes prior phase outputs when provided', () => {
      const prompt = buildImplementationPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
        {
          worktreePath: '/tmp/wt',
          priorPhaseOutputs: ['Spec: use JWT tokens', 'Arch: add middleware layer'],
        },
      );
      assert.ok(prompt.includes('## Prior Analysis'), 'Should include prior analysis section');
      assert.ok(prompt.includes('Spec: use JWT tokens'), 'Should include first output');
      assert.ok(prompt.includes('Arch: add middleware layer'), 'Should include second output');
    });

    it('includes work context (repo, branch, PR)', () => {
      const prompt = buildImplementationPrompt(
        makePhase({ type: 'refinement' }),
        makeAgent(),
        makeIntakeEvent(),
        makePlan(),
        { worktreePath: '/tmp/wt' },
      );
      assert.ok(prompt.includes('test-org/test-repo'), 'Should include repo');
      assert.ok(prompt.includes('feature/auth'), 'Should include branch');
      assert.ok(prompt.includes('#42'), 'Should include PR number');
    });
  });

  describe('buildReviewPrompt()', () => {
    it('includes diff in code block', () => {
      const prompt = buildReviewPrompt(
        makeIntakeEvent(),
        makePlan(),
        { diff: '+ added line\n- removed line', commitSha: 'abc123', attempt: 1 },
      );
      assert.ok(prompt.includes('```diff'), 'Should include diff code block');
      assert.ok(prompt.includes('+ added line'), 'Should include diff content');
    });

    it('includes commit SHA', () => {
      const prompt = buildReviewPrompt(
        makeIntakeEvent(),
        makePlan(),
        { diff: 'some diff', commitSha: 'deadbeef42', attempt: 1 },
      );
      assert.ok(prompt.includes('deadbeef42'), 'Should include commit SHA');
    });

    it('includes attempt number', () => {
      const prompt = buildReviewPrompt(
        makeIntakeEvent(),
        makePlan(),
        { diff: 'some diff', commitSha: 'abc', attempt: 3 },
      );
      assert.ok(prompt.includes('Review Attempt: 3'), 'Should include attempt number');
    });

    it('truncates diff over 8000 chars', () => {
      const longDiff = 'x'.repeat(10000);
      const prompt = buildReviewPrompt(
        makeIntakeEvent(),
        makePlan(),
        { diff: longDiff, commitSha: 'abc', attempt: 1 },
      );
      assert.ok(prompt.includes('(truncated)'), 'Should indicate truncation');
      // The diff portion should be at most 8000 + truncation marker
      assert.ok(!prompt.includes('x'.repeat(9000)), 'Should not include full diff');
    });

    it('includes JSON output format with findings schema', () => {
      const prompt = buildReviewPrompt(
        makeIntakeEvent(),
        makePlan(),
        { diff: 'some diff', commitSha: 'abc', attempt: 1 },
      );
      assert.ok(prompt.includes('## Output Format'), 'Should include output format');
      assert.ok(prompt.includes('"findings"'), 'Should include findings in schema');
      assert.ok(prompt.includes('"severity"'), 'Should include severity in schema');
      assert.ok(prompt.includes('JSON'), 'Should mention JSON');
    });
  });

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
