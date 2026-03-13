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
import { createCliClient } from './execution/cli-client';
import { createClaudeTaskExecutor } from './execution/task-executor';
import { createWorktreeManager } from './execution/worktree-manager';
import { createInteractiveExecutor } from './execution/interactive-executor';
import { createArtifactApplier } from './execution/artifact-applier';
import { createReviewGate, createStubDiffReviewer, createCliTestRunner, createPatternSecurityScanner } from './review/review-gate';
import { createGitHubClient } from './integration/github-client';
import { createFixItLoop } from './execution/fix-it-loop';
import type { FixExecutor, FixReviewer, FixCommitter, FixPromptBuilder } from './execution/fix-it-loop';
import { buildFixPrompt } from './execution/prompt-builder';
import { isAbsolute as pathIsAbsolute } from 'node:path';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'orch-agents' });
  const eventBus = createEventBus(logger);

  logger.info('Starting Orch-Agents', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
  });

  // Wire the event-sourced processing pipeline:
  // IntakeCompleted -> Triage -> Planning -> Execution -> Review
  // Execution modes:
  //   ENABLE_TASK_AGENTS=true → task-tool agents (real work via Claude prompts)
  //   ENABLE_AGENTS=true      → CLI lifecycle agents (swarm/agent/task via claude-flow CLI)
  //   neither                 → stub mode (pass-through, no real execution)
  const useTaskAgents = process.env.ENABLE_TASK_AGENTS === 'true';
  const useRealAgents = process.env.ENABLE_AGENTS === 'true';
  // Task-tool mode takes priority; skip MCP client when task-tool is enabled
  const cliClient = (useRealAgents && !useTaskAgents) ? createCliClient() : undefined;
  const taskExecutor = useTaskAgents ? createClaudeTaskExecutor() : undefined;

  if (useTaskAgents) {
    logger.info('Task-tool agent execution enabled');
    if (useRealAgents) {
      logger.warn('ENABLE_AGENTS ignored — ENABLE_TASK_AGENTS takes priority');
    }
  } else if (useRealAgents) {
    logger.info('Real agent execution enabled (CLI lifecycle)');
  }

  // Phase 5: interactive agent execution (opt-in via ENABLE_INTERACTIVE_AGENTS)
  const useInteractiveAgents = process.env.ENABLE_INTERACTIVE_AGENTS === 'true';

  let interactiveExecutor: ReturnType<typeof createInteractiveExecutor> | undefined;
  let worktreeManager: ReturnType<typeof createWorktreeManager> | undefined;
  let artifactApplier: ReturnType<typeof createArtifactApplier> | undefined;
  let reviewGate: ReturnType<typeof createReviewGate> | undefined;
  let githubClient: ReturnType<typeof createGitHubClient> | undefined;
  let fixItLoop: ReturnType<typeof createFixItLoop> | undefined;

  if (useInteractiveAgents) {
    const execLogger = logger.child ? logger.child({ module: 'interactive' }) : logger;

    // M4: Validate WORKTREE_BASE_PATH is absolute on the raw value before resolution
    const worktreeBasePath = process.env.WORKTREE_BASE_PATH ?? '/tmp/orch-agents';
    if (!pathIsAbsolute(worktreeBasePath)) {
      throw new Error(`WORKTREE_BASE_PATH must be an absolute path, got: ${worktreeBasePath}`);
    }

    const parsedAttempts = parseInt(process.env.MAX_FIX_ATTEMPTS ?? '3', 10);
    const maxFixAttempts = (isNaN(parsedAttempts) || parsedAttempts < 1 || parsedAttempts > 10) ? 3 : parsedAttempts;

    worktreeManager = createWorktreeManager({ logger: execLogger, basePath: worktreeBasePath });
    interactiveExecutor = createInteractiveExecutor({ logger: execLogger });
    artifactApplier = createArtifactApplier({ logger: execLogger });

    reviewGate = createReviewGate({
      diffReviewer: createStubDiffReviewer(),
      testRunner: createCliTestRunner({ logger: execLogger }),
      securityScanner: createPatternSecurityScanner({ logger: execLogger }),
      logger: execLogger,
    });

    // Adapt existing components to FixItLoop dependency interfaces
    const fixExecutor: FixExecutor = {
      async executeFix(worktreePath, prompt, timeout) {
        return interactiveExecutor!.execute({
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
        // C4+C5: Route through worktreeManager to get basePath validation and consistent git operations.
        // Build a handle from the worktreePath for the worktreeManager API.
        const handle = {
          planId: worktreePath.split('/').pop() ?? 'unknown',
          path: worktreePath,
          branch: 'fix',
          baseBranch: 'main',
          status: 'active' as const,
        };
        return worktreeManager!.commit(handle, message);
      },
      async diff(worktreePath) {
        const handle = {
          planId: worktreePath.split('/').pop() ?? 'unknown',
          path: worktreePath,
          branch: 'fix',
          baseBranch: 'main',
          status: 'active' as const,
        };
        return worktreeManager!.diff(handle);
      },
    };

    const fixPromptBuilder: FixPromptBuilder = {
      build(findings, feedback, attempt, attemptMax) {
        return buildFixPrompt(
          { id: 'fix', timestamp: new Date().toISOString(), source: 'system', sourceMetadata: {}, intent: 'review-pr', entities: {} },
          { id: 'fix-plan', workItemId: 'fix', methodology: 'adhoc', template: 'fix', topology: 'star', swarmStrategy: 'minimal', consensus: 'none', maxAgents: 1, phases: [], agentTeam: [], estimatedDuration: 0, estimatedCost: 0 },
          { worktreePath: '', findings, feedback, attempt, maxAttempts: attemptMax },
        );
      },
    };

    fixItLoop = createFixItLoop({
      fixExecutor, fixReviewer, fixCommitter, fixPromptBuilder, logger: execLogger,
    });

    if (process.env.GITHUB_TOKEN) {
      githubClient = createGitHubClient({ logger: execLogger, token: process.env.GITHUB_TOKEN });
    }

    logger.info('Interactive agent execution enabled', {
      worktreeBasePath,
      maxFixAttempts,
      hasGitHubToken: !!process.env.GITHUB_TOKEN,
    });
  }

  const pipeline = startPipeline({
    eventBus, logger, cliClient, taskExecutor,
    interactiveExecutor, worktreeManager, artifactApplier, fixItLoop, reviewGate, githubClient,
  });

  const server = await buildServer({ config, logger, eventBus });

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
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
    pipeline.shutdown();
    eventBus.removeAllListeners();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
