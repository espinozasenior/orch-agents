/**
 * Claude Code SDK executor.
 *
 * Adapts the Claude Code SDK to the existing InteractiveTaskExecutor contract
 * so the rest of the execution layer can swap from CLI subprocesses to SDK
 * sessions without changing orchestration code.
 */

import { resolve as pathResolve } from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { Logger } from '../../shared/logger';
import type { LinearToolBridge, LinearToolOperation } from '../../integration/linear/linear-client';
import type {
  InteractiveTaskExecutor,
  InteractiveExecutionRequest,
} from './interactive-executor';
import type { TaskExecutionResult } from './task-executor';

const ALLOWED_WORKTREE_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/'];

type QueryFactory = (params: {
  prompt: string;
  cwd: string;
  allowedTools: string[];
  maxTurns: number;
  permissionPolicy: SessionPermissionPolicy;
  linearToolBridge?: LinearToolBridge;
}) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;

interface SessionPermissionPolicy {
  permissionMode: 'default';
  allowDangerouslySkipPermissions: false;
  allowedTools: string[];
  writableRoots: string[];
}

type NormalizedRuntimeEvent =
  | {
    type: 'progress';
    timestamp: number;
    agentRole: string;
    agentType: string;
    sessionId?: string;
    textDelta: string;
    output: string;
  }
  | {
    type: 'toolCall';
    timestamp: number;
    agentRole: string;
    agentType: string;
    sessionId?: string;
    toolName: string;
    operation?: LinearToolOperation['kind'];
    ok?: boolean;
    resourceId?: string;
    error?: string;
  }
  | {
    type: 'tokenUsage';
    timestamp: number;
    agentRole: string;
    agentType: string;
    sessionId?: string;
    usage: NonNullable<TaskExecutionResult['tokenUsage']>;
  }
  | {
    type: 'result';
    timestamp: number;
    agentRole: string;
    agentType: string;
    sessionId?: string;
    status: TaskExecutionResult['status'];
    continuationState?: TaskExecutionResult['continuationState'];
  }
  | {
    type: 'error';
    timestamp: number;
    agentRole: string;
    agentType: string;
    sessionId?: string;
    error: string;
  };

export interface SdkExecutorDeps {
  logger?: Logger;
  allowedTools?: string[];
  queryFactory?: QueryFactory;
  eventSink?: (payload: Record<string, unknown>) => void;
  linearToolBridge?: LinearToolBridge;
}

export function createSdkExecutor(deps: SdkExecutorDeps = {}): InteractiveTaskExecutor {
  const logger = deps.logger;
  const allowedTools = deps.allowedTools ?? ['Edit', 'Write', 'Read', 'Bash', 'Grep', 'Glob'];
  const permissionPolicy: SessionPermissionPolicy = {
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    allowedTools,
    writableRoots: ALLOWED_WORKTREE_PREFIXES.map((prefix) => prefix.replace(/\/$/, '')),
  };
  const eventSink = deps.eventSink ?? ((payload: Record<string, unknown>) => {
    parentPort?.postMessage(payload);
  });

  return {
    async execute(request: InteractiveExecutionRequest): Promise<TaskExecutionResult> {
      const startTime = Date.now();
      const resolvedWorktree = pathResolve(request.worktreePath);
      const isAllowed = ALLOWED_WORKTREE_PREFIXES.some((prefix) => resolvedWorktree.startsWith(prefix));
      if (!isAllowed) {
        return {
          status: 'failed',
          output: '',
          duration: Date.now() - startTime,
          error: `worktreePath "${resolvedWorktree}" is not within allowed directories: ${ALLOWED_WORKTREE_PREFIXES.join(', ')}`,
        };
      }

      try {
        const createQuery = deps.queryFactory ?? await resolveQueryFactory();
        const stream = await createQuery({
          prompt: request.prompt,
          cwd: resolvedWorktree,
          allowedTools,
          maxTurns: Math.max(1, Math.floor(request.timeout / 60_000)) || 20,
          permissionPolicy,
          linearToolBridge: deps.linearToolBridge,
        });

        let output = '';
        let tokenUsage: TaskExecutionResult['tokenUsage'];
        let resultError: string | undefined;
        let completed = false;
        let sessionId: string | undefined;
        let lastActivityAt: string | undefined;
        let continuationState: TaskExecutionResult['continuationState'];

        for await (const event of stream) {
          const activityTimestamp = Date.now();
          lastActivityAt = new Date(activityTimestamp).toISOString();
          sessionId = extractSessionId(event) ?? sessionId;

          const eventText = extractText(event);
          if (eventText) {
            output += eventText;
            emitNormalizedEvent(eventSink, {
              type: 'progress',
              timestamp: activityTimestamp,
              agentRole: request.agentRole,
              agentType: request.agentType,
              sessionId,
              textDelta: eventText,
              output,
            });
          }

          const usage = extractTokenUsage(event);
          if (usage) {
            tokenUsage = usage;
            emitNormalizedEvent(eventSink, {
              type: 'tokenUsage',
              timestamp: activityTimestamp,
              agentRole: request.agentRole,
              agentType: request.agentType,
              sessionId,
              usage,
            });
          }

          const toolEvent = normalizeToolCallEvent(event);
          if (toolEvent) {
            const toolResult = await invokeLinearToolBridge(deps.linearToolBridge, toolEvent.operation);
            emitNormalizedEvent(eventSink, {
              type: 'toolCall',
              timestamp: activityTimestamp,
              agentRole: request.agentRole,
              agentType: request.agentType,
              sessionId,
              toolName: toolEvent.toolName,
              operation: toolEvent.operation?.kind,
              ok: toolResult?.ok,
              resourceId: toolResult && 'resourceId' in toolResult ? toolResult.resourceId : undefined,
              error: toolResult && !toolResult.ok ? toolResult.error : undefined,
            });
          }

          const result = extractResult(event);
          if (result) {
            completed = result.status === 'completed';
            continuationState = result.continuationState ?? continuationState;
            sessionId = result.sessionId ?? sessionId;
            if (result.output && !output) {
              output = result.output;
            }
            if (result.error) {
              resultError = result.error;
            }
            if (result.status === 'failed') {
              emitNormalizedEvent(eventSink, {
                type: 'error',
                timestamp: activityTimestamp,
                agentRole: request.agentRole,
                agentType: request.agentType,
                sessionId,
                error: result.error ?? 'Claude Agent SDK execution failed',
              });
            } else {
              emitNormalizedEvent(eventSink, {
                type: 'result',
                timestamp: activityTimestamp,
                agentRole: request.agentRole,
                agentType: request.agentType,
                sessionId,
                status: result.status,
                continuationState,
              });
            }
          }
        }

        if (!completed && resultError) {
          return {
            status: 'failed',
            output: '',
            duration: Date.now() - startTime,
            error: resultError,
            tokenUsage,
            sessionId,
            lastActivityAt,
            continuationState,
          };
        }

        logger?.info('Claude Code SDK execution completed', {
          agentRole: request.agentRole,
          agentType: request.agentType,
          worktreePath: resolvedWorktree,
          durationMs: Date.now() - startTime,
        });

        return {
          status: 'completed',
          output,
          duration: Date.now() - startTime,
          tokenUsage,
          sessionId,
          lastActivityAt,
          continuationState,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitNormalizedEvent(eventSink, {
          type: 'error',
          timestamp: Date.now(),
          agentRole: request.agentRole,
          agentType: request.agentType,
          error: message,
        });
        logger?.warn('Claude Code SDK execution failed', {
          agentRole: request.agentRole,
          agentType: request.agentType,
          worktreePath: resolvedWorktree,
          error: message,
        });
        return {
          status: 'failed',
          output: '',
          duration: Date.now() - startTime,
          error: message,
        };
      }
    },
  };
}

async function resolveQueryFactory(): Promise<QueryFactory> {
  const sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = (
    sdkModule as unknown as {
      query?: (params: Record<string, unknown>) => AsyncIterable<unknown>;
      default?: { query?: (params: Record<string, unknown>) => AsyncIterable<unknown> };
    }
  ).query ?? (
    sdkModule as unknown as {
      default?: { query?: (params: Record<string, unknown>) => AsyncIterable<unknown> };
    }
  ).default?.query;

  if (!queryFn) {
    throw new Error('Unsupported @anthropic-ai/claude-agent-sdk API shape');
  }

  return ({ prompt, cwd, allowedTools, maxTurns }) => queryFn({
    prompt,
    options: {
      cwd,
      allowedTools,
      maxTurns,
      permissionMode: 'default',
      tools: {
        type: 'preset',
        preset: 'claude_code',
      },
    },
  });
}

function extractText(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const candidate = event as {
    type?: string;
    text?: string;
    message?: { content?: unknown };
    content?: unknown;
  };

  if (candidate.type === 'text' && typeof candidate.text === 'string') {
    return candidate.text;
  }
  if (typeof candidate.text === 'string') {
    return candidate.text;
  }
  return extractTextFromContent(candidate.message?.content ?? candidate.content);
}

function extractTokenUsage(event: unknown): TaskExecutionResult['tokenUsage'] | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const usageContainer = event as {
    usage?: Record<string, unknown>;
    type?: string;
  };
  const usage = usageContainer.usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const input = readNumber(usage, ['input', 'inputTokens', 'input_tokens', 'input_tokens_total', 'prompt_tokens', 'promptTokens']);
  const output = readNumber(usage, ['output', 'outputTokens', 'output_tokens', 'output_tokens_total', 'completion_tokens', 'completionTokens']);
  if (input === undefined && output === undefined) {
    return undefined;
  }

  return {
    input: input ?? 0,
    output: output ?? 0,
  };
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function extractResult(event: unknown): {
  status: 'completed' | 'failed';
  output?: string;
  error?: string;
  sessionId?: string;
  continuationState?: TaskExecutionResult['continuationState'];
} | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    type?: string;
    subtype?: string;
    result?: string;
    errors?: string[];
    is_error?: boolean;
    stop_reason?: string | null;
    continuation?: { resumable?: boolean; reason?: string; sessionId?: string } | null;
  };

  if (candidate.type !== 'result') {
    return undefined;
  }

  const sessionId = extractSessionId(event);

  if (candidate.subtype === 'success' && !candidate.is_error) {
    const continuationState = extractContinuationState(candidate, sessionId);
    return {
      status: 'completed',
      output: candidate.result ?? '',
      sessionId,
      continuationState,
    };
  }

  return {
    status: 'failed',
    error: candidate.errors?.join('; ') || candidate.stop_reason || 'Claude Agent SDK execution failed',
    sessionId,
  };
}

function extractSessionId(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    sessionId?: unknown;
    session_id?: unknown;
    session?: { id?: unknown };
  };

  if (typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0) {
    return candidate.sessionId;
  }
  if (typeof candidate.session_id === 'string' && candidate.session_id.length > 0) {
    return candidate.session_id;
  }
  if (candidate.session && typeof candidate.session.id === 'string' && candidate.session.id.length > 0) {
    return candidate.session.id;
  }
  return undefined;
}

function extractContinuationState(
  event: {
    stop_reason?: string | null;
    continuation?: { resumable?: boolean; reason?: string; sessionId?: string } | null;
  },
  sessionId?: string,
): TaskExecutionResult['continuationState'] | undefined {
  if (event.continuation?.resumable) {
    return {
      resumable: true,
      sessionId: event.continuation.sessionId ?? sessionId,
      reason: event.continuation.reason ?? event.stop_reason ?? undefined,
    };
  }

  if (event.stop_reason && RESUMABLE_STOP_REASONS.has(event.stop_reason)) {
    return {
      resumable: true,
      sessionId,
      reason: event.stop_reason,
    };
  }

  return undefined;
}

const RESUMABLE_STOP_REASONS = new Set(['max_turns', 'pause_turn', 'awaiting_input', 'tool_use']);

function normalizeToolCallEvent(event: unknown): { toolName: string; operation?: LinearToolOperation } | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    type?: string;
    tool?: unknown;
    name?: unknown;
    tool_name?: unknown;
    arguments?: unknown;
    input?: unknown;
    params?: unknown;
  };

  if (!candidate.type || !['tool_call', 'tool_use', 'toolUse'].includes(candidate.type)) {
    return undefined;
  }

  const toolName = [candidate.tool, candidate.name, candidate.tool_name].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (!toolName) {
    return undefined;
  }

  const args = asRecord(candidate.arguments ?? candidate.input ?? candidate.params);
  return {
    toolName,
    operation: mapLinearToolOperation(toolName, args),
  };
}

function mapLinearToolOperation(
  toolName: string,
  args: Record<string, unknown> | undefined,
): LinearToolOperation | undefined {
  if (!args) {
    return undefined;
  }

  switch (toolName) {
    case 'linear.createComment':
    case 'linear_create_comment':
      if (typeof args.issueId === 'string' && typeof args.body === 'string') {
        return { kind: 'comment.create', issueId: args.issueId, body: args.body };
      }
      return undefined;
    case 'linear.updateComment':
    case 'linear_update_comment':
      if (typeof args.commentId === 'string' && typeof args.body === 'string') {
        return { kind: 'comment.update', commentId: args.commentId, body: args.body };
      }
      return undefined;
    case 'linear.updateIssueState':
    case 'linear_update_issue_state':
      if (typeof args.issueId === 'string' && typeof args.stateId === 'string') {
        return { kind: 'issue.updateState', issueId: args.issueId, stateId: args.stateId };
      }
      return undefined;
    case 'linear.createAttachment':
    case 'linear_create_attachment':
      if (typeof args.issueId === 'string' && typeof args.title === 'string' && typeof args.url === 'string') {
        return { kind: 'attachment.create', issueId: args.issueId, title: args.title, url: args.url };
      }
      return undefined;
    default:
      return undefined;
  }
}

async function invokeLinearToolBridge(
  bridge: LinearToolBridge | undefined,
  operation: LinearToolOperation | undefined,
) {
  if (!bridge || !operation) {
    return undefined;
  }
  return bridge.invoke(operation);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function emitNormalizedEvent(
  sink: (payload: Record<string, unknown>) => void,
  payload: NormalizedRuntimeEvent,
): void {
  sink(payload);

  if (payload.type !== 'tokenUsage') {
    sink({
      type: 'event',
      timestamp: payload.timestamp,
      agentRole: payload.agentRole,
      agentType: payload.agentType,
      sessionId: payload.sessionId,
    });
  }

  if (payload.type === 'result' && payload.status === 'completed') {
    sink({
      type: 'completed',
      timestamp: payload.timestamp,
      agentRole: payload.agentRole,
      agentType: payload.agentType,
      sessionId: payload.sessionId,
    });
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content.map((part) => {
    if (typeof part === 'string') {
      return part;
    }
    if (!part || typeof part !== 'object') {
      return '';
    }
    const candidate = part as { type?: string; text?: string };
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      return candidate.text;
    }
    if (typeof candidate.text === 'string') {
      return candidate.text;
    }
    return '';
  }).join('');
}
