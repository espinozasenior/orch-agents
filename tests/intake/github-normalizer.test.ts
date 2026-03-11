import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGitHubEvent,
  setBotUserId,
  setRoutingTable,
  resetRoutingTable,
  type RoutingRule,
} from '../../src/intake/github-normalizer';
import type { ParsedGitHubEvent } from '../../src/webhook-gateway/event-parser';

// Load the actual routing table from config
import routingRules from '../../config/github-routing.json';

function makeParsed(overrides: Partial<ParsedGitHubEvent> = {}): ParsedGitHubEvent {
  return {
    eventType: 'push',
    action: null,
    deliveryId: 'test-delivery-001',
    repoFullName: 'acme/webapp',
    defaultBranch: 'main',
    branch: 'main',
    prNumber: null,
    issueNumber: null,
    sender: 'octocat',
    senderId: 12345,
    senderIsBot: false,
    labels: [],
    files: [],
    merged: false,
    conclusion: null,
    commentBody: null,
    reviewState: null,
    rawPayload: {},
    ...overrides,
  };
}

describe('normalizeGitHubEvent', () => {
  beforeEach(() => {
    setRoutingTable(routingRules as RoutingRule[]);
    setBotUserId(0);
  });

  describe('push events', () => {
    it('should map push to default branch as validate-main', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'main',
        defaultBranch: 'main',
        files: ['src/app.ts'],
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'validate-main');
      assert.equal(result.source, 'github');
      assert.equal(result.entities.repo, 'acme/webapp');
      assert.equal(result.entities.branch, 'main');
      assert.deepEqual(result.entities.files, ['src/app.ts']);
      assert.equal(result.entities.severity, 'high');
      assert.equal(result.id, 'test-delivery-001');
    });

    it('should map push to non-default branch as validate-branch', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'feature/login',
        defaultBranch: 'main',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'validate-branch');
      assert.equal(result.entities.branch, 'feature/login');
      assert.equal(result.entities.severity, 'low');
    });
  });

  describe('pull_request events', () => {
    it('should map pull_request opened as review-pr', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'opened',
        prNumber: 42,
        branch: 'feature/auth',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'review-pr');
      assert.equal(result.entities.prNumber, 42);
      assert.equal(result.entities.severity, 'medium');
    });

    it('should map pull_request synchronize as re-review-pr', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'synchronize',
        prNumber: 42,
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 're-review-pr');
    });

    it('should map pull_request closed+merged as post-merge', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'closed',
        merged: true,
        prNumber: 43,
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'post-merge');
      assert.equal(result.entities.severity, 'high');
    });

    it('should map pull_request ready_for_review as review-pr', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'ready_for_review',
        prNumber: 44,
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'review-pr');
    });

    it('should return null for pull_request closed without merge', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'closed',
        merged: false,
        prNumber: 45,
      });

      const result = normalizeGitHubEvent(parsed);

      // closed without merge does not match 'merged' condition
      assert.equal(result, null);
    });
  });

  describe('issues events', () => {
    it('should map issues opened as triage-issue', () => {
      const parsed = makeParsed({
        eventType: 'issues',
        action: 'opened',
        issueNumber: 100,
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'triage-issue');
      assert.equal(result.entities.issueNumber, 100);
    });

    it('should map issues labeled bug as custom:fix-bug', () => {
      const parsed = makeParsed({
        eventType: 'issues',
        action: 'labeled',
        issueNumber: 101,
        labels: ['bug'],
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'custom:fix-bug');
      assert.deepEqual(result.entities.labels, ['bug']);
    });

    it('should map issues labeled enhancement as custom:build-feature', () => {
      const parsed = makeParsed({
        eventType: 'issues',
        action: 'labeled',
        issueNumber: 102,
        labels: ['enhancement'],
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'custom:build-feature');
    });
  });

  describe('issue_comment events', () => {
    it('should map issue_comment created as respond-comment', () => {
      const parsed = makeParsed({
        eventType: 'issue_comment',
        action: 'created',
        issueNumber: 50,
        commentBody: '@bot please look at this',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'respond-comment');
      assert.equal(result.rawText, '@bot please look at this');
      assert.equal(result.entities.severity, 'low');
    });
  });

  describe('pull_request_review events', () => {
    it('should map review with changes_requested as custom:address-review', () => {
      const parsed = makeParsed({
        eventType: 'pull_request_review',
        action: 'submitted',
        prNumber: 60,
        reviewState: 'changes_requested',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'custom:address-review');
    });

    it('should return null for review approved (no matching rule)', () => {
      const parsed = makeParsed({
        eventType: 'pull_request_review',
        action: 'submitted',
        prNumber: 61,
        reviewState: 'approved',
      });

      const result = normalizeGitHubEvent(parsed);
      assert.equal(result, null);
    });
  });

  describe('workflow_run events', () => {
    it('should map workflow_run failure as debug-ci', () => {
      const parsed = makeParsed({
        eventType: 'workflow_run',
        action: 'completed',
        conclusion: 'failure',
        branch: 'feature/ci',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'debug-ci');
      assert.equal(result.entities.severity, 'high');
    });

    it('should return null for workflow_run success (no matching rule)', () => {
      const parsed = makeParsed({
        eventType: 'workflow_run',
        action: 'completed',
        conclusion: 'success',
      });

      const result = normalizeGitHubEvent(parsed);
      assert.equal(result, null);
    });
  });

  describe('release events', () => {
    it('should map release published as deploy-release', () => {
      const parsed = makeParsed({
        eventType: 'release',
        action: 'published',
        branch: 'v1.2.0',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'deploy-release');
      assert.equal(result.entities.severity, 'critical');
    });
  });

  describe('deployment_status events', () => {
    it('should map deployment_status failure as incident-response', () => {
      const parsed = makeParsed({
        eventType: 'deployment_status',
        action: null,
        conclusion: 'failure',
        branch: 'main',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.intent, 'incident-response');
      assert.equal(result.entities.severity, 'critical');
    });
  });

  describe('bot loop prevention', () => {
    it('should return null when sender matches bot user ID', () => {
      setBotUserId(99999);

      const parsed = makeParsed({
        senderId: 99999,
        sender: 'my-bot[bot]',
        senderIsBot: false, // Even if not flagged as bot, ID match should skip
      });

      const result = normalizeGitHubEvent(parsed);
      assert.equal(result, null);
    });

    it('should return null for bot senders when no bot ID configured', () => {
      setBotUserId(0);

      const parsed = makeParsed({
        senderIsBot: true,
        sender: 'dependabot[bot]',
        senderId: 88888,
      });

      const result = normalizeGitHubEvent(parsed);
      assert.equal(result, null);
    });

    it('should allow human senders even when bot ID is configured', () => {
      setBotUserId(99999);

      const parsed = makeParsed({
        senderId: 12345,
        sender: 'human-dev',
        senderIsBot: false,
      });

      const result = normalizeGitHubEvent(parsed);
      assert.ok(result); // Should produce a valid IntakeEvent
    });
  });

  describe('unknown events', () => {
    it('should return null for unmatched event types', () => {
      const parsed = makeParsed({
        eventType: 'star',
        action: 'created',
      });

      const result = normalizeGitHubEvent(parsed);
      assert.equal(result, null);
    });
  });

  describe('all 14 routing table entries', () => {
    // Verify each routing rule maps to the correct intent
    const testCases: Array<{
      name: string;
      overrides: Partial<ParsedGitHubEvent>;
      expectedIntent: string;
    }> = [
      {
        name: 'push default branch -> validate-main',
        overrides: { eventType: 'push', branch: 'main', defaultBranch: 'main' },
        expectedIntent: 'validate-main',
      },
      {
        name: 'push other branch -> validate-branch',
        overrides: { eventType: 'push', branch: 'feat/x', defaultBranch: 'main' },
        expectedIntent: 'validate-branch',
      },
      {
        name: 'pull_request opened -> review-pr',
        overrides: { eventType: 'pull_request', action: 'opened', prNumber: 1 },
        expectedIntent: 'review-pr',
      },
      {
        name: 'pull_request synchronize -> re-review-pr',
        overrides: { eventType: 'pull_request', action: 'synchronize', prNumber: 1 },
        expectedIntent: 're-review-pr',
      },
      {
        name: 'pull_request closed+merged -> post-merge',
        overrides: { eventType: 'pull_request', action: 'closed', merged: true, prNumber: 1 },
        expectedIntent: 'post-merge',
      },
      {
        name: 'pull_request ready_for_review -> review-pr',
        overrides: { eventType: 'pull_request', action: 'ready_for_review', prNumber: 1 },
        expectedIntent: 'review-pr',
      },
      {
        name: 'issues opened -> triage-issue',
        overrides: { eventType: 'issues', action: 'opened', issueNumber: 1 },
        expectedIntent: 'triage-issue',
      },
      {
        name: 'issues labeled bug -> custom:fix-bug',
        overrides: { eventType: 'issues', action: 'labeled', labels: ['bug'], issueNumber: 1 },
        expectedIntent: 'custom:fix-bug',
      },
      {
        name: 'issues labeled enhancement -> custom:build-feature',
        overrides: { eventType: 'issues', action: 'labeled', labels: ['enhancement'], issueNumber: 1 },
        expectedIntent: 'custom:build-feature',
      },
      {
        name: 'issue_comment created -> respond-comment',
        overrides: { eventType: 'issue_comment', action: 'created', commentBody: '@bot help' },
        expectedIntent: 'respond-comment',
      },
      {
        name: 'pull_request_review changes_requested -> custom:address-review',
        overrides: { eventType: 'pull_request_review', action: 'submitted', reviewState: 'changes_requested', prNumber: 1 },
        expectedIntent: 'custom:address-review',
      },
      {
        name: 'workflow_run failure -> debug-ci',
        overrides: { eventType: 'workflow_run', action: 'completed', conclusion: 'failure' },
        expectedIntent: 'debug-ci',
      },
      {
        name: 'release published -> deploy-release',
        overrides: { eventType: 'release', action: 'published' },
        expectedIntent: 'deploy-release',
      },
      {
        name: 'deployment_status failure -> incident-response',
        overrides: { eventType: 'deployment_status', conclusion: 'failure' },
        expectedIntent: 'incident-response',
      },
    ];

    for (const tc of testCases) {
      it(tc.name, () => {
        const parsed = makeParsed(tc.overrides);
        const result = normalizeGitHubEvent(parsed);
        assert.ok(result, `Expected IntakeEvent for: ${tc.name}`);
        assert.equal(result.intent, tc.expectedIntent);
      });
    }
  });

  describe('source metadata', () => {
    it('should include template and phases in sourceMetadata', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'main',
        defaultBranch: 'main',
      });

      const result = normalizeGitHubEvent(parsed);

      assert.ok(result);
      assert.equal(result.sourceMetadata.template, 'cicd-pipeline');
      assert.deepEqual(result.sourceMetadata.phases, ['refinement', 'completion']);
      assert.equal(result.sourceMetadata.skipTriage, false);
    });
  });
});
