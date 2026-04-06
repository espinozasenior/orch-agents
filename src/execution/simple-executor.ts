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
import { getCoordinatorSystemPrompt, getCoordinatorUserContext } from '../coordinator/coordinatorPrompt';
import type { LinearClient } from '../integration/linear/linear-client';
import type { Logger } from '../shared/logger';
import type { EventBus } from '../shared/event-bus';
import { createDomainEvent } from '../shared/event-bus';
import { formatAgentComment, getBotMarker } from '../shared/agent-identity';
import { sanitize } from '../shared/input-sanitizer';
import { trackAgentCommit } from '../shared/agent-commit-tracker';
import { renderWorkflowPromptTemplate } from '../integration/linear/workflow-prompt';
import {
  isForkSubagentEnabled,
  isInForkChild,
  buildForkConversationMessages,
  FORK_AGENT,
  createCompositeAgentRegistry,
  getDefaultProgrammaticAgents,
} from '../agents/fork/index';
import type { ForkMessage } from '../agents/fork/index';
import { recordForkHistory, serializeForkContext } from './fork-context';
import { postAgentResponse, emitThought } from '../integration/linear/activity-router';
import { createTask, TaskType, TaskStatus, transition } from './task';
import type { TaskRegistry } from './task';

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
  linearClient?: Pick<LinearClient, 'createComment' | 'createAgentActivity'>;
  logger: Logger;
  eventBus?: EventBus;
  maxFixAttempts?: number;
  agentTimeoutMs?: number;
  /**
   * Whether we are in coordinator mode. Fork is disabled in coordinator
   * mode (coordinator has its own delegation model).
   * Defaults to false.
   */
  isCoordinator?: boolean;
  /**
   * Whether the session is non-interactive. Fork is disabled for
   * non-interactive sessions (background tasks cannot deliver
   * task-notifications).
   * Defaults to false.
   */
  isNonInteractive?: boolean;
  /** P6: Optional TaskRegistry for task backbone wiring. */
  taskRegistry?: TaskRegistry;
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
  /** P6: Task ID from the task backbone, when TaskRegistry is wired. */
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSimpleExecutor(deps: SimpleExecutorDeps): SimpleExecutor {
  // P8: Composite registry — merge disk-loaded agents with programmatic agents
  // (e.g., FORK_AGENT). Programmatic agents override disk agents with same key.
  const programmaticAgents = getDefaultProgrammaticAgents();
  const compositeAgentRegistry = createCompositeAgentRegistry(
    new Map(deps.agentRegistry.getAll().map((a) => [a.name, { agentType: a.name, whenToUse: a.description || '', source: 'disk' }])),
    programmaticAgents,
  );

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

      // Fork context: accumulated conversation history for cache-sharing
      // forks. Each agent's prompt/response pair is recorded as ForkMessage
      // entries so subsequent agents can inherit parent context via
      // buildForkMessages (P5 — fork subagent with prompt cache sharing).
      const forkHistory: ForkMessage[] = [];
      const isCoordinator = deps.isCoordinator ?? (plan.methodology === 'coordinator');
      const isNonInteractive = deps.isNonInteractive ?? false;

      // FR-P8-006: When fork is enabled, all dispatches are forced async
      // through the task backbone (P6). Log once at the start.
      const forkEnabled = isForkSubagentEnabled(isCoordinator, isNonInteractive);
      if (forkEnabled && deps.taskRegistry) {
        deps.logger.info('Fork-enabled: all dispatches forced async', { forkEnabled });
      }

      for (const agent of agents) {
        const agentStart = Date.now();
        let handle: Awaited<ReturnType<WorktreeManager['create']>> | undefined;
        let taskId: string | undefined;

        // AIG: Emit PhaseStarted event before each agent runs
        if (deps.eventBus) {
          deps.eventBus.publish(createDomainEvent('PhaseStarted', {
            planId: plan.id,
            phaseType: 'refinement' as const,
            agents: [agent.type],
          }));
        }

        try {
          // P6: Create task before dispatch (when registry is wired)
          let task: import('./task/types').Task | undefined;
          if (deps.taskRegistry) {
            task = createTask(TaskType.local_agent);
            taskId = task.id;
            deps.taskRegistry.register(task);
          }

          // 1. Get agent definition (full markdown body as instructions)
          const agentDef = deps.agentRegistry.getByPath(agent.type);
          const instructions = agentDef?.body || agentDef?.description || '';

          // 2. Create worktree from last successful agent's commit (or base branch)
          handle = await deps.worktreeManager.create(
            plan.id, lastCommitRef, `agent/${plan.id}/${agent.role}`,
          );

          // 3. Build prompt: agent instructions + issue context
          let prompt: string;

          if (plan.methodology === 'coordinator') {
            // Coordinator mode (P2): Claude Code orchestrator with 4-phase workflow.
            // The coordinator system prompt replaces agent-specific instructions.
            // Claude Code decides how to approach the task autonomously.
            const coordinatorPrompt = getCoordinatorSystemPrompt();
            const { workerToolsContext: workerContext } = getCoordinatorUserContext([]);
            const issueRef = intakeEvent.entities.requirementId ?? '';
            const issueDesc = intakeEvent.rawText ?? '';

            // Build context-rich prompt for the coordinator
            const contextParts: string[] = [coordinatorPrompt, workerContext, '---'];

            if (issueRef) {
              contextParts.push(`## Issue: ${issueRef}`);
            }

            // If this is a comment/follow-up, label it clearly so the coordinator
            // knows this is a question about the issue, not a new task
            if (intakeEvent.intent === ('custom:linear-prompted' as string) && issueDesc) {
              contextParts.push(
                '## User Comment (follow-up on the issue above)',
                issueDesc,
                '',
                'Answer the user\'s question in context of this Linear issue. ' +
                'Read the issue description and any relevant code before responding. ' +
                'If the user asks about a feature, check the codebase to see if it\'s implemented.',
              );
            } else {
              contextParts.push('## Task', issueDesc || 'Complete the assigned task.');
            }

            prompt = contextParts.join('\n\n');
          } else {
            const workflowPrompt = renderWorkflowPromptTemplate(
              plan.promptTemplate ?? '',
              intakeEvent,
              agent,
              plan,
            );
            prompt = buildAgentPrompt(
              workflowPrompt,
              instructions,
              intakeEvent,
              agent,
              plan,
              priorOutputs,
            );
          }

          // 4. Fork eligibility — 3-gate pattern (P8: fork runtime wiring)
          //    Gate 1: Feature enabled? (not coordinator, not non-interactive)
          //    Gate 2: Not already in a fork child? (depth = 1 limit)
          //    Gate 3: Prior history exists? (first agent starts fresh)
          let forkContextPrefix: string | undefined;
          // forkEnabled is computed once before the loop (FR-P8-006)
          let isForkPath = false;

          if (!forkEnabled) {
            deps.logger.debug('Fork blocked: feature disabled', {
              isCoordinator, isNonInteractive,
            });
          } else if (isInForkChild(forkHistory)) {
            deps.logger.debug('Fork blocked: already in fork child (depth limit)');
          } else if (forkHistory.length === 0) {
            deps.logger.debug('Fork skipped: no prior history to inherit');
          } else {
            // All gates passed — determine fork path based on subagentType.
            // When subagentType is omitted, resolve via composite registry
            // which includes FORK_AGENT as a built-in programmatic agent.
            isForkPath = !agent.subagentType
              && compositeAgentRegistry.has(FORK_AGENT.agentType);

            // Build fork context: full context inheritance via
            // buildForkConversationMessages (replaces simpler buildForkMessages)
            const forkedMessages = buildForkConversationMessages(forkHistory, prompt);
            forkContextPrefix = serializeForkContext(forkedMessages);

            deps.logger.info('Fork context applied', {
              planId: plan.id,
              agent: agent.type,
              forkHistoryLength: forkHistory.length,
              prefixBytes: forkContextPrefix.length,
              isForkPath,
            });
          }

          // 5a. Emit thought activity before execution (FR-10A.02)
          const agentSessionIdForThought = typeof intakeEvent.sourceMetadata.agentSessionId === 'string'
            ? intakeEvent.sourceMetadata.agentSessionId as string
            : undefined;
          await emitThought(
            agentSessionIdForThought,
            'Working on your request...',
            deps.linearClient,
            deps.logger,
          );

          // P6: Transition task to running before execution
          if (deps.taskRegistry && task && taskId) {
            task = transition(task, TaskStatus.running);
            deps.taskRegistry.update(taskId, task);
          }

          // 5. Run Claude Code session in worktree
          const execResult = await deps.interactiveExecutor.execute({
            prompt,
            worktreePath: handle.path,
            agentRole: agent.role,
            agentType: agent.type,
            tier: agent.tier,
            phaseType: 'refinement',
            timeout: deps.agentTimeoutMs ?? 900_000,
            metadata: {
              planId: plan.id,
              workItemId: plan.workItemId,
              taskId,
              // FR-P8-006: Signal forced-async dispatch when fork is enabled
              ...(forkEnabled && deps.taskRegistry && { forceAsync: true }),
              // P8: Fork agent properties — when isForkPath, FORK_AGENT
              // definition applies (model: 'inherit' = parent model reuse,
              // maxTurns: 200). Downstream executors use these for dispatch.
              ...(isForkPath && {
                forkAgent: true,
                forkModel: FORK_AGENT.model,
                forkMaxTurns: FORK_AGENT.maxTurns,
              }),
            },
            forkContextPrefix,
          });

          if (execResult.status === 'failed') {
            // P6: Transition task to failed
            if (deps.taskRegistry && task && taskId) {
              const failed = transition(task, TaskStatus.failed);
              deps.taskRegistry.update(taskId, failed);
            }
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
              taskId,
            });
            emitPhaseCompleted(plan.id, 'failed', agentStart);
            await deps.worktreeManager.dispose(handle);
            continue;
          }

          // 6. Validate & commit
          const applyResult = await deps.artifactApplier.apply(plan.id, handle, {
            commitMessage: `${agent.role}: ${agent.type} work on ${plan.workItemId}`,
          });

          if (applyResult.status === 'rejected') {
            // P6: Transition task to failed
            if (deps.taskRegistry && task && taskId) {
              const failed = transition(task, TaskStatus.failed);
              deps.taskRegistry.update(taskId, failed);
            }
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
              taskId,
            });
            emitPhaseCompleted(plan.id, 'failed', agentStart);
            await deps.worktreeManager.dispose(handle);
            continue;
          }

          // 7. Review gate (optional)
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

          // 7b. Track agent commit SHA for feedback loop prevention
          if (applyResult.commitSha) {
            trackAgentCommit(applyResult.commitSha);
          }

          // 8. Push commits to remote
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

          // Record this agent's prompt/response in fork history so
          // subsequent agents can inherit context (P5 fork cache sharing).
          recordForkHistory(forkHistory, prompt, execResult.output ?? '');

          // 9. Post PR/issue comment with work summary
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
            const linearIssueId = intakeEvent.sourceMetadata.linearIssueId as string;
            const agentSessionId = typeof intakeEvent.sourceMetadata.agentSessionId === 'string'
              ? intakeEvent.sourceMetadata.agentSessionId as string
              : undefined;
            const linearSummary = formatLinearAgentSummary({
              agentType: agent.type,
              durationMs: Date.now() - agentStart,
              commitSha: applyResult.commitSha,
              changedFiles: applyResult.changedFiles ?? [],
              output: execResult.output ?? '',
              findings,
              includeMarker: !agentSessionId,
            });
            // Route response: createAgentActivity for sessions, createComment fallback
            await postAgentResponse(
              intakeEvent.source,
              agentSessionId,
              linearSummary,
              deps.linearClient,
              deps.githubClient,
              { issueId: linearIssueId, repo: intakeEvent.entities.repo, prNumber: intakeEvent.entities.prNumber },
            ).catch((err: unknown) => deps.logger.warn('Failed to post Linear response', {
              issueId: linearIssueId,
              agentSessionId,
              error: err instanceof Error ? err.message : String(err),
            }));
          }

          // Chain: next agent starts from this agent's commit
          if (applyResult.commitSha) {
            lastCommitRef = applyResult.commitSha;
          }

          // P6: Transition task to completed
          if (deps.taskRegistry && task && taskId) {
            const completed = transition(task, TaskStatus.completed);
            deps.taskRegistry.update(taskId, completed);
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
            taskId,
          });

          emitPhaseCompleted(plan.id, 'completed', agentStart);

          // 10. Cleanup worktree
          await deps.worktreeManager.dispose(handle);

        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error('Agent execution failed', {
            planId: plan.id, agent: agent.type, error: message,
          });
          if (handle) {
            await deps.worktreeManager.dispose(handle).catch(() => {});
          }
          // P6: Transition task to failed on exception
          if (deps.taskRegistry && taskId) {
            try {
              const currentTask = deps.taskRegistry.get(taskId);
              if (currentTask && currentTask.status !== TaskStatus.failed && currentTask.status !== TaskStatus.completed) {
                const failed = transition(currentTask, TaskStatus.failed);
                deps.taskRegistry.update(taskId, failed);
              }
            } catch { /* best effort */ }
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
            taskId,
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
  includeMarker?: boolean;
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

  const parts = [
    `**${params.agentType}** completed in ${durationSeconds}s`,
    params.commitSha ? `Commit: \`${params.commitSha.slice(0, 7)}\`` : '',
    changedFiles,
    output,
    findings,
  ];
  if (params.includeMarker !== false) {
    parts.push(getBotMarker());
  }
  return parts.filter(Boolean).join('\n');
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

