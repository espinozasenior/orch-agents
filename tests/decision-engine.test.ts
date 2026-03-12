/**
 * Unit tests for the Decision Engine (London School TDD, mock-first).
 *
 * The decision engine is tested in isolation by injecting a mock
 * router bridge via dependency injection, avoiding CJS module issues.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, TriageResult } from '../src/types';
import type { Logger } from '../src/shared/logger';
import { createDecisionEngine, type RouterBridge } from '../src/planning/decision-engine';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

interface RouterResult {
  template: string;
  classification: {
    domain: string;
    complexity: { level: string; percentage: number };
    scope: string;
    risk: string;
  };
  ambiguity: { level: string; score: number; needsClarification: boolean };
  agents: Array<{ role: string; type: string; tier: number }>;
  topology: string;
  strategy: string;
}

function makeRouterResult(overrides: Partial<RouterResult> = {}): RouterResult {
  return {
    template: 'feature-build',
    classification: {
      domain: 'backend',
      complexity: { level: 'medium', percentage: 45 },
      scope: 'module',
      risk: 'medium',
    },
    ambiguity: { level: 'low', score: 0.1, needsClarification: false },
    agents: [
      { role: 'lead', type: 'planner', tier: 3 },
      { role: 'implementer', type: 'coder', tier: 2 },
      { role: 'reviewer', type: 'reviewer', tier: 2 },
    ],
    topology: 'hierarchical',
    strategy: 'specialized',
    ...overrides,
  };
}

/**
 * Create a mock router bridge that captures the task input and
 * returns a configurable result.
 */
function createMockRouter(
  resultOrFn: RouterResult | ((task: string) => RouterResult) = makeRouterResult(),
): RouterBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    makeDecision(task: string) {
      calls.push(task);
      if (typeof resultOrFn === 'function') return resultOrFn(task);
      return resultOrFn;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => makeLogger(),
  };
}

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'evt-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: { eventType: 'push', skipTriage: false },
    intent: 'validate-main',
    entities: {
      repo: 'org/repo',
      branch: 'main',
      severity: 'medium',
    },
    ...overrides,
  };
}

function makeTriageResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    intakeEventId: 'evt-001',
    priority: 'P2-standard',
    complexity: { level: 'medium', percentage: 45 },
    impact: 'module',
    risk: 'medium',
    recommendedPhases: ['specification', 'refinement', 'completion'],
    requiresApproval: false,
    skipTriage: false,
    estimatedEffort: 'medium',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Decision Engine', () => {

  // -- Task description building -------------------------------------------

  describe('buildTaskDescription (via decide)', () => {
    it('includes intent in the task description passed to router', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({ intent: 'review-pr' }),
        triageResult: makeTriageResult(),
      });

      assert.equal(router.calls.length, 1);
      assert.ok(
        router.calls[0].includes('[review-pr]'),
        `Expected task to contain "[review-pr]", got: "${router.calls[0]}"`,
      );
    });

    it('includes repo and branch context', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({
          entities: { repo: 'acme/widget', branch: 'feat/login' },
        }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('repo:acme/widget'), `Expected repo in task, got: "${task}"`);
      assert.ok(task.includes('branch:feat/login'), `Expected branch in task, got: "${task}"`);
    });

    it('includes PR and issue numbers when present', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({
          entities: { repo: 'org/repo', prNumber: 42, issueNumber: 99 },
        }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('PR #42'), `Expected "PR #42" in task, got: "${task}"`);
      assert.ok(task.includes('Issue #99'), `Expected "Issue #99" in task, got: "${task}"`);
    });

    it('includes labels when present', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({
          entities: { repo: 'org/repo', labels: ['bug', 'security'] },
        }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('labels:bug,security'), `Expected labels in task, got: "${task}"`);
    });

    it('includes first 5 files and indicates truncation for more', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({
          entities: {
            repo: 'org/repo',
            files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
          },
        }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('a.ts'), 'Expected first file in task');
      assert.ok(task.includes('e.ts'), 'Expected 5th file in task');
      assert.ok(task.includes('(+2 more)'), `Expected truncation indicator, got: "${task}"`);
    });

    it('does not truncate when exactly 5 files', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({
          entities: {
            repo: 'org/repo',
            files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
          },
        }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('e.ts'), 'Expected 5th file');
      assert.ok(!task.includes('more)'), 'Should NOT have truncation for exactly 5 files');
    });

    it('truncates rawText longer than 200 characters', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const longText = 'A'.repeat(300);
      engine.decide({
        intakeEvent: makeIntakeEvent({ rawText: longText }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('A'.repeat(200) + '...'), 'Expected truncated rawText with ellipsis');
      // The full 300-char string should NOT appear
      assert.ok(!task.includes('A'.repeat(201)), 'Should not include more than 200 consecutive As');
    });

    it('includes short rawText without truncation', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({ rawText: 'Fix the login bug' }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('Fix the login bug'), 'Expected full rawText');
    });

    it('handles event with minimal entities (no repo, no branch)', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({ entities: {} }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(task.includes('[validate-main]'), 'Expected intent even with empty entities');
      assert.ok(!task.includes('repo:'), 'Should not have repo with empty entities');
      assert.ok(!task.includes('branch:'), 'Should not have branch with empty entities');
    });
  });

  // -- Classification merging ----------------------------------------------

  describe('classification merging', () => {
    it('takes domain and scope from router, complexity and risk from triage', () => {
      const router = createMockRouter(makeRouterResult({
        classification: {
          domain: 'frontend',
          complexity: { level: 'high', percentage: 80 },
          scope: 'cross-cutting',
          risk: 'high',
        },
      }));

      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const triageResult = makeTriageResult({
        complexity: { level: 'low', percentage: 15 },
        risk: 'critical',
      });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult,
      });

      const cls = result.planningInput.classification;
      // Domain and scope from ROUTER
      assert.equal(cls.domain, 'frontend');
      assert.equal(cls.scope, 'cross-cutting');
      // Complexity and risk from TRIAGE
      assert.equal(cls.complexity.level, 'low');
      assert.equal(cls.complexity.percentage, 15);
      assert.equal(cls.risk, 'critical');
    });

    it('preserves full triage result in planningInput', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const triageResult = makeTriageResult({
        priority: 'P0-immediate',
        estimatedEffort: 'epic',
        requiresApproval: true,
      });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult,
      });

      assert.equal(result.planningInput.triageResult.priority, 'P0-immediate');
      assert.equal(result.planningInput.triageResult.estimatedEffort, 'epic');
      assert.equal(result.planningInput.triageResult.requiresApproval, true);
      // Should be the same reference
      assert.equal(result.planningInput.triageResult, triageResult);
    });
  });

  // -- Agent team mapping --------------------------------------------------

  describe('agent team mapping', () => {
    it('marks lead and implementer as required, others as not required', () => {
      const router = createMockRouter(makeRouterResult({
        agents: [
          { role: 'lead', type: 'planner', tier: 3 },
          { role: 'implementer', type: 'coder', tier: 2 },
          { role: 'reviewer', type: 'reviewer', tier: 2 },
          { role: 'tester', type: 'tester', tier: 1 },
        ],
      }));

      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult: makeTriageResult(),
      });

      const team = result.planningInput.agentTeam;
      assert.equal(team.length, 4);

      const lead = team.find((a) => a.role === 'lead')!;
      assert.ok(lead, 'Should have lead agent');
      assert.equal(lead.required, true);
      assert.equal(lead.tier, 3);
      assert.equal(lead.type, 'planner');

      const impl = team.find((a) => a.role === 'implementer')!;
      assert.ok(impl, 'Should have implementer agent');
      assert.equal(impl.required, true);
      assert.equal(impl.tier, 2);

      const reviewer = team.find((a) => a.role === 'reviewer')!;
      assert.equal(reviewer.required, false);

      const tester = team.find((a) => a.role === 'tester')!;
      assert.equal(tester.required, false);
      assert.equal(tester.tier, 1);
    });

    it('preserves tier values from router agents', () => {
      const router = createMockRouter(makeRouterResult({
        agents: [
          { role: 'lead', type: 'architect', tier: 1 },
        ],
      }));

      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.agentTeam[0].tier, 1);
      assert.equal(result.planningInput.agentTeam[0].type, 'architect');
    });
  });

  // -- Template key resolution from sourceMetadata -------------------------

  describe('template key resolution', () => {
    it('prefers sourceMetadata.template over router template', () => {
      const router = createMockRouter(makeRouterResult({ template: 'router-default' }));
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: 'custom-override', skipTriage: false },
        }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.templateKey, 'custom-override');
    });

    it('falls back to router template when sourceMetadata has no template', () => {
      const router = createMockRouter(makeRouterResult({ template: 'router-default' }));
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { skipTriage: false },
        }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.templateKey, 'router-default');
    });

    it('falls back to router when sourceMetadata.template is not a string (number)', () => {
      const router = createMockRouter(makeRouterResult({ template: 'router-fallback' }));
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: 123, skipTriage: false },
        }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.templateKey, 'router-fallback');
    });

    it('falls back to router when sourceMetadata.template is null', () => {
      const router = createMockRouter(makeRouterResult({ template: 'router-null-fallback' }));
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: null, skipTriage: false },
        }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.templateKey, 'router-null-fallback');
    });

    it('uses empty string template from sourceMetadata as valid override', () => {
      const router = createMockRouter(makeRouterResult({ template: 'router-default' }));
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: '', skipTriage: false },
        }),
        triageResult: makeTriageResult(),
      });

      // Empty string IS a string, so typeof check passes
      assert.equal(result.planningInput.templateKey, '');
    });
  });

  // -- Router decision output structure ------------------------------------

  describe('routerDecision output', () => {
    it('passes through router topology, strategy, and template', () => {
      const router = createMockRouter(makeRouterResult({
        topology: 'mesh',
        strategy: 'balanced',
        template: 'security-audit',
      }));

      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.routerDecision.topology, 'mesh');
      assert.equal(result.routerDecision.strategy, 'balanced');
      assert.equal(result.routerDecision.template, 'security-audit');
      assert.equal(result.routerDecision.agents.length, 3);
    });

    it('includes ambiguity info in both routerDecision and planningInput', () => {
      const router = createMockRouter(makeRouterResult({
        ambiguity: { level: 'high', score: 0.85, needsClarification: true },
      }));

      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.routerDecision.ambiguity.score, 0.85);
      assert.equal(result.routerDecision.ambiguity.needsClarification, true);
      assert.ok(result.planningInput.ambiguity, 'planningInput should have ambiguity');
      assert.equal(result.planningInput.ambiguity!.score, 0.85);
      assert.equal(result.planningInput.ambiguity!.needsClarification, true);
    });
  });

  // -- Error handling when router bridge fails -----------------------------

  describe('error handling', () => {
    it('throws descriptive error when router bridge throws an Error', () => {
      const router: RouterBridge = {
        makeDecision() {
          throw new Error('CJS module not found');
        },
      };

      const errorLog: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = makeLogger();
      logger.error = (message: string, context?: Record<string, unknown>) => {
        errorLog.push({ message, context });
      };

      const engine = createDecisionEngine({ logger, router });

      assert.throws(
        () => engine.decide({
          intakeEvent: makeIntakeEvent(),
          triageResult: makeTriageResult(),
        }),
        (err: Error) => {
          assert.ok(err.message.includes('Tech-lead-router failed'));
          assert.ok(err.message.includes('CJS module not found'));
          return true;
        },
      );

      // Verify error was logged before throwing
      assert.equal(errorLog.length, 1);
      assert.equal(errorLog[0].message, 'Router bridge failed');
    });

    it('handles non-Error thrown values (string)', () => {
      const router: RouterBridge = {
        makeDecision() {
          throw 'string error'; // eslint-disable-line no-throw-literal
        },
      };

      const engine = createDecisionEngine({ logger: makeLogger(), router });

      assert.throws(
        () => engine.decide({
          intakeEvent: makeIntakeEvent(),
          triageResult: makeTriageResult(),
        }),
        (err: Error) => {
          assert.ok(err.message.includes('string error'));
          return true;
        },
      );
    });

    it('truncates long task descriptions in error message to 80 chars', () => {
      const router: RouterBridge = {
        makeDecision() {
          throw new Error('timeout');
        },
      };

      const engine = createDecisionEngine({ logger: makeLogger(), router });
      const longRawText = 'X'.repeat(200);

      assert.throws(
        () => engine.decide({
          intakeEvent: makeIntakeEvent({ rawText: longRawText }),
          triageResult: makeTriageResult(),
        }),
        (err: Error) => {
          assert.ok(err.message.includes('Tech-lead-router failed for "'));
          const match = err.message.match(/failed for "(.+?)"/);
          assert.ok(match, 'Should match the quoted task description');
          assert.ok(match![1].length <= 80, `Task in error should be <= 80 chars, got ${match![1].length}`);
          return true;
        },
      );
    });
  });

  // -- Edge cases ----------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty sourceMetadata', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({ sourceMetadata: {} }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.templateKey, 'feature-build');
    });

    it('sets intakeEventId from the intake event id', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent({ id: 'unique-id-xyz' }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.intakeEventId, 'unique-id-xyz');
    });

    it('handles empty agents array from router', () => {
      const router = createMockRouter(makeRouterResult({ agents: [] }));
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const result = engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult: makeTriageResult(),
      });

      assert.equal(result.planningInput.agentTeam.length, 0);
    });

    it('handles custom intent prefix', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({ intent: 'custom:deploy-canary' }),
        triageResult: makeTriageResult(),
      });

      assert.ok(router.calls[0].includes('[custom:deploy-canary]'));
    });

    it('handles empty labels and files arrays', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      engine.decide({
        intakeEvent: makeIntakeEvent({
          entities: { repo: 'org/repo', labels: [], files: [] },
        }),
        triageResult: makeTriageResult(),
      });

      const task = router.calls[0];
      assert.ok(!task.includes('labels:'), 'Empty labels should not appear');
      assert.ok(!task.includes('files:'), 'Empty files should not appear');
    });

    it('handles undefined rawText', () => {
      const router = createMockRouter();
      const engine = createDecisionEngine({ logger: makeLogger(), router });

      const event = makeIntakeEvent();
      delete event.rawText;

      engine.decide({
        intakeEvent: event,
        triageResult: makeTriageResult(),
      });

      assert.ok(router.calls[0].length > 0, 'Task description should be non-empty');
    });

    it('creates separate engine instances with independent state', () => {
      const router = createMockRouter();
      const engine1 = createDecisionEngine({ logger: makeLogger(), router });
      const engine2 = createDecisionEngine({ logger: makeLogger(), router });

      const result1 = engine1.decide({
        intakeEvent: makeIntakeEvent({ id: 'id-1' }),
        triageResult: makeTriageResult(),
      });
      const result2 = engine2.decide({
        intakeEvent: makeIntakeEvent({ id: 'id-2' }),
        triageResult: makeTriageResult(),
      });

      assert.equal(result1.planningInput.intakeEventId, 'id-1');
      assert.equal(result2.planningInput.intakeEventId, 'id-2');
    });

    it('logs debug and info messages during successful decide', () => {
      const router = createMockRouter();
      const debugMessages: string[] = [];
      const infoMessages: string[] = [];
      const logger = makeLogger();
      logger.debug = (msg: string) => { debugMessages.push(msg); };
      logger.info = (msg: string) => { infoMessages.push(msg); };

      const engine = createDecisionEngine({ logger, router });
      engine.decide({
        intakeEvent: makeIntakeEvent(),
        triageResult: makeTriageResult(),
      });

      assert.ok(debugMessages.some((m) => m.includes('Decision engine input')));
      assert.ok(infoMessages.some((m) => m.includes('Decision made')));
    });
  });
});
