import type { IntakeEvent, PlannedAgent, WorkflowPlan, WorktreeHandle } from '../../types';
import type { WorkflowConfig } from '../../integration/linear/workflow-parser';
import type { LinearIssueResponse } from '../../integration/linear/linear-client';

export interface IssueWorkerLifecycleDeps {
  issue: LinearIssueResponse;
  attempt: number;
  workflowConfig: WorkflowConfig;
  acquireWorkspace(planId: string): Promise<WorktreeHandle>;
  releaseWorkspace(handle: WorktreeHandle, status: IssueWorkerLifecycleResult['status']): Promise<void>;
  executeTurn(plan: WorkflowPlan, intakeEvent: IntakeEvent, handle: WorktreeHandle): Promise<{
    status: 'completed' | 'failed' | 'partial';
    totalDuration: number;
    sessionId?: string;
    lastActivityAt?: string;
    continuationState?: import('../runtime/task-executor').TaskExecutionResult['continuationState'];
    tokenUsage?: import('../runtime/task-executor').TaskExecutionResult['tokenUsage'];
  }>;
  fetchIssue(issueId: string): Promise<LinearIssueResponse>;
  updateWorkpad(params: {
    issue: LinearIssueResponse;
    plan: WorkflowPlan;
    currentCommentId?: string;
    workspacePath: string;
    status: 'active' | 'completed' | 'failed' | 'paused';
    continuationCount: number;
  }): Promise<string | undefined>;
  defaultRepo?: string;
  defaultBranch?: string;
}

export interface IssueWorkerLifecycleResult {
  status: 'completed' | 'failed' | 'paused';
  totalDuration: number;
  continuationCount: number;
  workspacePath: string;
  workpadCommentId?: string;
  sessionId?: string;
  lastActivityAt?: string;
  continuationState?: import('../runtime/task-executor').TaskExecutionResult['continuationState'];
  tokenUsage?: import('../runtime/task-executor').TaskExecutionResult['tokenUsage'];
}

export async function runIssueWorkerLifecycle(
  deps: IssueWorkerLifecycleDeps,
): Promise<IssueWorkerLifecycleResult> {
  const templateName = selectTemplateForIssue(deps.issue, deps.workflowConfig);
  const template = deps.workflowConfig.templates[templateName]
    ?? deps.workflowConfig.templates[deps.workflowConfig.agents.defaultTemplate]
    ?? [];

  if (template.length === 0) {
    throw new Error(`No agents configured for template "${templateName}"`);
  }

  const plan = buildWorkflowPlan(deps.issue, deps.workflowConfig, templateName, template);
  const handle = await deps.acquireWorkspace(plan.id);

  const startedAt = Date.now();
  let workpadCommentId: string | undefined;
  let continuationCount = 0;
  let currentIssue = deps.issue;
  let finalStatus: IssueWorkerLifecycleResult['status'] = 'failed';

  try {
    while (deps.workflowConfig.tracker.activeStates.includes(currentIssue.state.name)) {
      workpadCommentId = await deps.updateWorkpad({
        issue: currentIssue,
        plan,
        currentCommentId: workpadCommentId,
        workspacePath: handle.path,
        status: 'active',
        continuationCount,
      });

      const intakeEvent = buildIntakeEvent({
        issue: currentIssue,
        templateName,
        attempt: deps.attempt + continuationCount,
        defaultRepo: deps.defaultRepo,
        defaultBranch: deps.defaultBranch,
      });

      const result = await deps.executeTurn(plan, intakeEvent, handle);
      if (result.status === 'failed') {
        workpadCommentId = await deps.updateWorkpad({
          issue: currentIssue,
          plan,
          currentCommentId: workpadCommentId,
          workspacePath: handle.path,
          status: 'failed',
          continuationCount,
        });

        finalStatus = 'failed';
        return {
          status: 'failed',
          totalDuration: Date.now() - startedAt,
          continuationCount,
          workspacePath: handle.path,
          workpadCommentId,
          sessionId: result.sessionId,
          lastActivityAt: result.lastActivityAt,
          continuationState: result.continuationState,
          tokenUsage: result.tokenUsage,
        };
      }

      currentIssue = await deps.fetchIssue(currentIssue.id);
      if (deps.workflowConfig.tracker.terminalStates.includes(currentIssue.state.name)) {
        workpadCommentId = await deps.updateWorkpad({
          issue: currentIssue,
          plan,
          currentCommentId: workpadCommentId,
          workspacePath: handle.path,
          status: 'completed',
          continuationCount,
        });

        finalStatus = 'completed';
        return {
          status: 'completed',
          totalDuration: Date.now() - startedAt,
          continuationCount,
          workspacePath: handle.path,
          workpadCommentId,
          sessionId: result.sessionId,
          lastActivityAt: result.lastActivityAt,
          continuationState: result.continuationState,
          tokenUsage: result.tokenUsage,
        };
      }

      if (!deps.workflowConfig.tracker.activeStates.includes(currentIssue.state.name)) {
        workpadCommentId = await deps.updateWorkpad({
          issue: currentIssue,
          plan,
          currentCommentId: workpadCommentId,
          workspacePath: handle.path,
          status: 'paused',
          continuationCount,
        });

        finalStatus = 'paused';
        return {
          status: 'paused',
          totalDuration: Date.now() - startedAt,
          continuationCount,
          workspacePath: handle.path,
          workpadCommentId,
          sessionId: result.sessionId,
          lastActivityAt: result.lastActivityAt,
          continuationState: result.continuationState,
          tokenUsage: result.tokenUsage,
        };
      }

      continuationCount += 1;
    }

    finalStatus = 'paused';
    return {
      status: 'paused',
      totalDuration: Date.now() - startedAt,
      continuationCount,
      workspacePath: handle.path,
      workpadCommentId,
    };
  } finally {
    await deps.releaseWorkspace(handle, finalStatus).catch(() => {});
  }
}

export function buildWorkflowPlan(
  issue: LinearIssueResponse,
  workflowConfig: WorkflowConfig,
  templateName: string,
  template: string[],
): WorkflowPlan {
  return {
    id: sanitizePlanId(issue.id),
    workItemId: issue.identifier,
    template: templateName,
    promptTemplate: workflowConfig.promptTemplate,
    maxAgents: workflowConfig.agent.maxConcurrentAgents,
    agentTeam: template.map((agentPath): PlannedAgent => ({
      role: agentPath.replace(/^.*\//, '').replace(/\.md$/, ''),
      type: agentPath,
      tier: 2,
      required: true,
    })),
  };
}

export function buildIntakeEvent(params: {
  issue: LinearIssueResponse;
  templateName: string;
  attempt: number;
  defaultRepo?: string;
  defaultBranch?: string;
}): IntakeEvent {
  const { issue, templateName, attempt, defaultRepo, defaultBranch } = params;
  return {
    id: issue.id,
    timestamp: new Date().toISOString(),
    source: 'linear',
    sourceMetadata: {
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      linearTitle: issue.title,
      linearState: issue.state.name,
      linearTeamId: issue.team?.id,
      linearTeamKey: issue.team?.key,
      attempt,
      template: templateName,
    },
    intent: 'custom:linear-issue',
    entities: {
      repo: defaultRepo,
      branch: defaultBranch ?? 'main',
      labels: issue.labels.nodes.map((label) => label.name),
      requirementId: issue.identifier,
      projectId: issue.project?.id,
    },
    rawText: buildIssueDescription(issue),
  };
}

export function selectTemplateForIssue(issue: LinearIssueResponse, workflowConfig: WorkflowConfig): string {
  for (const label of issue.labels.nodes) {
    const mapped = workflowConfig.agents.routing[label.name.toLowerCase()];
    if (mapped) {
      return mapped;
    }
  }
  return workflowConfig.agents.defaultTemplate;
}

export function buildIssueDescription(issue: LinearIssueResponse): string {
  const description = issue.description?.trim();
  if (description) {
    return description;
  }
  return `${issue.identifier}: ${issue.title}`;
}

export function sanitizePlanId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}
