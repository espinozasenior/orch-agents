/**
 * TDD: Tests for CancellationController — graceful process cancellation.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCancellationController } from '../../src/execution/cancellation-controller';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockChild(): ChildProcess & { killCalls: string[] } {
  const emitter = new EventEmitter() as ChildProcess & { killCalls: string[] };
  emitter.killCalls = [];
  emitter.kill = ((signal?: string) => {
    emitter.killCalls.push(signal ?? 'SIGTERM');
    return true;
  }) as ChildProcess['kill'];
  emitter.pid = Math.floor(Math.random() * 10000);
  return emitter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CancellationController', () => {
  describe('register + cancel', () => {
    it('sends SIGTERM on cancel', () => {
      const controller = createCancellationController();
      const child = makeMockChild();
      controller.register('exec-1', child, 'plan-1');

      const result = controller.cancel('exec-1');
      assert.equal(result, true);
      assert.equal(child.killCalls[0], 'SIGTERM');
    });

    it('returns false for unknown execId', () => {
      const controller = createCancellationController();
      const result = controller.cancel('unknown');
      assert.equal(result, false);
    });
  });

  describe('SIGKILL escalation', () => {
    it('sends SIGKILL after grace period', async () => {
      const controller = createCancellationController();
      const child = makeMockChild();
      controller.register('exec-1', child, 'plan-1');

      // Use a very short grace period for testing
      controller.cancel('exec-1', 10);

      assert.equal(child.killCalls.length, 1);
      assert.equal(child.killCalls[0], 'SIGTERM');

      // Wait for escalation timer
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(child.killCalls.length, 2);
      assert.equal(child.killCalls[1], 'SIGKILL');
    });
  });

  describe('cancelPlan', () => {
    it('cancels all agents for a plan', () => {
      const controller = createCancellationController();
      const child1 = makeMockChild();
      const child2 = makeMockChild();
      const child3 = makeMockChild();

      controller.register('exec-1', child1, 'plan-1');
      controller.register('exec-2', child2, 'plan-1');
      controller.register('exec-3', child3, 'plan-2');

      const count = controller.cancelPlan('plan-1');
      assert.equal(count, 2);
      assert.equal(child1.killCalls[0], 'SIGTERM');
      assert.equal(child2.killCalls[0], 'SIGTERM');
      assert.equal(child3.killCalls.length, 0);
    });

    it('returns 0 for unknown plan', () => {
      const controller = createCancellationController();
      const count = controller.cancelPlan('unknown');
      assert.equal(count, 0);
    });
  });

  describe('unregister', () => {
    it('clears escalation timer', async () => {
      const controller = createCancellationController();
      const child = makeMockChild();
      controller.register('exec-1', child, 'plan-1');

      controller.cancel('exec-1', 50);
      assert.equal(child.killCalls.length, 1); // SIGTERM

      // Unregister before escalation
      controller.unregister('exec-1');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should NOT have received SIGKILL since we unregistered
      assert.equal(child.killCalls.length, 1);
    });

    it('is safe to call for unknown execId', () => {
      const controller = createCancellationController();
      // Should not throw
      controller.unregister('unknown');
    });
  });

  describe('SIGKILL escalation — process already exited', () => {
    it('handles SIGKILL gracefully when kill throws', async () => {
      const controller = createCancellationController();
      const child = makeMockChild();
      // Override kill to throw on second call (simulating already-exited process)
      let callCount = 0;
      child.kill = ((signal?: string) => {
        callCount++;
        child.killCalls.push(signal ?? 'SIGTERM');
        if (callCount > 1) throw new Error('Process already exited');
        return true;
      }) as ChildProcess['kill'];

      controller.register('exec-1', child, 'plan-1');
      controller.cancel('exec-1', 10);

      // Wait for escalation timer — should NOT throw
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(child.killCalls.length, 2);
      assert.equal(child.killCalls[0], 'SIGTERM');
      assert.equal(child.killCalls[1], 'SIGKILL');
    });
  });

  describe('cancel — double cancel', () => {
    it('sends SIGTERM again on second cancel', () => {
      const controller = createCancellationController();
      const child = makeMockChild();
      controller.register('exec-1', child, 'plan-1');

      controller.cancel('exec-1', 5000);
      controller.cancel('exec-1', 5000);

      assert.equal(child.killCalls.length, 2);
      assert.equal(child.killCalls[0], 'SIGTERM');
      assert.equal(child.killCalls[1], 'SIGTERM');
    });
  });

  describe('register — overwrite', () => {
    it('overwrites existing registration for same execId', () => {
      const controller = createCancellationController();
      const child1 = makeMockChild();
      const child2 = makeMockChild();

      controller.register('exec-1', child1, 'plan-1');
      controller.register('exec-1', child2, 'plan-2');

      // Cancelling should affect the second registration
      controller.cancel('exec-1');
      assert.equal(child1.killCalls.length, 0);
      assert.equal(child2.killCalls.length, 1);

      // Count should still be 1 (overwrite, not add)
      assert.equal(controller.getActiveCount(), 1);
    });
  });

  describe('unregister — entry without timer', () => {
    it('safely unregisters entry that was never cancelled', () => {
      const controller = createCancellationController();
      controller.register('exec-1', makeMockChild(), 'plan-1');
      assert.equal(controller.getActiveCount(), 1);

      // Unregister without cancel — no timer to clear
      controller.unregister('exec-1');
      assert.equal(controller.getActiveCount(), 0);
    });
  });

  describe('cancelPlan — mixed plans', () => {
    it('cancels only matching plan agents across interleaved registrations', () => {
      const controller = createCancellationController();
      const children = Array.from({ length: 5 }, () => makeMockChild());

      controller.register('e1', children[0], 'plan-A');
      controller.register('e2', children[1], 'plan-B');
      controller.register('e3', children[2], 'plan-A');
      controller.register('e4', children[3], 'plan-C');
      controller.register('e5', children[4], 'plan-B');

      const count = controller.cancelPlan('plan-B');
      assert.equal(count, 2);
      assert.equal(children[1].killCalls.length, 1); // e2
      assert.equal(children[4].killCalls.length, 1); // e5
      assert.equal(children[0].killCalls.length, 0); // plan-A
      assert.equal(children[2].killCalls.length, 0); // plan-A
      assert.equal(children[3].killCalls.length, 0); // plan-C
    });
  });

  describe('getActiveCount', () => {
    it('tracks active process count', () => {
      const controller = createCancellationController();
      assert.equal(controller.getActiveCount(), 0);

      controller.register('exec-1', makeMockChild(), 'plan-1');
      assert.equal(controller.getActiveCount(), 1);

      controller.register('exec-2', makeMockChild(), 'plan-1');
      assert.equal(controller.getActiveCount(), 2);

      controller.unregister('exec-1');
      assert.equal(controller.getActiveCount(), 1);
    });
  });
});
