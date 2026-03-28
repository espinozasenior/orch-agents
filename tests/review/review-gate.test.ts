/**
 * TDD: Tests for ReviewGate — composable review gate aggregating 3 checkers.
 *
 * London School (mock-first): all 3 checkers are mocked via the injectable
 * interfaces. Tests verify aggregation logic, scoring, and error handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewGate,
  createStubDiffReviewer,
  createStubTestRunner,
  createStubSecurityScanner,
  type ReviewGate,
  type ReviewRequest,
  type ReviewGateDeps,
  type DiffReviewer,
  type TestRunner,
  type SecurityScanner,
  type ReviewContext,
  type TestRunResult,
} from '../../src/review/review-gate';
import type { Finding } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    commitSha: 'abc123',
    attempt: 1,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    planId: 'plan-001',
    workItemId: 'work-001',
    commitSha: 'abc123',
    branch: 'feature/test',
    worktreePath: '/tmp/orch-agents/plan-001',
    diff: 'diff --git a/foo.ts b/foo.ts\n+console.log("hello")',
    artifacts: [],
    context: makeContext(),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding-001',
    severity: 'info',
    category: 'test',
    message: 'Test finding',
    ...overrides,
  };
}

/** Mock diff reviewer returning specified findings. */
function mockDiffReviewer(findings: Finding[] = []): DiffReviewer {
  return {
    async review(): Promise<Finding[]> {
      return findings;
    },
  };
}

/** Mock test runner with configurable result. */
function mockTestRunner(result?: Partial<TestRunResult>): TestRunner {
  return {
    async run(): Promise<TestRunResult> {
      return {
        passed: true,
        findings: [],
        output: 'All tests passed',
        ...result,
      };
    },
  };
}

/** Mock security scanner returning specified findings. */
function mockSecurityScanner(findings: Finding[] = []): SecurityScanner {
  return {
    async scan(): Promise<Finding[]> {
      return findings;
    },
  };
}

/** Mock diff reviewer that throws. */
function throwingDiffReviewer(error: Error): DiffReviewer {
  return {
    async review(): Promise<Finding[]> {
      throw error;
    },
  };
}

/** Mock test runner that throws. */
function throwingTestRunner(error: Error): TestRunner {
  return {
    async run(): Promise<TestRunResult> {
      throw error;
    },
  };
}

/** Mock security scanner that throws. */
function throwingSecurityScanner(error: Error): SecurityScanner {
  return {
    async scan(): Promise<Finding[]> {
      throw error;
    },
  };
}

function makeDeps(overrides: Partial<ReviewGateDeps> = {}): ReviewGateDeps {
  return {
    diffReviewer: createStubDiffReviewer(),
    testRunner: createStubTestRunner(),
    securityScanner: createStubSecurityScanner(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewGate', () => {
  describe('createReviewGate()', () => {
    it('returns a ReviewGate object with review method', () => {
      const gate = createReviewGate(makeDeps());
      assert.ok(gate);
      assert.equal(typeof gate.review, 'function');
    });
  });

  describe('review() — pass verdicts', () => {
    it('returns pass when all checkers return no findings', async () => {
      const gate = createReviewGate(makeDeps());
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'pass');
      assert.equal(verdict.findings.length, 0);
      assert.equal(verdict.securityScore, 100);
      assert.equal(verdict.testCoveragePercent, 80);
      assert.equal(verdict.codeReviewApproval, true);
      assert.ok(verdict.feedback, 'Should have feedback string');
    });
  });

  describe('review() — fail verdicts', () => {
    it('returns fail when diffReviewer returns critical finding', async () => {
      const criticalFinding = makeFinding({
        severity: 'critical',
        category: 'code-review',
        message: 'SQL injection vulnerability',
      });

      const gate = createReviewGate(
        makeDeps({ diffReviewer: mockDiffReviewer([criticalFinding]) }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'fail');
      assert.ok(verdict.findings.length >= 1);
      assert.equal(verdict.codeReviewApproval, false);
    });

    it('returns fail when testRunner fails', async () => {
      const testFinding = makeFinding({
        severity: 'error',
        category: 'test-runner',
        message: 'Tests failed with exit code 1',
      });

      const gate = createReviewGate(
        makeDeps({
          testRunner: mockTestRunner({
            passed: false,
            findings: [testFinding],
          }),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'fail');
      assert.equal(verdict.testCoveragePercent, 0);
      assert.equal(verdict.codeReviewApproval, false);
    });

    it('returns fail when securityScanner returns error finding', async () => {
      const secFinding = makeFinding({
        severity: 'error',
        category: 'security',
        message: 'Potential secret detected',
      });

      const gate = createReviewGate(
        makeDeps({ securityScanner: mockSecurityScanner([secFinding]) }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'fail');
      assert.equal(verdict.codeReviewApproval, false);
    });
  });

  describe('review() — conditional verdicts', () => {
    it('returns conditional when only warnings exist', async () => {
      const warningFinding = makeFinding({
        severity: 'warning',
        category: 'code-review',
        message: 'Consider using const instead of let',
      });

      const gate = createReviewGate(
        makeDeps({ diffReviewer: mockDiffReviewer([warningFinding]) }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'conditional');
      assert.equal(verdict.codeReviewApproval, true);
    });
  });

  describe('review() — aggregation', () => {
    it('aggregates findings from all 3 checkers', async () => {
      const diffFinding = makeFinding({
        id: 'diff-1',
        severity: 'info',
        category: 'code-review',
        message: 'Minor style issue',
      });
      const testFinding = makeFinding({
        id: 'test-1',
        severity: 'warning',
        category: 'test',
        message: 'Low coverage',
      });
      const secFinding = makeFinding({
        id: 'sec-1',
        severity: 'info',
        category: 'security',
        message: 'Informational note',
      });

      const gate = createReviewGate(
        makeDeps({
          diffReviewer: mockDiffReviewer([diffFinding]),
          testRunner: mockTestRunner({ findings: [testFinding] }),
          securityScanner: mockSecurityScanner([secFinding]),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.findings.length, 3);
      assert.ok(
        verdict.findings.some((f) => f.category === 'code-review'),
        'Should include diff findings',
      );
      assert.ok(
        verdict.findings.some((f) => f.category === 'test'),
        'Should include test findings',
      );
      assert.ok(
        verdict.findings.some((f) => f.category === 'security'),
        'Should include security findings',
      );
    });
  });

  describe('review() — error handling', () => {
    it('handles diffReviewer throwing an error', async () => {
      const gate = createReviewGate(
        makeDeps({
          diffReviewer: throwingDiffReviewer(new Error('Network timeout')),
        }),
      );
      const verdict = await gate.review(makeRequest());

      // Should not crash; should add error finding
      assert.equal(verdict.status, 'fail');
      assert.ok(verdict.findings.length >= 1);
      const errorFinding = verdict.findings.find(
        (f) => f.category === 'diff-review' && f.severity === 'error',
      );
      assert.ok(errorFinding, 'Should have error finding for failed checker');
      assert.ok(
        errorFinding!.message.includes('Network timeout'),
        'Should include original error message',
      );
    });

    it('handles testRunner throwing an error', async () => {
      const gate = createReviewGate(
        makeDeps({
          testRunner: throwingTestRunner(new Error('spawn failed')),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'fail');
      const errorFinding = verdict.findings.find(
        (f) => f.category === 'test-runner' && f.severity === 'error',
      );
      assert.ok(errorFinding, 'Should have error finding for test runner');
      assert.ok(errorFinding!.message.includes('spawn failed'));
    });

    it('handles securityScanner throwing an error', async () => {
      const gate = createReviewGate(
        makeDeps({
          securityScanner: throwingSecurityScanner(
            new Error('Pattern engine crash'),
          ),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.status, 'fail');
      const errorFinding = verdict.findings.find(
        (f) => f.category === 'security-scanner' && f.severity === 'error',
      );
      assert.ok(errorFinding, 'Should have error finding for scanner');
      assert.ok(errorFinding!.message.includes('Pattern engine crash'));
    });
  });

  describe('review() — scoring', () => {
    it('securityScore decreases with more security findings', async () => {
      const secFindings = [
        makeFinding({ id: 'sec-1', severity: 'info', category: 'security', message: 'a' }),
        makeFinding({ id: 'sec-2', severity: 'info', category: 'security', message: 'b' }),
        makeFinding({ id: 'sec-3', severity: 'info', category: 'security', message: 'c' }),
      ];

      const gate = createReviewGate(
        makeDeps({ securityScanner: mockSecurityScanner(secFindings) }),
      );
      const verdict = await gate.review(makeRequest());

      // 100 - (3 * 20) = 40
      assert.equal(verdict.securityScore, 40);
    });

    it('securityScore floors at 0', async () => {
      const secFindings = Array.from({ length: 10 }, (_, i) =>
        makeFinding({ id: `sec-${i}`, severity: 'info', category: 'security', message: `s${i}` }),
      );

      const gate = createReviewGate(
        makeDeps({ securityScanner: mockSecurityScanner(secFindings) }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.securityScore, 0);
    });

    it('codeReviewApproval is false when critical findings exist', async () => {
      const gate = createReviewGate(
        makeDeps({
          diffReviewer: mockDiffReviewer([
            makeFinding({ severity: 'critical', category: 'code-review', message: 'bad' }),
          ]),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.codeReviewApproval, false);
    });

    it('codeReviewApproval is false when error findings exist', async () => {
      const gate = createReviewGate(
        makeDeps({
          securityScanner: mockSecurityScanner([
            makeFinding({ severity: 'error', category: 'security', message: 'bad' }),
          ]),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.equal(verdict.codeReviewApproval, false);
    });
  });

  describe('review() — feedback', () => {
    it('feedback string summarizes findings', async () => {
      const findings = [
        makeFinding({ severity: 'error', category: 'test', message: 'Test fail' }),
        makeFinding({ severity: 'warning', category: 'style', message: 'Style issue' }),
        makeFinding({ severity: 'info', category: 'note', message: 'FYI' }),
      ];

      const gate = createReviewGate(
        makeDeps({
          diffReviewer: mockDiffReviewer(findings),
        }),
      );
      const verdict = await gate.review(makeRequest());

      assert.ok(verdict.feedback, 'Should have feedback');
      assert.ok(
        verdict.feedback!.includes('3 finding(s)'),
        'Should mention finding count',
      );
      assert.ok(
        verdict.feedback!.includes('critical/error'),
        'Should mention critical/error count',
      );
      assert.ok(
        verdict.feedback!.includes('warning'),
        'Should mention warnings',
      );
    });

    it('feedback for clean review says all checks passed', async () => {
      const gate = createReviewGate(makeDeps());
      const verdict = await gate.review(makeRequest());

      assert.ok(verdict.feedback!.includes('All checks passed'));
    });
  });

  describe('stub implementations', () => {
    it('createStubDiffReviewer returns no findings', async () => {
      const reviewer = createStubDiffReviewer();
      const findings = await reviewer.review('some diff', makeContext());
      assert.deepEqual(findings, []);
    });

    it('createStubTestRunner passes with no findings', async () => {
      const runner = createStubTestRunner();
      const result = await runner.run('/tmp/test');
      assert.equal(result.passed, true);
      assert.deepEqual(result.findings, []);
    });

    it('createStubSecurityScanner returns no findings', async () => {
      const scanner = createStubSecurityScanner();
      const findings = await scanner.scan('some diff');
      assert.deepEqual(findings, []);
    });
  });
});
