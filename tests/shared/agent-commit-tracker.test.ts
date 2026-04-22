/**
 * Tests for shared/agent-commit-tracker.ts — SHA-based feedback loop prevention.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  trackAgentCommit,
  isAgentCommit,
  clearTrackedCommits,
  trackAgentPR,
  isAgentPR,
  clearTrackedPRs,
} from '../../src/execution/agent-commit-tracker';

describe('agent-commit-tracker', () => {
  beforeEach(() => {
    clearTrackedCommits();
    clearTrackedPRs();
  });

  it('should return true for a tracked SHA', () => {
    trackAgentCommit('abc1234');
    assert.equal(isAgentCommit('abc1234'), true);
  });

  it('should return false for an unknown SHA', () => {
    assert.equal(isAgentCommit('unknown-sha'), false);
  });

  it('should return false after clearTrackedCommits', () => {
    trackAgentCommit('abc1234');
    clearTrackedCommits();
    assert.equal(isAgentCommit('abc1234'), false);
  });

  it('should track multiple SHAs independently', () => {
    trackAgentCommit('sha-1');
    trackAgentCommit('sha-2');
    assert.equal(isAgentCommit('sha-1'), true);
    assert.equal(isAgentCommit('sha-2'), true);
    assert.equal(isAgentCommit('sha-3'), false);
  });

  it('should expire entries after TTL', () => {
    trackAgentCommit('fresh-sha');
    assert.equal(isAgentCommit('fresh-sha'), true);
  });
});

describe('agent-pr-tracker', () => {
  beforeEach(() => {
    clearTrackedPRs();
  });

  it('should return true for a tracked PR', () => {
    trackAgentPR('owner/repo', 42);
    assert.equal(isAgentPR('owner/repo', 42), true);
  });

  it('should return false for an unknown PR', () => {
    assert.equal(isAgentPR('owner/repo', 99), false);
  });

  it('should return false after clearTrackedPRs', () => {
    trackAgentPR('owner/repo', 42);
    clearTrackedPRs();
    assert.equal(isAgentPR('owner/repo', 42), false);
  });

  it('should track PRs independently per repo', () => {
    trackAgentPR('owner/repo-a', 1);
    trackAgentPR('owner/repo-b', 1);
    assert.equal(isAgentPR('owner/repo-a', 1), true);
    assert.equal(isAgentPR('owner/repo-b', 1), true);
    assert.equal(isAgentPR('owner/repo-c', 1), false);
  });
});
