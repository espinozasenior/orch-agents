/**
 * Tests for the P20 github-workflow-normalizer.
 *
 * After P20 the normalizer is a thin shell:
 *   1. bot-loop / agent-commit filtering
 *   2. stamp `sourceMetadata.{skillPath, ruleKey, parsed}` via skill-resolver
 *
 * `template`, `intent`, `severity`, and `skipTriage` are gone — they were
 * vestigial vocabulary that nothing downstream actually consumed.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGitHubEventFromWorkflow,
  createGitHubNormalizer,
  setBotUserId,
  setBotUsername,
} from '../../src/intake/github-workflow-normalizer';
import {
  trackAgentCommit,
  clearTrackedCommits,
} from '../../src/shared/agent-commit-tracker';
import { createSkillResolver } from '../../src/intake/skill-resolver';
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
    templates: {},
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
        'pull_request.opened': '.claude/skills/github-ops/SKILL.md',
        'pull_request.synchronize': '.claude/skills/github-ops/SKILL.md',
        'push.default_branch': '.claude/skills/cicd/SKILL.md',
        'issues.labeled.bug': '.claude/skills/bug-fix/SKILL.md',
      },
    },
    agents: { maxConcurrent: 8, routing: {}, defaultTemplate: 'coordinator' },
    agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 0, maxTurns: 20 },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    agentRunner: { stallTimeoutMs: 0, command: 'claude', turnTimeoutMs: 0 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 0 },
    promptTemplate: 'test prompt',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizeGitHubEventFromWorkflow (P20)', () => {
  beforeEach(() => {
    setBotUserId(0);
    setBotUsername('');
    clearTrackedCommits();
  });

  it('stamps sourceMetadata.skillPath + ruleKey for pull_request.opened', () => {
    const parsed = makeParsed({
      eventType: 'pull_request',
      action: 'opened',
      prNumber: 42,
      branch: 'feature/auth',
    });
    const result = normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig());
    assert.ok(result);
    assert.equal(result.sourceMetadata.skillPath, '.claude/skills/github-ops/SKILL.md');
    assert.equal(result.sourceMetadata.ruleKey, 'pull_request.opened');
    assert.equal(result.entities.prNumber, 42);
    assert.equal(result.source, 'github');
    // The full ParsedGitHubEvent is stamped for downstream context-fetchers.
    assert.equal((result.sourceMetadata.parsed as ParsedGitHubEvent).prNumber, 42);
  });

  it('stamps issues.labeled.bug rule', () => {
    const parsed = makeParsed({
      eventType: 'issues',
      action: 'labeled',
      issueNumber: 101,
      labels: ['bug'],
      branch: null,
    });
    const result = normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig());
    assert.ok(result);
    assert.equal(result.sourceMetadata.skillPath, '.claude/skills/bug-fix/SKILL.md');
    assert.equal(result.sourceMetadata.ruleKey, 'issues.labeled.bug');
  });

  it('stamps push.default_branch rule', () => {
    const parsed = makeParsed({
      eventType: 'push',
      branch: 'main',
      defaultBranch: 'main',
      files: ['src/app.ts'],
    });
    const result = normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig());
    assert.ok(result);
    assert.equal(result.sourceMetadata.skillPath, '.claude/skills/cicd/SKILL.md');
  });

  it('returns null for unmapped events — explicit-only routing', () => {
    const parsed = makeParsed({ eventType: 'star', action: 'created', branch: null });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig()), null);
  });

  it('returns null when github section is absent', () => {
    const config = makeWorkflowConfig({ github: undefined });
    const parsed = makeParsed({ eventType: 'pull_request', action: 'opened', prNumber: 1 });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, config), null);
  });

  // -------------------------------------------------------------------------
  // Bot-loop / agent-commit filtering (preserved from pre-P20)
  // -------------------------------------------------------------------------

  it('returns null for bot sender by ID', () => {
    setBotUserId(99999);
    const parsed = makeParsed({ senderId: 99999, sender: 'my-bot[bot]' });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig()), null);
  });

  it('returns null for bot sender by username', () => {
    setBotUsername('my-bot');
    const parsed = makeParsed({ sender: 'my-bot' });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig()), null);
  });

  it('returns null for senderIsBot when no bot ID configured', () => {
    const parsed = makeParsed({ senderIsBot: true, sender: 'dependabot[bot]' });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig()), null);
  });

  it('skips push when head_commit.id is a tracked agent SHA', () => {
    trackAgentCommit('agent-sha-001');
    const parsed = makeParsed({
      eventType: 'push',
      branch: 'feature/x',
      defaultBranch: 'main',
      rawPayload: { head_commit: { id: 'agent-sha-001' } },
    });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig()), null);
  });

  it('skips pull_request.synchronize when after SHA is a tracked agent SHA', () => {
    trackAgentCommit('agent-sha-002');
    const parsed = makeParsed({
      eventType: 'pull_request',
      action: 'synchronize',
      prNumber: 10,
      rawPayload: { after: 'agent-sha-002' },
    });
    assert.equal(normalizeGitHubEventFromWorkflow(parsed, makeWorkflowConfig()), null);
  });

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  it('createGitHubNormalizer wires an injectable resolver', () => {
    const normalizer = createGitHubNormalizer({ skillResolver: createSkillResolver() });
    const result = normalizer.normalize(
      makeParsed({ eventType: 'pull_request', action: 'opened', prNumber: 7, branch: 'feat' }),
      makeWorkflowConfig(),
    );
    assert.ok(result);
    assert.equal(result.sourceMetadata.skillPath, '.claude/skills/github-ops/SKILL.md');
  });

  it('sanitizes commentBody into rawText', () => {
    const parsed = makeParsed({
      eventType: 'issue_comment',
      action: 'created',
      commentBody: '@bot <!-- hidden --> help',
      branch: null,
    });
    const config = makeWorkflowConfig({
      github: {
        events: {
          issue_comment: '.claude/skills/mentions/SKILL.md',
        },
      },
    });
    const result = normalizeGitHubEventFromWorkflow(parsed, config);
    assert.ok(result);
    assert.ok(result.rawText);
    assert.ok(!result.rawText.includes('<!-- hidden -->'));
  });
});
