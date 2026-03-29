/**
 * Worker-thread entrypoint for a single Linear issue.
 *
 * Each worker owns the lifecycle of one issue: it keeps a persistent workspace,
 * updates one persistent workpad comment, and continues running until the issue
 * leaves active execution states.
 */

import process from 'node:process';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { createLogger } from '../../shared/logger';
import type { WorkflowConfig } from '../../integration/linear/workflow-parser';
import type { LinearIssueResponse } from '../../integration/linear/linear-client';
import { createLinearClient } from '../../integration/linear/linear-client';
import { createLinearToolBridge } from '../../integration/linear/linear-client';
import { createSimpleExecutor } from '../simple-executor';
import { createWorktreeManager } from '../workspace/worktree-manager';
import { createArtifactApplier } from '../workspace/artifact-applier';
import { createSdkExecutor } from '../runtime/sdk-executor';
import { getDefaultRegistry } from '../../agent-registry/agent-registry';
import { createGitHubClient } from '../../integration/github-client';
import { createGitHubAppTokenProvider } from '../../integration/github-app-auth';
import { buildWorkpadComment, syncPersistentWorkpadComment } from '../../integration/linear/workpad-reporter';
import { runIssueWorkerLifecycle } from './issue-worker-runner';
import type { WorkpadState } from '../../integration/linear/types';

interface IssueWorkerData {
  issue: LinearIssueResponse;
  attempt: number;
  workflowConfig: WorkflowConfig;
  worktreeBasePath: string;
  defaultRepo?: string;
  defaultBranch?: string;
}

async function main(): Promise<void> {
  const data = workerData as IssueWorkerData;
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | undefined) ?? 'info',
    name: 'issue-worker',
    bindings: {
      issueId: data.issue.id,
      issueIdentifier: data.issue.identifier,
    },
  });

  const linearClient = data.workflowConfig.tracker.apiKey
    ? createLinearClient({
      apiKey: data.workflowConfig.tracker.apiKey,
      logger,
    })
    : undefined;

  const githubClient = createWorkerGitHubClient(logger);
  const worktreeManager = createWorktreeManager({
    logger,
    basePath: data.worktreeBasePath,
  });
  const artifactApplier = createArtifactApplier({ logger });
  const interactiveExecutor = createSdkExecutor({
    logger,
    eventSink: (payload) => parentPort?.postMessage(payload),
    linearToolBridge: linearClient ? createLinearToolBridge(linearClient) : undefined,
  });

  const workerStartedAt = new Date().toISOString();
  const result = await runIssueWorkerLifecycle({
    issue: data.issue,
    attempt: data.attempt,
    workflowConfig: data.workflowConfig,
    acquireWorkspace: async (planId) => {
      const workspacePath = joinPath(data.worktreeBasePath, planId);
      if (existsSync(workspacePath)) {
        logger.info('Reusing persistent issue workspace', { planId, path: workspacePath });
        return {
          planId,
          path: workspacePath,
          branch: `issue/${planId}`,
          baseBranch: data.defaultBranch ?? 'main',
          status: 'active',
        };
      }

      return worktreeManager.create(
        planId,
        data.defaultBranch ?? 'main',
        `issue/${planId}`,
      );
    },
    releaseWorkspace: async (handle, status) => {
      if (status !== 'completed') {
        logger.info('Preserving issue workspace for future retries or resumes', {
          planId: handle.planId,
          path: handle.path,
          status,
        });
        return;
      }

      await worktreeManager.dispose(handle);
    },
    fetchIssue: async (issueId) => {
      if (!linearClient) {
        return data.issue;
      }
      return linearClient.fetchIssue(issueId);
    },
    updateWorkpad: async ({ issue, plan, currentCommentId, workspacePath, status, continuationCount }) => {
      if (!linearClient) {
        return currentCommentId;
      }

      const workpadState: WorkpadState = {
        planId: plan.id,
        linearIssueId: issue.id,
        currentPhase: issue.state.name,
        status,
        startedAt: workerStartedAt,
        elapsedMs: Math.max(0, Date.now() - Date.parse(workerStartedAt)),
        agents: plan.agentTeam.map((agent) => ({
          role: agent.role,
          type: agent.type,
          status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running',
          durationMs: 0,
        })),
        phases: [
          {
            type: 'refinement',
            status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'active',
            summary: `Continuation ${continuationCount + 1} in ${workspacePath}`,
          },
        ],
        findings: [],
      };

      return syncPersistentWorkpadComment(
        linearClient,
        issue.id,
        buildWorkpadComment(workpadState),
        currentCommentId,
        logger,
      );
    },
    executeTurn: async (plan, intakeEvent, handle) => {
      const persistentExecutor = createSimpleExecutor({
        interactiveExecutor,
        worktreeManager: {
          create: async () => handle,
          commit: worktreeManager.commit,
          push: worktreeManager.push,
          diff: worktreeManager.diff,
          dispose: async () => {},
        },
        artifactApplier,
        agentRegistry: getDefaultRegistry(),
        githubClient,
        logger,
        agentTimeoutMs: data.workflowConfig.agentRunner.turnTimeoutMs,
      });

      return persistentExecutor.execute(plan, intakeEvent);
    },
    defaultRepo: data.defaultRepo,
    defaultBranch: data.defaultBranch,
  });
  parentPort?.postMessage({
    type: 'completed',
    issueId: data.issue.id,
    status: result.status,
    totalDuration: result.totalDuration,
  });

  if (result.status === 'failed') {
    throw new Error(`Issue worker failed for ${data.issue.identifier}`);
  }
}

function createWorkerGitHubClient(logger: ReturnType<typeof createLogger>) {
  if (
    process.env.GITHUB_APP_ID
    && process.env.GITHUB_APP_PRIVATE_KEY_PATH
    && process.env.GITHUB_APP_INSTALLATION_ID
  ) {
    const tokenProvider = createGitHubAppTokenProvider({
      appId: process.env.GITHUB_APP_ID,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID,
      logger,
    });
    return createGitHubClient({ logger, tokenProvider });
  }

  if (process.env.GITHUB_TOKEN) {
    return createGitHubClient({ logger, token: process.env.GITHUB_TOKEN });
  }

  return undefined;
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    parentPort?.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  },
);
