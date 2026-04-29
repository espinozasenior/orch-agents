/**
 * Server-Sent Events stream for live run telemetry.
 *
 * Endpoints (mounted onto the web surface alongside /v1/* routes):
 *   GET /v1/events                — global stream, filter via ?planId=X
 *   GET /v1/runs/:planId/events   — convenience alias
 *
 * Wire format:
 *   id: <monotonic seq>\n
 *   event: <type>\n            (optional; defaults to 'message')
 *   data: <json>\n\n
 *
 * Reliability features:
 *   - Monotonic `seq` counter persisted to disk so post-restart ids don't
 *     collide with browser-cached ids. The counter is bumped to `seq + N`
 *     where N is buffered every reload.
 *   - Bounded in-memory replay buffer (default 2000 events). On reconnect
 *     the client sends Last-Event-ID; if older than the buffer's tail seq
 *     we emit `event: gap` so the UI can render "history truncated".
 *   - Per-client bounded outbound queue (default 500). On overflow we
 *     drop-oldest and emit `event: dropped` so the client knows it lost
 *     intermediate events.
 *   - Backpressure: honor `reply.raw.write()` returning false; pause the
 *     subscriber until 'drain' fires.
 *   - Cleanup on ALL three socket-close listeners ('close', 'aborted',
 *     'error') — Fastify only fires one depending on transport state.
 *   - Hard cap on concurrent connections; 503 beyond.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from '../kernel/event-bus';
import type { AnyDomainEvent, DomainEventType } from '../kernel/event-types';
import { requireScope } from './web-auth';

// ---------------------------------------------------------------------------
// Sequence counter (persisted)
// ---------------------------------------------------------------------------

interface PersistedSeqState {
  seq: number;
  lastWrittenAt: string;
}

export interface SeqCounter {
  next(): number;
  current(): number;
  /** Persist immediately (for shutdown). */
  flush(): void;
}

const SEQ_PERSIST_INTERVAL = 1000;

export function createSeqCounter(stateFile: string): SeqCounter {
  mkdirSync(dirname(stateFile), { recursive: true });
  let seq = 0;
  if (existsSync(stateFile)) {
    try {
      const raw = readFileSync(stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedSeqState;
      if (typeof parsed.seq === 'number' && parsed.seq >= 0) {
        // Bump by one persist-interval window so any in-flight ids that
        // weren't yet written never collide with the new monotonic stream.
        seq = parsed.seq + SEQ_PERSIST_INTERVAL;
      }
    } catch { /* ignore corrupt state, start from 0 */ }
  }

  function persist(): void {
    const state: PersistedSeqState = { seq, lastWrittenAt: new Date().toISOString() };
    writeFileSync(stateFile, JSON.stringify(state), 'utf-8');
  }

  let writesSinceFlush = 0;

  return {
    next(): number {
      seq += 1;
      writesSinceFlush += 1;
      if (writesSinceFlush >= SEQ_PERSIST_INTERVAL) {
        writesSinceFlush = 0;
        persist();
      }
      return seq;
    },
    current(): number {
      return seq;
    },
    flush(): void {
      persist();
    },
  };
}

// ---------------------------------------------------------------------------
// Replay buffer
// ---------------------------------------------------------------------------

export interface BufferedEvent {
  seq: number;
  type: string;
  /** Pre-serialized JSON payload (avoids re-stringifying on every fan-out). */
  data: string;
  /** correlationId for filtering by planId via the runs index. */
  correlationId: string;
  /** planId once known (after PlanCreated). */
  planId?: string;
}

export interface ReplayBuffer {
  push(evt: BufferedEvent): void;
  /** Replay events with seq strictly greater than `afterSeq`, optionally filtered. */
  since(afterSeq: number, filter?: (evt: BufferedEvent) => boolean): BufferedEvent[];
  tailSeq(): number; // smallest seq still in buffer
  size(): number;
}

const DEFAULT_REPLAY_CAPACITY = 2000;

export function createReplayBuffer(capacity = DEFAULT_REPLAY_CAPACITY): ReplayBuffer {
  const buf: BufferedEvent[] = [];
  return {
    push(evt) {
      buf.push(evt);
      if (buf.length > capacity) buf.shift();
    },
    since(afterSeq, filter) {
      const out: BufferedEvent[] = [];
      for (const e of buf) {
        if (e.seq > afterSeq && (!filter || filter(e))) out.push(e);
      }
      return out;
    },
    tailSeq() {
      return buf.length > 0 ? buf[0].seq : 0;
    },
    size() {
      return buf.length;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE stream registration
// ---------------------------------------------------------------------------

export interface SseStreamOptions {
  eventBus: EventBus;
  seq: SeqCounter;
  replay: ReplayBuffer;
  /** Maximum concurrent SSE connections. Default 50. */
  maxConnections?: number;
  /** Per-connection outbound queue size before drop-oldest kicks in. Default 500. */
  perClientQueueSize?: number;
  /** Heartbeat interval (ms). Default 25000. */
  heartbeatIntervalMs?: number;
}

const HANDLED_EVENT_TYPES: DomainEventType[] = [
  'IntakeCompleted',
  'PlanCreated',
  'PhaseStarted',
  'PhaseCompleted',
  'AgentSpawned',
  'AgentChunk',
  'AgentCompleted',
  'AgentFailed',
  'AgentCancelled',
  'WorkCompleted',
  'WorkFailed',
  'WorkCancelled',
  'AutomationTriggered',
  'AutomationCompleted',
  'AutomationFailed',
];

interface ClientState {
  reply: FastifyReply;
  queue: string[];
  draining: boolean;
  closed: boolean;
  filterPlanId?: string;
}

export async function registerSseStream(
  fastify: FastifyInstance,
  options: SseStreamOptions,
): Promise<void> {
  const { eventBus, seq, replay } = options;
  const maxConnections = options.maxConnections ?? 50;
  const perClientQueueSize = options.perClientQueueSize ?? 500;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;

  const clients = new Set<ClientState>();
  /** correlationId → planId, populated on PlanCreated for filter()ing. */
  const correlationToPlan = new Map<string, string>();

  // --- Subscribe to the event bus once, fan out to clients ---------------

  function buildBufferedEvent(event: AnyDomainEvent): BufferedEvent {
    const planIdFromEvent = extractPlanId(event);
    if (planIdFromEvent) {
      correlationToPlan.set(event.correlationId, planIdFromEvent);
    }
    return {
      seq: seq.next(),
      type: event.type,
      data: JSON.stringify(event),
      correlationId: event.correlationId,
      planId: planIdFromEvent ?? correlationToPlan.get(event.correlationId),
    };
  }

  const unsubs: Array<() => void> = [];
  for (const t of HANDLED_EVENT_TYPES) {
    unsubs.push(
      eventBus.subscribe(t, (event) => {
        const buffered = buildBufferedEvent(event as AnyDomainEvent);
        replay.push(buffered);
        for (const client of clients) {
          if (client.closed) continue;
          if (client.filterPlanId && buffered.planId !== client.filterPlanId) continue;
          enqueueAndFlush(client, formatEventLine(buffered));
        }
      }),
    );
  }

  function enqueueAndFlush(client: ClientState, line: string): void {
    if (client.closed) return;
    if (client.queue.length >= perClientQueueSize) {
      // Drop oldest and flag it
      const dropped = client.queue.length - perClientQueueSize + 1;
      client.queue.splice(0, dropped);
      const droppedLine = formatRawEvent(seq.next(), 'dropped', JSON.stringify({ droppedCount: dropped }));
      client.queue.push(droppedLine);
    }
    client.queue.push(line);
    if (!client.draining) flush(client);
  }

  function flush(client: ClientState): void {
    while (client.queue.length > 0 && !client.closed) {
      const line = client.queue.shift()!;
      const ok = client.reply.raw.write(line);
      if (!ok) {
        client.draining = true;
        client.reply.raw.once('drain', () => {
          client.draining = false;
          flush(client);
        });
        return;
      }
    }
  }

  function closeClient(client: ClientState): void {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    try {
      client.reply.raw.end();
    } catch {
      // already torn down
    }
  }

  // --- Heartbeat -----------------------------------------------------------

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.closed) continue;
      enqueueAndFlush(client, ': ping\n\n');
    }
  }, heartbeatIntervalMs);
  // Don't keep the process alive purely for heartbeats
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  fastify.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const off of unsubs) off();
    for (const c of [...clients]) closeClient(c);
    seq.flush();
  });

  // --- Route handlers ------------------------------------------------------

  async function streamHandler(
    request: FastifyRequest,
    reply: FastifyReply,
    explicitPlanId: string | undefined,
  ): Promise<void> {
    if (clients.size >= maxConnections) {
      reply.status(503).send({ error: 'too many SSE connections' });
      return;
    }

    const queryPlanId = (request.query as { planId?: string }).planId;
    const filterPlanId = explicitPlanId ?? queryPlanId;

    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const client: ClientState = {
      reply,
      queue: [],
      draining: false,
      closed: false,
      filterPlanId,
    };
    clients.add(client);

    // Replay buffered events newer than Last-Event-ID
    const lastEventIdHeader = request.headers['last-event-id'];
    const lastEventId = typeof lastEventIdHeader === 'string' ? Number(lastEventIdHeader) : 0;
    if (lastEventId > 0 && lastEventId < replay.tailSeq()) {
      // Client is older than what we still have buffered — emit gap frame
      const gapLine = formatRawEvent(
        seq.next(),
        'gap',
        JSON.stringify({ lastSeenId: lastEventId, currentMinId: replay.tailSeq() }),
      );
      enqueueAndFlush(client, gapLine);
    }
    const replayed = replay.since(
      Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0,
      (e) => !filterPlanId || e.planId === filterPlanId,
    );
    for (const evt of replayed) enqueueAndFlush(client, formatEventLine(evt));

    // Initial comment to flush headers cleanly
    enqueueAndFlush(client, ': connected\n\n');

    // Cleanup on every transport-close path Fastify might fire
    const cleanup = (): void => closeClient(client);
    request.raw.on('close', cleanup);
    request.raw.on('aborted', cleanup);
    reply.raw.on('error', cleanup);

    // Keep the connection open by returning a never-resolving promise.
    // Fastify treats this as an active handler; the cleanup hooks above
    // shut everything down when the socket goes away.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (client.closed) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
      if (typeof interval.unref === 'function') interval.unref();
    });
  }

  fastify.get('/v1/events', { preHandler: requireScope('runs:read') }, async (request, reply) => {
    await streamHandler(request, reply, undefined);
  });

  fastify.get<{ Params: { planId: string } }>(
    '/v1/runs/:planId/events',
    { preHandler: requireScope('runs:read') },
    async (request, reply) => {
      await streamHandler(request, reply, request.params.planId);
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatEventLine(buffered: BufferedEvent): string {
  return formatRawEvent(buffered.seq, buffered.type, buffered.data);
}

function formatRawEvent(seqId: number, type: string, data: string): string {
  return `id: ${seqId}\nevent: ${type}\ndata: ${data}\n\n`;
}

function extractPlanId(event: AnyDomainEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  const direct = payload.planId;
  if (typeof direct === 'string') return direct;
  // PlanCreated nests the id inside workflowPlan
  const wp = payload.workflowPlan as { id?: string } | undefined;
  if (wp?.id) return wp.id;
  // PhaseCompleted nests inside phaseResult
  const pr = payload.phaseResult as { planId?: string } | undefined;
  if (pr?.planId) return pr.planId;
  return undefined;
}
