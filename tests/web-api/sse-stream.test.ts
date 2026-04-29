import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { createEventBus, type EventBus } from '../../src/kernel/event-bus';
import {
  createReplayBuffer,
  createSeqCounter,
  registerSseStream,
} from '../../src/web-api/sse-stream';
import { bearerAuth, createWebTokenStore, type WebTokenStore } from '../../src/web-api/web-auth';
import type { IntakeCompletedEvent, PlanCreatedEvent, PhaseCompletedEvent } from '../../src/kernel/event-types';
import type { PlanId, WorkItemId, PhaseId } from '../../src/kernel/branded-types';

function intake(correlationId: string): IntakeCompletedEvent {
  return {
    type: 'IntakeCompleted',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    correlationId,
    payload: {
      intakeEvent: {
        id: 'i1',
        timestamp: new Date().toISOString(),
        source: 'github',
        sourceMetadata: { source: 'github', eventType: 'pr', deliveryId: 'd' },
        entities: { repo: 'a/b' },
      },
    },
  };
}

function planCreated(correlationId: string, planId: PlanId): PlanCreatedEvent {
  return {
    type: 'PlanCreated',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    correlationId,
    payload: { workflowPlan: { id: planId, workItemId: 'w' as WorkItemId, agentTeam: [] } },
  };
}

function phaseCompleted(correlationId: string, planId: PlanId): PhaseCompletedEvent {
  return {
    type: 'PhaseCompleted',
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    correlationId,
    payload: {
      phaseResult: {
        phaseId: 'p1' as PhaseId,
        planId,
        phaseType: 'specification',
        status: 'completed',
        artifacts: [],
        metrics: { duration: 100, agentUtilization: 0.5, modelCost: 0 },
      },
    },
  };
}

interface FrameBatch {
  raw: string;
  frames: Array<{ id: number; event: string; data: string }>;
}

function parseFrames(raw: string): FrameBatch {
  const frames = raw
    .split('\n\n')
    .filter((f) => f.trim().length > 0 && !f.startsWith(': '))
    .map((f) => {
      const lines = f.split('\n');
      const out: { id: number; event: string; data: string } = { id: 0, event: 'message', data: '' };
      for (const line of lines) {
        if (line.startsWith('id: ')) out.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) out.event = line.slice(7);
        else if (line.startsWith('data: ')) out.data = line.slice(6);
      }
      return out;
    });
  return { raw, frames };
}

async function readForMs(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let collected = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (result.done) break;
      if (result.value) collected += decoder.decode(result.value, { stream: true });
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return collected;
}

describe('SSE stream', () => {
  let tmp: string;
  let server: FastifyInstance;
  let bus: EventBus;
  let baseUrl: string;
  let tokenStore: WebTokenStore;
  let token: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sse-stream-'));
    bus = createEventBus();
    tokenStore = createWebTokenStore(join(tmp, 'tokens.db'));
    token = tokenStore.mint({ label: 'sse', scopes: ['runs:read'] }).token;

    const seq = createSeqCounter(join(tmp, 'sse-state.json'));
    const replay = createReplayBuffer(100);

    server = Fastify({ logger: false });
    server.addHook('onRequest', bearerAuth(tokenStore));
    await server.register((instance) =>
      registerSseStream(instance, {
        eventBus: bus,
        seq,
        replay,
        maxConnections: 5,
        perClientQueueSize: 50,
        heartbeatIntervalMs: 60_000,
      }),
    );
    await server.ready();
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  after(async () => {
    await server.close();
    tokenStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('streams events as they fire on the bus', async () => {
    const res = await fetch(`${baseUrl}/v1/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    // Fire some events while reading
    setTimeout(() => {
      bus.publish(intake('corr-A'));
      bus.publish(planCreated('corr-A', 'plan-A' as PlanId));
      bus.publish(phaseCompleted('corr-A', 'plan-A' as PlanId));
    }, 50);

    const raw = await readForMs(res.body!, 500);
    const { frames } = parseFrames(raw);

    const eventTypes = frames.map((f) => f.event);
    assert.ok(eventTypes.includes('IntakeCompleted'));
    assert.ok(eventTypes.includes('PlanCreated'));
    assert.ok(eventTypes.includes('PhaseCompleted'));

    // Sequence ids must be monotonically increasing
    const seqs = frames.map((f) => f.id).filter((n) => n > 0);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `seq must be monotonic, got ${seqs[i - 1]} -> ${seqs[i]}`);
    }
  });

  it('filters by planId on /v1/runs/:planId/events', async () => {
    const res = await fetch(`${baseUrl}/v1/runs/plan-X/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    setTimeout(() => {
      // Different plans
      bus.publish(intake('corr-X'));
      bus.publish(planCreated('corr-X', 'plan-X' as PlanId));
      bus.publish(intake('corr-Y'));
      bus.publish(planCreated('corr-Y', 'plan-Y' as PlanId));
      bus.publish(phaseCompleted('corr-X', 'plan-X' as PlanId));
    }, 50);

    const raw = await readForMs(res.body!, 500);
    const { frames } = parseFrames(raw);
    // Only events tied to plan-X (or correlationId mapped to it) should appear
    for (const f of frames) {
      if (f.event === 'message' || f.data === '') continue;
      const parsed = JSON.parse(f.data) as { correlationId: string };
      assert.equal(parsed.correlationId, 'corr-X', `unexpected correlationId on ${f.event}`);
    }
  });

  it('caps concurrent connections and 503s beyond the limit', async () => {
    const opens: Array<Promise<Response>> = [];
    for (let i = 0; i < 5; i++) {
      opens.push(
        fetch(`${baseUrl}/v1/events`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    }
    const responses = await Promise.all(opens);
    for (const r of responses) assert.equal(r.status, 200);

    // Sixth must 503
    const sixth = await fetch(`${baseUrl}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(sixth.status, 503);
    // Cleanup
    for (const r of responses) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  });

  it('returns 401 without bearer token', async () => {
    const res = await fetch(`${baseUrl}/v1/events`);
    assert.equal(res.status, 401);
    try { await res.body?.cancel(); } catch { /* ignore */ }
  });
});
