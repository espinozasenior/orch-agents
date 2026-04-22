import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  recordSuccess,
  recordFailure,
  resume,
} from '../../src/scheduling/automation-state-machine';

describe('automation-state-machine', () => {
  it('creates initial state with zero failures and not paused', () => {
    const state = createInitialState('repo::health');
    assert.equal(state.automationId, 'repo::health');
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.paused, false);
    assert.equal(state.pausedAt, undefined);
    assert.equal(state.lastRunAt, undefined);
    assert.equal(state.lastRunStatus, undefined);
  });

  it('recordSuccess resets consecutive failures to 0', () => {
    const initial = { ...createInitialState('x'), consecutiveFailures: 2, lastRunStatus: 'failed' as const };
    const result = recordSuccess(initial);
    assert.equal(result.consecutiveFailures, 0);
    assert.equal(result.lastRunStatus, 'success');
    assert.ok(result.lastRunAt);
  });

  it('recordFailure increments consecutive failures', () => {
    const state = createInitialState('x');
    const r1 = recordFailure(state);
    assert.equal(r1.state.consecutiveFailures, 1);
    assert.equal(r1.paused, false);
    assert.equal(r1.state.lastRunStatus, 'failed');

    const r2 = recordFailure(r1.state);
    assert.equal(r2.state.consecutiveFailures, 2);
    assert.equal(r2.paused, false);
  });

  it('auto-pauses after 3 consecutive failures', () => {
    let state = createInitialState('x');
    let result = recordFailure(state);
    result = recordFailure(result.state);
    result = recordFailure(result.state);

    assert.equal(result.state.consecutiveFailures, 3);
    assert.equal(result.paused, true);
    assert.equal(result.state.paused, true);
    assert.ok(result.state.pausedAt);
  });

  it('does not re-flag paused on subsequent failures if already paused', () => {
    let state = createInitialState('x');
    let result = recordFailure(state);
    result = recordFailure(result.state);
    result = recordFailure(result.state); // pauses here
    assert.equal(result.paused, true);

    result = recordFailure(result.state); // already paused
    assert.equal(result.paused, false); // paused flag is false because it was *already* paused
    assert.equal(result.state.paused, true);
    assert.equal(result.state.consecutiveFailures, 4);
  });

  it('resume resets paused flag and failure counter', () => {
    let state = createInitialState('x');
    let result = recordFailure(state);
    result = recordFailure(result.state);
    result = recordFailure(result.state);
    assert.equal(result.state.paused, true);

    const resumed = resume(result.state);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pausedAt, undefined);
    assert.equal(resumed.consecutiveFailures, 0);
  });
});
