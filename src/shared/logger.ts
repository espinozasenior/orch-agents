/**
 * Simple structured logger for the Orch-Agents system.
 *
 * Console-based implementation for Phases 0-2.
 * Will be replaced by Pino at Phase 3+ when Fastify is introduced.
 */

import type { LogLevel } from './config';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

/**
 * Create a structured logger that outputs JSON lines to the console.
 */
export function createLogger(options: {
  level?: LogLevel;
  name?: string;
  bindings?: LogContext;
} = {}): Logger {
  const minLevel = LOG_LEVEL_ORDER[options.level ?? 'info'];
  const baseBindings: LogContext = {
    ...(options.name ? { name: options.name } : {}),
    ...options.bindings,
  };

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= minLevel;
  }

  function write(level: LogLevel, message: string, context?: LogContext): void {
    if (!shouldLog(level)) return;

    const entry = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...baseBindings,
      ...context,
    };

    const output = JSON.stringify(entry);

    if (level === 'error' || level === 'fatal') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  const logger: Logger = {
    trace: (msg, ctx) => write('trace', msg, ctx),
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    fatal: (msg, ctx) => write('fatal', msg, ctx),
    child(bindings: LogContext): Logger {
      return createLogger({
        level: options.level,
        bindings: { ...baseBindings, ...bindings },
      });
    },
  };

  return logger;
}
