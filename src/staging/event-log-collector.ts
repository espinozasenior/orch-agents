/**
 * Event Log Collector for staging validation.
 *
 * Subscribes to the event bus and captures all domain events during a
 * validation run. Provides an observable timeline of events for
 * verifying the webhook intake → execution attempt → completion flow.
 */

import type { EventBus } from '../kernel/event-bus';
import type { DomainEventType, DomainEventMap } from '../kernel/event-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CollectedEvent {
  /** Domain event type (e.g. 'IntakeCompleted', 'PlanCreated') */
  type: string;
  /** Event unique ID */
  eventId: string;
  /** Correlation ID linking events in the same flow */
  correlationId: string;
  /** ISO timestamp when the event was captured */
  capturedAt: string;
  /** Event payload (shallow copy) */
  payload: unknown;
}

export interface EventLogCollector {
  /** All events captured so far, ordered by capture time */
  readonly events: ReadonlyArray<CollectedEvent>;
  /** Stop collecting events and unsubscribe from the event bus */
  stop(): void;
  /** Wait until an event of the given type appears, or timeout */
  waitFor(eventType: string, timeoutMs?: number): Promise<CollectedEvent>;
  /** Clear all collected events */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Monitored event types for staging validation
// ---------------------------------------------------------------------------

const MONITORED_EVENTS: DomainEventType[] = [
  'IntakeCompleted',
  'WorkTriaged',
  'PlanCreated',
  'PhaseStarted',
  'PhaseCompleted',
  'WorkCompleted',
  'WorkFailed',
  'WorkCancelled',
  'AgentSpawned',
  'AgentCompleted',
  'AgentFailed',
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an event log collector that subscribes to key domain events.
 */
export function createEventLogCollector(eventBus: EventBus): EventLogCollector {
  const collected: CollectedEvent[] = [];
  const unsubscribers: Array<() => void> = [];
  const waiters: Array<{ type: string; resolve: (event: CollectedEvent) => void }> = [];

  for (const eventType of MONITORED_EVENTS) {
    const unsub = eventBus.subscribe(eventType, (event: DomainEventMap[typeof eventType]) => {
      const entry: CollectedEvent = {
        type: event.type,
        eventId: event.id,
        correlationId: event.correlationId,
        capturedAt: new Date().toISOString(),
        payload: event.payload,
      };
      collected.push(entry);

      // Resolve any pending waiters for this event type
      const pending = waiters.filter(w => w.type === event.type);
      for (const waiter of pending) {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        waiter.resolve(entry);
      }
    });
    unsubscribers.push(unsub);
  }

  return {
    get events() {
      return collected;
    },

    stop() {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
    },

    waitFor(eventType: string, timeoutMs = 5000): Promise<CollectedEvent> {
      // Check if already captured
      const existing = collected.find(e => e.type === eventType);
      if (existing) return Promise.resolve(existing);

      return new Promise<CollectedEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for event '${eventType}' after ${timeoutMs}ms`));
        }, timeoutMs);

        waiters.push({
          type: eventType,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },

    clear() {
      collected.length = 0;
    },
  };
}
