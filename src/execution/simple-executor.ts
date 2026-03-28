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
import type { Logger } from '../shared/logger';
import type { EventBus } from '../shared/event-bus';
import { createDomainEvent } from '../shared/event-bus';
import { formatAgentComment } from '../shared/agent-identity';

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
}

export interface AgentResult {
  agentRole: string;
  agentType: string;
  status: 'completed' | 'failed' | 'skipped';
  commitSha?: string;
  findings: Finding[];
  duration: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSimpleExecutor(deps: SimpleExecutorDeps): SimpleExecutor {
  return {
    async execute(plan, intakeEvent): Promise<ExecutionResult> {
      const startTime = Date.now();
      const agentResults: AgentResult[] = [];
      const agents = plan.agentTeam;

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
          // 1. Get agent definition (description as instructions)
          const agentDef = deps.agentRegistry.getByName(agent.type);
          const instructions = agentDef?.description ?? '';

          // 2. Create isolated worktree
          const baseBranch = intakeEvent.entities.branch ?? 'main';
          handle = await deps.worktreeManager.create(
            plan.id, baseBranch, `agent/${plan.id}/${agent.role}`,
          );

          // 3. Build prompt: agent instructions + issue context
          const prompt = buildAgentPrompt(instructions, intakeEvent, agent, plan);

          // 4. Run Claude Code session in worktree
          const execResult = await deps.interactiveExecutor.execute({
            prompt,
            worktreePath: handle.path,
            agentRole: agent.role,
            agentType: agent.type,
            tier: agent.tier,
            phaseType: 'refinement',
            timeout: deps.agentTimeoutMs ?? 300_000,
            metadata: { planId: plan.id, workItemId: plan.workItemId },
          });

          if (execResult.status === 'failed') {
            agentResults.push({
              agentRole: agent.role,
              agentType: agent.type,
              status: 'failed',
              findings: [],
              duration: Date.now() - agentStart,
            });
            // AIG: Emit PhaseCompleted (failed) event
            if (deps.eventBus) {
              deps.eventBus.publish(createDomainEvent('PhaseCompleted', {
                phaseResult: {
                  phaseId: randomUUID(),
                  planId: plan.id,
                  phaseType: 'refinement' as const,
                  status: 'failed' as const,
                  artifacts: [],
                  metrics: { duration: Date.now() - agentStart, agentUtilization: 1, modelCost: 0 },
                },
              }));
            }
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
            });
            // AIG: Emit PhaseCompleted (failed) event
            if (deps.eventBus) {
              deps.eventBus.publish(createDomainEvent('PhaseCompleted', {
                phaseResult: {
                  phaseId: randomUUID(),
                  planId: plan.id,
                  phaseType: 'refinement' as const,
                  status: 'failed' as const,
                  artifacts: [],
                  metrics: { duration: Date.now() - agentStart, agentUtilization: 1, modelCost: 0 },
                },
              }));
            }
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
              timeout: deps.agentTimeoutMs ?? 300_000,
            });
            findings = fixResult.finalVerdict.findings;
          }

          // 7. Post PR/issue comment with work summary
          if (deps.githubClient && intakeEvent.entities.prNumber && intakeEvent.entities.repo) {
            const changedFiles = applyResult.changedFiles ?? [];
            const duration = Math.round((Date.now() - agentStart) / 1000);
            const findingLines = findings.length > 0
              ? `\n\n**Findings (${findings.length}):**\n${findings.map(f => `- [${f.severity}] ${f.message}`).join('\n')}`
              : '';
            const fileLines = changedFiles.length > 0
              ? `\n\n**Files (${changedFiles.length}):**\n${changedFiles.slice(0, 10).map(f => `- \`${f}\``).join('\n')}${changedFiles.length > 10 ? `\n- ... and ${changedFiles.length - 10} more` : ''}`
              : '';
            const outputPreview = execResult.output
              ? `\n\n**Output:**\n${execResult.output.slice(0, 500)}${execResult.output.length > 500 ? '...' : ''}`
              : '';

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

          agentResults.push({
            agentRole: agent.role,
            agentType: agent.type,
            status: 'completed',
            commitSha: applyResult.commitSha,
            findings,
            duration: Date.now() - agentStart,
          });

          // AIG: Emit PhaseCompleted event after agent completes
          if (deps.eventBus) {
            deps.eventBus.publish(createDomainEvent('PhaseCompleted', {
              phaseResult: {
                phaseId: randomUUID(),
                planId: plan.id,
                phaseType: 'refinement' as const,
                status: 'completed' as const,
                artifacts: [],
                metrics: { duration: Date.now() - agentStart, agentUtilization: 1, modelCost: 0 },
              },
            }));
          }

          // 8. Cleanup worktree
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
          });
          // AIG: Emit PhaseCompleted (failed) event
          if (deps.eventBus) {
            deps.eventBus.publish(createDomainEvent('PhaseCompleted', {
              phaseResult: {
                phaseId: randomUUID(),
                planId: plan.id,
                phaseType: 'refinement' as const,
                status: 'failed' as const,
                artifacts: [],
                metrics: { duration: Date.now() - agentStart, agentUtilization: 1, modelCost: 0 },
              },
            }));
          }
        }
      }

      // Determine overall status
      const allCompleted = agentResults.length > 0
        ? agentResults.every((r) => r.status === 'completed')
        : true;
      const anyCompleted = agentResults.some((r) => r.status === 'completed');

      return {
        status: allCompleted ? 'completed' : anyCompleted ? 'partial' : 'failed',
        agentResults,
        totalDuration: Date.now() - startTime,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — agent instructions + issue context
// ---------------------------------------------------------------------------

/** @internal Exported for testing only */
export function buildAgentPrompt(
  agentInstructions: string,
  intakeEvent: IntakeEvent,
  agent: PlannedAgent,
  plan: WorkflowPlan,
): string {
  const sections: string[] = [];

  sections.push(`You are a ${agent.type} agent with role: ${agent.role}.`);
  sections.push('');

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
    sections.push(intakeEvent.rawText);
  }

  if (intakeEvent.entities.labels?.length) {
    sections.push('');
    sections.push(`Labels: ${intakeEvent.entities.labels.join(', ')}`);
  }

  return sections.join('\n');
}
