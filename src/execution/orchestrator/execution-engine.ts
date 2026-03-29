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
import type { EventBus } from '../../shared/event-bus';
import type { Logger } from '../../shared/logger';
import { createDomainEvent } from '../../shared/event-bus';
import type { SimpleExecutor } from '../simple-executor';
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
  const { eventBus, logger, simpleExecutor, workflowConfig } = deps;
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
      ?? workflowConfig.templates[workflowConfig.agents.defaultTemplate]
      ?? ['coder'];

    // Validate all agent paths exist before building the plan
    for (const agentPath of agentTypes) {
      if (!existsSync(resolve(process.cwd(), agentPath))) {
        const reason = `Template '${templateName}' references missing agent: ${agentPath}`;
        logger.error(reason);
        eventBus.publish(
          createDomainEvent('WorkFailed', {
            workItemId: executionKey,
            failureReason: reason,
            retryCount: 0,
          }, correlationId),
        );
        return;
      }
    }

    // Build a simple plan from the template
    const planId = randomUUID();
    const agentTeam: PlannedAgent[] = agentTypes.map((agentPath) => ({
      role: agentPath.replace(/^.*\//, '').replace(/\.md$/, ''),
      type: agentPath,
      tier: 2 as const,
      required: true,
    }));

    const plan: WorkflowPlan = {
      id: planId,
      workItemId: intakeEvent.id,
      template: templateName,
      agentTeam,
      maxAgents: workflowConfig.agents.maxConcurrent,
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
