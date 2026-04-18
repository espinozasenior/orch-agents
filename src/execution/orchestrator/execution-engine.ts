/**
 * Execution Engine.
 *
 * Subscribes to IntakeCompleted and AgentPrompted events and dispatches every
 * main-thread execution through LocalAgentTask in coordinator mode.
 *
 * Option C step 2 (PR A): the legacy template-driven multi-agent path that
 * routed IntakeCompleted through SimpleExecutor has been removed. Templates
 * defined in WORKFLOW.md are still parsed for backward compat (and still used
 * by the worker-thread path in src/execution/orchestrator/issue-worker.ts —
 * scheduled for migration in PR B), but they no longer drive dispatch from
 * the main-thread engine. Coordinator mode is the only mode here.
 */

import { randomUUID } from 'node:crypto';
import type { IntakeEvent, WorkflowPlan } from '../../types';
import { isLinearMeta, isGitHubMeta } from '../../types';
import { createTask, TaskType } from '../task/index';
import {
  planId as toPlanId,
  workItemId as toWorkItemId,
  linearIssueId as toLinearIssueId,
} from '../../shared/branded-types';
import type { EventBus } from '../../shared/event-bus';
import type { Logger } from '../../shared/logger';
import { createDomainEvent } from '../../shared/event-bus';
import type { CoordinatorDispatcher } from '../coordinator-dispatcher';
import type { WorkflowConfig } from '../../integration/linear/workflow-parser';
import { createWorkTracker } from './work-tracker';
import type { GitHubClient } from '../../integration/github-client';
import type { LinearClient } from '../../integration/linear/linear-client';
import type { CancellationController } from '../runtime/cancellation-controller';
import { formatAgentComment, getBotName } from '../../shared/agent-identity';
import { buildWorkpadComment, postOrUpdateWorkpad } from '../../integration/linear/workpad-reporter';
import { createSkillResolver, type SkillResolver } from '../../intake/skill-resolver';
import { fetchContextForSkill } from '../../intake/context-fetchers';

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export interface ExecutionEngineDeps {
  eventBus: EventBus;
  logger: Logger;
  /**
   * CC-aligned coordinator dispatch path. Wired to BOTH the IntakeCompleted
   * and AgentPrompted handlers as of Option C step 2 (PR A). All main-thread
   * dispatches now route through LocalAgentTask in coordinator mode.
   * See src/execution/coordinator-dispatcher.ts.
   */
  localAgentTask: CoordinatorDispatcher;
  workflowConfig: WorkflowConfig;
  githubClient?: GitHubClient;
  linearClient?: LinearClient;
  cancellationController?: CancellationController;
  linearExecutionMode?: 'generic' | 'symphony';
  /** P20: skill resolver for IntakeCompleted dispatch (defaults to filesystem-backed). */
  skillResolver?: SkillResolver;
  /** P20: repository root used to resolve relative skill paths from WORKFLOW.md. */
  repoRoot?: string;
}

/**
 * Start the execution engine: subscribe to IntakeCompleted and AgentPrompted,
 * dispatch every event through LocalAgentTask in coordinator mode, and publish
 * WorkCompleted/WorkFailed. Returns an unsubscribe function for cleanup.
 */
export function startExecutionEngine(deps: ExecutionEngineDeps): () => void {
  const { eventBus, logger, localAgentTask, workflowConfig } = deps;
  const skillResolver = deps.skillResolver ?? createSkillResolver();
  const repoRoot = deps.repoRoot ?? process.cwd();
  const tracker = createWorkTracker();
  const unsubscribers: Array<() => void> = [];

  // Per-org concurrency tracking: tracks active execution count per org owner
  const activeByOrg = new Map<string, Set<string>>();

  function orgFromRepo(repo: string | undefined): string {
    return repo?.split('/')[0] ?? 'default';
  }

  function trackOrgStart(org: string, planId: string): void {
    let orgSet = activeByOrg.get(org);
    if (!orgSet) {
      orgSet = new Set();
      activeByOrg.set(org, orgSet);
    }
    orgSet.add(planId);
  }

  function trackOrgEnd(org: string, planId: string): void {
    const orgSet = activeByOrg.get(org);
    if (orgSet) {
      orgSet.delete(planId);
      if (orgSet.size === 0) {
        activeByOrg.delete(org);
      }
    }
  }

  function isOrgAtCapacity(org: string): boolean {
    const perOrgLimit = workflowConfig.defaults.agents.maxConcurrentPerOrg;
    const orgSet = activeByOrg.get(org);
    return (orgSet?.size ?? 0) >= perOrgLimit;
  }

  // AIG: Subscribe to WorkCancelled events for stop command support
  unsubscribers.push(
    eventBus.subscribe('WorkCancelled', (cancelEvent) => {
      const { workItemId } = cancelEvent.payload;
      logger.info('Work cancellation requested', { workItemId });
      if (deps.cancellationController) {
        deps.cancellationController.cancelPlan(workItemId);
      }
    }),
  );

  unsubscribers.push(eventBus.subscribe('IntakeCompleted', async (event) => {
    const intakeEvent = event.payload.intakeEvent;
    const correlationId = event.correlationId;
    const executionKey = getExecutionKey(intakeEvent);

    if (intakeEvent.source === 'linear' && deps.linearExecutionMode === 'symphony') {
      logger.info('Skipping generic execution for Linear intake because Symphony owns the runtime', {
        workItemId: executionKey,
        correlationId,
      });
      return;
    }

    const activeItems = tracker.listActive();
    const alreadyRunning = activeItems.some(item => item.workItemId === executionKey);
    if (alreadyRunning) {
      logger.warn('Duplicate execution ignored — work item already running', {
        workItemId: executionKey,
      });
      return;
    }

    // Per-org concurrency gate
    const intakeOrg = orgFromRepo(intakeEvent.entities.repo);
    if (isOrgAtCapacity(intakeOrg)) {
      logger.warn('Per-org concurrency limit reached; skipping dispatch', {
        workItemId: executionKey,
        org: intakeOrg,
        activeCount: activeByOrg.get(intakeOrg)?.size ?? 0,
        limit: workflowConfig.defaults.agents.maxConcurrentPerOrg,
      });
      return;
    }

    // Option C step 2 (PR A): coordinator mode is the only mode for the
    // main-thread engine. Templates from WORKFLOW.md are still parsed for
    // backward compat (and still used by the worker-thread path) but are
    // no longer consulted here. The template metadata field is preserved
    // on the plan purely for downstream observability.
    const meta = intakeEvent.sourceMetadata;
    const templateName = (meta && isLinearMeta(meta) ? meta.template : undefined) ?? 'coordinator';

    const task = createTask(TaskType.local_agent);
    const taskPlanId = toPlanId(task.id);
    const plan: WorkflowPlan = {
      id: taskPlanId,
      workItemId: toWorkItemId(intakeEvent.id),
      template: templateName,
      agentTeam: [{ role: 'coordinator', type: 'coordinator', tier: 2 as const, required: true }],
      maxAgents: workflowConfig.agents.maxConcurrent,
      methodology: 'coordinator',
    };

    logger.info('Executing work item (coordinator mode)', {
      planId: taskPlanId,
      workItemId: executionKey,
      template: templateName,
      correlationId,
    });

    tracker.start(taskPlanId, executionKey);
    trackOrgStart(intakeOrg, taskPlanId);

    eventBus.publish(
      createDomainEvent('PlanCreated', {
        workflowPlan: plan,
        intakeEvent,
      }, correlationId),
    );

    if (deps.linearClient && meta && isLinearMeta(meta) && meta.linearIssueId) {
      const issueId = meta.linearIssueId;
      await moveLinearIssueToInProgress(deps.linearClient, issueId, logger);
      await postOrUpdateWorkpad(
        deps.linearClient,
        issueId,
        buildWorkpadComment({
          planId: taskPlanId,
          linearIssueId: issueId,
          currentPhase: 'starting',
          status: 'active',
          startedAt: new Date().toISOString(),
          elapsedMs: 0,
          agents: [],
          phases: [],
          findings: [],
        }),
        logger,
      );
    }

    // AIG: Instant feedback — acknowledge receipt before execution
    if (deps.githubClient && intakeEvent.entities.prNumber && intakeEvent.entities.repo) {
      const botName = getBotName();
      await deps.githubClient.postPRComment(
        intakeEvent.entities.repo,
        intakeEvent.entities.prNumber,
        formatAgentComment(
          `**${botName}** is working on this...\n\nMode: \`coordinator\``,
        ),
      ).catch((err: unknown) => logger.warn('AIG instant feedback failed', { error: String(err) }));
    }

    // P20: resolve the skill, fetch context in parallel, compose enriched intake.
    let enrichedIntake = intakeEvent;
    if (intakeEvent.source === 'github') {
      const skillStart = Date.now();
      const ghMeta = meta && isGitHubMeta(meta) ? meta : undefined;
      const skillPath = ghMeta?.skillPath;
      const ruleKey = ghMeta?.ruleKey;
      const parsedGh = ghMeta?.parsed;

      if (!skillPath) {
        logger.warn('IntakeCompleted has no skillPath — skipping dispatch', {
          intakeId: intakeEvent.id,
          ruleKey,
        });
        tracker.complete(taskPlanId);
        trackOrgEnd(intakeOrg, taskPlanId);
        return;
      }

      const skill = skillResolver.resolveByPath(skillPath, repoRoot);
      if (!skill) {
        logger.warn('Skill file missing or unparseable — skipping dispatch', {
          intakeId: intakeEvent.id,
          skillPath,
          ruleKey,
        });
        tracker.complete(taskPlanId);
        trackOrgEnd(intakeOrg, taskPlanId);
        return;
      }

      let fetchedContext = '';
      if (parsedGh && deps.githubClient) {
        fetchedContext = await fetchContextForSkill(skill, parsedGh, deps.githubClient, logger);
      }

      const composedRawText = `${skill.body}\n\n## Trigger Context\n\n${fetchedContext}`;
      enrichedIntake = { ...intakeEvent, rawText: composedRawText };

      logger.info('Resolved skill for IntakeCompleted', {
        skillPath,
        ruleKey,
        contextFetchers: skill.frontmatter.contextFetchers,
        bytesInBody: skill.body.length,
        bytesInContext: fetchedContext.length,
        durationMs: Date.now() - skillStart,
      });
    }

    try {
      const result = await localAgentTask.execute(plan, enrichedIntake);

      tracker.complete(taskPlanId);
      trackOrgEnd(intakeOrg, taskPlanId);

      if (result.status === 'failed') {
        const reason = `All agents failed for plan ${taskPlanId}`;
        tracker.fail(taskPlanId, reason);
        eventBus.publish(
          createDomainEvent('WorkFailed', {
            workItemId: toWorkItemId(executionKey),
            failureReason: reason,
            retryCount: 0,
          }, correlationId),
        );
        return;
      }

      eventBus.publish(
        createDomainEvent('WorkCompleted', {
          workItemId: toWorkItemId(executionKey),
          planId: taskPlanId,
          phaseCount: result.agentResults.length,
          totalDuration: result.totalDuration,
        }, correlationId),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      tracker.fail(taskPlanId, reason);
      trackOrgEnd(intakeOrg, taskPlanId);

      logger.error('LocalAgentTask error (IntakeCompleted)', { planId: taskPlanId, error: reason });

      eventBus.publish(
        createDomainEvent('WorkFailed', {
          workItemId: toWorkItemId(executionKey),
          failureReason: reason,
          retryCount: 0,
        }, correlationId),
      );
    }
  }));

  // AgentPrompted: comments and agent sessions forward to coordinator mode.
  // Claude Code decides what to do based on the prompt content.
  unsubscribers.push(eventBus.subscribe('AgentPrompted', async (event) => {
    const { issueId, body, agentSessionId } = event.payload;
    const correlationId = event.correlationId;
    const executionKey = `linear:${issueId}`;

    // Skip if already running a plan for this issue
    const activeItems = tracker.listActive();
    if (activeItems.some(item => item.workItemId === executionKey)) {
      logger.debug('AgentPrompted skipped — work already running for issue', {
        issueId, executionKey,
      });
      return;
    }

    if (!body || body.trim().length === 0) {
      logger.debug('AgentPrompted skipped — empty body', { issueId });
      return;
    }

    // 9F: Typed task ID — in_process_teammate for comment/prompt interactions
    const promptTask = createTask(TaskType.in_process_teammate);
    const promptPlanId = toPlanId(promptTask.id);
    const plan: WorkflowPlan = {
      id: promptPlanId,
      workItemId: toWorkItemId(issueId),
      template: 'coordinator',
      agentTeam: [{ role: 'coordinator', type: 'coordinator', tier: 2 as const, required: true }],
      maxAgents: workflowConfig.agents.maxConcurrent,
      methodology: 'coordinator',
    };

    // Fetch issue context from Linear so the coordinator knows what the
    // comment is about (issue title + description + the comment itself)
    let issueContext = '';
    if (deps.linearClient) {
      try {
        const issue = await deps.linearClient.fetchIssue(issueId);
        const title = issue.title ?? '';
        const desc = issue.description ?? '';
        const identifier = issue.identifier ?? '';
        issueContext = [
          identifier ? `## Issue: ${identifier} — ${title}` : `## Issue: ${title}`,
          desc ? `\n${desc}` : '',
          '\n---\n',
        ].filter(Boolean).join('');
      } catch (err) {
        logger.debug('Failed to fetch issue context for AgentPrompted', {
          issueId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fetch conversation history from session activities (FR-10A.03)
    let conversationHistory = '';
    if (deps.linearClient && agentSessionId) {
      try {
        const history = await fetchConversationHistory(agentSessionId, deps.linearClient);
        if (history.length > 0) {
          conversationHistory = '## Previous Conversation\n\n' +
            history.map((m) =>
              m.role === 'user' ? `**User:** ${m.content}` : `**Assistant:** ${m.content}`,
            ).join('\n\n') + '\n\n---\n';
        }
      } catch (err) {
        logger.debug('Failed to fetch conversation history', {
          agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Synthesize an IntakeEvent with full context: issue + history + comment
    const rawTextParts = [
      issueContext,
      conversationHistory,
      issueContext || conversationHistory ? `## User Comment\n${body}` : body,
    ].filter(Boolean);

    const intakeEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: 'linear' as const,
      sourceMetadata: { source: 'linear' as const, agentSessionId, linearIssueId: toLinearIssueId(issueId), intent: 'custom:linear-prompted' },
      entities: { requirementId: issueId, labels: [] as string[] },
      rawText: rawTextParts.join('\n'),
    };

    logger.info('AgentPrompted → coordinator execution', {
      planId: promptPlanId, issueId, correlationId,
      bodyPreview: body.slice(0, 100),
    });

    const promptOrg = orgFromRepo((intakeEvent.entities as { repo?: string }).repo);
    if (isOrgAtCapacity(promptOrg)) {
      logger.warn('Per-org concurrency limit reached for AgentPrompted; skipping', {
        issueId,
        org: promptOrg,
        activeCount: activeByOrg.get(promptOrg)?.size ?? 0,
        limit: workflowConfig.defaults.agents.maxConcurrentPerOrg,
      });
      return;
    }

    tracker.start(promptPlanId, executionKey);
    trackOrgStart(promptOrg, promptPlanId);

    try {
      // CC-aligned dispatch: AgentPrompted runs in coordinator mode via
      // LocalAgentTask. As of Option C step 2 (PR A), IntakeCompleted also
      // routes through LocalAgentTask — the engine no longer dispatches via
      // the legacy SimpleExecutor path.
      const result = await localAgentTask.execute(plan, intakeEvent);
      tracker.complete(promptPlanId);
      trackOrgEnd(promptOrg, promptPlanId);

      if (result.status === 'failed') {
        tracker.fail(promptPlanId, 'Coordinator session failed');
        eventBus.publish(createDomainEvent('WorkFailed', {
          workItemId: toWorkItemId(executionKey),
          failureReason: 'Coordinator session failed',
          retryCount: 0,
        }, correlationId));
      } else {
        eventBus.publish(createDomainEvent('WorkCompleted', {
          workItemId: toWorkItemId(executionKey),
          planId: promptPlanId,
          phaseCount: 1,
          totalDuration: result.totalDuration,
        }, correlationId));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      tracker.fail(promptPlanId, reason);
      trackOrgEnd(promptOrg, promptPlanId);
      logger.error('AgentPrompted coordinator error', { planId: promptPlanId, error: reason });
      eventBus.publish(createDomainEvent('WorkFailed', {
        workItemId: toWorkItemId(executionKey),
        failureReason: reason,
        retryCount: 0,
      }, correlationId));
    }
  }));

  // Return a combined unsubscribe function
  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}

function getExecutionKey(intakeEvent: IntakeEvent): string {
  const meta = intakeEvent.sourceMetadata;
  if (intakeEvent.source === 'linear' && meta && isLinearMeta(meta)) {
    return `linear:${meta.linearIssueId}`;
  }

  return intakeEvent.id;
}

async function moveLinearIssueToInProgress(
  linearClient: LinearClient,
  issueId: string,
  logger: Logger,
): Promise<void> {
  try {
    const issue = await linearClient.fetchIssue(issueId);
    if (issue.state.name.toLowerCase() === 'in progress') {
      return;
    }
    if (!issue.team?.id) {
      logger.warn('Linear issue team missing; cannot move to In Progress', { issueId });
      return;
    }

    const states = await linearClient.fetchTeamStates(issue.team.id);
    const inProgressState = states.find((state) => state.name.toLowerCase() === 'in progress');
    if (!inProgressState) {
      logger.warn('Linear team has no In Progress state', {
        issueId,
        teamId: issue.team.id,
      });
      return;
    }

    await linearClient.updateIssueState(issueId, inProgressState.id);
  } catch (err) {
    logger.warn('Failed to move Linear issue to In Progress', {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Conversation history from session activities (FR-10A.03)
// ---------------------------------------------------------------------------

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_CONVERSATION_EXCHANGES = 20;

async function fetchConversationHistory(
  agentSessionId: string,
  linearClient: LinearClient,
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 5; // Safety limit to avoid infinite pagination

  do {
    const result = await linearClient.fetchSessionActivities(agentSessionId, {
      after: cursor,
    });

    for (const activity of result.activities) {
      if (activity.type === 'Prompt' && activity.body) {
        messages.push({ role: 'user', content: activity.body });
      } else if (activity.type === 'Response' && activity.body) {
        messages.push({ role: 'assistant', content: activity.body });
      }
    }

    cursor = result.hasNextPage ? result.endCursor : undefined;
    pages++;
  } while (cursor && pages < maxPages);

  // Cap at last N exchanges to avoid prompt overflow
  if (messages.length > MAX_CONVERSATION_EXCHANGES * 2) {
    return messages.slice(-(MAX_CONVERSATION_EXCHANGES * 2));
  }
  return messages;
}
