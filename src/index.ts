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
import { createInteractiveExecutor } from './execution/runtime/interactive-executor';
import { createArtifactApplier } from './execution/workspace/artifact-applier';
import { createReviewGate, createStubDiffReviewer, createCliTestRunner, createPatternSecurityScanner } from './review/review-gate';
import { createClaudeDiffReviewer } from './review/claude-diff-reviewer';
import { createGitHubClient } from './integration/github-client';
import { createFixItLoop } from './execution/fix-it-loop';
import type { FixExecutor, FixReviewer, FixCommitter, FixPromptBuilder } from './execution/fix-it-loop';
import { buildFixPrompt } from './execution/prompt-builder';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import { createSimpleExecutor, type SimpleExecutor } from './execution/simple-executor';
import { getDefaultRegistry } from './agent-registry/agent-registry';
import { parseWorkflowMd, type WorkflowConfig } from './integration/linear/workflow-parser';
import { resolve as pathResolve } from 'node:path';

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
  let workflowConfig: WorkflowConfig;
  try {
    workflowConfig = parseWorkflowMd(workflowMdPath);
    logger.info('Loaded WORKFLOW.md', {
      path: workflowMdPath,
      templates: Object.keys(workflowConfig.templates),
      defaultTemplate: workflowConfig.agents.defaultTemplate,
    });
  } catch (err) {
    logger.fatal('Failed to load WORKFLOW.md — cannot start without it', {
      path: workflowMdPath,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Interactive agent execution (opt-in via ENABLE_INTERACTIVE_AGENTS)
  const useInteractiveAgents = process.env.ENABLE_INTERACTIVE_AGENTS === 'true';

  let simpleExecutor: SimpleExecutor | undefined;
  let reviewGate: ReturnType<typeof createReviewGate> | undefined;

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
    const interactiveExecutor = createInteractiveExecutor({ logger: execLogger });
    const artifactApplier = createArtifactApplier({ logger: execLogger });

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
    if (process.env.GITHUB_TOKEN) {
      githubClient = createGitHubClient({ logger: execLogger, token: process.env.GITHUB_TOKEN });
    }

    // Wire SimpleExecutor
    simpleExecutor = createSimpleExecutor({
      interactiveExecutor,
      worktreeManager,
      artifactApplier,
      reviewGate,
      fixItLoop,
      agentRegistry: getDefaultRegistry(),
      githubClient,
      logger: execLogger,
      eventBus,
      maxFixAttempts,
    });

    logger.info('Interactive agent execution enabled', {
      worktreeBasePath,
      maxFixAttempts,
      hasGitHubToken: !!process.env.GITHUB_TOKEN,
      simpleExecutor: true,
    });
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

  const pipeline = startPipeline({
    eventBus, logger, reviewGate, simpleExecutor, workflowConfig,
  });

  const server = await buildServer({ config, logger, eventBus, workflowConfig });

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
    pipeline.shutdown();
    eventBus.removeAllListeners();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
