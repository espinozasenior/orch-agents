/**
 * Tests for LinearStateReconciler -- pure function tests.
 *
 * Covers: state change detection, label diff, assignee, priority.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotIssue,
  detectChanges,
} from '../../../src/integration/linear/linear-state-reconciler';
import type { LinearIssueResponse } from '../../../src/integration/linear/linear-client';
import type { LinearIssueSnapshot } from '../../../src/integration/linear/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<LinearIssueResponse> = {}): LinearIssueResponse {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Test issue',
    priority: 2,
    updatedAt: '2026-01-01T00:00:00Z',
    state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
    labels: { nodes: [] },
    assignee: null,
    creator: { id: 'user-1', name: 'Test' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearStateReconciler', () => {
  describe('snapshotIssue', () => {
    it('creates a snapshot from an issue response', () => {
      const issue = makeIssue({
        labels: { nodes: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'feature' }] },
        assignee: { id: 'user-2', name: 'Bob' },
      });

      const snapshot = snapshotIssue(issue);

      assert.equal(snapshot.id, 'issue-1');
      assert.equal(snapshot.state, 'Backlog');
      assert.equal(snapshot.stateId, 'state-1');
      assert.equal(snapshot.stateType, 'backlog');
      assert.deepEqual(snapshot.labels, ['bug', 'feature']);
      assert.equal(snapshot.assigneeId, 'user-2');
      assert.equal(snapshot.priority, 2);
    });

    it('handles null assignee', () => {
      const issue = makeIssue({ assignee: null });
      const snapshot = snapshotIssue(issue);
      assert.equal(snapshot.assigneeId, null);
    });
  });

  describe('detectChanges', () => {
    it('detects state change by type', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({
        state: { id: 'state-2', name: 'Todo', type: 'unstarted' },
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].field, 'state');
      assert.equal(changes[0].from, 'backlog');
      assert.equal(changes[0].to, 'unstarted');
    });

    it('detects state change by type even when name is renamed', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Ready',       // Was renamed from "Backlog"
        stateId: 'state-1',
        stateType: 'backlog',  // Type never changes
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      // State renamed from "Todo" to "Up Next", but type is still "unstarted"
      const current = makeIssue({
        state: { id: 'state-2', name: 'Up Next', type: 'unstarted' },
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].field, 'state');
      assert.equal(changes[0].from, 'backlog');
      assert.equal(changes[0].to, 'unstarted');
    });

    it('reports no state change when only name changes but type stays the same', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Todo',
        stateId: 'state-1',
        stateType: 'unstarted',
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      // Name changed from "Todo" to "Ready" but type is still "unstarted"
      const current = makeIssue({
        state: { id: 'state-1', name: 'Ready', type: 'unstarted' },
      });

      const changes = detectChanges(cached, current);

      // No state change detected — type is still "unstarted"
      assert.equal(changes.length, 0);
    });

    it('detects label change (added)', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({
        labels: { nodes: [{ id: 'l1', name: 'bug' }] },
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].field, 'labels');
      assert.deepEqual(changes[0].from, []);
      assert.deepEqual(changes[0].to, ['bug']);
    });

    it('detects label change (removed)', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: ['bug'],
        labelIds: ['l1'],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({
        labels: { nodes: [] },
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].field, 'labels');
    });

    it('detects assignee change', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({
        assignee: { id: 'user-2', name: 'Bob' },
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].field, 'assignee');
      assert.equal(changes[0].from, null);
      assert.equal(changes[0].to, 'user-2');
    });

    it('detects priority change', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({ priority: 1 });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].field, 'priority');
      assert.equal(changes[0].from, 2);
      assert.equal(changes[0].to, 1);
    });

    it('detects multiple changes simultaneously', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: [],
        labelIds: [],
        assigneeId: null,
        priority: 3,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({
        state: { id: 'state-2', name: 'Todo', type: 'unstarted' },
        assignee: { id: 'user-2' },
        priority: 1,
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 3);
      assert.ok(changes.some((c) => c.field === 'state'));
      assert.ok(changes.some((c) => c.field === 'assignee'));
      assert.ok(changes.some((c) => c.field === 'priority'));
    });

    it('returns empty array when nothing changed', () => {
      const cached: LinearIssueSnapshot = {
        id: 'issue-1',
        state: 'Backlog',
        stateId: 'state-1',
        stateType: 'backlog',
        labels: ['bug'],
        labelIds: ['l1'],
        assigneeId: 'user-1',
        priority: 2,
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const current = makeIssue({
        state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
        labels: { nodes: [{ id: 'l1', name: 'bug' }] },
        assignee: { id: 'user-1' },
        priority: 2,
      });

      const changes = detectChanges(cached, current);

      assert.equal(changes.length, 0);
    });
  });
});
