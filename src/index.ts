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
import { createMcpClient } from './execution/mcp-client';

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
  // When ENABLE_AGENTS=true, real claude-flow agents are spawned per phase.
  const useRealAgents = process.env.ENABLE_AGENTS === 'true';
  const mcpClient = useRealAgents ? createMcpClient() : undefined;

  if (useRealAgents) {
    logger.info('Real agent execution enabled');
  }

  const pipeline = startPipeline({ eventBus, logger, mcpClient });

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
