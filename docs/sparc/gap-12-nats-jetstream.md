# SPARC Gap 12: NATS JetStream Event Bus

## Scalable Event Bus with Persistence, Backpressure, and Exactly-Once Delivery

## Priority: P2
## Estimated Effort: 14-21 days
## Status: Planning

---

## Problem Statement

The event bus is an in-process EventEmitter (`src/shared/event-bus.ts`). It cannot scale to multiple orchestrator instances, events are lost on process restart, there is no backpressure mechanism, and no event replay capability. The architecture doc explicitly mentions NATS JetStream as the Phase 3+ upgrade path, and `event-types.ts` header comments reference this plan. With 28+ domain event types flowing between bounded contexts (webhook-gateway, triage, planning, execution, review), the in-memory bus is a single point of failure and a scaling bottleneck.

---

## S -- Specification

### Requirements

1. **R1 -- NatsEventBus implementation.** Create `src/shared/event-bus-nats.ts` implementing the existing `EventBus` interface (`publish`, `subscribe`, `removeAllListeners`). Use NATS JetStream for persistent, exactly-once message delivery.

2. **R2 -- JetStream subject mapping.** Map domain events to JetStream subjects: `orch.events.{eventType}` (e.g., `orch.events.IntakeCompleted`, `orch.events.PhaseStarted`). Single stream `ORCH_EVENTS` captures all subjects via wildcard `orch.events.>`.

3. **R3 -- Durable consumers.** One durable consumer per bounded context: `webhook-gateway`, `triage`, `planning`, `execution`, `review`. Each consumer receives all events but only processes those it subscribes to. Consumer names: `orch-{context}` (e.g., `orch-triage`).

4. **R4 -- Event bus factory.** Create `src/shared/event-bus-factory.ts` with `createEventBus(config)` that returns `NatsEventBus` when `EVENT_BUS=nats` or the existing in-memory EventBus when `EVENT_BUS=memory` (default).

5. **R5 -- Serialization.** Events serialized as JSON with the `type` field as discriminator. `publish()` serializes `DomainEventMap[T]` to JSON bytes. Consumers deserialize and dispatch to the correct typed handler.

6. **R6 -- Backpressure.** Use JetStream pull-based consumers. Each consumer pulls messages in configurable batches (default: 10). If processing falls behind, messages remain in the stream until pulled. No unbounded in-memory queuing.

7. **R7 -- Event persistence and replay.** JetStream file storage backend. Stream retention: `limits` policy, `max_age=24h`, `max_msgs=100000`. Enables event replay for debugging and late-joining consumers.

8. **R8 -- Health check integration.** `NatsEventBus` exposes `isConnected(): boolean`. The existing `GET /health` endpoint includes NATS connection status when NATS bus is active.

9. **R9 -- Graceful degradation.** If NATS is unavailable at startup, fall back to in-memory EventBus with a `warn`-level log. If NATS disconnects at runtime, buffer events in-memory (max 1000) and attempt reconnection.

10. **R10 -- Connection configuration.** Environment variables: `NATS_URL` (default: `nats://localhost:4222`), `NATS_USER`, `NATS_PASS`, `NATS_TLS` (boolean, enables TLS).

### Acceptance Criteria

- AC1: With `EVENT_BUS=nats` and NATS running, `publish(IntakeCompleted)` delivers the event to a subscriber in a separate consumer group.
- AC2: After restarting the orchestrator process, a new consumer with the same durable name receives events published before restart (replay from stream).
- AC3: With `EVENT_BUS=memory`, behavior is identical to current implementation (zero regressions).
- AC4: Publishing 1000 events/second for 10 seconds does not cause unbounded memory growth (pull-based consumer controls intake).
- AC5: When NATS is down, `createEventBus({ bus: 'nats' })` returns in-memory fallback with warning log.
- AC6: `GET /health` returns `{ nats: { connected: true, stream: 'ORCH_EVENTS', consumers: 5 } }` when NATS is active.
- AC7: All 28+ existing domain event types are publishable and subscribable via NatsEventBus.
- AC8: `removeAllListeners()` drains all NATS subscriptions without leaving orphaned consumers.

### Constraints

- Must implement the existing `EventBus` interface exactly -- `{ publish, subscribe, removeAllListeners }`.
- Must use the `nats` npm package (official NATS.js client), not `nats.ws` or third-party wrappers.
- Must not change the `DomainEventType` or `DomainEventMap` types -- serialization handles existing types.
- NATS server is an external dependency managed by infrastructure, not bundled with the application.
- All existing event bus tests must pass when `EVENT_BUS=memory`.
- JetStream stream and consumers are created idempotently (safe to run on every startup).

### Edge Cases

- NATS connection lost mid-publish -- buffer event, retry on reconnect.
- Consumer processing throws -- NATS message is not ack'd, redelivered after `ack_wait` (30s default).
- Two orchestrator instances publish the same event type -- JetStream handles concurrent publishers natively.
- Stream reaches max_msgs limit -- oldest messages are discarded (limits retention policy).
- Subscriber registered after events already published -- durable consumer replays from last acknowledged position.
- `removeAllListeners()` called while messages are in-flight -- drain subscriptions, wait for in-flight to complete.
- NATS TLS certificate validation fails -- log error, fall back to in-memory.
- Consumer group name collision with non-orchestrator NATS clients -- namespace with `orch-` prefix.

---

## P -- Pseudocode

### P1 -- NatsEventBus

```
class NatsEventBus implements EventBus:
  nc: NatsConnection
  js: JetStreamClient
  jsm: JetStreamManager
  subscriptions: Map<string, NatsSubscription[]>
  buffer: DomainEvent[]  // for disconnect buffering
  logger: Logger

  static async create(config: NatsConfig, logger?) -> NatsEventBus:
    nc = await connect({
      servers: config.url,
      user: config.user,
      pass: config.pass,
      tls: config.tls ? { } : undefined,
      reconnect: true,
      maxReconnectAttempts: -1,  // infinite
      reconnectTimeWait: 1000,
    })

    js = nc.jetstream()
    jsm = await nc.jetstreamManager()

    // Ensure stream exists (idempotent)
    await jsm.streams.add({
      name: 'ORCH_EVENTS',
      subjects: ['orch.events.>'],
      retention: RetentionPolicy.Limits,
      max_age: nanos(24 * 60 * 60 * 1000),  // 24h
      max_msgs: 100000,
      storage: StorageType.File,
    }).catch(() => jsm.streams.update(...))  // update if exists

    bus = new NatsEventBus(nc, js, jsm, logger)

    nc.status().then(async (status) => {
      for await (s of status):
        if s.type === 'disconnect':
          logger?.warn('NATS disconnected, buffering events')
        if s.type === 'reconnect':
          logger?.info('NATS reconnected, flushing buffer')
          bus.flushBuffer()
    })

    return bus

  publish<T extends DomainEventType>(event: DomainEventMap[T]):
    subject = `orch.events.${event.type}`
    data = JSON.stringify(event)

    if !nc.isClosed():
      js.publish(subject, encode(data))
    else:
      if buffer.length < 1000:
        buffer.push(event)
      else:
        logger?.error('Event buffer full, dropping event', { type: event.type })

  subscribe<T extends DomainEventType>(
    eventType: T,
    handler: EventHandler<T>,
    consumerName?: string
  ) -> () => void:
    subject = `orch.events.${eventType}`
    durable = consumerName ?? `orch-default`

    // Create or bind to durable pull consumer
    consumer = await js.consumers.get('ORCH_EVENTS', durable)
      .catch(() => jsm.consumers.add('ORCH_EVENTS', {
        durable_name: durable,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        ack_wait: nanos(30000),
        deliver_policy: DeliverPolicy.Last,
      }))

    // Start pull loop
    sub = await consumer.consume({
      max_messages: 10,  // batch size
      callback: async (msg) => {
        try:
          event = JSON.parse(decode(msg.data)) as DomainEventMap[T]
          await handler(event)
          msg.ack()
        catch error:
          logger?.error('Handler error, will redeliver', { eventType, error })
          // Do NOT ack -- NATS will redeliver after ack_wait
    })

    subscriptions.get(eventType)?.push(sub) ?? subscriptions.set(eventType, [sub])

    return () => {
      sub.unsubscribe()
      subs = subscriptions.get(eventType)
      if subs: subscriptions.set(eventType, subs.filter(s => s !== sub))
    }

  removeAllListeners():
    for [type, subs] of subscriptions:
      for sub of subs:
        sub.drain()
    subscriptions.clear()

  isConnected() -> boolean:
    return !nc.isClosed()

  async flushBuffer():
    while buffer.length > 0:
      event = buffer.shift()
      publish(event)

  async close():
    await removeAllListeners()
    await nc.drain()
    await nc.close()
```

### P2 -- Event Bus Factory

```
interface EventBusConfig:
  bus: 'memory' | 'nats'
  nats?: NatsConfig
  logger?: Logger

interface NatsConfig:
  url: string        // default: nats://localhost:4222
  user?: string
  pass?: string
  tls?: boolean

async function createEventBus(config: EventBusConfig) -> EventBus:
  if config.bus === 'nats':
    try:
      return await NatsEventBus.create(config.nats, config.logger)
    catch error:
      config.logger?.warn('NATS unavailable, falling back to in-memory', { error })
      return createInMemoryEventBus(config.logger)
  else:
    return createInMemoryEventBus(config.logger)

function createEventBusFromEnv(logger?) -> Promise<EventBus>:
  config = {
    bus: process.env.EVENT_BUS ?? 'memory',
    nats: {
      url: process.env.NATS_URL ?? 'nats://localhost:4222',
      user: process.env.NATS_USER,
      pass: process.env.NATS_PASS,
      tls: process.env.NATS_TLS === 'true',
    },
    logger,
  }
  return createEventBus(config)
```

### P3 -- Health Check Integration

```
function createNatsHealthCheck(eventBus: EventBus) -> HealthCheck:
  return {
    name: 'nats',
    check():
      if eventBus is NatsEventBus:
        return {
          connected: eventBus.isConnected(),
          stream: 'ORCH_EVENTS',
          consumers: eventBus.consumerCount(),
        }
      else:
        return { type: 'memory', note: 'in-process event bus' }
  }
```

### Complexity Analysis

- Publish: O(1) -- single JetStream publish call
- Subscribe: O(1) setup, O(B) per pull batch where B = batch size
- Buffer flush: O(N) where N = buffered events (max 1000)
- removeAllListeners: O(S) where S = total subscription count
- Health check: O(1)

---

## A -- Architecture

### New Components

```
src/shared/
  event-bus-nats.ts        -- NatsEventBus implementing EventBus interface
  event-bus-factory.ts     -- createEventBus(config), createEventBusFromEnv()
  nats-health.ts           -- NATS health check for /health endpoint
```

### Modified Components

```
src/shared/event-bus.ts    -- Rename createEventBus -> createInMemoryEventBus (re-export old name)
src/server.ts              -- Use createEventBusFromEnv(), add NATS health check
src/index.ts               -- Wire event bus factory
src/pipeline.ts            -- Accept EventBus from factory (no change to interface)
```

### Component Diagram

```
                        EventBus interface
                       /                  \
           InMemoryEventBus          NatsEventBus
           (EventEmitter)            (JetStream)
                                          |
                                    NATS Server
                                          |
                                    Stream: ORCH_EVENTS
                                    Subjects: orch.events.>
                                          |
                     +--------------------+--------------------+
                     |                    |                    |
              orch-webhook         orch-triage          orch-execution
              (durable)            (durable)            (durable)
                     |                    |                    |
              orch-planning        orch-review
              (durable)            (durable)
```

### Event Flow (NATS Mode)

```
Producer (any bounded context)
  -> NatsEventBus.publish(event)
    -> JetStream publish to orch.events.{type}
      -> Stream: ORCH_EVENTS (persisted to disk)
        -> Durable consumer: orch-{context}
          -> Pull batch (10 messages)
            -> handler(event)
              -> msg.ack()
```

### Integration Points

1. **Pipeline** -- `createPipeline()` already accepts `EventBus`. No interface change needed. Factory provides the correct implementation.
2. **Server** -- `src/server.ts` switches from `createEventBus(logger)` to `createEventBusFromEnv(logger)`. Health endpoint augmented.
3. **Bounded Contexts** -- Each context's subscriber code is unchanged. The EventBus interface is the same. Consumer group assignment happens at subscription time via the factory.
4. **Docker/Infrastructure** -- NATS server runs as a sidecar or shared service. Docker Compose config adds `nats:2.10` image with JetStream enabled (`-js`).

### Key Design Decisions

1. **Pull-based consumers over push-based.** Push consumers require complex flow control and can overwhelm slow handlers. Pull-based consumers let each bounded context control its own processing rate, providing natural backpressure.

2. **Single stream with filter subjects.** One `ORCH_EVENTS` stream with wildcard `orch.events.>` is simpler to manage than 28+ individual streams. Consumers use `filter_subject` to receive only their subscribed event types.

3. **Graceful degradation to in-memory.** NATS is an infrastructure dependency. The orchestrator must function (with reduced capability) when NATS is unavailable. Fallback is logged at `warn` level so operators notice.

4. **Idempotent stream/consumer creation.** Every startup attempts to create the stream and consumers. If they already exist, the operation is a no-op. This eliminates the need for separate migration scripts.

5. **Buffer limit of 1000 during disconnect.** Prevents unbounded memory growth during extended NATS outages. Events beyond the limit are dropped with error-level logging. Operators must monitor for these drops.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| NATS server unavailable | MEDIUM | Graceful degradation to in-memory bus with warning |
| Message ordering across consumers | LOW | JetStream preserves per-subject ordering. Cross-subject ordering not guaranteed but not required. |
| Ack timeout too short | LOW | Default 30s is generous. Configurable via consumer options. |
| Stream storage disk exhaustion | MEDIUM | max_msgs=100000 and max_age=24h limit growth. Monitor disk usage. |
| Serialization/deserialization mismatch | LOW | JSON with type discriminator. TypeScript compiler ensures type safety at publish time. |
| Migration from memory to NATS loses in-flight events | LOW | Deploy NATS consumers first (they start from latest). Existing in-flight events complete normally. |
| Connection credential management | MEDIUM | NATS_USER/NATS_PASS via env vars (never hardcoded). TLS for wire encryption. |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: event-bus-factory.ts + tests (0 external dependencies)

Tests (London School -- mock both bus implementations):
- `createEventBus({ bus: 'memory' })` returns InMemoryEventBus
- `createEventBus({ bus: 'nats', nats: config })` attempts NatsEventBus.create
- When NatsEventBus.create throws, falls back to InMemoryEventBus with warning
- `createEventBusFromEnv()` reads EVENT_BUS, NATS_URL, NATS_USER, NATS_PASS, NATS_TLS
- Default config: `EVENT_BUS=memory`, `NATS_URL=nats://localhost:4222`

### Step 2: event-bus-nats.ts serialization + tests (mock NATS connection)

Tests (mock nats.connect, JetStream client):
- `publish(event)` serializes event to JSON and publishes to correct subject
- Subject format: `orch.events.{event.type}`
- Published data round-trips through JSON.parse back to original event shape
- All 28+ DomainEventType values produce valid subjects
- Event envelope fields (id, timestamp, correlationId, payload) preserved

### Step 3: event-bus-nats.ts subscribe + tests (mock NATS consumer)

Tests (mock JetStream consumer):
- `subscribe('IntakeCompleted', handler)` creates consumer with correct filter_subject
- Handler receives deserialized event with correct type
- Message is ack'd after successful handler execution
- Message is NOT ack'd when handler throws (will redeliver)
- Returned unsubscribe function removes subscription
- Multiple subscribers to same event type all receive the event

### Step 4: event-bus-nats.ts connection lifecycle + tests

Tests (mock NATS connection status):
- `NatsEventBus.create()` connects and creates ORCH_EVENTS stream
- Stream creation is idempotent (no error if exists)
- `isConnected()` returns true when connected
- `isConnected()` returns false after disconnect
- Disconnect triggers event buffering
- Reconnect flushes buffer
- Buffer respects 1000 event limit
- `close()` drains subscriptions and closes connection
- `removeAllListeners()` drains all subscriptions

### Step 5: event-bus-nats.ts integration test (requires NATS, skipped in CI without NATS)

Tests (real NATS server, conditional on `NATS_URL` env var):
- Publish event, subscribe, receive event end-to-end
- Durable consumer survives reconnection
- Two subscribers on different consumer groups both receive event
- Pull-based consumer processes batches correctly
- Stream retention: old events are queryable within 24h window

### Step 6: nats-health.ts + tests

Tests (mock NatsEventBus):
- Returns `{ connected: true, stream: 'ORCH_EVENTS', consumers: N }` when connected
- Returns `{ connected: false }` when disconnected
- Returns `{ type: 'memory' }` when EventBus is InMemoryEventBus

### Step 7: server.ts + index.ts wiring + tests

Tests:
- Server creates event bus via factory
- Health endpoint includes NATS status when NATS active
- Health endpoint excludes NATS section when using memory bus
- Existing server tests pass with `EVENT_BUS=memory`

### Step 8: event-bus.ts backward compatibility

- Rename `createEventBus` to `createInMemoryEventBus` internally
- Re-export `createEventBus` as alias for backward compatibility
- All existing imports continue to work

### Quality Gates

- All existing `tests/shared/event-bus.test.ts` tests pass unchanged
- All existing pipeline/server tests pass with `EVENT_BUS=memory`
- NATS integration tests pass when NATS is available (CI optional)
- 100% branch coverage on new modules (excluding integration tests)
- `npm run build` succeeds
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] NatsEventBus implements EventBus interface (publish, subscribe, removeAllListeners)
- [ ] All 28+ domain event types publishable and subscribable via NATS
- [ ] JetStream stream ORCH_EVENTS created with correct retention config
- [ ] Durable consumers created for each bounded context
- [ ] Pull-based consumption provides backpressure
- [ ] Event serialization round-trips correctly (JSON with type discriminator)
- [ ] Graceful degradation to in-memory when NATS unavailable
- [ ] Buffer behavior during disconnect (max 1000, flush on reconnect)
- [ ] Health check reports NATS connection status
- [ ] Connection config via env vars (NATS_URL, NATS_USER, NATS_PASS, NATS_TLS)
- [ ] Existing tests pass with EVENT_BUS=memory
- [ ] No changes to DomainEventType or DomainEventMap types
- [ ] createEventBus backward compatibility alias works

### Deployment Steps

1. Add `nats` npm package: `npm install nats`.
2. Merge event-bus-factory.ts, event-bus-nats.ts, nats-health.ts.
3. Update server.ts and index.ts wiring.
4. Deploy with `EVENT_BUS=memory` (default, no behavior change).
5. Provision NATS server (Docker: `nats:2.10-alpine` with `-js` flag for JetStream).
6. Configure: `NATS_URL=nats://nats:4222`, `NATS_USER`, `NATS_PASS`.
7. Switch to `EVENT_BUS=nats` in staging.
8. Verify: health endpoint, event delivery, consumer lag.
9. Run load test: 1000 events/sec for 60 seconds, monitor memory and consumer lag.
10. Enable in production.

### Rollback Plan

1. Set `EVENT_BUS=memory` -- immediately reverts to in-memory EventEmitter. Zero NATS dependency.
2. NATS server can remain running (consumers will idle).
3. No data migration -- events in JetStream stream are independent of application state.
4. If event-bus-factory.ts itself has issues, revert the server.ts/index.ts changes to use `createInMemoryEventBus()` directly.

### Infrastructure Requirements

- NATS server 2.10+ with JetStream enabled
- Persistent volume for JetStream file storage (recommended: 10GB for 24h retention)
- Network: application can reach NATS on port 4222 (or configured port)
- Monitoring: NATS provides built-in metrics at `http://nats:8222/jsz` for stream and consumer monitoring

---

## Cross-Plan Dependencies

- **No hard dependency** on other gap plans.
- **Soft dependency on Gap 13 (Persistent Memory):** Memory events (OutcomeRecorded, WeightsUpdated) benefit from NATS persistence for replay, but Gap 13 can use in-memory bus initially.
- Gap 11 (Security Scanning) is independent -- scanners are synchronous within a single pipeline run.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/shared/event-bus-nats.ts` | NEW |
| `src/shared/event-bus-factory.ts` | NEW |
| `src/shared/nats-health.ts` | NEW |
| `src/shared/event-bus.ts` | MODIFIED (rename + re-export) |
| `src/server.ts` | MODIFIED |
| `src/index.ts` | MODIFIED |
| `package.json` | MODIFIED (add nats dependency) |
| `tests/shared/event-bus-nats.test.ts` | NEW |
| `tests/shared/event-bus-factory.test.ts` | NEW |
| `tests/shared/nats-health.test.ts` | NEW |
| `tests/shared/event-bus.test.ts` | MODIFIED (backward compat) |
| `tests/integration/nats-e2e.test.ts` | NEW (conditional on NATS) |
