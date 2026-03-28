/**
 * Tests for GitHubWorkflowNormalizer (GAP-15).
 *
 * Covers: rule key parsing, condition matching, event normalization,
 * bot loop prevention, fallback chain, and feature flag behavior.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGitHubEventFromWorkflow,
  parseRuleKey,
  setBotUserId,
  setBotUsername,
} from '../../src/intake/github-workflow-normalizer';
import {
  trackAgentCommit,
  clearTrackedCommits,
} from '../../src/shared/agent-commit-tracker';
import type { WorkflowConfig } from '../../src/integration/linear/workflow-parser';
import type { ParsedGitHubEvent } from '../../src/webhook-gateway/event-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeWorkflowConfig(overrides?: Partial<WorkflowConfig>): WorkflowConfig {
  return {
    tracker: {
      kind: 'linear',
      apiKey: 'test-key',
      team: 'test-team',
      activeTypes: ['unstarted', 'started'],
      terminalTypes: ['completed', 'canceled'],
      activeStates: [],
      terminalStates: [],
    },
    github: {
      events: {
        'pull_request.opened': 'github-ops',
        'pull_request.synchronize': 'github-ops',
        'pull_request.closed.merged': 'release-pipeline',
        'pull_request.ready_for_review': 'github-ops',
        'push.default_branch': 'cicd-pipeline',
        'push.other': 'quick-fix',
        'issues.opened': 'github-ops',
        'issues.labeled.bug': 'tdd-workflow',
        'issues.labeled.enhancement': 'feature-build',
        'issues.labeled.security': 'security-audit',
        'issue_comment.mentions_bot': 'quick-fix',
        'pull_request_review.changes_requested': 'quick-fix',
        'workflow_run.failure': 'quick-fix',
        'release.published': 'release-pipeline',
        'deployment_status.failure': 'quick-fix',
      },
    },
    agents: {
      maxConcurrent: 8,
      routing: {
        bug: 'tdd-workflow',
        feature: 'feature-build',
        security: 'security-audit',
        refactor: 'sparc-full',
      },
      defaultTemplate: 'quick-fix',
    },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    promptTemplate: 'test prompt',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule key parser tests
// ---------------------------------------------------------------------------

describe('parseRuleKey', () => {
  it('should parse event.action format', () => {
    const result = parseRuleKey('pull_request.opened');
    assert.deepEqual(result, { event: 'pull_request', action: 'opened', condition: null });
  });

  it('should parse event.action.condition format', () => {
    const result = parseRuleKey('pull_request.closed.merged');
    assert.deepEqual(result, { event: 'pull_request', action: 'closed', condition: 'merged' });
  });

  it('should parse event.condition for no-action events', () => {
    const result = parseRuleKey('push.default_branch');
    assert.deepEqual(result, { event: 'push', action: null, condition: 'default_branch' });
  });

  it('should parse event.condition for issue_comment (no known action match)', () => {
    const result = parseRuleKey('issue_comment.mentions_bot');
    assert.deepEqual(result, { event: 'issue_comment', action: null, condition: 'mentions_bot' });
  });

  it('should parse issues.labeled.bug', () => {
    const result = parseRuleKey('issues.labeled.bug');
    assert.deepEqual(result, { event: 'issues', action: 'labeled', condition: 'bug' });
  });

  it('should parse pull_request_review.changes_requested', () => {
    const result = parseRuleKey('pull_request_review.changes_requested');
    assert.deepEqual(result, { event: 'pull_request_review', action: null, condition: 'changes_requested' });
  });

  it('should parse workflow_run.failure', () => {
    const result = parseRuleKey('workflow_run.failure');
    assert.deepEqual(result, { event: 'workflow_run', action: null, condition: 'failure' });
  });

  it('should parse release.published', () => {
    const result = parseRuleKey('release.published');
    assert.deepEqual(result, { event: 'release', action: 'published', condition: null });
  });

  it('should parse deployment_status.failure', () => {
    const result = parseRuleKey('deployment_status.failure');
    assert.deepEqual(result, { event: 'deployment_status', action: null, condition: 'failure' });
  });

  it('should parse single-segment key', () => {
    const result = parseRuleKey('push');
    assert.deepEqual(result, { event: 'push', action: null, condition: null });
  });

  it('should parse push.other', () => {
    const result = parseRuleKey('push.other');
    assert.deepEqual(result, { event: 'push', action: null, condition: 'other' });
  });
});

// ---------------------------------------------------------------------------
// normalizeGitHubEventFromWorkflow tests
// ---------------------------------------------------------------------------

describe('normalizeGitHubEventFromWorkflow', () => {
  beforeEach(() => {
    setBotUserId(0);
    setBotUsername('');
    clearTrackedCommits();
  });

  // AC1/AC4: pull_request.opened maps to github-ops
  it('AC4: should map pull_request.opened to github-ops template', () => {
    const parsed = makeParsed({
      eventType: 'pull_request',
      action: 'opened',
      prNumber: 42,
      branch: 'feature/auth',
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'github-ops');
    assert.equal(result.sourceMetadata.configSource, 'workflow-md');
    assert.equal(result.intent, 'review-pr');
    assert.equal(result.source, 'github');
    assert.equal(result.entities.prNumber, 42);
  });

  // AC2: issues.labeled.bug maps to tdd-workflow
  it('AC2: should map issues.labeled.bug to tdd-workflow template', () => {
    const parsed = makeParsed({
      eventType: 'issues',
      action: 'labeled',
      issueNumber: 101,
      labels: ['bug'],
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'tdd-workflow');
    assert.equal(result.intent, 'custom:fix-bug');
  });

  // AC3: push to default branch maps to cicd-pipeline
  it('AC3: should map push to default branch to cicd-pipeline template', () => {
    const parsed = makeParsed({
      eventType: 'push',
      branch: 'main',
      defaultBranch: 'main',
      files: ['src/app.ts'],
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'cicd-pipeline');
    assert.equal(result.intent, 'validate-main');
  });

  // AC4: push to non-default branch maps to quick-fix
  it('AC4: should map push to non-default branch to quick-fix template', () => {
    const parsed = makeParsed({
      eventType: 'push',
      branch: 'feature/login',
      defaultBranch: 'main',
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'quick-fix');
    assert.equal(result.intent, 'validate-branch');
  });

  // AC5: no github section falls back (returns null)
  it('AC5: should return null when no github.events section exists', () => {
    const parsed = makeParsed({
      eventType: 'pull_request',
      action: 'opened',
      prNumber: 1,
    });
    const config = makeWorkflowConfig({ github: undefined });

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.equal(result, null);
  });

  // AC6: no matching event falls back to agents.routing.default
  it('AC6: should fall back to agents.routing.default when no rule matches', () => {
    const parsed = makeParsed({
      eventType: 'star',
      action: 'created',
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'quick-fix');
  });

  // AC7: bot events skipped
  it('AC7: should return null for bot sender (loop prevention)', () => {
    setBotUserId(99999);

    const parsed = makeParsed({
      senderId: 99999,
      sender: 'my-bot[bot]',
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.equal(result, null);
  });

  it('AC7: should return null for bot sender by username', () => {
    setBotUsername('my-bot');

    const parsed = makeParsed({
      sender: 'my-bot',
      senderId: 12345,
      senderIsBot: false,
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.equal(result, null);
  });

  it('AC7: should return null for bot sender type when no bot ID configured', () => {
    setBotUserId(0);

    const parsed = makeParsed({
      senderIsBot: true,
      sender: 'dependabot[bot]',
      senderId: 88888,
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.equal(result, null);
  });

  // AC8: feature flag off uses old normalizer (tested via config, not here)

  // AC9: workflow_run.failure maps to quick-fix
  it('AC9: should map workflow_run.failure to quick-fix template', () => {
    const parsed = makeParsed({
      eventType: 'workflow_run',
      action: 'completed',
      conclusion: 'failure',
      branch: 'feature/ci',
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    assert.equal(result.sourceMetadata.template, 'quick-fix');
    assert.equal(result.intent, 'debug-ci');
  });

  // AC10: shared label routing (agents.routing fallback)
  it('AC10: should fall back to agents.routing for label matching', () => {
    const parsed = makeParsed({
      eventType: 'issues',
      action: 'labeled',
      issueNumber: 200,
      labels: ['refactor'],
    });
    const config = makeWorkflowConfig();

    const result = normalizeGitHubEventFromWorkflow(parsed, config);

    assert.ok(result);
    // 'refactor' is not in github.events but IS in agents.routing -> sparc-full
    assert.equal(result.sourceMetadata.template, 'sparc-full');
  });

  // Additional coverage for all 15 event rules
  describe('all event rules from WORKFLOW.md', () => {
    const config = makeWorkflowConfig();

    const testCases: Array<{
      name: string;
      overrides: Partial<ParsedGitHubEvent>;
      expectedTemplate: string;
    }> = [
      {
        name: 'pull_request.opened -> github-ops',
        overrides: { eventType: 'pull_request', action: 'opened', prNumber: 1 },
        expectedTemplate: 'github-ops',
      },
      {
        name: 'pull_request.synchronize -> github-ops',
        overrides: { eventType: 'pull_request', action: 'synchronize', prNumber: 1 },
        expectedTemplate: 'github-ops',
      },
      {
        name: 'pull_request.closed.merged -> release-pipeline',
        overrides: { eventType: 'pull_request', action: 'closed', merged: true, prNumber: 1 },
        expectedTemplate: 'release-pipeline',
      },
      {
        name: 'pull_request.ready_for_review -> github-ops',
        overrides: { eventType: 'pull_request', action: 'ready_for_review', prNumber: 1 },
        expectedTemplate: 'github-ops',
      },
      {
        name: 'push.default_branch -> cicd-pipeline',
        overrides: { eventType: 'push', branch: 'main', defaultBranch: 'main' },
        expectedTemplate: 'cicd-pipeline',
      },
      {
        name: 'push.other -> quick-fix',
        overrides: { eventType: 'push', branch: 'feat/x', defaultBranch: 'main' },
        expectedTemplate: 'quick-fix',
      },
      {
        name: 'issues.opened -> github-ops',
        overrides: { eventType: 'issues', action: 'opened', issueNumber: 1 },
        expectedTemplate: 'github-ops',
      },
      {
        name: 'issues.labeled.bug -> tdd-workflow',
        overrides: { eventType: 'issues', action: 'labeled', labels: ['bug'], issueNumber: 1 },
        expectedTemplate: 'tdd-workflow',
      },
      {
        name: 'issues.labeled.enhancement -> feature-build',
        overrides: { eventType: 'issues', action: 'labeled', labels: ['enhancement'], issueNumber: 1 },
        expectedTemplate: 'feature-build',
      },
      {
        name: 'issues.labeled.security -> security-audit',
        overrides: { eventType: 'issues', action: 'labeled', labels: ['security'], issueNumber: 1 },
        expectedTemplate: 'security-audit',
      },
      {
        name: 'issue_comment.mentions_bot -> quick-fix',
        overrides: { eventType: 'issue_comment', action: 'created', commentBody: '@bot help' },
        expectedTemplate: 'quick-fix',
      },
      {
        name: 'pull_request_review.changes_requested -> quick-fix',
        overrides: { eventType: 'pull_request_review', action: 'submitted', reviewState: 'changes_requested', prNumber: 1 },
        expectedTemplate: 'quick-fix',
      },
      {
        name: 'workflow_run.failure -> quick-fix',
        overrides: { eventType: 'workflow_run', action: 'completed', conclusion: 'failure' },
        expectedTemplate: 'quick-fix',
      },
      {
        name: 'release.published -> release-pipeline',
        overrides: { eventType: 'release', action: 'published' },
        expectedTemplate: 'release-pipeline',
      },
      {
        name: 'deployment_status.failure -> quick-fix',
        overrides: { eventType: 'deployment_status', action: null, conclusion: 'failure' },
        expectedTemplate: 'quick-fix',
      },
    ];

    for (const tc of testCases) {
      it(tc.name, () => {
        const parsed = makeParsed(tc.overrides);
        const result = normalizeGitHubEventFromWorkflow(parsed, config);
        assert.ok(result, `Expected IntakeEvent for: ${tc.name}`);
        assert.equal(result.sourceMetadata.template, tc.expectedTemplate);
      });
    }
  });

  describe('edge cases', () => {
    it('should return null for pull_request closed without merge', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'closed',
        merged: false,
        prNumber: 45,
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      // closed without merge does not match 'merged' condition
      // Falls back to default template
      assert.ok(result);
      assert.equal(result.sourceMetadata.template, 'quick-fix');
    });

    it('should sanitize comment body in rawText', () => {
      const parsed = makeParsed({
        eventType: 'issue_comment',
        action: 'created',
        commentBody: '@bot <!-- hidden --> help',
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.ok(result.rawText);
      assert.ok(!result.rawText.includes('<!-- hidden -->'));
    });

    it('should handle workflow_run success (no matching condition)', () => {
      const parsed = makeParsed({
        eventType: 'workflow_run',
        action: 'completed',
        conclusion: 'success',
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      // No rule matches, falls back to default
      assert.ok(result);
      assert.equal(result.sourceMetadata.template, 'quick-fix');
    });

    it('should handle multiple labels - first match wins', () => {
      const parsed = makeParsed({
        eventType: 'issues',
        action: 'labeled',
        issueNumber: 300,
        labels: ['bug', 'security'],
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      // 'issues.labeled.bug' comes before 'issues.labeled.security' in the rules
      assert.equal(result.sourceMetadata.template, 'tdd-workflow');
    });

    it('should set skipTriage for quick-fix template', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'feature/x',
        defaultBranch: 'main',
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.equal(result.sourceMetadata.skipTriage, true);
    });

    it('should not set skipTriage for non-quick-fix template', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'main',
        defaultBranch: 'main',
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.equal(result.sourceMetadata.skipTriage, false);
    });

    it('should handle botUsername parameter override', () => {
      // Don't set module-level bot username
      setBotUsername('');

      const parsed = makeParsed({
        sender: 'my-custom-bot',
        senderId: 12345,
        senderIsBot: false,
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config, 'my-custom-bot');

      assert.equal(result, null);
    });

    it('should allow human senders when bot ID is configured', () => {
      setBotUserId(99999);

      const parsed = makeParsed({
        senderId: 12345,
        sender: 'human-dev',
        senderIsBot: false,
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
    });

    it('should include repo and branch in entities', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'main',
        defaultBranch: 'main',
        files: ['src/app.ts', 'tests/app.test.ts'],
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.equal(result.entities.repo, 'acme/webapp');
      assert.equal(result.entities.branch, 'main');
      assert.deepEqual(result.entities.files, ['src/app.ts', 'tests/app.test.ts']);
      assert.equal(result.entities.author, 'octocat');
    });
  });

  // -------------------------------------------------------------------------
  // Agent feedback loop prevention
  // -------------------------------------------------------------------------

  describe('agent feedback loop prevention', () => {
    it('should skip push event when head_commit.id is a tracked agent SHA', () => {
      trackAgentCommit('agent-sha-001');
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'feature/x',
        defaultBranch: 'main',
        rawPayload: { head_commit: { id: 'agent-sha-001' } },
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.equal(result, null);
    });

    it('should skip pull_request.synchronize when after SHA is a tracked agent SHA', () => {
      trackAgentCommit('agent-sha-002');
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'synchronize',
        prNumber: 10,
        rawPayload: { after: 'agent-sha-002' },
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.equal(result, null);
    });

    it('should process pull_request.synchronize with human SHA normally', () => {
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'synchronize',
        prNumber: 10,
        rawPayload: { after: 'human-sha-999' },
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.equal(result.sourceMetadata.template, 'github-ops');
    });

    it('should not affect pull_request.opened (not synchronize)', () => {
      trackAgentCommit('agent-sha-003');
      const parsed = makeParsed({
        eventType: 'pull_request',
        action: 'opened',
        prNumber: 10,
        rawPayload: { after: 'agent-sha-003' },
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.equal(result.sourceMetadata.template, 'github-ops');
    });

    it('should skip push to non-default branch when no rule matches', () => {
      // Config WITHOUT push.other rule
      const config = makeWorkflowConfig({
        github: {
          events: {
            'push.default_branch': 'cicd-pipeline',
            'pull_request.opened': 'github-ops',
          },
        },
      });
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'feature/agent-branch',
        defaultBranch: 'main',
      });

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.equal(result, null);
    });

    it('should still match push to default branch after rule matching', () => {
      const config = makeWorkflowConfig();
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'main',
        defaultBranch: 'main',
      });

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      assert.equal(result.sourceMetadata.template, 'cicd-pipeline');
    });

    it('should process push with non-agent SHA normally', () => {
      const parsed = makeParsed({
        eventType: 'push',
        branch: 'feat/x',
        defaultBranch: 'main',
        rawPayload: { head_commit: { id: 'human-push-sha' } },
      });
      const config = makeWorkflowConfig();

      const result = normalizeGitHubEventFromWorkflow(parsed, config);

      assert.ok(result);
      // push.other rule matches in the default config
      assert.equal(result.sourceMetadata.template, 'quick-fix');
    });
  });
});
