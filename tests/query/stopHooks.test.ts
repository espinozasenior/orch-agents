import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorkCancelledStopRegistry,
} from '../../src/query/index.js';
import { createEventBus, createDomainEvent } from '../../src/kernel/event-bus.js';

describe('createWorkCancelledStopRegistry', () => {
  it('reports isCancelled === false before WorkCancelled fires', () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    assert.equal(reg.isCancelled('WORK-1'), false);
    reg.dispose();
  });

  it('flips isCancelled after WorkCancelled event for matching workItemId', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    // event-bus is sync emit; allow microtask flush
    await Promise.resolve();
    assert.equal(reg.isCancelled('WORK-1'), true);
    assert.equal(reg.isCancelled('WORK-2'), false);
    reg.dispose();
  });

  it('handleStopHooksFor returns preventContinuation: true after cancellation', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    const handle = reg.handleStopHooksFor('WORK-1');
    const before = await handle([], []);
    assert.equal(before.preventContinuation, false);
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    const after = await handle([], []);
    assert.equal(after.preventContinuation, true);
    reg.dispose();
  });

  it('aborts a bound AbortController when WorkCancelled fires', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    const ac = new AbortController();
    reg.bindAbortController('WORK-1', ac);
    assert.equal(ac.signal.aborted, false);
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    assert.equal(ac.signal.aborted, true);
    reg.dispose();
  });

  it('aborts immediately on bind if workItemId already cancelled', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    const ac = new AbortController();
    reg.bindAbortController('WORK-1', ac);
    assert.equal(ac.signal.aborted, true);
    reg.dispose();
  });

  it('does not abort controllers bound to a different workItemId', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    const ac = new AbortController();
    reg.bindAbortController('WORK-1', ac);
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-2',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    assert.equal(ac.signal.aborted, false);
    reg.dispose();
  });

  it('unbind() removes the controller from the registry', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    const ac = new AbortController();
    const unbind = reg.bindAbortController('WORK-1', ac);
    unbind();
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    // The cancellation set still flips, but our unbound controller stays untouched
    assert.equal(ac.signal.aborted, false);
    reg.dispose();
  });

  it('emits StopHookFired observability event when handler trips', async () => {
    const bus = createEventBus();
    const events: Array<{ type: string }> = [];
    const reg = createWorkCancelledStopRegistry(bus, {
      emit: (e) => events.push(e),
    });
    const handle = reg.handleStopHooksFor('WORK-1');
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    await handle([], []);
    assert.ok(events.some((e) => e.type === 'StopHookFired'));
    reg.dispose();
  });

  it('dispose() removes the EventBus subscription (idempotent)', async () => {
    const bus = createEventBus();
    const reg = createWorkCancelledStopRegistry(bus);
    reg.dispose();
    reg.dispose(); // idempotent — must not throw
    bus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'WORK-1',
      cancellationReason: 'user',
    }));
    await Promise.resolve();
    // After dispose the registry's internal set is cleared and the
    // subscription is removed.
    assert.equal(reg.isCancelled('WORK-1'), false);
  });
});
