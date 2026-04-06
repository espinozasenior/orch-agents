/**
 * Execution Engine.
 *
 * Subscribes to IntakeCompleted events and orchestrates execution via SimpleExecutor.
 * Reads template and agent list directly from WorkflowConfig (WORKFLOW.md).
 * No planning layer, no SPARC phases, no topology selection.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowPlan, PlannedAgent } from '../../types';
import { createTask, TaskType } from '../task/index';
import type { EventBus } from '../../shared/event-bus';
import type { Logger } from '../../shared/logger';
import { createDomainEvent } from '../../shared/event-bus';
import type { SimpleExecutor } from '../simple-executor';
import type { LocalAgentTaskExecutor } from '../../tasks/local-agent';
import type { WorkflowConfig } from '../../integration/linear/workflow-parser';
import { createWorkTracker } from './work-tracker';
import type { GitHubClient } from '../../integration/github-client';
import type { LinearClient } from '../../integration/linear/linear-client';
import type { CancellationController } from '../runtime/cancellation-controller';
import { formatAgentComment, getBotName } from '../../shared/agent-identity';
import { buildWorkpadComment, postOrUpdateWorkpad } from '../../integration/linear/workpad-reporter';

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export interface ExecutionEngineDeps {
  eventBus: EventBus;
  logger: Logger;
  simpleExecutor: SimpleExecutor;
  /**
   * CC-aligned coordinator dispatch path. Wired to the AgentPrompted handler
   * (Linear comment / agent-session prompt). The IntakeCompleted handler
   * keeps using simpleExecutor for the legacy template-driven multi-agent
   * path. See src/tasks/local-agent/LocalAgentTask.ts.
   */
  localAgentTask: LocalAgentTaskExecutor;
  workflowConfig: WorkflowConfig;
  githubClient?: GitHubClient;
  linearClient?: LinearClient;
  cancellationController?: CancellationController;
  linearExecutionMode?: 'generic' | 'symphony';
}

/**
 * Start the execution engine: subscribe to IntakeCompleted,
 * resolve template from WorkflowConfig, run agents via SimpleExecutor,
 * publish WorkCompleted/WorkFailed.
 * Returns an unsubscribe function for cleanup.
 */
export function startExecutionEngine(deps: ExecutionEngineDeps): () => void {
  const { eventBus, logger, simpleExecutor, localAgentTask, workflowConfig } = deps;
  const tracker = createWorkTracker();
  const unsubscribers: Array<() => void> = [];

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

    // Resolve template name from intake metadata or default
    const templateName = (intakeEvent.sourceMetadata?.template as string)
      ?? workflowConfig.agents.defaultTemplate;

    // Look up agent types from WORKFLOW.md templates
    const agentTypes = workflowConfig.templates[templateName]
      ?? workflowConfig.templates[workflowConfig.agents.defaultTemplate];

    // 9F: Use typed task ID instead of raw UUID — type extractable from prefix
    const task = createTask(TaskType.local_agent);
    const planId = task.id;
    let agentTeam: PlannedAgent[];
    let useCoordinatorMode = false;

    if (agentTypes && agentTypes.length > 0) {
      // Template matched — validate agent paths exist
      const validAgents = agentTypes.filter((agentPath) => {
        if (!existsSync(resolve(process.cwd(), agentPath))) {
          logger.warn('Agent path missing, skipping', { agentPath, templateName });
          return false;
        }
        return true;
      });

      if (validAgents.length > 0) {
        agentTeam = validAgents.map((agentPath) => ({
          role: agentPath.replace(/^.*\//, '').replace(/\.md$/, ''),
          type: agentPath,
          tier: 2 as const,
          required: true,
        }));
      } else {
        // All agents missing — fall back to coordinator mode
        useCoordinatorMode = true;
        agentTeam = [{ role: 'coordinator', type: 'coordinator', tier: 2 as const, required: true }];
        logger.warn('No valid agents in template, falling back to coordinator mode', { templateName });
      }
    } else {
      // No template match — invoke Claude Code in coordinator mode (P2).
      // The coordinator decides how to approach the task: research, implement,
      // verify — spawning its own workers as needed via the 4-phase workflow.
      useCoordinatorMode = true;
      agentTeam = [{ role: 'coordinator', type: 'coordinator', tier: 2 as const, required: true }];
      logger.info('No template matched, using Claude Code coordinator mode', { templateName });
    }

    const plan: WorkflowPlan = {
      id: planId,
      workItemId: intakeEvent.id,
      template: templateName,
      agentTeam,
      maxAgents: workflowConfig.agents.maxConcurrent,
      methodology: useCoordinatorMode ? 'coordinator' : undefined,
    };

    logger.info('Executing work item', {
      planId,
      workItemId: executionKey,
      template: templateName,
      agents: agentTypes,
      correlationId,
    });

    tracker.start(planId, executionKey);

    eventBus.publish(
      createDomainEvent('PlanCreated', {
        workflowPlan: plan,
        intakeEvent,
      }, correlationId),
    );

    if (deps.linearClient && intakeEvent.sourceMetadata?.linearIssueId) {
      const issueId = intakeEvent.sourceMetadata.linearIssueId as string;
      await moveLinearIssueToInProgress(deps.linearClient, issueId, logger);
      await postOrUpdateWorkpad(
        deps.linearClient,
        issueId,
        buildWorkpadComment({
          planId,
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
          `**${botName}** is working on this...\n\nTemplate: \`${templateName}\` | Agents: ${agentTypes.join(', ')}`,
        ),
      ).catch((err: unknown) => logger.warn('AIG instant feedback failed', { error: String(err) }));
    }

    try {
      const result = await simpleExecutor.execute(plan, intakeEvent);

      tracker.complete(planId);

      if (result.status === 'failed') {
        const reason = `All agents failed for plan ${planId}`;
        tracker.fail(planId, reason);
        eventBus.publish(
          createDomainEvent('WorkFailed', {
            workItemId: executionKey,
            failureReason: reason,
            retryCount: 0,
          }, correlationId),
        );
        return;
      }

      eventBus.publish(
        createDomainEvent('WorkCompleted', {
          workItemId: executionKey,
          planId,
          phaseCount: result.agentResults.length,
          totalDuration: result.totalDuration,
        }, correlationId),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      tracker.fail(planId, reason);

      logger.error('SimpleExecutor error', { planId, error: reason });

      eventBus.publish(
        createDomainEvent('WorkFailed', {
          workItemId: executionKey,
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
    const planId = promptTask.id;
    const plan: WorkflowPlan = {
      id: planId,
      workItemId: issueId,
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
      sourceMetadata: { agentSessionId, linearIssueId: issueId },
      intent: 'custom:linear-prompted' as const,
      entities: { requirementId: issueId, labels: [] as string[] },
      rawText: rawTextParts.join('\n'),
    };

    logger.info('AgentPrompted → coordinator execution', {
      planId, issueId, correlationId,
      bodyPreview: body.slice(0, 100),
    });

    tracker.start(planId, executionKey);

    try {
      // CC-aligned dispatch: AgentPrompted always runs in coordinator mode.
      // Routes through LocalAgentTask (src/tasks/local-agent/) instead of
      // the legacy SimpleExecutor path used by IntakeCompleted.
      const result = await localAgentTask.execute(plan, intakeEvent);
      tracker.complete(planId);

      if (result.status === 'failed') {
        tracker.fail(planId, 'Coordinator session failed');
        eventBus.publish(createDomainEvent('WorkFailed', {
          workItemId: executionKey,
          failureReason: 'Coordinator session failed',
          retryCount: 0,
        }, correlationId));
      } else {
        eventBus.publish(createDomainEvent('WorkCompleted', {
          workItemId: executionKey,
          planId,
          phaseCount: 1,
          totalDuration: result.totalDuration,
        }, correlationId));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      tracker.fail(planId, reason);
      logger.error('AgentPrompted coordinator error', { planId, error: reason });
      eventBus.publish(createDomainEvent('WorkFailed', {
        workItemId: executionKey,
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

function getExecutionKey(intakeEvent: { source: string; id: string; sourceMetadata?: Record<string, unknown> }): string {
  if (intakeEvent.source === 'linear' && typeof intakeEvent.sourceMetadata?.linearIssueId === 'string') {
    return `linear:${intakeEvent.sourceMetadata.linearIssueId}`;
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
