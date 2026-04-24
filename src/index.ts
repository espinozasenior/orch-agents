/**
 * Application entry point for the Orch-Agents system.
 *
 * Wires together config, logger, event bus, processing pipeline,
 * and HTTP server.
 */

import { loadConfig } from './shared/config';
import { createLogger } from './shared/logger';
import { createEventBus } from './kernel/event-bus';
import { buildServer } from './server';
import { startPipeline } from './pipeline';
import { createWorktreeManager } from './execution/workspace/worktree-manager';
import { createSdkExecutor } from './execution/runtime/sdk-executor';
import { createArtifactApplier } from './execution/workspace/artifact-applier';
import { createReviewGate, createStubDiffReviewer, createCliTestRunner, createPatternSecurityScanner } from './review/review-gate';
import { createClaudeDiffReviewer } from './review/claude-diff-reviewer';
import { createGitHubClient } from './integration/github-client';
import { isAbsolute as pathIsAbsolute, join as pathJoin } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { cleanupAllSandboxes, cleanupStaleSandboxes } from './execution/runtime/agent-sandbox';
import { createCoordinatorDispatcher, type CoordinatorDispatcher } from './execution/coordinator-dispatcher';
import { createWorkspaceProvisioner } from './execution/workspace/workspace-provisioner';
import type { WorkflowConfig } from './config';
import { resolve as pathResolve } from 'node:path';
import { createGitHubAppTokenProvider, type GitHubTokenProvider } from './integration/github-app-auth';
import { setBotName } from './kernel/agent-identity';
import { createLinearClient, type LinearAuthStrategy } from './integration/linear/linear-client';
import { createOAuthTokenStore, type OAuthTokenStore } from './integration/linear/oauth-token-store';
import { createSymphonyOrchestrator, type SymphonyOrchestrator } from './execution/orchestrator/symphony-orchestrator';
import { createCoordinatorSession } from './execution/runtime/coordinator-session';
import { createWorkpadReporter, type WorkpadReporter } from './integration/linear/workpad-reporter';
import { createSlackResponder, type SlackResponder } from './integration/slack/slack-responder';
import type { SecretStore } from './security/secret-store';
import { createWorkflowConfigStore } from './config/workflow-config-store';
import type { StatusSurfaceSnapshot } from './webhook-gateway/webhook-router';

/**
 * Prune stale git worktrees whose directories no longer exist on disk.
 * Runs `git worktree list --porcelain` and invokes `git worktree prune`
 * when orphaned entries are found.
 */
function cleanupStaleWorktrees(logger: ReturnType<typeof createLogger>): void {
  try {
    const raw = execSync('git worktree list --porcelain', { encoding: 'utf-8' });
    const worktreeBasePath = process.env.WORKTREE_BASE_PATH ?? '/tmp/orch-agents';
    const staleEntries: string[] = [];

    for (const block of raw.split('\n\n')) {
      const worktreeLine = block.split('\n').find((l) => l.startsWith('worktree '));
      if (!worktreeLine) continue;
      const wtPath = worktreeLine.slice('worktree '.length);

      // Skip the main working tree (bare flag absent and no "branch" means main)
      if (block.includes('bare') || !block.includes('branch ')) continue;

      // Only consider worktrees under /tmp/ or the configured base path
      const isTmpWorktree = wtPath.startsWith('/tmp/') || wtPath.startsWith(worktreeBasePath);
      if (!isTmpWorktree) continue;

      if (!existsSync(wtPath)) {
        staleEntries.push(wtPath);
      }
    }

    if (staleEntries.length > 0) {
      execSync('git worktree prune', { encoding: 'utf-8' });
      logger.info('Pruned stale git worktrees', { count: staleEntries.length, paths: staleEntries });
    }
  } catch (err) {
    // Non-fatal — log and continue
    logger.warn('Failed to clean up stale worktrees', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'orch-agents' });
  const eventBus = createEventBus(logger);

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // Clean up stale resources from previous runs
  cleanupStaleWorktrees(logger);
  cleanupStaleSandboxes(24 * 60 * 60 * 1000); // Remove sandbox dirs older than 24 hours

  logger.info('Starting Orch-Agents', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
  });

  // Load WORKFLOW.md — the single source of truth for per-repo routing.
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

  // Validate at least one repo is configured
  const repoNames = Object.keys(workflowConfig.repos);
  if (repoNames.length === 0) {
    logger.fatal('No repos configured in WORKFLOW.md — at least one repo is required');
    process.exit(1);
  }
  logger.info('Configured repos', {
    count: repoNames.length,
    repos: repoNames.map(name => ({
      name,
      events: Object.keys(workflowConfig.repos[name].github?.events ?? {}).length,
    })),
  });

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
  const linearApiKey = workflowConfig.tracker?.apiKey ?? config.linearApiKey;

  if (config.linearAuthMode === 'oauth') {
    if (!config.linearClientId || !config.linearClientSecret) {
      logger.warn('OAuth mode requires LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET');
    } else {
      // Persistent token storage via SQLite — survives restarts
      const { createOAuthTokenPersistence } = await import('./integration/linear/oauth-token-persistence.js');
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

  // Load MCP server names from .mcp.json (if present) so the coordinator
  // prompt can inform agents about available MCP tools.
  const mcpClients: Array<{ name: string }> = [];
  const mcpJsonPath = pathJoin(process.cwd(), '.mcp.json');
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      const servers = mcpJson.mcpServers ?? mcpJson;
      for (const name of Object.keys(servers)) {
        mcpClients.push({ name });
      }
      logger.info('MCP server names loaded from .mcp.json', {
        servers: mcpClients.map((c) => c.name),
      });
    } catch (err) {
      logger.warn('Failed to parse .mcp.json — MCP context will be empty', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Encrypted secrets store ──────────────────────────────────
  let secretStore: SecretStore | undefined;
  if (config.secretsMasterKey) {
    const { createSecretPersistence } = await import('./security/secret-persistence');
    const { createSecretStore: makeSecretStore } = await import('./security/secret-store');
    const secretPersistence = createSecretPersistence(
      process.env.SECRETS_DB_PATH ?? './data/secrets.db',
    );
    secretStore = makeSecretStore({
      persistence: secretPersistence,
      masterKey: config.secretsMasterKey,
    });
    logger.info('Encrypted secrets store initialized');
  }

  // Interactive agent execution (opt-in via ENABLE_INTERACTIVE_AGENTS)
  const useInteractiveAgents = process.env.ENABLE_INTERACTIVE_AGENTS === 'true';

  let localAgentTask: CoordinatorDispatcher | undefined;
  let reviewGate: ReturnType<typeof createReviewGate> | undefined;
  let symphonyOrchestrator: SymphonyOrchestrator | undefined;
  let workpadReporter: WorkpadReporter | undefined;
  let slackResponder: SlackResponder | undefined;
  let linearExecutionMode: 'generic' | 'symphony' = 'generic';
  let directSpawnStrategy: import('./execution/runtime/direct-spawn-strategy').DirectSpawnStrategy | undefined;

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
    const workspaceProvisioner = createWorkspaceProvisioner({
      worktreeManager,
      logger: execLogger,
      eventBus,
      workflowConfig,
    });
    // P12: deferred-tool registry — built-ins (Read/Edit/Write/Bash/Grep/Glob/Agent)
    // and the ToolSearch meta-tool registered as alwaysLoad.
    const { createDefaultDeferredToolRegistry } = await import('./services/deferred-tools');
    const deferredToolRegistry = createDefaultDeferredToolRegistry();

    // Direct spawn mode: read feature flag for agent spawn routing
    const agentSpawnMode = (process.env.AGENT_SPAWN_MODE === 'direct' ? 'direct' : 'sdk') as import('./shared/config').AgentSpawnMode;

    // When direct mode, create a SwarmDaemon for child agent dispatch
    let childSwarmDaemon: import('./execution/runtime/swarm-daemon').SwarmDaemon | undefined;
    if (agentSpawnMode === 'direct') {
      const { SwarmDaemon } = await import('./execution/runtime/swarm-daemon');
      childSwarmDaemon = new SwarmDaemon({ logger: execLogger, maxSlots: 8 });
      childSwarmDaemon.start();
      execLogger.info('Direct agent spawn mode enabled — child SwarmDaemon started');
    }

    const baseExecutor = createSdkExecutor({
      logger: execLogger,
      // P11: pass eventBus so WorkCancelled domain events abort in-flight
      // SDK executions via the stop-hook → AbortController bridge.
      eventBus,
      // P12: feed the registry so allowedTools is computed from it.
      deferredToolRegistry,
      // Direct mode: remove Agent from SDK allowedTools
      agentSpawnMode,
    });

    // Apply harness enhancements: P0 compaction + P3 budget + P1 query loop + P2 coordinator
    const { buildExecutor } = await import('./execution/runtime/executor-factory');
    const executorResult = buildExecutor({
      baseExecutor,
      logger: execLogger,
      contextWindowTokens: parseInt(process.env.CONTEXT_WINDOW_TOKENS ?? '200000', 10),
      tokenBudget: process.env.TOKEN_BUDGET ? parseInt(process.env.TOKEN_BUDGET, 10) : undefined,
      enableCompaction: process.env.ENABLE_COMPACTION !== 'false',
      mcpClients,
      // Direct spawn mode wiring
      agentSpawnMode,
      swarmDaemon: childSwarmDaemon,
      worktreeManager,
      eventBus,
      deferredToolRegistry,
    });
    const interactiveExecutor = executorResult.executor;
    directSpawnStrategy = executorResult.directSpawnStrategy;
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

    // Option C step 2 (PR A): FixItLoop wiring removed from the main-thread
    // bootstrap. It was only ever consumed by SimpleExecutor, which is no
    // longer constructed here. The fix-it-loop module file remains available
    // for the worker thread and will be re-evaluated for orphan deletion in
    // PR C. Keeping this comment as a deliberate breadcrumb.

    let githubClient: ReturnType<typeof createGitHubClient> | undefined;
    if (tokenProvider) {
      // App auth — tokenProvider resolves fresh tokens on each call
      githubClient = createGitHubClient({ logger: execLogger, tokenProvider });
    } else if (effectiveGithubToken) {
      // PAT fallback — static token
      githubClient = createGitHubClient({ logger: execLogger, token: effectiveGithubToken });
    }

    // Option C step 2 (PR A): SimpleExecutor is no longer wired into the
    // main-thread engine. The IntakeCompleted handler now dispatches through
    // LocalAgentTask in coordinator mode (same as AgentPrompted). The
    // worker-thread path (src/execution/orchestrator/issue-worker.ts) still
    // constructs its own SimpleExecutor — that migration is PR B.

    // Wire LocalAgentTask (CC-aligned coordinator dispatch — IntakeCompleted + AgentPrompted).
    // Mirrors src/tasks/LocalAgentTask/ in Claude Code's codebase.
    localAgentTask = createCoordinatorDispatcher({
      interactiveExecutor,
      worktreeManager,
      artifactApplier,
      githubClient,
      linearClient,
      logger: execLogger,
      eventBus,
      agentTimeoutMs: workflowConfig.agentRunner.turnTimeoutMs,
      mcpClients,
      getGitHubToken: tokenProvider
        ? (repo?: string) => repo ? tokenProvider!.getTokenForRepo(repo) : tokenProvider!.getToken()
        : undefined,
      workspaceProvisioner,
      secretStore,
    });

    logger.info('Interactive agent execution enabled', {
      worktreeBasePath,
      maxFixAttempts,
      hasGitHubToken: !!effectiveGithubToken,
      hasGitHubApp: !!tokenProvider,
      dispatcher: 'localAgentTask',
    });

    if (config.linearEnabled && linearClient) {
      // P9: Create coordinator session for symphony orchestrator dispatch.
      // When coordinator mode is active, the symphony orchestrator routes
      // issues through this session instead of spawning raw Workers.
      const symphonyCoordinatorSession = createCoordinatorSession({
        baseExecutor: interactiveExecutor,
        logger: execLogger,
        mcpClients,
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

    // Slack responder — thread replies + broadcast notifications
    if (config.slackEnabled && config.slackBotToken) {
      slackResponder = createSlackResponder({
        eventBus,
        logger: execLogger,
        slackBotToken: config.slackBotToken,
        broadcastWebhookUrl: config.slackWebhookUrl,
      });
      slackResponder.start();
      logger.info('Slack responder enabled');
    }
  }

  if (!localAgentTask) {
    // Stub LocalAgentTask: same shape, no real execution.
    // Used when ENABLE_INTERACTIVE_AGENTS is not set (stub mode).
    localAgentTask = {
      async execute(plan) {
        logger.info('Stub local-agent task: no real execution', { planId: plan.id });
        return { status: 'completed', agentResults: [], totalDuration: 0 };
      },
    };
    logger.info('Running in stub mode (ENABLE_INTERACTIVE_AGENTS not set)');
  }

  // Declared early so the status snapshot closure can reference it.
  // Assigned after server.listen() if ENABLE_TUNNEL is set.
  let tunnelManager: import('./tunnel/cloudflare-tunnel').TunnelManager | undefined;

  // ── Automation scheduling (cron + webhook + auto-pause) ──────
  const { createAutomationRunPersistence } = await import('./scheduling/automation-run-persistence');
  const { createCronScheduler } = await import('./scheduling/cron-scheduler');

  const automationPersistence = createAutomationRunPersistence({
    dbPath: process.env.AUTOMATION_DB_PATH ?? './data/automation-runs.db',
    logger,
  });
  const cronScheduler = createCronScheduler({
    workflowConfigProvider: () => workflowConfigStore.requireConfig(),
    eventBus,
    logger,
    persistence: automationPersistence,
  });
  cronScheduler.start();

  const pipeline = await startPipeline({
    eventBus, logger, reviewGate, localAgentTask, workflowConfig,
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
      tunnel: tunnelManager?.getUrl()
        ? { enabled: true, url: tunnelManager.getUrl()! }
        : config.enableTunnel
          ? { enabled: true, url: '' }
          : undefined,
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
    directSpawnStrategy,
    cronScheduler,
    secretStore,
  });

  try {
    const host = process.env.BIND_HOST ?? '127.0.0.1';
    await server.listen({ port: config.port, host });
    logger.info('Server listening', { port: config.port });
  } catch (err) {
    logger.fatal('Failed to start server', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // -- Cloudflare Quick Tunnel (opt-in) ----------------------------------------
  if (config.enableTunnel) {
    const { createTunnelManager } = await import('./tunnel/cloudflare-tunnel');
    const { updateRepoWebhooks, updateAppWebhook } = await import('./tunnel/webhook-updater');

    tunnelManager = createTunnelManager();
    try {
      const tunnelUrl = await tunnelManager.start(config.port);
      logger.info('Cloudflare tunnel started', { url: tunnelUrl });

      // Make available to repo-add command
      process.env.WEBHOOK_URL = tunnelUrl;

      // Update GitHub App webhook URL (app-level, uses JWT)
      if (config.githubAppId && config.githubAppPrivateKeyPath && config.webhookSecret) {
        const appResult = await updateAppWebhook(
          tunnelUrl,
          config.githubAppId,
          config.githubAppPrivateKeyPath,
          config.webhookSecret,
        );
        logger.info('GitHub App webhook update', { action: appResult.action, error: appResult.error });
      }

      // Update all configured repo webhooks with the new URL
      if (tokenProvider && config.webhookSecret) {
        const results = await updateRepoWebhooks(
          workflowConfig.repos,
          tunnelUrl,
          (repo) => tokenProvider!.getTokenForRepo(repo),
          config.webhookSecret,
        );
        for (const r of results) {
          logger.info('Webhook update', { repo: r.repo, action: r.action, hookId: r.hookId, error: r.error });
        }
      } else {
        logger.warn('Skipping webhook update — no GitHub App configured or GITHUB_WEBHOOK_SECRET not set');
      }
    } catch (err) {
      logger.error('Failed to start Cloudflare tunnel', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal: server still runs, just no tunnel
    }
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '10000', 10);

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn('Shutdown already in progress, ignoring duplicate signal', { signal });
      return;
    }
    shuttingDown = true;
    logger.info('Shutdown initiated', { signal, timeoutMs: shutdownTimeoutMs });

    // Force exit if graceful shutdown takes too long
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit', { timeoutMs: shutdownTimeoutMs });
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref();

    try {
      logger.info('Shutdown step: stopping cron scheduler');
      cronScheduler.stop();

      logger.info('Shutdown step: closing automation persistence');
      automationPersistence.close();

      logger.info('Shutdown step: stopping tunnel');
      tunnelManager?.stop();

      logger.info('Shutdown step: stopping symphony orchestrator');
      await symphonyOrchestrator?.stop();

      logger.info('Shutdown step: stopping workflow config store');
      workflowConfigStore.stop();

      logger.info('Shutdown step: stopping workpad reporter');
      workpadReporter?.stop();

      logger.info('Shutdown step: stopping slack responder');
      slackResponder?.stop();

      logger.info('Shutdown step: shutting down pipeline');
      pipeline.shutdown();

      logger.info('Shutdown step: removing event listeners');
      eventBus.removeAllListeners();

      logger.info('Shutdown step: closing HTTP server');
      await server.close();

      logger.info('Shutdown step: cleaning up agent sandboxes');
      cleanupAllSandboxes();

      logger.info('Shutdown complete', { signal });
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main();
}
