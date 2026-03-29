/**
 * Simple Executor — Symphony-style agent execution.
 *
 * For each agent in the plan's team, runs a Claude Code session
 * with the agent's instructions in an isolated worktree. Sequential execution.
 * No topologies, no consensus, no SPARC phases — just agents doing work.
 *
 * This is the "strangler fig" replacement for the complex phase-runner +
 * strategies + swarm system. The old path remains as fallback.
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowPlan, PlannedAgent, IntakeEvent, Finding } from '../types';
import type { InteractiveTaskExecutor } from './runtime/interactive-executor';
import type { WorktreeManager } from './workspace/worktree-manager';
import type { ArtifactApplier } from './workspace/artifact-applier';
import type { ReviewGate } from '../review/review-gate';
import type { FixItLoop } from './fix-it-loop';
import type { AgentRegistry } from '../agent-registry/agent-registry';
import type { GitHubClient } from '../integration/github-client';
import type { LinearClient } from '../integration/linear/linear-client';
import type { Logger } from '../shared/logger';
import type { EventBus } from '../shared/event-bus';
import { createDomainEvent } from '../shared/event-bus';
import { formatAgentComment } from '../shared/agent-identity';
import { sanitize } from '../shared/input-sanitizer';
import { trackAgentCommit } from '../shared/agent-commit-tracker';
import { renderWorkflowPromptTemplate } from '../integration/linear/workflow-prompt';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SimpleExecutorDeps {
  interactiveExecutor: InteractiveTaskExecutor;
  worktreeManager: WorktreeManager;
  artifactApplier: ArtifactApplier;
  reviewGate?: ReviewGate;
  fixItLoop?: FixItLoop;
  agentRegistry: AgentRegistry;
  githubClient?: GitHubClient;
  linearClient?: Pick<LinearClient, 'createComment'>;
  logger: Logger;
  eventBus?: EventBus;
  maxFixAttempts?: number;
  agentTimeoutMs?: number;
}

export interface SimpleExecutor {
  execute(plan: WorkflowPlan, intakeEvent: IntakeEvent): Promise<ExecutionResult>;
}

export interface ExecutionResult {
  status: 'completed' | 'failed' | 'partial';
  agentResults: AgentResult[];
  totalDuration: number;
  sessionId?: string;
  lastActivityAt?: string;
  continuationState?: import('./runtime/task-executor').TaskExecutionResult['continuationState'];
  tokenUsage?: import('./runtime/task-executor').TaskExecutionResult['tokenUsage'];
}

export interface AgentResult {
  agentRole: string;
  agentType: string;
  status: 'completed' | 'failed' | 'skipped';
  commitSha?: string;
  findings: Finding[];
  duration: number;
  sessionId?: string;
  lastActivityAt?: string;
  continuationState?: import('./runtime/task-executor').TaskExecutionResult['continuationState'];
  tokenUsage?: import('./runtime/task-executor').TaskExecutionResult['tokenUsage'];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSimpleExecutor(deps: SimpleExecutorDeps): SimpleExecutor {
  function emitPhaseCompleted(planId: string, status: 'completed' | 'failed', agentStart: number): void {
    if (!deps.eventBus) return;
    deps.eventBus.publish(createDomainEvent('PhaseCompleted', {
      phaseResult: {
        phaseId: randomUUID(),
        planId,
        phaseType: 'refinement' as const,
        status,
        artifacts: [],
        metrics: { duration: Date.now() - agentStart, agentUtilization: 1, modelCost: 0 },
      },
    }));
  }

  return {
    async execute(plan, intakeEvent): Promise<ExecutionResult> {
      const startTime = Date.now();
      const agentResults: AgentResult[] = [];
      const agents = plan.agentTeam;
      const priorOutputs: string[] = [];
      // Chain sequential agents: each starts from the previous agent's commit
      let lastCommitRef = intakeEvent.entities.branch ?? 'main';

      for (const agent of agents) {
        const agentStart = Date.now();
        let handle: Awaited<ReturnType<WorktreeManager['create']>> | undefined;

        // AIG: Emit PhaseStarted event before each agent runs
        if (deps.eventBus) {
          deps.eventBus.publish(createDomainEvent('PhaseStarted', {
            planId: plan.id,
            phaseType: 'refinement' as const,
            agents: [agent.type],
          }));
        }

        try {
          // 1. Get agent definition (full markdown body as instructions)
          const agentDef = deps.agentRegistry.getByPath(agent.type);
          const instructions = agentDef?.body || agentDef?.description || '';

          // 2. Create worktree from last successful agent's commit (or base branch)
          handle = await deps.worktreeManager.create(
            plan.id, lastCommitRef, `agent/${plan.id}/${agent.role}`,
          );

          // 3. Build prompt: agent instructions + issue context
          const workflowPrompt = renderWorkflowPromptTemplate(
            plan.promptTemplate ?? '',
            intakeEvent,
            agent,
            plan,
          );
          const prompt = buildAgentPrompt(
            workflowPrompt,
            instructions,
            intakeEvent,
            agent,
            plan,
            priorOutputs,
          );

          // 4. Run Claude Code session in worktree
          const execResult = await deps.interactiveExecutor.execute({
            prompt,
            worktreePath: handle.path,
            agentRole: agent.role,
            agentType: agent.type,
            tier: agent.tier,
            phaseType: 'refinement',
            timeout: deps.agentTimeoutMs ?? 900_000,
            metadata: { planId: plan.id, workItemId: plan.workItemId },
          });

          if (execResult.status === 'failed') {
            agentResults.push({
              agentRole: agent.role,
              agentType: agent.type,
              status: 'failed',
              findings: [],
              duration: Date.now() - agentStart,
              sessionId: execResult.sessionId,
              lastActivityAt: execResult.lastActivityAt,
              continuationState: execResult.continuationState,
              tokenUsage: execResult.tokenUsage,
            });
            emitPhaseCompleted(plan.id, 'failed', agentStart);
            await deps.worktreeManager.dispose(handle);
            continue;
          }

          // 5. Validate & commit
          const applyResult = await deps.artifactApplier.apply(plan.id, handle, {
            commitMessage: `${agent.role}: ${agent.type} work on ${plan.workItemId}`,
          });

          if (applyResult.status === 'rejected') {
            agentResults.push({
              agentRole: agent.role,
              agentType: agent.type,
              status: 'failed',
              findings: [],
              duration: Date.now() - agentStart,
              sessionId: execResult.sessionId,
              lastActivityAt: execResult.lastActivityAt,
              continuationState: execResult.continuationState,
              tokenUsage: execResult.tokenUsage,
            });
            emitPhaseCompleted(plan.id, 'failed', agentStart);
            await deps.worktreeManager.dispose(handle);
            continue;
          }

          // 6. Review gate (optional)
          let findings: Finding[] = [];
          if (deps.fixItLoop && deps.reviewGate && applyResult.commitSha) {
            const fixResult = await deps.fixItLoop.run({
              planId: plan.id,
              workItemId: plan.workItemId,
              branch: handle.branch,
              worktreePath: handle.path,
              initialCommitSha: applyResult.commitSha,
              artifacts: [],
              maxAttempts: deps.maxFixAttempts ?? 3,
              timeout: deps.agentTimeoutMs ?? 900_000,
            });
            findings = fixResult.finalVerdict.findings;
          }

          // 6b. Track agent commit SHA for feedback loop prevention
          if (applyResult.commitSha) {
            trackAgentCommit(applyResult.commitSha);
          }

          // 7. Push commits to remote
          if (deps.githubClient && applyResult.commitSha) {
            const targetBranch = intakeEvent.entities.branch ?? handle.branch;
            try {
              // Push local agent branch → remote target branch via GitHubClient
              await deps.githubClient.pushBranch(handle.path, handle.branch, {
                remoteBranch: targetBranch,
                repo: intakeEvent.entities.repo,
              });
              deps.logger.info('Branch pushed', { planId: plan.id, localBranch: handle.branch, remoteBranch: targetBranch });
            } catch (pushErr) {
              deps.logger.warn('Failed to push branch', {
                planId: plan.id,
                localBranch: handle.branch,
                remoteBranch: targetBranch,
                error: pushErr instanceof Error ? pushErr.message : String(pushErr),
              });
            }
          }

          const handoffOutput = truncateForHandoff(execResult.output ?? '');
          if (handoffOutput) {
            priorOutputs.push(handoffOutput);
          }

          // 8. Post PR/issue comment with work summary
          if (deps.githubClient && intakeEvent.entities.prNumber && intakeEvent.entities.repo) {
            const changedFiles = applyResult.changedFiles ?? [];
            const duration = Math.round((Date.now() - agentStart) / 1000);
            const findingLines = findings.length > 0
              ? `\n\n**Findings (${findings.length}):**\n${findings.map(f => `- [${f.severity}] ${f.message}`).join('\n')}`
              : '';
            const fileLines = changedFiles.length > 0
              ? `\n\n**Files (${changedFiles.length}):**\n${changedFiles.slice(0, 10).map(f => `- \`${f}\``).join('\n')}${changedFiles.length > 10 ? `\n- ... and ${changedFiles.length - 10} more` : ''}`
              : '';
            const maxOutputLen = 2000;
            let outputText = execResult.output ?? '';
            if (outputText.length > maxOutputLen) {
              const truncated = outputText.slice(0, maxOutputLen);
              const lastNewline = truncated.lastIndexOf('\n');
              outputText = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
              outputText += '\n\n_(truncated)_';
            }
            const outputPreview = outputText ? `\n\n**Output:**\n${outputText}` : '';

            const summary = [
              `**${agent.type}** completed in ${duration}s`,
              applyResult.commitSha ? `Commit: \`${applyResult.commitSha.slice(0, 7)}\`` : '',
              fileLines,
              outputPreview,
              findingLines,
            ].filter(Boolean).join('\n');

            await deps.githubClient.postPRComment(
              intakeEvent.entities.repo,
              intakeEvent.entities.prNumber,
              formatAgentComment(summary),
            ).catch((err: unknown) => deps.logger.warn('Failed to post PR comment', {
              error: err instanceof Error ? err.message : String(err),
            }));
          }

          if (deps.linearClient && typeof intakeEvent.sourceMetadata.linearIssueId === 'string') {
            const linearSummary = formatLinearAgentSummary({
              agentType: agent.type,
              durationMs: Date.now() - agentStart,
              commitSha: applyResult.commitSha,
              changedFiles: applyResult.changedFiles ?? [],
              output: execResult.output ?? '',
              findings,
            });
            await deps.linearClient.createComment(
              intakeEvent.sourceMetadata.linearIssueId,
              linearSummary,
            ).catch((err: unknown) => deps.logger.warn('Failed to post Linear comment', {
              issueId: intakeEvent.sourceMetadata.linearIssueId,
              error: err instanceof Error ? err.message : String(err),
            }));
          }

          // Chain: next agent starts from this agent's commit
          if (applyResult.commitSha) {
            lastCommitRef = applyResult.commitSha;
          }

          agentResults.push({
            agentRole: agent.role,
            agentType: agent.type,
            status: 'completed',
            commitSha: applyResult.commitSha,
            findings,
            duration: Date.now() - agentStart,
            sessionId: execResult.sessionId,
            lastActivityAt: execResult.lastActivityAt,
            continuationState: execResult.continuationState,
            tokenUsage: execResult.tokenUsage,
          });

          emitPhaseCompleted(plan.id, 'completed', agentStart);

          // 9. Cleanup worktree
          await deps.worktreeManager.dispose(handle);

        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error('Agent execution failed', {
            planId: plan.id, agent: agent.type, error: message,
          });
          if (handle) {
            await deps.worktreeManager.dispose(handle).catch(() => {});
          }
          agentResults.push({
            agentRole: agent.role,
            agentType: agent.type,
            status: 'failed',
            findings: [],
            duration: Date.now() - agentStart,
            sessionId: undefined,
            lastActivityAt: undefined,
            continuationState: undefined,
            tokenUsage: undefined,
          });
          emitPhaseCompleted(plan.id, 'failed', agentStart);
        }
      }

      // Determine overall status
      const allCompleted = agentResults.length > 0
        ? agentResults.every((r) => r.status === 'completed')
        : false;
      const anyCompleted = agentResults.some((r) => r.status === 'completed');
      const latestAgentResult = agentResults[agentResults.length - 1];

      return {
        status: allCompleted ? 'completed' : anyCompleted ? 'partial' : 'failed',
        agentResults,
        totalDuration: Date.now() - startTime,
        sessionId: latestAgentResult?.sessionId,
        lastActivityAt: latestAgentResult?.lastActivityAt,
        continuationState: latestAgentResult?.continuationState,
        tokenUsage: latestAgentResult?.tokenUsage,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — agent instructions + issue context
// ---------------------------------------------------------------------------

/** @internal Exported for testing only */
export function buildAgentPrompt(
  workflowPrompt: string,
  agentInstructions: string,
  intakeEvent: IntakeEvent,
  agent: PlannedAgent,
  plan: WorkflowPlan,
  priorAgentOutputs: string[] = [],
): string {
  const sections: string[] = [];

  sections.push(`You are a ${agent.type} agent with role: ${agent.role}.`);
  sections.push('You must make concrete changes to the codebase. Read files, write code, create tests, and fix issues. Do not just analyze — act.');
  sections.push('');

  if (workflowPrompt) {
    sections.push('## Workflow Contract');
    sections.push(workflowPrompt);
    sections.push('');
  }

  if (agentInstructions) {
    sections.push('## Your Instructions');
    sections.push(agentInstructions);
    sections.push('');
  }

  sections.push('## Task');
  sections.push(`Work item: ${plan.workItemId}`);
  if (intakeEvent.entities.repo) sections.push(`Repository: ${intakeEvent.entities.repo}`);
  if (intakeEvent.entities.branch) sections.push(`Branch: ${intakeEvent.entities.branch}`);
  if (intakeEvent.entities.prNumber) sections.push(`PR: #${intakeEvent.entities.prNumber}`);
  if (intakeEvent.entities.issueNumber) sections.push(`Issue: #${intakeEvent.entities.issueNumber}`);
  sections.push('');

  if (intakeEvent.rawText) {
    sections.push('## Description');
    sections.push(sanitize(intakeEvent.rawText));
  }

  if (typeof intakeEvent.sourceMetadata.linearIdentifier === 'string') {
    sections.push('');
    sections.push(`Linear issue: ${intakeEvent.sourceMetadata.linearIdentifier}`);
  }

  if (priorAgentOutputs.length > 0) {
    sections.push('');
    sections.push('## Prior Agent Output');
    sections.push(priorAgentOutputs.join('\n\n---\n\n'));
  }

  if (intakeEvent.entities.labels?.length) {
    sections.push('');
    sections.push(`Labels: ${intakeEvent.entities.labels.join(', ')}`);
  }

  return sections.join('\n');
}

function truncateForHandoff(output: string): string {
  if (!output.trim()) {
    return '';
  }
  const maxHandoff = 8192;
  if (output.length <= maxHandoff) {
    return output;
  }
  return `(truncated)\n${output.slice(-maxHandoff)}`;
}

function formatLinearAgentSummary(params: {
  agentType: string;
  durationMs: number;
  commitSha?: string;
  changedFiles: string[];
  output: string;
  findings: Finding[];
}): string {
  const durationSeconds = Math.max(1, Math.round(params.durationMs / 1000));
  const changedFiles = params.changedFiles.length > 0
    ? `\n\nFiles changed (${params.changedFiles.length}):\n${params.changedFiles.slice(0, 10).map((file) => `- \`${file}\``).join('\n')}${params.changedFiles.length > 10 ? `\n- ... and ${params.changedFiles.length - 10} more` : ''}`
    : '';
  const findings = params.findings.length > 0
    ? `\n\nFindings (${params.findings.length}):\n${params.findings.map((finding) => `- [${finding.severity}] ${finding.message}`).join('\n')}`
    : '';
  const output = params.output.trim()
    ? `\n\nOutput:\n${truncatePreview(params.output, 2000)}`
    : '';

  return [
    `**${params.agentType}** completed in ${durationSeconds}s`,
    params.commitSha ? `Commit: \`${params.commitSha.slice(0, 7)}\`` : '',
    changedFiles,
    output,
    findings,
  ].filter(Boolean).join('\n');
}

function truncatePreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const truncated = text.slice(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  const preview = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return `${preview}\n\n_(truncated)_`;
}
