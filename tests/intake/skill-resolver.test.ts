/**
 * Tests for the P20 skill resolver.
 *
 * Covers parseRuleKey (ported from github-workflow-normalizer), pure path
 * lookup against WORKFLOW.md config, and file-system resolution.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseRuleKey,
  resolvePath,
  resolveByPath,
  resolveSkillForEvent,
  createSkillResolver,
  buildRuleKeyCandidates,
} from '../../src/intake/skill-resolver';
import type { WorkflowConfig } from '../../src/integration/linear/workflow-parser';
import type { ParsedGitHubEvent } from '../../src/webhook-gateway/event-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParsed(overrides: Partial<ParsedGitHubEvent> = {}): ParsedGitHubEvent {
  return {
    eventType: 'push',
    action: null,
    deliveryId: 'test-delivery',
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

function makeConfig(overrides?: Partial<WorkflowConfig['github']>): WorkflowConfig {
  return {
    templates: {},
    tracker: {
      kind: 'linear',
      apiKey: '',
      team: 't',
      activeTypes: ['unstarted', 'started'],
      terminalTypes: ['completed', 'canceled'],
      activeStates: [],
      terminalStates: [],
    },
    github: {
      events: {
        'pull_request.opened': '.claude/skills/github-ops/SKILL.md',
        'issues.labeled.bug': '.claude/skills/bug-fix/SKILL.md',
        'push.default_branch': '.claude/skills/cicd/SKILL.md',
      },
      ...overrides,
    },
    agents: { maxConcurrent: 1, routing: {}, defaultTemplate: 'coordinator' },
    agent: { maxConcurrentAgents: 1, maxRetryBackoffMs: 0, maxTurns: 1 },
    polling: { intervalMs: 0, enabled: false },
    stall: { timeoutMs: 0 },
    agentRunner: { stallTimeoutMs: 0, command: 'claude', turnTimeoutMs: 0 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 0 },
    promptTemplate: '',
  };
}

// ---------------------------------------------------------------------------
// parseRuleKey (ported from github-workflow-normalizer)
// ---------------------------------------------------------------------------

describe('parseRuleKey', () => {
  it('parses event.action format', () => {
    assert.deepEqual(parseRuleKey('pull_request.opened'),
      { event: 'pull_request', action: 'opened', condition: null });
  });

  it('parses event.action.condition format', () => {
    assert.deepEqual(parseRuleKey('pull_request.closed.merged'),
      { event: 'pull_request', action: 'closed', condition: 'merged' });
  });

  it('parses event.condition for no-action events', () => {
    assert.deepEqual(parseRuleKey('push.default_branch'),
      { event: 'push', action: null, condition: 'default_branch' });
  });

  it('parses issues.labeled.bug', () => {
    assert.deepEqual(parseRuleKey('issues.labeled.bug'),
      { event: 'issues', action: 'labeled', condition: 'bug' });
  });

  it('parses pull_request_review.changes_requested', () => {
    assert.deepEqual(parseRuleKey('pull_request_review.changes_requested'),
      { event: 'pull_request_review', action: null, condition: 'changes_requested' });
  });

  it('parses single-segment key', () => {
    assert.deepEqual(parseRuleKey('push'),
      { event: 'push', action: null, condition: null });
  });
});

// ---------------------------------------------------------------------------
// resolvePath (pure)
// ---------------------------------------------------------------------------

describe('resolvePath', () => {
  it('returns mapped path for matching event.action', () => {
    const parsed = makeParsed({ eventType: 'pull_request', action: 'opened', branch: 'feature/x' });
    const result = resolvePath(parsed, makeConfig());
    assert.deepEqual(result, {
      relPath: '.claude/skills/github-ops/SKILL.md',
      ruleKey: 'pull_request.opened',
    });
  });

  it('returns label-conditioned path', () => {
    const parsed = makeParsed({
      eventType: 'issues', action: 'labeled', branch: null, labels: ['bug'],
    });
    const result = resolvePath(parsed, makeConfig());
    assert.deepEqual(result, {
      relPath: '.claude/skills/bug-fix/SKILL.md',
      ruleKey: 'issues.labeled.bug',
    });
  });

  it('returns push.default_branch path', () => {
    const parsed = makeParsed({ eventType: 'push', branch: 'main', defaultBranch: 'main' });
    const result = resolvePath(parsed, makeConfig());
    assert.equal(result?.relPath, '.claude/skills/cicd/SKILL.md');
  });

  it('falls back to github.default when no rule matches', () => {
    const parsed = makeParsed({ eventType: 'star', action: 'created', branch: null });
    const config = makeConfig({
      events: {},
      default: '.claude/skills/general/SKILL.md',
    });
    const result = resolvePath(parsed, config);
    assert.deepEqual(result, {
      relPath: '.claude/skills/general/SKILL.md',
      ruleKey: 'default',
    });
  });

  it('returns null when no rule and no default', () => {
    const parsed = makeParsed({ eventType: 'star', action: 'created', branch: null });
    const config = makeConfig({ events: {} });
    assert.equal(resolvePath(parsed, config), null);
  });

  it('returns null when github section is absent', () => {
    const parsed = makeParsed({ eventType: 'pull_request', action: 'opened' });
    const config = makeConfig();
    delete (config as { github?: unknown }).github;
    assert.equal(resolvePath(parsed, config), null);
  });
});

describe('buildRuleKeyCandidates', () => {
  it('produces increasingly less specific keys', () => {
    const parsed = makeParsed({
      eventType: 'pull_request', action: 'closed', merged: true, branch: 'feat/x', defaultBranch: 'main',
    });
    const candidates = buildRuleKeyCandidates(parsed);
    assert.ok(candidates.includes('pull_request.closed.merged'));
    assert.ok(candidates.includes('pull_request.closed'));
    assert.ok(candidates.includes('pull_request'));
  });
});

// ---------------------------------------------------------------------------
// resolveByPath (file system)
// ---------------------------------------------------------------------------

describe('resolveByPath', () => {
  let tmpRoot = '';

  before(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'skill-resolver-'));
    mkdirSync(path.join(tmpRoot, '.claude/skills/github-ops'), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, '.claude/skills/github-ops/SKILL.md'),
      `---
name: github-ops
context-fetchers:
  - gh-pr-view
  - gh-pr-diff
---
# GitHub Ops

Real PR review.
`,
    );
  });

  after(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns parsed skill for an existing file', () => {
    const result = resolveByPath('.claude/skills/github-ops/SKILL.md', tmpRoot);
    assert.notEqual(result, null);
    assert.equal(result!.frontmatter.name, 'github-ops');
    assert.deepEqual(result!.frontmatter.contextFetchers, ['gh-pr-view', 'gh-pr-diff']);
    assert.match(result!.body, /Real PR review\./);
    assert.equal(result!.path, path.resolve(tmpRoot, '.claude/skills/github-ops/SKILL.md'));
  });

  it('returns null for missing file', () => {
    assert.equal(resolveByPath('.claude/skills/missing/SKILL.md', tmpRoot), null);
  });

  it('resolveSkillForEvent composes path lookup + file read', () => {
    const config: WorkflowConfig = makeConfig({
      events: { 'pull_request.opened': '.claude/skills/github-ops/SKILL.md' },
    });
    const parsed = makeParsed({ eventType: 'pull_request', action: 'opened', branch: 'feat/x' });
    const skill = resolveSkillForEvent(parsed, config, tmpRoot);
    assert.notEqual(skill, null);
    assert.equal(skill!.frontmatter.name, 'github-ops');
  });

  it('createSkillResolver wires the helpers', () => {
    const resolver = createSkillResolver();
    const config = makeConfig();
    const parsed = makeParsed({ eventType: 'pull_request', action: 'opened', branch: 'feat/x' });
    const lookup = resolver.resolvePath(parsed, config);
    assert.equal(lookup?.ruleKey, 'pull_request.opened');
  });
});
