import type { IntakeEvent, WorkflowPlan, WorktreeHandle } from '../../types';
import type { WorkflowConfig } from '../../integration/linear/workflow-parser';
import type { LinearClient, LinearIssueResponse } from '../../integration/linear/linear-client';
import type { AgentPlanStep } from '../../integration/linear/types';
import { createTask, TaskType, TaskStatus } from '../task';
import type { TaskRegistry } from '../task';
import { planId as pId, workItemId as wId, linearIssueId as lId } from '../../shared/branded-types';

// ---------------------------------------------------------------------------
// Phase 7F: Plan step definitions
// ---------------------------------------------------------------------------

// Coordinator-mode plan steps reflect the CC-canonical 4-phase workflow
// (Research → Synthesis → Implementation → Verification). The lifecycle
// fires step transitions as the issue progresses through active states.
export const PLAN_STEPS = [
  'Research and analyze issue',
  'Synthesize approach',
  'Implement and verify changes',
  'Commit, push, and open PR',
] as const;

// ---------------------------------------------------------------------------
// Phase 7F: Worker inbound message types
// ---------------------------------------------------------------------------

export type WorkerInboundMessage =
  | { type: 'prompted'; body: string; agentSessionId: string }
  | { type: 'stop'; reason: string };

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
    prUrl?: string;
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
  /** Optional Linear client for delegate/state management (Phase 7H). */
  linearClient?: LinearClient;
  /** Optional agent session ID for terminal activities (Phase 7H). */
  agentSessionId?: string;
  /** Optional agent app user ID for delegate assignment (Phase 7H). */
  agentAppUserId?: string;
  /** Optional logger for best-effort warnings (Phase 7H). */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** Optional queue of pending prompted messages from orchestrator (Phase 7F). */
  pendingPrompts?: string[];
  /** P6 (FR-P6-008): Optional task registry for backbone tracking. */
  taskRegistry?: TaskRegistry;
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
  prUrl?: string;
}

export async function runIssueWorkerLifecycle(
  deps: IssueWorkerLifecycleDeps,
): Promise<IssueWorkerLifecycleResult> {
  // Option C step 2b (PR B): coordinator-only dispatch via LocalAgentTask.
  // Templates from WORKFLOW.md are no longer consulted — every issue runs
  // through the coordinator's decide-at-runtime model. The template metadata
  // field on the plan is preserved as 'coordinator' for downstream
  // observability and parity with the main-thread engine (PR A).
  const templateName = 'coordinator';
  const plan: WorkflowPlan = {
    id: pId(sanitizePlanId(deps.issue.id)),
    workItemId: wId(deps.issue.identifier),
    template: templateName,
    promptTemplate: deps.workflowConfig.promptTemplate,
    maxAgents: deps.workflowConfig.agent.maxConcurrentAgents,
    agentTeam: [{ role: 'coordinator', type: 'coordinator', tier: 2 as const, required: true }],
    methodology: 'coordinator',
  };

  // Phase 7H: Best-effort setup — set delegate and move to started state
  await setupIssueForExecution(deps.linearClient, deps.issue, deps.agentAppUserId, deps.logger);

  // Phase 7F: Build updateAgentPlan helper scoped to this lifecycle
  const updateAgentPlan = buildPlanUpdater(deps.linearClient, deps.agentSessionId, deps.logger);

  // Phase 7F (FR-7F.08, FR-7F.09): Reconstruct conversation history from prior activities
  const conversationHistory = await reconstructConversationHistory(
    deps.linearClient, deps.agentSessionId, deps.logger,
  );

  // Phase 7F: Mark first step as inProgress
  await updateAgentPlan(0, 'inProgress');

  const handle = await deps.acquireWorkspace(plan.id);

  const startedAt = Date.now();
  let workpadCommentId: string | undefined;
  let continuationCount = 0;
  let currentIssue = deps.issue;
  let finalStatus: IssueWorkerLifecycleResult['status'] = 'failed';
  let lastPrUrl: string | undefined;
  let conversationHistoryInjected = false;

  try {
    while ((deps.workflowConfig.tracker?.activeStates ?? []).includes(currentIssue.state.name)) {
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

      // Phase 7F (FR-7F.09): Inject conversation history into first turn
      if (conversationHistory && !conversationHistoryInjected) {
        conversationHistoryInjected = true;
        intakeEvent.rawText = intakeEvent.rawText
          ? `${intakeEvent.rawText}\n\n---\nPrior conversation history:\n${conversationHistory}`
          : conversationHistory;
      }

      // Phase 7F (FR-7F.06): Inject pending prompted messages into context
      if (deps.pendingPrompts && deps.pendingPrompts.length > 0) {
        const promptedContext = deps.pendingPrompts.splice(0).join('\n\n');
        intakeEvent.rawText = intakeEvent.rawText
          ? `${intakeEvent.rawText}\n\n---\nAdditional context from prompted messages:\n${promptedContext}`
          : promptedContext;
      }

      // Phase 7F: Step 1 (Implement) inProgress
      await updateAgentPlan(1, 'inProgress');

      // P6 (FR-P6-008): Create task for backbone tracking before dispatch
      const turnTask = createTask(TaskType.local_agent);
      if (deps.taskRegistry) {
        deps.taskRegistry.register(turnTask);
        Object.assign(turnTask, { status: TaskStatus.running, updatedAt: Date.now(), startedAt: Date.now() });
        deps.taskRegistry.update(turnTask.id, turnTask);
      }

      const result = await deps.executeTurn(plan, intakeEvent, handle);

      // P6: Transition task to terminal state based on result
      if (deps.taskRegistry) {
        const terminalStatus = result.status === 'failed' ? TaskStatus.failed : TaskStatus.completed;
        Object.assign(turnTask, { status: terminalStatus, updatedAt: Date.now(), completedAt: Date.now() });
        deps.taskRegistry.update(turnTask.id, turnTask);
      }
      lastPrUrl = result.prUrl ?? lastPrUrl;

      if (result.status === 'failed') {
        // Phase 7F: Mark current step and remaining as canceled
        await updateAgentPlan(1, 'canceled');

        workpadCommentId = await deps.updateWorkpad({
          issue: currentIssue,
          plan,
          currentCommentId: workpadCommentId,
          workspacePath: handle.path,
          status: 'failed',
          continuationCount,
        });

        finalStatus = 'failed';
        // Phase 7H: Emit error activity on failure
        await emitTerminalActivity(deps.linearClient, deps.agentSessionId, 'error',
          `Execution failed for ${deps.issue.identifier}`, deps.logger);
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

      // Coordinator: implement+verify done → commit/push/PR inProgress
      await updateAgentPlan(2, 'inProgress');

      currentIssue = await deps.fetchIssue(currentIssue.id);

      await updateAgentPlan(3, 'inProgress');

      if ((deps.workflowConfig.tracker?.terminalStates ?? []).includes(currentIssue.state.name)) {

        workpadCommentId = await deps.updateWorkpad({
          issue: currentIssue,
          plan,
          currentCommentId: workpadCommentId,
          workspacePath: handle.path,
          status: 'completed',
          continuationCount,
        });

        // All coordinator steps completed
        await updateAgentPlan(3, 'completed');

        // Phase 7F (FR-7F.04): Link PR URL to session
        await linkPrUrl(deps.linearClient, deps.agentSessionId, lastPrUrl, deps.logger);

        finalStatus = 'completed';
        // Phase 7H: Emit response activity on completion
        await emitTerminalActivity(deps.linearClient, deps.agentSessionId, 'response',
          `Completed work on ${deps.issue.identifier} after ${continuationCount + 1} turn(s)`, deps.logger);
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
          prUrl: lastPrUrl,
        };
      }

      if (!(deps.workflowConfig.tracker?.activeStates ?? []).includes(currentIssue.state.name)) {
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

// ---------------------------------------------------------------------------
// Phase 7F: Plan update helpers
// ---------------------------------------------------------------------------

/**
 * Build a plan updater function scoped to a specific session.
 * Returns a function that updates the plan steps in Linear with retry.
 */
function buildPlanUpdater(
  linearClient: LinearClient | undefined,
  agentSessionId: string | undefined,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): (stepIndex: number, status: AgentPlanStep['status']) => Promise<void> {
  return async (stepIndex: number, status: AgentPlanStep['status']): Promise<void> => {
    if (!linearClient || !agentSessionId) return;

    const planSteps: AgentPlanStep[] = PLAN_STEPS.map((content, i) => ({
      content,
      status:
        i < stepIndex ? 'completed' as const :
        i === stepIndex ? status :
        status === 'canceled' ? 'canceled' as const : 'pending' as const,
    }));

    await retryPlanUpdate(linearClient, agentSessionId, { plan: planSteps }, logger);
  };
}

/**
 * Best-effort plan update with one retry on failure (FR-7F.07).
 * First call fails -> wait 1s -> retry once -> on failure, log and continue.
 */
async function retryPlanUpdate(
  linearClient: LinearClient,
  agentSessionId: string,
  updates: { plan?: AgentPlanStep[]; addedExternalUrls?: Array<{ label: string; url: string }> },
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await linearClient.agentSessionUpdate(agentSessionId, updates);
  } catch {
    // Retry once after 1s delay
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await linearClient.agentSessionUpdate(agentSessionId, updates);
    } catch (retryErr) {
      logger?.warn('Plan update failed after retry', {
        agentSessionId,
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }
  }
}

/**
 * Link a PR URL to the agent session's external URLs (FR-7F.04).
 */
async function linkPrUrl(
  linearClient: LinearClient | undefined,
  agentSessionId: string | undefined,
  prUrl: string | undefined,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (!linearClient || !agentSessionId || !prUrl) return;

  try {
    await linearClient.agentSessionUpdate(agentSessionId, {
      addedExternalUrls: [{ label: 'Pull Request', url: prUrl }],
    });
  } catch (err) {
    logger?.warn('Failed to link PR URL to agent session', {
      agentSessionId,
      prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reconstruct conversation history from prior Agent Activities (FR-7F.08, FR-7F.09).
 * Fetches Prompt + Response activities from the session for context continuity.
 */
async function reconstructConversationHistory(
  linearClient: LinearClient | undefined,
  agentSessionId: string | undefined,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<string | undefined> {
  if (!linearClient || !agentSessionId) return undefined;

  try {
    const result = await linearClient.fetchSessionActivities(agentSessionId);
    const relevantActivities = result.activities.filter(
      (a) => a.type === 'prompt' || a.type === 'response',
    );

    if (relevantActivities.length === 0) return undefined;

    return relevantActivities
      .map((a) => `[${a.type}]: ${a.body ?? ''}`)
      .join('\n\n');
  } catch (err) {
    logger?.warn('Failed to reconstruct conversation history', {
      agentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 7G: Agent signal elicitation helpers
// ---------------------------------------------------------------------------

/**
 * Emit an auth elicitation activity (FR-7G.02, FR-7G.05).
 * Renders a "Link account" button in the Linear UI with the given OAuth URL.
 */
export async function emitAuthElicitation(
  linearClient: LinearClient | undefined,
  sessionId: string | undefined,
  authUrl: string,
  providerName: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (!linearClient || !sessionId) return;

  try {
    await linearClient.createAgentActivity(sessionId, {
      type: 'elicitation',
      body: `Please link your ${providerName} account to continue.`,
    }, {
      signal: 'auth',
      signalMetadata: {
        url: authUrl,
        providerName,
      },
    });
  } catch (err) {
    logger?.warn('Failed to emit auth elicitation', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Emit a select elicitation activity (FR-7G.03, FR-7G.06).
 * Renders option buttons in the Linear UI for multi-choice selection.
 */
export async function emitSelectElicitation(
  linearClient: LinearClient | undefined,
  sessionId: string | undefined,
  question: string,
  options: Array<{ label: string; value: string }>,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (!linearClient || !sessionId) return;

  try {
    await linearClient.createAgentActivity(sessionId, {
      type: 'elicitation',
      body: question,
    }, {
      signal: 'select',
      signalMetadata: { options },
    });
  } catch (err) {
    logger?.warn('Failed to emit select elicitation', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
      source: 'linear',
      linearIssueId: lId(issue.id),
      linearIdentifier: issue.identifier,
      linearTitle: issue.title,
      linearState: issue.state.name,
      linearTeamId: issue.team?.id,
      linearTeamKey: issue.team?.key,
      attempt,
      template: templateName,
      intent: 'custom:linear-issue',
    },
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

// ---------------------------------------------------------------------------
// Phase 7H: Issue delegate + state management
// ---------------------------------------------------------------------------

/**
 * Best-effort setup: set delegate and move to first started state.
 * All calls are wrapped in try/catch so failures never block execution.
 */
export async function setupIssueForExecution(
  linearClient: LinearClient | undefined,
  issue: LinearIssueResponse,
  agentAppUserId: string | undefined,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (!linearClient) return;

  // 1. Set delegate if not already set (FR-7H.01, FR-7H.06)
  if (!issue.delegate && agentAppUserId) {
    try {
      await linearClient.issueUpdate(issue.id, { delegateId: agentAppUserId });
    } catch (err) {
      logger?.warn('Failed to set delegate on issue', {
        issueId: issue.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Move to first started state if not already started/completed/canceled (FR-7H.02, FR-7H.05)
  const stateType = issue.state.type;
  if (stateType && ['started', 'completed', 'canceled'].includes(stateType)) {
    return;
  }

  if (!issue.team?.id) {
    return;
  }

  try {
    const states = await linearClient.fetchTeamStates(issue.team.id);
    const startedStates = states
      .filter((s) => s.type === 'started')
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const firstStarted = startedStates[0];
    if (firstStarted) {
      await linearClient.updateIssueState(issue.id, firstStarted.id);
    }
  } catch (err) {
    logger?.warn('Failed to move issue to started state', {
      issueId: issue.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort terminal activity emission (FR-7H.03, FR-7H.04).
 * Emits a response or error activity at lifecycle end.
 */
export async function emitTerminalActivity(
  linearClient: LinearClient | undefined,
  agentSessionId: string | undefined,
  type: 'response' | 'error',
  body: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (!linearClient || !agentSessionId) return;

  try {
    await linearClient.createAgentActivity(agentSessionId, { type, body });
  } catch (err) {
    logger?.warn(`Failed to emit terminal ${type} activity`, {
      agentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
