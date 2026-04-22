/**
 * PostExecutionActions — side effects after an agent finishes work.
 *
 * Extracted from coordinator-dispatcher.ts to keep that file focused on
 * orchestrating the agent lifecycle. Each action is independent and
 * wrapped in .catch() so failures don't block subsequent actions.
 *
 * Actions: pushBranch, createPRIfNeeded, submitReviewWithFindings,
 *          postSummaryComment, postLinearResponse.
 */

import type { IntakeEvent, Finding } from '../types';
import { isLinearMeta } from '../types';
import type { GitHubClient } from '../integration/github-client';
import type { LinearClient } from '../integration/linear/linear-client';
import type { Logger } from '../shared/logger';
import { formatAgentComment, getBotMarker } from '../kernel/agent-identity';
import { trackAgentCommit, trackAgentPR } from './agent-commit-tracker';
import { postAgentResponse } from '../integration/linear/activity-router';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostExecutionDeps {
  githubClient?: GitHubClient;
  linearClient?: Pick<LinearClient, 'createComment' | 'createAgentActivity'>;
  logger: Logger;
}

export interface PostExecutionContext {
  agent: { type: string; role: string };
  planId: string;
  workItemId: string;
  agentStart: number;

  apply: { commitSha?: string; changedFiles?: string[] };
  exec: { output?: string; status: string };
  intake: IntakeEvent;
  worktree: { path: string; branch: string; baseBranch: string };
  findings: Finding[];
}

export interface PostExecutionResult {
  pushed: boolean;
  prCreated: boolean;
  prNumber?: number;
  prUrl?: string;
  reviewSubmitted: boolean;
  commentPosted: boolean;
  linearResponsePosted: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runPostExecutionActions(
  deps: PostExecutionDeps,
  ctx: PostExecutionContext,
): Promise<PostExecutionResult> {
  const result: PostExecutionResult = {
    pushed: false,
    prCreated: false,
    reviewSubmitted: false,
    commentPosted: false,
    linearResponsePosted: false,
  };

  // 1. Track agent commit for feedback loop prevention
  if (ctx.apply.commitSha) {
    trackAgentCommit(ctx.apply.commitSha);
  }

  // 2. Push branch to remote
  if (deps.githubClient && ctx.apply.commitSha) {
    const targetBranch = ctx.intake.entities.branch ?? ctx.worktree.branch;
    try {
      await deps.githubClient.pushBranch(ctx.worktree.path, ctx.worktree.branch, {
        remoteBranch: targetBranch,
        repo: ctx.intake.entities.repo,
      });
      deps.logger.info('Branch pushed', {
        planId: ctx.planId, localBranch: ctx.worktree.branch, remoteBranch: targetBranch,
      });
      result.pushed = true;
    } catch (err) {
      deps.logger.warn('Failed to push branch', {
        planId: ctx.planId,
        localBranch: ctx.worktree.branch,
        remoteBranch: targetBranch,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Create PR if branch was pushed and this isn't already a PR event
  if (result.pushed && deps.githubClient && ctx.intake.entities.repo && !ctx.intake.entities.prNumber) {
    const repo = ctx.intake.entities.repo;
    const head = ctx.intake.entities.branch ?? ctx.worktree.branch;
    const base = ctx.worktree.baseBranch;
    try {
      // Idempotency: try to create, handle "already exists" gracefully.
      // gh pr create fails with a clear error when a PR already exists for the head branch.
      const prResult = await deps.githubClient.createPR(repo, {
        head,
        base,
        title: `${ctx.agent.type}: ${ctx.workItemId}`,
        body: formatPRBody(ctx),
      });

      trackAgentPR(repo, prResult.number);
      result.prCreated = true;
      result.prNumber = prResult.number;
      result.prUrl = prResult.url;

      deps.logger.info('PR created', {
        planId: ctx.planId, repo, prNumber: prResult.number, url: prResult.url,
      });
    } catch (err) {
      // PR creation can fail if one already exists — not an error
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already exists') || message.includes('A pull request already exists')) {
        deps.logger.info('PR already exists for branch, skipping creation', {
          planId: ctx.planId, repo, head,
        });
      } else {
        deps.logger.warn('Failed to create PR', {
          planId: ctx.planId, repo, error: message,
        });
      }
    }
  }

  // 4. Submit review with inline findings (when findings have structured locations)
  const prNumber = ctx.intake.entities.prNumber ?? result.prNumber;
  const repo = ctx.intake.entities.repo;
  if (deps.githubClient && prNumber && repo && ctx.findings.length > 0) {
    try {
      await submitReviewWithFindings(deps.githubClient, deps.logger, {
        repo,
        prNumber,
        findings: ctx.findings,
        commitSha: ctx.apply.commitSha,
      });
      result.reviewSubmitted = true;
    } catch (err) {
      deps.logger.warn('Failed to submit review', {
        planId: ctx.planId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Post summary comment (skip for GitHub-sourced events to avoid duplicates)
  if (deps.githubClient && ctx.intake.source !== 'github' && prNumber && repo) {
    try {
      const summary = formatSummaryComment(ctx);
      await deps.githubClient.postPRComment(repo, prNumber, formatAgentComment(summary));
      result.commentPosted = true;
    } catch (err) {
      deps.logger.warn('Failed to post PR comment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Post Linear response
  const responseMeta = ctx.intake.sourceMetadata;
  if (deps.linearClient && isLinearMeta(responseMeta) && responseMeta.linearIssueId) {
    const linearIssueId = responseMeta.linearIssueId;
    const agentSessionId = responseMeta.agentSessionId;
    const linearSummary = formatLinearSummary(ctx);
    try {
      await postAgentResponse(
        ctx.intake.source,
        agentSessionId,
        linearSummary,
        deps.linearClient as LinearClient,
        deps.githubClient,
        { issueId: linearIssueId, repo: ctx.intake.entities.repo, prNumber },
      );
      result.linearResponsePosted = true;
    } catch (err) {
      deps.logger.warn('Failed to post Linear response', {
        issueId: linearIssueId, agentSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Review submission with inline comments
// ---------------------------------------------------------------------------

async function submitReviewWithFindings(
  github: GitHubClient,
  logger: Logger,
  opts: { repo: string; prNumber: number; findings: Finding[]; commitSha?: string },
): Promise<void> {
  const { repo, prNumber, findings, commitSha } = opts;

  // Post inline comments for findings that have structured file/line
  const inlineFindings = findings.filter((f) => f.filePath && f.lineNumber);
  const bodyFindings = findings.filter((f) => !f.filePath || !f.lineNumber);

  for (const finding of inlineFindings) {
    const sha = finding.commitSha ?? commitSha;
    if (!sha) continue;
    await github.postInlineComment(
      repo, prNumber,
      finding.filePath!, finding.lineNumber!,
      `**[${finding.severity}]** ${finding.message}`,
      sha,
    ).catch((err: unknown) => {
      logger.warn('Failed to post inline comment', {
        path: finding.filePath, line: finding.lineNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Build review body from non-inline findings
  const bodyLines = bodyFindings.map((f) => `- **[${f.severity}]** ${f.message}`);
  const hasCritical = findings.some((f) => f.severity === 'critical' || f.severity === 'error');
  const verdict = hasCritical ? 'REQUEST_CHANGES' as const : 'APPROVE' as const;

  const reviewBody = [
    hasCritical ? 'Automated review found issues that need attention:' : 'Automated review passed.',
    ...(bodyLines.length > 0 ? ['', ...bodyLines] : []),
    ...(inlineFindings.length > 0 ? [`\n${inlineFindings.length} inline comment(s) posted.`] : []),
  ].join('\n');

  await github.submitReview(repo, prNumber, verdict, reviewBody);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPRBody(ctx: PostExecutionContext): string {
  const changedFiles = ctx.apply.changedFiles ?? [];
  const fileList = changedFiles.length > 0
    ? `\n\n**Files (${changedFiles.length}):**\n${changedFiles.slice(0, 10).map((f) => `- \`${f}\``).join('\n')}${changedFiles.length > 10 ? `\n- ... and ${changedFiles.length - 10} more` : ''}`
    : '';

  return [
    `Automated PR from **${ctx.agent.type}** for ${ctx.workItemId}.`,
    fileList,
    getBotMarker(),
  ].filter(Boolean).join('\n');
}

function formatSummaryComment(ctx: PostExecutionContext): string {
  const duration = Math.round((Date.now() - ctx.agentStart) / 1000);
  const changedFiles = ctx.apply.changedFiles ?? [];
  const findingLines = ctx.findings.length > 0
    ? `\n\n**Findings (${ctx.findings.length}):**\n${ctx.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}`
    : '';
  const fileLines = changedFiles.length > 0
    ? `\n\n**Files (${changedFiles.length}):**\n${changedFiles.slice(0, 10).map((f) => `- \`${f}\``).join('\n')}${changedFiles.length > 10 ? `\n- ... and ${changedFiles.length - 10} more` : ''}`
    : '';

  let outputText = ctx.exec.output ?? '';
  if (outputText.length > 2000) {
    const truncated = outputText.slice(0, 2000);
    const lastNewline = truncated.lastIndexOf('\n');
    outputText = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
    outputText += '\n\n_(truncated)_';
  }
  const outputPreview = outputText ? `\n\n**Output:**\n${outputText}` : '';

  return [
    `**${ctx.agent.type}** completed in ${duration}s`,
    ctx.apply.commitSha ? `Commit: \`${ctx.apply.commitSha.slice(0, 7)}\`` : '',
    fileLines,
    outputPreview,
    findingLines,
  ].filter(Boolean).join('\n');
}

function formatLinearSummary(ctx: PostExecutionContext): string {
  const durationSeconds = Math.max(1, Math.round((Date.now() - ctx.agentStart) / 1000));
  const changedFiles = ctx.apply.changedFiles ?? [];
  const changedFilesText = changedFiles.length > 0
    ? `\n\nFiles changed (${changedFiles.length}):\n${changedFiles.slice(0, 10).map((f) => `- \`${f}\``).join('\n')}${changedFiles.length > 10 ? `\n- ... and ${changedFiles.length - 10} more` : ''}`
    : '';
  const findingsText = ctx.findings.length > 0
    ? `\n\nFindings (${ctx.findings.length}):\n${ctx.findings.map((f) => `- [${f.severity}] ${f.message}`).join('\n')}`
    : '';

  let outputText = (ctx.exec.output ?? '').trim();
  if (outputText.length > 2000) {
    const truncated = outputText.slice(0, 2000);
    const lastNewline = truncated.lastIndexOf('\n');
    outputText = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
    outputText += '\n\n_(truncated)_';
  }
  const outputPreview = outputText ? `\n\nOutput:\n${outputText}` : '';

  const meta = ctx.intake.sourceMetadata;
  const includeMarker = !(isLinearMeta(meta) && meta.agentSessionId);

  const parts = [
    `**${ctx.agent.type}** completed in ${durationSeconds}s`,
    ctx.apply.commitSha ? `Commit: \`${ctx.apply.commitSha.slice(0, 7)}\`` : '',
    changedFilesText,
    outputPreview,
    findingsText,
  ];
  if (includeMarker) {
    parts.push(getBotMarker());
  }
  return parts.filter(Boolean).join('\n');
}
