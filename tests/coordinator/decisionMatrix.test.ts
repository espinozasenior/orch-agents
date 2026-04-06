/**
 * Tests for the continue-vs-spawn decision matrix.
 *
 * Validates that the coordinator correctly decides when to
 * reuse a worker (continue) vs spawn a fresh one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideContinueOrSpawn } from '../../src/coordinator/decisionMatrix';
import type { WorkerState, TaskSpec } from '../../src/coordinator/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    id: 'worker-test',
    phase: 'research',
    status: 'completed',
    description: 'Test worker',
    filesExplored: [],
    startTime: Date.now(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    type: 'implementation',
    targetFiles: [],
    description: 'Test task',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decideContinueOrSpawn', () => {
  it('should always spawn fresh for verification tasks', () => {
    const worker = makeWorker({
      filesExplored: ['a.ts', 'b.ts', 'c.ts'],
    });
    const task = makeTask({
      type: 'verification',
      targetFiles: ['a.ts', 'b.ts', 'c.ts'],  // 100% overlap — still spawns
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'spawn');
  });

  it('should continue on failure correction', () => {
    const worker = makeWorker({
      lastStatus: 'failed',
      filesExplored: ['auth.ts'],
    });
    const task = makeTask({
      type: 'correction',
      targetFiles: ['unrelated.ts'],  // No overlap — still continues
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'continue');
  });

  it('should spawn on low context overlap', () => {
    const worker = makeWorker({
      filesExplored: ['a.ts', 'b.ts'],
    });
    const task = makeTask({
      type: 'implementation',
      targetFiles: ['x.ts', 'y.ts', 'z.ts'],  // 0% overlap
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'spawn');
  });

  it('should continue on high context overlap', () => {
    const worker = makeWorker({
      filesExplored: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    });
    const task = makeTask({
      type: 'implementation',
      targetFiles: ['a.ts', 'b.ts', 'c.ts'],  // 100% overlap
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'continue');
  });

  it('should spawn at exactly 70% overlap threshold', () => {
    // 7/10 = 0.7 — the boundary. <=0.7 spawns.
    const worker = makeWorker({
      filesExplored: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'],
    });
    const task = makeTask({
      type: 'implementation',
      targetFiles: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'],
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'spawn');
  });

  it('should continue just above 70% overlap threshold', () => {
    // 8/10 = 0.8 — above threshold, should continue
    const worker = makeWorker({
      filesExplored: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'],
    });
    const task = makeTask({
      type: 'implementation',
      targetFiles: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'],
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'continue');
  });

  it('should spawn when target files are empty (0 overlap)', () => {
    const worker = makeWorker({
      filesExplored: ['a.ts'],
    });
    const task = makeTask({
      type: 'implementation',
      targetFiles: [],
    });

    assert.equal(decideContinueOrSpawn(worker, task), 'spawn');
  });
});
