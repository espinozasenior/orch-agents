/**
 * Workpad reporter for Linear issues.
 *
 * Subscribes to domain events (PhaseStarted, PhaseCompleted, AgentSpawned,
 * AgentCompleted, WorkCompleted, WorkFailed) and builds/updates a structured
 * Markdown comment on the corresponding Linear issue.
 *
 * The Workpad comment is identified by an HTML marker (<!-- orch-agents-workpad -->)
 * and updated in-place via the Linear commentUpdate mutation.
 */

import type { EventBus } from '../../shared/event-bus';
import type { Logger } from '../../shared/logger';
import { formatDuration } from '../../shared/format';
import type { LinearClient } from './linear-client';
import type { WorkpadState } from './types';
import { getBotMarker, getBotName } from '../../shared/agent-identity';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkpadReporterDeps {
  eventBus: EventBus;
  logger: Logger;
  linearClient: LinearClient;
}

export interface WorkpadReporter {
  /** Start subscribing to events. */
  start(): void;
  /** Stop subscribing and clean up. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Workpad content builder
// ---------------------------------------------------------------------------

export const WORKPAD_MARKER = '<!-- orch-agents-workpad -->';

export function buildWorkpadComment(state: WorkpadState): string {
  const sections: string[] = [];

  sections.push('## Agent Workpad');
  sections.push(WORKPAD_MARKER);
  sections.push(`**Agent**: ${getBotName()} (agent) is working on this`);
  sections.push('');

  sections.push(`**Status**: ${state.currentPhase} (${state.status})`);
  sections.push(`**Elapsed**: ${formatDuration(state.elapsedMs)}`);
  sections.push(`**Plan ID**: \`${state.planId}\``);
  sections.push('');

  if (state.agents.length > 0) {
    sections.push('### Agent Roster');
    sections.push('| Role | Type | Status | Duration |');
    sections.push('|------|------|--------|----------|');
    for (const agent of state.agents) {
      sections.push(
        `| ${agent.role} | ${agent.type} | ${agent.status} | ${formatDuration(agent.durationMs)} |`,
      );
    }
    sections.push('');
  }

  sections.push('### Phase Progress');
  for (const phase of state.phases) {
    const checkmark = phase.status === 'completed' ? '[x]' : '[ ]';
    sections.push(`- ${checkmark} **${phase.type}**: ${phase.summary ?? 'pending'}`);
  }
  sections.push('');

  if (state.findings.length > 0) {
    sections.push('### Findings');
    for (const finding of state.findings) {
      sections.push(`- **${finding.severity}**: ${finding.message}`);
    }
    sections.push('');
  }

  sections.push('---');
  sections.push(`*Last updated: ${new Date().toISOString()}*`);
  sections.push(getBotMarker());

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Post or update workpad comment
// ---------------------------------------------------------------------------

export async function postOrUpdateWorkpad(
  linearClient: LinearClient,
  issueId: string,
  workpadContent: string,
  logger?: Logger,
): Promise<void> {
  await syncPersistentWorkpadComment(linearClient, issueId, workpadContent, undefined, logger);
}

export async function syncPersistentWorkpadComment(
  linearClient: Pick<LinearClient, 'fetchComments' | 'createComment' | 'updateComment'>,
  issueId: string,
  workpadContent: string,
  currentCommentId?: string,
  logger?: Logger,
): Promise<string | undefined> {
  try {
    if (currentCommentId) {
      await linearClient.updateComment(currentCommentId, workpadContent);
      return currentCommentId;
    }

    const comments = await linearClient.fetchComments(issueId);
    const existing = comments.find((c) => c.body.includes(WORKPAD_MARKER));

    if (existing) {
      await linearClient.updateComment(existing.id, workpadContent);
      return existing.id;
    } else {
      return await linearClient.createComment(issueId, workpadContent);
    }
  } catch (err) {
    logger?.error('Failed to post/update workpad', {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return currentCommentId;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkpadReporter(deps: WorkpadReporterDeps): WorkpadReporter {
  const { eventBus, logger, linearClient } = deps;
  const unsubscribers: Array<() => void> = [];

  // Track workpad state per plan (planId -> state)
  const workpadStates = new Map<string, WorkpadState>();
  // Map planId -> linearIssueId (set when IntakeCompleted has linear source)
  const planToIssue = new Map<string, string>();

  function getOrCreateState(planId: string): WorkpadState {
    let state = workpadStates.get(planId);
    if (!state) {
      state = {
        planId,
        linearIssueId: '',
        currentPhase: 'initializing',
        status: 'active',
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        agents: [],
        phases: [],
        findings: [],
      };
      workpadStates.set(planId, state);
    }
    return state;
  }

  async function updateWorkpad(planId: string): Promise<void> {
    const state = workpadStates.get(planId);
    const issueId = planToIssue.get(planId);
    if (!state || !issueId) return;

    state.linearIssueId = issueId;
    state.elapsedMs = Date.now() - Date.parse(state.startedAt);

    const content = buildWorkpadComment(state);
    await postOrUpdateWorkpad(linearClient, issueId, content, logger);
  }

  return {
    start() {
      // Track IntakeCompleted to map planId -> linearIssueId
      unsubscribers.push(
        eventBus.subscribe('IntakeCompleted', (event) => {
          const intake = event.payload.intakeEvent;
          if (intake.source === 'linear') {
            const issueId = intake.sourceMetadata.linearIssueId as string;
            if (issueId) {
              // We'll map this when PlanCreated arrives
              // Store temporarily by intake event id
              planToIssue.set(intake.id, issueId);
            }
          }
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('PlanCreated', (event) => {
          const plan = event.payload.workflowPlan;
          const intake = event.payload.intakeEvent;
          if (intake?.source === 'linear') {
            const issueId = intake.sourceMetadata.linearIssueId as string;
            if (issueId) {
              planToIssue.set(plan.id, issueId);
            }
          }
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('PhaseStarted', (event) => {
          const { planId, phaseType, agents } = event.payload;
          const state = getOrCreateState(planId);
          state.currentPhase = phaseType;
          state.status = 'active';
          state.phases.push({
            type: phaseType,
            status: 'active',
            summary: `Running with ${agents.length} agent(s)`,
          });
          void updateWorkpad(planId).catch((err) => {
            logger.error('Workpad update failed', {
              planId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('PhaseCompleted', (event) => {
          const result = event.payload.phaseResult;
          const state = getOrCreateState(result.planId);
          const phase = state.phases.find(
            (p) => p.type === result.phaseType && p.status === 'active',
          );
          if (phase) {
            phase.status = result.status === 'completed' ? 'completed' : 'failed';
            phase.summary = `${result.status} in ${result.metrics.duration}ms`;
          }
          void updateWorkpad(result.planId).catch((err) => {
            logger.error('Workpad update failed', {
              planId: result.planId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('AgentSpawned', (event) => {
          const { execId: _execId, planId, agentRole, agentType } = event.payload;
          const state = getOrCreateState(planId);
          state.agents.push({
            role: agentRole,
            type: agentType,
            status: 'running',
            durationMs: 0,
          });
          void updateWorkpad(planId).catch((err) => {
            logger.error('Workpad update failed', {
              planId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('AgentCompleted', (event) => {
          const { planId, agentRole, duration } = event.payload;
          const state = getOrCreateState(planId);
          const agent = state.agents.find(
            (a) => a.role === agentRole && a.status === 'running',
          );
          if (agent) {
            agent.status = 'completed';
            agent.durationMs = duration;
          }
          void updateWorkpad(planId).catch((err) => {
            logger.error('Workpad update failed', {
              planId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('WorkCompleted', (event) => {
          const { planId } = event.payload;
          const state = workpadStates.get(planId);
          if (state) {
            state.status = 'completed';
            state.currentPhase = 'done';
          }
          void updateWorkpad(planId).catch((err) => {
            logger.error('Workpad update failed', {
              planId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      );

      unsubscribers.push(
        eventBus.subscribe('WorkFailed', (event) => {
          const { workItemId } = event.payload;
          const state = workpadStates.get(workItemId);
          if (state) {
            state.status = 'failed';
          }
          void updateWorkpad(workItemId).catch((err) => {
            logger.error('Workpad update failed', {
              planId: workItemId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }),
      );
    },

    stop() {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
      workpadStates.clear();
      planToIssue.clear();
    },
  };
}
