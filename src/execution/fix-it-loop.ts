/**
 * FixItLoop — orchestrates the review -> reject -> fix cycle.
 *
 * When a review gate rejects changes, the loop builds a fix prompt from
 * the findings, executes the fix in the worktree, commits, and re-reviews.
 * Repeats up to maxAttempts times before giving up.
 *
 * All dependencies are injected via the factory for London School TDD.
 */

import type { Logger } from '../shared/logger';
import type { ReviewVerdict, Finding, Artifact } from '../types';

// ---------------------------------------------------------------------------
// Dependencies (all injected for testability)
// ---------------------------------------------------------------------------

/** Executes a fix prompt in the worktree */
export interface FixExecutor {
  executeFix(worktreePath: string, prompt: string, timeout: number): Promise<FixExecutionResult>;
}

export interface FixExecutionResult {
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  duration: number;
  error?: string;
}

/** Reviews code in a worktree */
export interface FixReviewer {
  review(request: FixReviewRequest): Promise<ReviewVerdict>;
}

export interface FixReviewRequest {
  planId: string;
  workItemId: string;
  commitSha: string;
  branch: string;
  worktreePath: string;
  diff: string;
  artifacts: Artifact[];
  attempt: number;
}

/** Commits changes in a worktree */
export interface FixCommitter {
  commit(worktreePath: string, message: string): Promise<string>;
  diff(worktreePath: string): Promise<string>;
}

/** Builds fix prompts from findings */
export interface FixPromptBuilder {
  build(findings: Finding[], feedback: string, attempt: number, maxAttempts: number): string;
}

// ---------------------------------------------------------------------------
// FixItLoop public types
// ---------------------------------------------------------------------------

export interface FixItContext {
  planId: string;
  workItemId: string;
  branch: string;
  worktreePath: string;
  initialCommitSha: string;
  artifacts: Artifact[];
  maxAttempts: number;
  timeout: number;
}

export interface FixItResult {
  status: 'passed' | 'failed';
  attempts: number;
  finalVerdict: ReviewVerdict;
  commitSha?: string;
  history: FixItAttemptRecord[];
}

export interface FixItAttemptRecord {
  attempt: number;
  verdict: ReviewVerdict;
  fixApplied: boolean;
  commitSha?: string;
  duration: number;
}

export interface FixItLoop {
  run(context: FixItContext): Promise<FixItResult>;
}

export interface FixItLoopDeps {
  fixExecutor: FixExecutor;
  fixReviewer: FixReviewer;
  fixCommitter: FixCommitter;
  fixPromptBuilder: FixPromptBuilder;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return noopLogger; },
};

export function createFixItLoop(deps: FixItLoopDeps): FixItLoop {
  const { fixExecutor, fixReviewer, fixCommitter, fixPromptBuilder } = deps;
  const logger = deps.logger ?? noopLogger;

  return { run };

  async function run(context: FixItContext): Promise<FixItResult> {
    const history: FixItAttemptRecord[] = [];
    let currentSha = context.initialCommitSha;

    for (let attempt = 1; attempt <= context.maxAttempts; attempt++) {
      const startTime = Date.now();

      // 1. Review current state
      let verdict: ReviewVerdict;
      try {
        const currentDiff = await fixCommitter.diff(context.worktreePath);
        verdict = await fixReviewer.review({
          planId: context.planId,
          workItemId: context.workItemId,
          commitSha: currentSha,
          branch: context.branch,
          worktreePath: context.worktreePath,
          diff: currentDiff,
          artifacts: context.artifacts,
          attempt,
        });
      } catch (err) {
        const duration = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Review threw error', { attempt, error: message });

        // Create a synthetic fail verdict so the loop can continue
        verdict = {
          phaseResultId: '',
          status: 'fail',
          findings: [],
          securityScore: 0,
          testCoveragePercent: 0,
          codeReviewApproval: false,
          feedback: `Review error: ${message}`,
        };
        history.push({ attempt, verdict, fixApplied: false, duration });
        continue;
      }

      const reviewDuration = Date.now() - startTime;

      // 2. If review passed, we are done
      if (verdict.status === 'pass') {
        history.push({
          attempt,
          verdict,
          fixApplied: false,
          commitSha: currentSha,
          duration: reviewDuration,
        });
        return {
          status: 'passed',
          attempts: attempt,
          finalVerdict: verdict,
          commitSha: currentSha,
          history,
        };
      }

      // 3. Build fix prompt from findings
      const prompt = fixPromptBuilder.build(
        verdict.findings,
        verdict.feedback ?? '',
        attempt,
        context.maxAttempts,
      );

      // 4. Execute fix
      let fixApplied = false;
      try {
        const fixResult = await fixExecutor.executeFix(
          context.worktreePath,
          prompt,
          context.timeout,
        );

        if (fixResult.status === 'failed') {
          logger.warn('Fix execution failed', { attempt, error: fixResult.error });
          history.push({ attempt, verdict, fixApplied: false, duration: Date.now() - startTime });
          continue;
        }

        // 5. Commit the fix
        const commitSha = await fixCommitter.commit(
          context.worktreePath,
          `fix: attempt ${attempt}`,
        );
        currentSha = commitSha;
        fixApplied = true;

        history.push({
          attempt,
          verdict,
          fixApplied,
          commitSha,
          duration: Date.now() - startTime,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Fix/commit threw error', { attempt, error: message });
        history.push({ attempt, verdict, fixApplied: false, duration: Date.now() - startTime });
        continue;
      }
    }

    // M10: Only do final review if the last attempt actually committed changes
    const lastAttempt = history[history.length - 1];
    const lastAttemptCommitted = lastAttempt?.commitSha && lastAttempt.commitSha !== '';

    let finalVerdict: ReviewVerdict;
    if (lastAttemptCommitted) {
      try {
        const finalDiff = await fixCommitter.diff(context.worktreePath);
        finalVerdict = await fixReviewer.review({
          planId: context.planId,
          workItemId: context.workItemId,
          commitSha: currentSha,
          branch: context.branch,
          worktreePath: context.worktreePath,
          diff: finalDiff,
          artifacts: context.artifacts,
          attempt: context.maxAttempts + 1,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Final review threw error', { error: message });
        finalVerdict = {
          phaseResultId: '',
          status: 'fail',
          findings: [],
          securityScore: 0,
          testCoveragePercent: 0,
          codeReviewApproval: false,
          feedback: `Final review error: ${message}`,
        };
      }
    } else {
      logger.info('Skipping final review — last attempt did not commit changes');
      finalVerdict = lastAttempt?.verdict ?? {
        phaseResultId: '',
        status: 'fail',
        findings: [],
        securityScore: 0,
        testCoveragePercent: 0,
        codeReviewApproval: false,
        feedback: 'All attempts exhausted without successful commit',
      };
    }

    return {
      status: finalVerdict.status === 'pass' ? 'passed' : 'failed',
      attempts: context.maxAttempts,
      finalVerdict,
      commitSha: currentSha,
      history,
    };
  }
}
