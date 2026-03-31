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
import { createOAuthTokenStore } from '../../integration/linear/oauth-token-store';
import { createSimpleExecutor } from '../simple-executor';
import { createWorktreeManager } from '../workspace/worktree-manager';
import { createArtifactApplier } from '../workspace/artifact-applier';
import { createSdkExecutor } from '../runtime/sdk-executor';
import { getDefaultRegistry } from '../../agent-registry/agent-registry';
import { createGitHubClient } from '../../integration/github-client';
import { createGitHubAppTokenProvider } from '../../integration/github-app-auth';
import { buildWorkpadComment, syncPersistentWorkpadComment } from '../../integration/linear/workpad-reporter';
import { runIssueWorkerLifecycle } from './issue-worker-runner';
import type { WorkerInboundMessage } from './issue-worker-runner';
import type { WorkpadState } from '../../integration/linear/types';

interface IssueWorkerData {
  issue: LinearIssueResponse;
  attempt: number;
  workflowConfig: WorkflowConfig;
  worktreeBasePath: string;
  defaultRepo?: string;
  defaultBranch?: string;
  /** Agent session ID for plan sync (Phase 7F). */
  agentSessionId?: string;
  /** Agent app user ID for delegate assignment (Phase 7H). */
  agentAppUserId?: string;
  /** OAuth credentials for Linear actor=app auth (optional). */
  oauthCredentials?: {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
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

  let linearClient: ReturnType<typeof createLinearClient> | undefined;
  if (data.oauthCredentials) {
    const tokenStore = createOAuthTokenStore({
      clientId: data.oauthCredentials.clientId,
      clientSecret: data.oauthCredentials.clientSecret,
      initialTokens: {
        accessToken: data.oauthCredentials.accessToken,
        refreshToken: data.oauthCredentials.refreshToken,
        expiresAt: data.oauthCredentials.expiresAt,
      },
      logger,
    });
    linearClient = createLinearClient({
      authStrategy: {
        mode: 'oauth',
        clientId: data.oauthCredentials.clientId,
        clientSecret: data.oauthCredentials.clientSecret,
        accessToken: data.oauthCredentials.accessToken,
        refreshToken: data.oauthCredentials.refreshToken,
        expiresAt: data.oauthCredentials.expiresAt,
      },
      tokenStore,
      logger,
    });
  } else if (data.workflowConfig.tracker.apiKey) {
    linearClient = createLinearClient({
      apiKey: data.workflowConfig.tracker.apiKey,
      logger,
    });
  }

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

  // Phase 7F: Inbound message channel — listen for prompted + stop messages
  const pendingPrompts: string[] = [];
  if (parentPort) {
    parentPort.on('message', (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const typed = msg as WorkerInboundMessage;
      if (typed.type === 'prompted' && 'body' in typed) {
        pendingPrompts.push(typed.body);
      } else if (typed.type === 'stop') {
        // Signal graceful stop — exit with code 0
        process.exit(0);
      }
    });
  }

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
    linearClient,
    agentSessionId: data.agentSessionId,
    agentAppUserId: data.agentAppUserId,
    pendingPrompts,
    logger,
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
