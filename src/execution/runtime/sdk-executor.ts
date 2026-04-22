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
import { evaluatePermission } from './permission-evaluator';
import type { SessionPermissionPolicy as EvaluatorPolicy } from './permission-evaluator';
import type { EventBus } from '../../kernel/event-bus';
import {
  callWithOverloadRetry,
  createWorkCancelledStopRegistry,
  OverloadExhaustedError,
  OverloadAbortedError,
  type QueryEventEmitter,
  type OverloadRetryOptions,
} from '../../query';
import type {
  InteractiveTaskExecutor,
  InteractiveExecutionRequest,
} from './interactive-executor';
import type { TaskExecutionResult } from './task-executor';
import { AgentRunner } from './agent-runner';
import { MemoryTransport } from './transport-inbound';
import { AgentMessageType } from './agent-message-types';

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
  }
  | {
    type: 'agentSpawn';
    timestamp: number;
    agentRole: string;
    agentType: string;
    sessionId?: string;
    childPrompt?: string;
    childSubagentType?: string;
  };

export interface SdkExecutorDeps {
  logger?: Logger;
  allowedTools?: string[];
  queryFactory?: QueryFactory;
  eventSink?: (payload: Record<string, unknown>) => void;
  linearToolBridge?: LinearToolBridge;
  /** 9A: Use AgentRunner async iterator loop instead of raw SDK query. */
  useAgentRunner?: boolean;
  /** P6: Optional TaskRegistry for lifecycle transitions. */
  taskRegistry?: import('../task/taskRegistry').TaskRegistry;
  /** P6: Optional TaskOutputWriter for JSONL progress logging. */
  taskOutputWriter?: import('../task/taskOutputWriter').TaskOutputWriter;
  /** P7: Optional permission policy for evaluating child permission requests. */
  permissionPolicy?: EvaluatorPolicy;
  /** P11: Optional EventBus — when supplied, WorkCancelled domain events
   *  will abort an in-flight SDK execution for the matching workItemId. */
  eventBus?: Pick<EventBus, 'subscribe'>;
  /** P11: Optional observability emitter — receives QueryLoopEvent payloads
   *  for overload retries and stop-hook firings. */
  emitQueryEvent?: QueryEventEmitter;
  /** P11: Override overload retry tuning (tests + advanced configs). */
  overloadRetry?: Pick<
    OverloadRetryOptions,
    'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio' | 'sleep' | 'random'
  >;
  /** P12: Optional deferred-tool registry. When supplied, the executor's
   *  allowedTools list is derived from the registry instead of the
   *  hardcoded default. Omitting it preserves prior behavior exactly. */
  deferredToolRegistry?: import('../../services/deferred-tools').DeferredToolRegistry;
  /** Current agent depth for depth limiting. 0 = top-level coordinator.
   *  When agentDepth >= MAX_AGENT_DEPTH (3), Agent/AgentTool are removed
   *  from allowedTools to prevent further sub-spawning. */
  agentDepth?: number;
  /** Maximum agent depth before Agent tool is removed. Defaults to 3. */
  maxAgentDepth?: number;
}

export function createSdkExecutor(deps: SdkExecutorDeps = {}): InteractiveTaskExecutor {
  const logger = deps.logger;
  // P12: prefer deferredToolRegistry → explicit allowedTools → hardcoded default.
  let allowedTools =
    deps.deferredToolRegistry?.list().map((t) => t.name)
    ?? deps.allowedTools
    ?? ['Edit', 'Write', 'Read', 'Bash', 'Grep', 'Glob'];

  // Step 5: Depth limiting — remove Agent/AgentTool when at max depth
  const currentDepth = deps.agentDepth ?? 0;
  const maxAgentDepth = deps.maxAgentDepth ?? 3;
  if (currentDepth >= maxAgentDepth) {
    allowedTools = allowedTools.filter((t) => t !== 'Agent' && t !== 'AgentTool');
  }
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

      // 9A: AgentRunner path — async iterator with built-in compaction + budget
      if (deps.useAgentRunner) {
        try {
          const transport = new MemoryTransport();
          await transport.connect();
          const history: unknown[] = [];
          let tokenCount = 0;
          const runner = new AgentRunner({
            transport,
            deps: {
              countTokens: (payload: unknown) => JSON.stringify(payload).length / 4,
              executeTask: async (payload: unknown) => payload,
              sendResponse: () => {},
              compactHistory: async (h: unknown[]) => h.slice(-5),
              getCurrentTokenCount: () => tokenCount,
              getConversationHistory: () => history,
              setConversationHistory: (h: unknown[]) => { history.length = 0; history.push(...h); tokenCount = JSON.stringify(h).length / 4; },
            },
            config: { contextWindow: 200_000, maxTasks: 200 },
            logger,
          });

          const effectivePrompt = request.forkContextPrefix
            ? `${request.forkContextPrefix}\n\n${request.prompt}`
            : request.prompt;
          transport.push({
            id: `task-${Date.now()}`,
            timestamp: Date.now(),
            type: AgentMessageType.UserTask,
            payload: { prompt: effectivePrompt, cwd: resolvedWorktree },
          });
          transport.end();

          let output = '';
          for await (const msg of runner.messageStream()) {
            if (typeof msg === 'object' && msg !== null && 'output' in msg) {
              output += String((msg as Record<string, unknown>).output ?? '');
            }
          }

          return {
            status: 'completed' as const,
            output,
            duration: Date.now() - startTime,
          };
        } catch (err) {
          return {
            status: 'failed' as const,
            output: '',
            duration: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // P11: Per-execution AbortController + WorkCancelled bridge.
      // The orchestrator passes workItemId via request.metadata; when an
      // EventBus is wired, we register a stop hook that aborts this
      // controller the moment WorkCancelled fires. The controller is
      // also checked between SDK events so iteration halts within one
      // event of the cancellation.
      const metaWorkItemId = (request.metadata as Record<string, unknown> | undefined)?.workItemId as string | undefined;
      const sdkAbortController = new AbortController();
      let unbindAbort: (() => void) | undefined;
      let stopRegistry: ReturnType<typeof createWorkCancelledStopRegistry> | undefined;
      if (deps.eventBus && metaWorkItemId) {
        stopRegistry = createWorkCancelledStopRegistry(deps.eventBus, {
          emit: deps.emitQueryEvent,
        });
        unbindAbort = stopRegistry.bindAbortController(metaWorkItemId, sdkAbortController);
      }

      try {
        const createQuery = deps.queryFactory ?? await resolveQueryFactory();
        // When fork context is provided, prepend it to the prompt so the
        // forked child inherits the parent conversation as additional context.
        const effectivePrompt = request.forkContextPrefix
          ? `${request.forkContextPrefix}\n\n${request.prompt}`
          : request.prompt;
        // P11: wrap the SDK stream construction with overload retry.
        // 529 / overloaded_error responses are retried with exponential
        // backoff (1s, 2s, 4s, 8s ±25%) up to 4 times. Non-overload
        // errors propagate immediately.
        const stream = await callWithOverloadRetry(
          () => Promise.resolve(createQuery({
            prompt: effectivePrompt,
            cwd: resolvedWorktree,
            allowedTools,
            maxTurns: Math.max(1, Math.floor(request.timeout / 60_000)) || 20,
            permissionPolicy,
            linearToolBridge: deps.linearToolBridge,
          })),
          {
            ...(deps.overloadRetry ?? {}),
            signal: sdkAbortController.signal,
            emit: deps.emitQueryEvent,
            taskId: (request.metadata as Record<string, unknown> | undefined)?.taskId as string | undefined,
          },
        );

        let output = '';
        let tokenUsage: TaskExecutionResult['tokenUsage'];
        let resultError: string | undefined;
        let completed = false;
        let sessionId: string | undefined;
        let lastActivityAt: string | undefined;
        let continuationState: TaskExecutionResult['continuationState'];
        // P6: Task backbone tracking
        const metaTaskId = (request.metadata as Record<string, unknown> | undefined)?.taskId as string | undefined;
        let taskTransitionedToRunning = false;

        for await (const event of stream) {
          // P11: bail out promptly if WorkCancelled flipped the abort
          // controller mid-stream. Best-effort — we cannot interrupt the
          // SDK's internal generator, but we stop consuming + reporting.
          if (sdkAbortController.signal.aborted) {
            resultError = 'cancelled';
            break;
          }
          const activityTimestamp = Date.now();
          lastActivityAt = new Date(activityTimestamp).toISOString();
          sessionId = extractSessionId(event) ?? sessionId;

          // P6: Transition pending -> running on first SDK event
          if (!taskTransitionedToRunning && metaTaskId && deps.taskRegistry) {
            const currentTask = deps.taskRegistry.get(metaTaskId);
            if (currentTask && currentTask.status === 'pending') {
              const { transition: tsTransition, TaskStatus: TS } = await import('../task');
              const running = tsTransition(currentTask, TS.running);
              deps.taskRegistry.update(metaTaskId, running);
            }
            taskTransitionedToRunning = true;
          }

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
            // P6: Append progress to JSONL output file
            if (metaTaskId && deps.taskOutputWriter) {
              deps.taskOutputWriter.append(metaTaskId, {
                timestamp: activityTimestamp,
                delta: eventText,
                sessionId,
              });
            }
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

            // Step 2: AgentTool event interception — emit agentSpawn observability event
            if (toolEvent.toolName === 'Agent' || toolEvent.toolName === 'AgentTool') {
              const agentArgs = extractAgentToolArgs(event);
              emitNormalizedEvent(eventSink, {
                type: 'agentSpawn',
                timestamp: activityTimestamp,
                agentRole: request.agentRole,
                agentType: request.agentType,
                sessionId,
                childPrompt: agentArgs?.prompt?.slice(0, 200),
                childSubagentType: agentArgs?.subagentType,
              });
            }
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
          // P6: Transition task to failed
          if (metaTaskId && deps.taskRegistry) {
            try {
              const currentTask = deps.taskRegistry.get(metaTaskId);
              if (currentTask && currentTask.status === 'running') {
                const { transition: tsTransition, TaskStatus: TS } = await import('../task');
                const failed = tsTransition(currentTask, TS.failed);
                deps.taskRegistry.update(metaTaskId, failed);
              }
            } catch { /* best effort */ }
          }
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

        // P6: Transition task to completed
        if (metaTaskId && deps.taskRegistry) {
          try {
            const currentTask = deps.taskRegistry.get(metaTaskId);
            if (currentTask && currentTask.status === 'running') {
              const { transition: tsTransition, TaskStatus: TS } = await import('../task');
              const done = tsTransition(currentTask, TS.completed);
              deps.taskRegistry.update(metaTaskId, done);
            }
          } catch { /* best effort */ }
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
        // P11: tag overload-specific failures so callers can distinguish.
        let message = err instanceof Error ? err.message : String(err);
        if (err instanceof OverloadExhaustedError) {
          message = `overloaded_exhausted: ${message}`;
        } else if (err instanceof OverloadAbortedError) {
          message = 'cancelled';
        }
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
      } finally {
        // P11: ensure the WorkCancelled subscription + abort binding are
        // released even on early returns / exceptions. No leaked
        // listeners (NFR-P11-003).
        try { unbindAbort?.(); } catch { /* best effort */ }
        try { stopRegistry?.dispose(); } catch { /* best effort */ }
      }
    },
  };
}

/**
 * P7: Evaluate a permission request against the executor's policy.
 * Used by session-runner / swarm-daemon when a child sends a permission_request.
 */
export function evaluateSessionPermission(
  request: { tool: string; args?: Record<string, unknown> },
  policy: EvaluatorPolicy | SessionPermissionPolicy,
): { approved: boolean; reason?: string } {
  return evaluatePermission(
    { tool: request.tool, args: request.args },
    { allowedTools: policy.allowedTools, writableRoots: policy.writableRoots },
  );
}

/**
 * P7: Build a permission policy from agent role and worktree path.
 */
export { buildSessionPolicy } from './permission-evaluator';

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

/**
 * Extract AgentTool arguments (prompt, subagent_type, description) from a tool
 * call event. Returns undefined if the event doesn't contain parseable args.
 */
function extractAgentToolArgs(
  event: unknown,
): { prompt?: string; subagentType?: string; description?: string } | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    arguments?: unknown;
    input?: unknown;
    params?: unknown;
  };

  const args = asRecord(candidate.input ?? candidate.arguments ?? candidate.params);
  if (!args) {
    return undefined;
  }

  return {
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
    subagentType: typeof args.subagent_type === 'string'
      ? args.subagent_type
      : typeof args.subagentType === 'string'
        ? args.subagentType
        : undefined,
    description: typeof args.description === 'string' ? args.description : undefined,
  };
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
