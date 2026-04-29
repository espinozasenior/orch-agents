'use client';

import { useEffect, useRef, useState } from 'react';
import type { GapFrame, DroppedFrame, SseEventName } from '@orch-agents/shared';

export interface RunStreamEvent {
  seq: number;
  type: SseEventName;
  /** Parsed JSON payload. For domain events, the full DomainEvent envelope. */
  data: unknown;
  /** When the browser observed the frame. */
  receivedAt: number;
}

export type RunStreamStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface UseRunStreamResult {
  status: RunStreamStatus;
  events: RunStreamEvent[];
  /** Set to a non-null value when the server emits an `event: gap` frame. */
  gap: GapFrame | null;
  /** Total events the server reports as dropped under load on this connection. */
  droppedCount: number;
}

const MAX_BUFFERED_EVENTS = 500;

/**
 * Subscribe to `/api/runs/:planId/events` (SSE). Auto-reconnects via the
 * native EventSource behavior; surfaces gap/dropped frames so the UI can
 * render an honest "history truncated" banner instead of pretending it
 * caught up silently.
 */
export function useRunStream(planId: string | undefined): UseRunStreamResult {
  const [status, setStatus] = useState<RunStreamStatus>('connecting');
  const [events, setEvents] = useState<RunStreamEvent[]>([]);
  const [gap, setGap] = useState<GapFrame | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!planId) {
      setStatus('closed');
      return;
    }
    setStatus('connecting');
    setEvents([]);
    setGap(null);
    setDroppedCount(0);

    const url = `/api/runs/${encodeURIComponent(planId)}/events`;
    const source = new EventSource(url);
    sourceRef.current = source;

    function handleFrame(eventName: SseEventName, raw: MessageEvent) {
      const seq = Number(raw.lastEventId);
      let parsed: unknown;
      try {
        parsed = raw.data ? JSON.parse(raw.data) : null;
      } catch {
        parsed = raw.data;
      }
      if (eventName === 'gap') {
        setGap(parsed as GapFrame);
        return;
      }
      if (eventName === 'dropped') {
        const droppedFrame = parsed as DroppedFrame;
        setDroppedCount((prev) => prev + (droppedFrame?.droppedCount ?? 0));
        return;
      }
      setEvents((prev) => {
        const next = [...prev, { seq, type: eventName, data: parsed, receivedAt: Date.now() }];
        if (next.length > MAX_BUFFERED_EVENTS) next.splice(0, next.length - MAX_BUFFERED_EVENTS);
        return next;
      });
    }

    // EventSource only fires 'message' for unnamed frames. Our server names
    // every frame ('event: <type>'), so we have to addEventListener per type.
    const namedTypes: SseEventName[] = [
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
      'gap',
      'dropped',
    ];
    const listeners: Array<[SseEventName, (e: MessageEvent) => void]> = namedTypes.map(
      (type) => [type, (e) => handleFrame(type, e)],
    );
    for (const [type, fn] of listeners) source.addEventListener(type, fn);

    source.onopen = () => setStatus('open');
    source.onerror = () => {
      // EventSource auto-retries; mark error but don't tear down — the
      // browser will reconnect with Last-Event-ID for free.
      setStatus('error');
    };

    return () => {
      for (const [type, fn] of listeners) source.removeEventListener(type, fn);
      source.close();
      sourceRef.current = null;
      setStatus('closed');
    };
  }, [planId]);

  return { status, events, gap, droppedCount };
}
