/**
 * In-process event bus for Phases 0-2.
 *
 * Wraps Node.js EventEmitter to provide type-safe domain event
 * publish/subscribe. Will be replaced by NATS JetStream at Phase 3+.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  DomainEventType,
  DomainEventMap,
} from './event-types';
import type { Logger } from '../shared/logger';

export type EventHandler<T extends DomainEventType> = (
  event: DomainEventMap[T],
) => void | Promise<void>;

export interface EventBus {
  /**
   * Publish a domain event to all subscribers.
   */
  publish<T extends DomainEventType>(event: DomainEventMap[T]): void;

  /**
   * Subscribe to a specific domain event type.
   * Returns an unsubscribe function.
   */
  subscribe<T extends DomainEventType>(
    eventType: T,
    handler: EventHandler<T>,
  ): () => void;

  /**
   * Remove all subscribers (useful for testing teardown).
   */
  removeAllListeners(): void;
}

/**
 * Create a typed in-process event bus backed by Node.js EventEmitter.
 */
export function createEventBus(logger?: Logger): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    publish<T extends DomainEventType>(event: DomainEventMap[T]): void {
      logger?.debug('Event published', {
        eventType: event.type,
        eventId: event.id,
        correlationId: event.correlationId,
      });
      emitter.emit(event.type, event);
    },

    subscribe<T extends DomainEventType>(
      eventType: T,
      handler: EventHandler<T>,
    ): () => void {
      const wrappedHandler = async (event: DomainEventMap[T]) => {
        try {
          await handler(event);
        } catch (err) {
          logger?.error('Event handler error', {
            eventType,
            eventId: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      emitter.on(eventType, wrappedHandler);

      return () => {
        emitter.off(eventType, wrappedHandler);
      };
    },

    removeAllListeners(): void {
      emitter.removeAllListeners();
    },
  };
}

/**
 * Helper to create a domain event with standard envelope fields.
 */
export function createDomainEvent<T extends DomainEventType>(
  type: T,
  payload: DomainEventMap[T]['payload'],
  correlationId?: string,
): DomainEventMap[T] {
  return {
    type,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    correlationId: correlationId ?? randomUUID(),
    payload,
  } as DomainEventMap[T];
}
