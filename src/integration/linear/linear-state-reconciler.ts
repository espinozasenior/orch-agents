/**
 * Linear state reconciler for polling mode.
 *
 * Pure function that compares a cached issue snapshot against the
 * current state from the Linear API and returns a list of changes.
 * Used by the polling loop to detect state transitions.
 */

import type { LinearIssueSnapshot, LinearChange } from './types';
import type { LinearIssueResponse } from './linear-client';

/**
 * Create a snapshot of a Linear issue for caching.
 */
export function snapshotIssue(issue: LinearIssueResponse): LinearIssueSnapshot {
  return {
    id: issue.id,
    state: issue.state.name,
    stateId: issue.state.id,
    labels: issue.labels.nodes.map((l) => l.name).sort(),
    labelIds: issue.labels.nodes.map((l) => l.id).sort(),
    assigneeId: issue.assignee?.id ?? null,
    priority: issue.priority,
    updatedAt: issue.updatedAt,
  };
}

/**
 * Detect changes between a cached snapshot and the current issue state.
 *
 * Returns an array of LinearChange objects describing what changed.
 * Returns empty array if nothing changed.
 */
export function detectChanges(
  cached: LinearIssueSnapshot,
  current: LinearIssueResponse,
): LinearChange[] {
  const changes: LinearChange[] = [];

  // State change
  if (cached.state !== current.state.name) {
    changes.push({
      field: 'state',
      from: cached.state,
      to: current.state.name,
      updatedFrom: { state: { id: cached.stateId } },
    });
  }

  // Label change
  const currentLabels = current.labels.nodes.map((l) => l.name).sort();
  const labelsChanged =
    cached.labels.length !== currentLabels.length ||
    cached.labels.some((l, i) => l !== currentLabels[i]);

  if (labelsChanged) {
    changes.push({
      field: 'labels',
      from: cached.labels,
      to: currentLabels,
      updatedFrom: { labelIds: cached.labelIds },
    });
  }

  // Assignee change
  const currentAssigneeId = current.assignee?.id ?? null;
  if (cached.assigneeId !== currentAssigneeId) {
    changes.push({
      field: 'assignee',
      from: cached.assigneeId,
      to: currentAssigneeId,
      updatedFrom: { assigneeId: cached.assigneeId },
    });
  }

  // Priority change
  if (cached.priority !== current.priority) {
    changes.push({
      field: 'priority',
      from: cached.priority,
      to: current.priority,
      updatedFrom: { priority: cached.priority },
    });
  }

  return changes;
}
