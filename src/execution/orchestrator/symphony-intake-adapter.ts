/**
 * Symphony Intake Adapter (P9)
 *
 * Extracts the webhook-to-task-request conversion logic from
 * symphony-orchestrator into a pure function. This adapter retains
 * issue fetching, state filtering, and repo resolution but does NOT
 * spawn workers, manage retry/backoff, or track lifecycle.
 *
 * The coordinator session owns all dispatch decisions.
 */

import { randomUUID } from 'node:crypto';
import type { LinearClient, LinearIssueResponse } from '../../integration/linear/linear-client';
import type { WorkflowConfig } from '../../config';
import { resolveRepoForIssue } from './repo-resolver';
import type { CoordinatorTaskRequest } from '../../coordinator/types';
import type { Logger } from '../../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { CoordinatorTaskRequest };

export interface SymphonyIntakeAdapterDeps {
  linearClient: LinearClient;
  workflowConfig: WorkflowConfig;
  workflowConfigProvider?: () => WorkflowConfig;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SymphonyIntakeAdapter {
  /**
   * Convert a Linear issue into a CoordinatorTaskRequest.
   * Returns null if the issue is not eligible for dispatch.
   */
  processWebhookIssue(issue: LinearIssueResponse): Promise<CoordinatorTaskRequest | null>;
}

export function createSymphonyIntakeAdapter(
  deps: SymphonyIntakeAdapterDeps,
): SymphonyIntakeAdapter {
  const logger = deps.logger.child({ module: 'symphony-intake-adapter' });

  function getWorkflowConfig(): WorkflowConfig {
    return deps.workflowConfigProvider?.() ?? deps.workflowConfig;
  }

  return {
    async processWebhookIssue(
      issue: LinearIssueResponse,
    ): Promise<CoordinatorTaskRequest | null> {
      const workflowConfig = getWorkflowConfig();

      // State filtering: must be in an active state and not terminal
      if (!issue.id || !issue.identifier || !issue.title || !issue.state?.name) {
        return null;
      }
      if (!(workflowConfig.tracker?.activeStates ?? []).includes(issue.state.name)) {
        return null;
      }
      if ((workflowConfig.tracker?.terminalStates ?? []).includes(issue.state.name)) {
        return null;
      }

      // Repo resolution
      let repoConfig: CoordinatorTaskRequest['repoConfig'];
      if (Object.keys(workflowConfig.repos).length > 0) {
        try {
          const result = await resolveRepoForIssue(
            issue, workflowConfig.repos, deps.linearClient, undefined, logger,
          );
          if (result.status === 'pending') {
            logger.debug('Repo resolution pending; skipping intake', { issueId: issue.id });
            return null;
          }
          if (result.repo) {
            repoConfig = {
              name: result.repo.name,
              url: result.repo.url,
              defaultBranch: result.repo.defaultBranch,
            };
          }
        } catch (err) {
          logger.warn('Repo resolution failed during intake', {
            issueId: issue.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const description = issue.description?.trim()
        || `${issue.identifier}: ${issue.title}`;

      return {
        id: randomUUID(),
        source: 'linear-webhook',
        issueId: issue.id,
        issueData: {
          identifier: issue.identifier,
          title: issue.title,
          state: issue.state.name,
        },
        repoConfig,
        description,
        priority: issue.priority ?? 999,
      };
    },
  };
}
