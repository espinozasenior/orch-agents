/**
 * ReviewGate — composable review gate that aggregates 3 review checkers.
 *
 * Checkers:
 * - DiffReviewer: code review of the diff (stub until Step 9 Claude wiring)
 * - TestRunner: runs the test suite in the worktree
 * - SecurityScanner: scans diff for secret patterns
 *
 * All checkers run in parallel via Promise.allSettled so a single checker
 * failure does not block the others.
 *
 * Bounded context: Review
 * Factory-DI pattern: createReviewGate(deps) -> ReviewGate
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Logger } from '../shared/logger';
import type { ReviewVerdict, Finding, Artifact } from '../types';

// ---------------------------------------------------------------------------
// Review checker interfaces (injectable for testing)
// ---------------------------------------------------------------------------

export interface DiffReviewer {
  review(diff: string, context: ReviewContext): Promise<Finding[]>;
}

export interface TestRunner {
  run(worktreePath: string): Promise<TestRunResult>;
}

export interface SecurityScanner {
  scan(diff: string): Promise<Finding[]>;
}

export interface ReviewContext {
  repo?: string;
  branch?: string;
  prNumber?: number;
  commitSha: string;
  attempt: number;
}

export interface TestRunResult {
  passed: boolean;
  findings: Finding[];
  output: string;
}

// ---------------------------------------------------------------------------
// ReviewGate
// ---------------------------------------------------------------------------

export interface ReviewRequest {
  planId: string;
  workItemId: string;
  commitSha: string;
  branch: string;
  worktreePath: string;
  diff: string;
  artifacts: Artifact[];
  context: ReviewContext;
}

export interface ReviewGate {
  review(request: ReviewRequest): Promise<ReviewVerdict>;
}

export interface ReviewGateDeps {
  diffReviewer: DiffReviewer;
  testRunner: TestRunner;
  securityScanner: SecurityScanner;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ReviewGate that runs all 3 checkers in parallel and aggregates
 * their findings into a single ReviewVerdict.
 */
export function createReviewGate(deps: ReviewGateDeps): ReviewGate {
  const { diffReviewer, testRunner, securityScanner, logger } = deps;

  return {
    async review(request: ReviewRequest): Promise<ReviewVerdict> {
      logger?.info('ReviewGate: starting review', {
        planId: request.planId,
        commitSha: request.commitSha,
        attempt: request.context.attempt,
      });

      // 1. Run all 3 checkers in parallel
      const [diffResult, testResult, securityResult] = await Promise.allSettled([
        diffReviewer.review(request.diff, request.context),
        testRunner.run(request.worktreePath),
        securityScanner.scan(request.diff),
      ]);

      // 2. Collect findings; add error findings for rejected promises
      const allFindings: Finding[] = [];

      if (diffResult.status === 'fulfilled') {
        allFindings.push(...diffResult.value);
      } else {
        allFindings.push({
          id: randomUUID(),
          severity: 'error',
          category: 'diff-review',
          message: `Diff reviewer failed: ${diffResult.reason instanceof Error ? diffResult.reason.message : String(diffResult.reason)}`,
        });
      }

      let testPassed = false;
      if (testResult.status === 'fulfilled') {
        allFindings.push(...testResult.value.findings);
        testPassed = testResult.value.passed;
      } else {
        allFindings.push({
          id: randomUUID(),
          severity: 'error',
          category: 'test-runner',
          message: `Test runner failed: ${testResult.reason instanceof Error ? testResult.reason.message : String(testResult.reason)}`,
        });
      }

      let securityFindingsCount = 0;
      if (securityResult.status === 'fulfilled') {
        allFindings.push(...securityResult.value);
        securityFindingsCount = securityResult.value.length;
      } else {
        allFindings.push({
          id: randomUUID(),
          severity: 'error',
          category: 'security-scanner',
          message: `Security scanner failed: ${securityResult.reason instanceof Error ? securityResult.reason.message : String(securityResult.reason)}`,
        });
      }

      // 3. Determine status
      const hasCritical = allFindings.some(
        (f) => f.severity === 'critical' || f.severity === 'error',
      );
      const hasWarnings = allFindings.some((f) => f.severity === 'warning');

      const status: ReviewVerdict['status'] = hasCritical
        ? 'fail'
        : hasWarnings
          ? 'conditional'
          : 'pass';

      // 4. Compute scores
      const securityScore = Math.max(0, 100 - securityFindingsCount * 20);
      const testCoveragePercent = testPassed ? 80 : 0;
      const codeReviewApproval = !hasCritical;

      // 5. Build feedback
      const feedback = buildFeedback(allFindings, status);

      logger?.info('ReviewGate: review complete', {
        planId: request.planId,
        status,
        findingCount: allFindings.length,
        securityScore,
        testCoveragePercent,
        codeReviewApproval,
      });

      // 6. Return ReviewVerdict
      return {
        phaseResultId: request.workItemId,
        status,
        findings: allFindings,
        securityScore,
        testCoveragePercent,
        codeReviewApproval,
        feedback,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Feedback builder
// ---------------------------------------------------------------------------

function buildFeedback(
  findings: Finding[],
  status: ReviewVerdict['status'],
): string {
  if (findings.length === 0) {
    return 'All checks passed. No findings.';
  }

  const criticalCount = findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'error',
  ).length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  const lines: string[] = [
    `Review ${status}. ${findings.length} finding(s):`,
  ];

  if (criticalCount > 0) {
    lines.push(`  - ${criticalCount} critical/error`);
  }
  if (warningCount > 0) {
    lines.push(`  - ${warningCount} warning(s)`);
  }
  if (infoCount > 0) {
    lines.push(`  - ${infoCount} info`);
  }

  lines.push('');
  for (const f of findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.category}: ${f.message}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stub implementations (for tests and default wiring)
// ---------------------------------------------------------------------------

/** Stub diff reviewer — always returns no findings. */
export function createStubDiffReviewer(): DiffReviewer {
  return {
    async review(): Promise<Finding[]> {
      return [];
    },
  };
}

/** Stub test runner — always passes with no findings. */
export function createStubTestRunner(): TestRunner {
  return {
    async run(): Promise<TestRunResult> {
      return { passed: true, findings: [], output: 'All tests passed (stub)' };
    },
  };
}

/** Stub security scanner — always returns no findings. */
export function createStubSecurityScanner(): SecurityScanner {
  return {
    async scan(): Promise<Finding[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Real implementations
// ---------------------------------------------------------------------------

/** Known secret patterns (same as artifact-applier). */
const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                          // AWS access key
  /ghp_[A-Za-z0-9_]{36}/,                      // GitHub personal access token
  /gho_[A-Za-z0-9_]{36}/,                      // GitHub OAuth token
  /ghs_[A-Za-z0-9_]{36}/,                      // GitHub server token
  /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/, // Private key
  /(?:secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i, // Hardcoded quoted secrets
  /(?:secret|password|api[_-]?key)\s*[:=]\s*\S{8,}/i, // Unquoted secrets (C3)
];

/**
 * Filter diff text to only include added lines (lines starting with `+`
 * but not `+++` file headers). This prevents false positives from removed
 * lines that may contain old secrets being cleaned up.
 */
function filterAddedLines(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
}

export interface CliTestRunnerOpts {
  logger?: Logger;
}

/**
 * Real test runner — executes `npm test` in the worktree via child_process.
 * Exit code 0 = passed, non-zero = failed with an error finding.
 */
export function createCliTestRunner(opts?: CliTestRunnerOpts): TestRunner {
  const logger = opts?.logger;

  return {
    async run(worktreePath: string): Promise<TestRunResult> {
      logger?.info('CliTestRunner: running npm test', { worktreePath });

      return new Promise<TestRunResult>((resolve) => {
        const child = spawn('npm', ['test'], {
          cwd: worktreePath,
          timeout: 120_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on('error', (err) => {
          logger?.error('CliTestRunner: spawn error', {
            worktreePath,
            error: err.message,
          });
          resolve({
            passed: false,
            findings: [
              {
                id: randomUUID(),
                severity: 'error',
                category: 'test-runner',
                message: `Test runner spawn error: ${err.message}`,
              },
            ],
            output: stderr || err.message,
          });
        });

        child.on('close', (code) => {
          const output = stdout + stderr;
          const passed = code === 0;

          logger?.info('CliTestRunner: finished', {
            worktreePath,
            exitCode: code,
            passed,
          });

          const findings: Finding[] = [];
          if (!passed) {
            findings.push({
              id: randomUUID(),
              severity: 'error',
              category: 'test-runner',
              message: `Tests failed with exit code ${code}`,
              location: worktreePath,
            });
          }

          resolve({ passed, findings, output });
        });
      });
    },
  };
}

export interface PatternSecurityScannerOpts {
  logger?: Logger;
  extraPatterns?: RegExp[];
}

/**
 * Real security scanner — scans diff text against known secret patterns.
 * Returns a Finding for each match.
 */
export function createPatternSecurityScanner(
  opts?: PatternSecurityScannerOpts,
): SecurityScanner {
  const logger = opts?.logger;
  const basePatterns = [
    ...DEFAULT_SECRET_PATTERNS,
    ...(opts?.extraPatterns ?? []),
  ];

  // M5: Pre-compile all patterns with global flag once in the constructor
  const compiledPatterns = basePatterns.map((pattern) =>
    pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g'),
  );

  return {
    async scan(diff: string): Promise<Finding[]> {
      logger?.debug('PatternSecurityScanner: scanning diff', {
        diffLength: diff.length,
        patternCount: compiledPatterns.length,
      });

      // C3: Filter to only added lines to avoid false positives on removed lines
      const addedLinesOnly = filterAddedLines(diff);

      const findings: Finding[] = [];

      for (const globalPattern of compiledPatterns) {
        // Reset lastIndex for global patterns to avoid stale state
        globalPattern.lastIndex = 0;
        const matches = [...addedLinesOnly.matchAll(globalPattern)];
        if (matches.length > 0) {
          for (const match of matches) {
            findings.push({
              id: randomUUID(),
              severity: 'critical',
              category: 'security',
              message: `Potential secret detected: ${match[0].slice(0, 20)}...`,
            });
          }
        }
      }

      logger?.info('PatternSecurityScanner: scan complete', {
        findingCount: findings.length,
      });

      return findings;
    },
  };
}
