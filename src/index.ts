/**
 * Application entry point for the Orch-Agents system.
 *
 * Wires together config, logger, event bus, processing pipeline,
 * and HTTP server.
 */

import { loadConfig } from './shared/config';
import { createLogger } from './shared/logger';
import { createEventBus } from './shared/event-bus';
import { buildServer } from './server';
import { startPipeline } from './pipeline';
import { createWorktreeManager } from './execution/workspace/worktree-manager';
import { createSdkExecutor } from './execution/runtime/sdk-executor';
import { createArtifactApplier } from './execution/workspace/artifact-applier';
import { createReviewGate, createStubDiffReviewer, createCliTestRunner, createPatternSecurityScanner } from './review/review-gate';
import { createClaudeDiffReviewer } from './review/claude-diff-reviewer';
import { createGitHubClient } from './integration/github-client';
import { createFixItLoop } from './execution/fix-it-loop';
import type { FixExecutor, FixReviewer, FixCommitter, FixPromptBuilder } from './execution/fix-it-loop';
import { buildFixPrompt } from './execution/prompt-builder';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import { createSimpleExecutor, type SimpleExecutor } from './execution/simple-executor';
import { createLocalAgentTaskExecutor, type LocalAgentTaskExecutor } from './tasks/local-agent';
import { getDefaultRegistry } from './agent-registry/agent-registry';
import type { WorkflowConfig } from './integration/linear/workflow-parser';
import { resolve as pathResolve } from 'node:path';
import { createGitHubAppTokenProvider, type GitHubTokenProvider } from './integration/github-app-auth';
import { setBotName } from './shared/agent-identity';
import { createLinearClient, type LinearAuthStrategy } from './integration/linear/linear-client';
import { createOAuthTokenStore, type OAuthTokenStore } from './integration/linear/oauth-token-store';
import { createSymphonyOrchestrator, type SymphonyOrchestrator } from './execution/orchestrator/symphony-orchestrator';
import { createCoordinatorSession } from './execution/runtime/coordinator-session';
import { createWorkpadReporter, type WorkpadReporter } from './integration/linear/workpad-reporter';
import { createWorkflowConfigStore } from './integration/linear/workflow-config-store';
import type { StatusSurfaceSnapshot } from './webhook-gateway/webhook-router';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'orch-agents' });
  const eventBus = createEventBus(logger);

  logger.info('Starting Orch-Agents', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
  });

  // Load WORKFLOW.md — the single source of truth for templates and routing.
  // Fail hard at startup if missing or invalid.
  const workflowMdPath = process.env.WORKFLOW_MD_PATH
    ?? pathResolve(process.cwd(), 'WORKFLOW.md');
  const workflowConfigStore = createWorkflowConfigStore({
    filePath: workflowMdPath,
    logger,
    watchFile: true,
  });
  workflowConfigStore.start();

  let workflowConfig: WorkflowConfig;
  try {
    workflowConfig = workflowConfigStore.requireConfig();
  } catch (err) {
    logger.fatal('Failed to load WORKFLOW.md — cannot start without it', {
      path: workflowMdPath,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // GitHub App authentication — prefer over PAT for bot identity
  let tokenProvider: GitHubTokenProvider | undefined;
  const effectiveGithubToken: string | undefined = config.githubToken || undefined;

  if ((config.githubAppId || config.githubAppPrivateKeyPath || config.githubAppInstallationId)
      && !(config.githubAppId && config.githubAppPrivateKeyPath && config.githubAppInstallationId)) {
    logger.warn('Partial GitHub App config detected — all 3 vars required (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID)', {
      hasAppId: !!config.githubAppId,
      hasPrivateKeyPath: !!config.githubAppPrivateKeyPath,
      hasInstallationId: !!config.githubAppInstallationId,
    });
  }

  if (config.githubAppId && config.githubAppPrivateKeyPath && config.githubAppInstallationId) {
    tokenProvider = createGitHubAppTokenProvider({
      appId: config.githubAppId,
      privateKeyPath: config.githubAppPrivateKeyPath,
      installationId: config.githubAppInstallationId,
      logger,
    });
    // Auto-resolve bot name from GitHub App slug (e.g., "automata-ai-bot[bot]")
    const slug = await tokenProvider.getAppSlug();
    const botLogin = `${slug}[bot]`;
    setBotName(botLogin);
    logger.info('GitHub App authentication enabled', { appId: config.githubAppId, botLogin });
  } else if (effectiveGithubToken) {
    logger.info('Using personal access token for GitHub');
  } else {
    logger.warn('No GitHub authentication configured');
  }

  // ── Build Linear auth strategy ──────────────────────────────
  let linearAuthStrategy: LinearAuthStrategy | undefined;
  let oauthTokenStore: OAuthTokenStore | undefined;
  let tokenPersistence: import('./integration/linear/oauth-token-persistence').OAuthTokenPersistence | undefined;

  // API key is always available for data queries (fetchIssues, etc.)
  // OAuth is layered on top for agent-specific mutations (activities, sessions)
  const linearApiKey = workflowConfig.tracker.apiKey ?? config.linearApiKey;

  if (config.linearAuthMode === 'oauth') {
    if (!config.linearClientId || !config.linearClientSecret) {
      logger.warn('OAuth mode requires LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET');
    } else {
      // Persistent token storage via SQLite — survives restarts
      const { createOAuthTokenPersistence } = require('./integration/linear/oauth-token-persistence');
      tokenPersistence = createOAuthTokenPersistence({
        dbPath: process.env.OAUTH_TOKEN_DB_PATH ?? './data/oauth-tokens.db',
        logger,
      });

      // Load saved tokens from last session
      const savedTokens = tokenPersistence!.load('default');

      oauthTokenStore = createOAuthTokenStore({
        clientId: config.linearClientId,
        clientSecret: config.linearClientSecret,
        initialTokens: savedTokens ?? undefined,
        logger,
        onTokenRefreshed: (tokens) => {
          // Persist to SQLite so they survive restarts
          tokenPersistence!.save('default', tokens);
          // Keep the strategy object in sync for worker thread seeding
          if (linearAuthStrategy && linearAuthStrategy.mode === 'oauth') {
            linearAuthStrategy.accessToken = tokens.accessToken;
            linearAuthStrategy.refreshToken = tokens.refreshToken;
            linearAuthStrategy.expiresAt = tokens.expiresAt;
          }
        },
      });
      linearAuthStrategy = {
        mode: 'oauth',
        clientId: config.linearClientId,
        clientSecret: config.linearClientSecret,
        accessToken: savedTokens?.accessToken ?? '',
        refreshToken: savedTokens?.refreshToken ?? '',
        expiresAt: savedTokens?.expiresAt ?? 0,
      };

      if (savedTokens) {
        logger.info('Linear OAuth tokens restored from persistence', {
          clientId: config.linearClientId,
          expiresAt: new Date(savedTokens.expiresAt).toISOString(),
        });
      } else {
        logger.info('Linear OAuth configured (no saved tokens — authorize via /oauth/authorize)', {
          clientId: config.linearClientId,
        });
      }
    }
  }

  // Fall back to API key if OAuth not configured or as the primary strategy
  if (!linearAuthStrategy && linearApiKey) {
    linearAuthStrategy = { mode: 'apiKey', apiKey: linearApiKey };
  }

  // Interactive agent execution (opt-in via ENABLE_INTERACTIVE_AGENTS)
  const useInteractiveAgents = process.env.ENABLE_INTERACTIVE_AGENTS === 'true';

  let simpleExecutor: SimpleExecutor | undefined;
  let localAgentTask: LocalAgentTaskExecutor | undefined;
  let reviewGate: ReturnType<typeof createReviewGate> | undefined;
  let symphonyOrchestrator: SymphonyOrchestrator | undefined;
  let workpadReporter: WorkpadReporter | undefined;
  let linearExecutionMode: 'generic' | 'symphony' = 'generic';

  if (useInteractiveAgents) {
    const execLogger = logger.child ? logger.child({ module: 'interactive' }) : logger;

    // Validate WORKTREE_BASE_PATH is absolute
    const worktreeBasePath = process.env.WORKTREE_BASE_PATH ?? '/tmp/orch-agents';
    if (!pathIsAbsolute(worktreeBasePath)) {
      throw new Error(`WORKTREE_BASE_PATH must be an absolute path, got: ${worktreeBasePath}`);
    }

    const parsedAttempts = parseInt(process.env.MAX_FIX_ATTEMPTS ?? '3', 10);
    const maxFixAttempts = (isNaN(parsedAttempts) || parsedAttempts < 1 || parsedAttempts > 10) ? 3 : parsedAttempts;

    const worktreeManager = createWorktreeManager({ logger: execLogger, basePath: worktreeBasePath });
    const baseExecutor = createSdkExecutor({
      logger: execLogger,
      // P11: pass eventBus so WorkCancelled domain events abort in-flight
      // SDK executions via the stop-hook → AbortController bridge.
      eventBus,
    });

    // Apply harness enhancements: P0 compaction + P3 budget + P1 query loop + P2 coordinator
    const { buildExecutor } = await import('./execution/runtime/executor-factory');
    const interactiveExecutor = buildExecutor({
      baseExecutor,
      logger: execLogger,
      contextWindowTokens: parseInt(process.env.CONTEXT_WINDOW_TOKENS ?? '200000', 10),
      tokenBudget: process.env.TOKEN_BUDGET ? parseInt(process.env.TOKEN_BUDGET, 10) : undefined,
      enableCompaction: process.env.ENABLE_COMPACTION !== 'false',
    });
    const artifactApplier = createArtifactApplier({ logger: execLogger });
    const linearClient = linearAuthStrategy
      ? createLinearClient({ apiKey: linearApiKey, authStrategy: linearAuthStrategy, tokenStore: oauthTokenStore, logger: execLogger })
      : undefined;

    const diffReviewer = config.enableClaudeDiffReview
      ? createClaudeDiffReviewer({ logger: execLogger })
      : createStubDiffReviewer();

    logger.info('DiffReviewer mode', {
      mode: config.enableClaudeDiffReview ? 'claude' : 'stub',
    });

    reviewGate = createReviewGate({
      diffReviewer,
      testRunner: createCliTestRunner({ logger: execLogger }),
      securityScanner: createPatternSecurityScanner({ logger: execLogger }),
      logger: execLogger,
    });

    // Adapt existing components to FixItLoop dependency interfaces
    const fixExecutor: FixExecutor = {
      async executeFix(worktreePath, prompt, timeout) {
        return interactiveExecutor.execute({
          prompt, worktreePath, agentRole: 'fixer', agentType: 'coder',
          tier: 3, phaseType: 'refinement', timeout, metadata: {},
        });
      },
    };

    const fixReviewer: FixReviewer = {
      async review(request) {
        return reviewGate!.review({
          planId: request.planId, workItemId: request.workItemId,
          commitSha: request.commitSha, branch: request.branch,
          worktreePath: request.worktreePath, diff: request.diff,
          artifacts: request.artifacts, context: {
            commitSha: request.commitSha, attempt: request.attempt,
          },
        });
      },
    };

    const fixCommitter: FixCommitter = {
      async commit(worktreePath, message) {
        const handle = {
          planId: worktreePath.split('/').pop() ?? 'unknown',
          path: worktreePath,
          branch: 'fix',
          baseBranch: 'main',
          status: 'active' as const,
        };
        return worktreeManager.commit(handle, message);
      },
      async diff(worktreePath) {
        const handle = {
          planId: worktreePath.split('/').pop() ?? 'unknown',
          path: worktreePath,
          branch: 'fix',
          baseBranch: 'main',
          status: 'active' as const,
        };
        return worktreeManager.diff(handle);
      },
    };

    const fixPromptBuilder: FixPromptBuilder = {
      build(findings, feedback, attempt, attemptMax) {
        return buildFixPrompt(
          { id: 'fix', timestamp: new Date().toISOString(), source: 'system', sourceMetadata: {}, intent: 'review-pr', entities: {} },
          { id: 'fix-plan', workItemId: 'fix', template: 'fix', agentTeam: [] },
          { worktreePath: '', findings, feedback, attempt, maxAttempts: attemptMax },
        );
      },
    };

    const fixItLoop = createFixItLoop({
      fixExecutor, fixReviewer, fixCommitter, fixPromptBuilder, logger: execLogger,
    });

    let githubClient: ReturnType<typeof createGitHubClient> | undefined;
    if (tokenProvider) {
      // App auth — tokenProvider resolves fresh tokens on each call
      githubClient = createGitHubClient({ logger: execLogger, tokenProvider });
    } else if (effectiveGithubToken) {
      // PAT fallback — static token
      githubClient = createGitHubClient({ logger: execLogger, token: effectiveGithubToken });
    }

    // Wire SimpleExecutor (legacy template-driven path — IntakeCompleted)
    simpleExecutor = createSimpleExecutor({
      interactiveExecutor,
      worktreeManager,
      artifactApplier,
      reviewGate,
      fixItLoop,
      agentRegistry: getDefaultRegistry(),
      githubClient,
      linearClient,
      logger: execLogger,
      eventBus,
      maxFixAttempts,
      agentTimeoutMs: workflowConfig.agentRunner.turnTimeoutMs,
    });

    // Wire LocalAgentTask (CC-aligned coordinator dispatch — AgentPrompted).
    // Mirrors src/tasks/LocalAgentTask/ in Claude Code's codebase.
    localAgentTask = createLocalAgentTaskExecutor({
      interactiveExecutor,
      worktreeManager,
      artifactApplier,
      agentRegistry: getDefaultRegistry(),
      githubClient,
      linearClient,
      logger: execLogger,
      eventBus,
      agentTimeoutMs: workflowConfig.agentRunner.turnTimeoutMs,
    });

    logger.info('Interactive agent execution enabled', {
      worktreeBasePath,
      maxFixAttempts,
      hasGitHubToken: !!effectiveGithubToken,
      hasGitHubApp: !!tokenProvider,
      simpleExecutor: true,
    });

    if (config.linearEnabled && linearClient) {
      // P9: Create coordinator session for symphony orchestrator dispatch.
      // When coordinator mode is active, the symphony orchestrator routes
      // issues through this session instead of spawning raw Workers.
      const symphonyCoordinatorSession = createCoordinatorSession({
        baseExecutor: interactiveExecutor,
        logger: execLogger,
      });

      symphonyOrchestrator = createSymphonyOrchestrator({
        workflowConfig,
        workflowConfigProvider: () => workflowConfigStore.requireConfig(),
        workflowState: () => workflowConfigStore.getSnapshot(),
        linearClient,
        logger: execLogger,
        worktreeBasePath,
        defaultRepo: process.env.GITHUB_REPOSITORY,
        defaultBranch: process.env.GITHUB_BASE_BRANCH ?? 'main',
        coordinatorEnqueue: (req) => symphonyCoordinatorSession.enqueueTask(req),
        getOAuthCredentials: oauthTokenStore
          ? () => {
            try {
              const tokens = oauthTokenStore!.getTokenSet();
              return {
                clientId: config.linearClientId,
                clientSecret: config.linearClientSecret,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
              };
            } catch {
              return undefined;
            }
          }
          : undefined,
      });
      linearExecutionMode = 'symphony';

      if (workflowConfig.polling.enabled) {
        symphonyOrchestrator.start();
        logger.info('Symphony orchestrator enabled for Linear polling', {
          pollIntervalMs: workflowConfig.polling.intervalMs,
        });
      } else {
        logger.info('Symphony orchestrator enabled for Linear webhook handoff', {
          pollingEnabled: workflowConfig.polling.enabled,
        });
      }
    }

    if (config.linearEnabled && linearClient) {
      workpadReporter = createWorkpadReporter({
        eventBus,
        logger: execLogger,
        linearClient,
      });
      workpadReporter.start();
      logger.info('Linear workpad reporter enabled');
    }
  }

  if (!simpleExecutor) {
    // Provide a no-op executor for stub mode (no real execution)
    simpleExecutor = {
      async execute(plan) {
        logger.info('Stub executor: no real execution', { planId: plan.id });
        return { status: 'completed', agentResults: [], totalDuration: 0 };
      },
    };
    logger.info('Running in stub mode (ENABLE_INTERACTIVE_AGENTS not set)');
  }

  if (!localAgentTask) {
    // Stub LocalAgentTask: same shape, no real execution.
    localAgentTask = {
      async execute(plan) {
        logger.info('Stub local-agent task: no real execution', { planId: plan.id });
        return { status: 'completed', agentResults: [], totalDuration: 0 };
      },
    };
  }

  const pipeline = startPipeline({
    eventBus, logger, reviewGate, simpleExecutor, localAgentTask, workflowConfig,
    linearExecutionMode,
    githubClient: tokenProvider
      ? createGitHubClient({ logger, tokenProvider })
      : effectiveGithubToken
        ? createGitHubClient({ logger, token: effectiveGithubToken })
        : undefined,
    linearClient: config.linearEnabled && linearAuthStrategy
      ? createLinearClient({ apiKey: linearApiKey, authStrategy: linearAuthStrategy, tokenStore: oauthTokenStore, logger })
      : undefined,
  });

  const server = await buildServer({
    config,
    logger,
    eventBus,
    workflowConfig,
    getStatusSnapshot: (): StatusSurfaceSnapshot => ({
      workflow: workflowConfigStore.getSnapshot(),
      orchestrator: symphonyOrchestrator?.getSnapshot(),
      links: {
        ...(process.env.OPERATOR_DASHBOARD_URL ? { dashboardUrl: process.env.OPERATOR_DASHBOARD_URL } : {}),
        ...(process.env.TERMINAL_SNAPSHOT_URL ? { terminalSnapshotUrl: process.env.TERMINAL_SNAPSHOT_URL } : {}),
      },
    }),
    onLinearIntake: symphonyOrchestrator
      ? async () => {
        await symphonyOrchestrator?.onTick();
      }
      : undefined,
    linearAuthStrategy,
    oauthTokenStore,
    linearClient: config.linearEnabled && linearAuthStrategy
      ? createLinearClient({ apiKey: linearApiKey, authStrategy: linearAuthStrategy, tokenStore: oauthTokenStore, logger })
      : undefined,
    tokenPersistence,
  });

  try {
    const host = process.env.BIND_HOST ?? '0.0.0.0';
    await server.listen({ port: config.port, host });
    logger.info('Server listening', { port: config.port });
  } catch (err) {
    logger.fatal('Failed to start server', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    await symphonyOrchestrator?.stop();
    workflowConfigStore.stop();
    workpadReporter?.stop();
    pipeline.shutdown();
    eventBus.removeAllListeners();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
