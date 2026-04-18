/**
 * Tests for WorkflowParser github.events per-repo section (GAP-15 / SPEC-001).
 *
 * Verifies that github.events inside each repo entry are correctly parsed
 * and accessible via resolveRepoConfig().
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflowMdString,
  resolveRepoConfig,
} from '../../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKFLOW_WITH_GITHUB = `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: my-team
  active_types:
    - unstarted
    - started
  terminal_types:
    - completed
    - canceled

repos:
  org/main-repo:
    url: git@github.com:org/main-repo.git
    default_branch: main
    github:
      events:
        pull_request.opened: github-ops
        pull_request.synchronize: github-ops
        pull_request.closed.merged: release-pipeline
        pull_request.ready_for_review: github-ops
        push.default_branch: cicd-pipeline
        push.other: quick-fix
        issues.opened: github-ops
        issues.labeled.bug: tdd-workflow
        issues.labeled.enhancement: feature-build
        issues.labeled.security: security-audit
        issue_comment.mentions_bot: quick-fix
        pull_request_review.changes_requested: quick-fix
        workflow_run.failure: quick-fix
        release.published: release-pipeline
        deployment_status.failure: quick-fix

  org/secondary-repo:
    url: git@github.com:org/secondary-repo.git

polling:
  interval_ms: 30000
  enabled: false

stall:
  timeout_ms: 300000
---

You are an agent.
`;

const WORKFLOW_WITHOUT_GITHUB = `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git

polling:
  enabled: false

stall:
  timeout_ms: 300000
---

Prompt template here.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowParser github.events (GAP-15)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'test-key';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('AC2: should parse github.events section into per-repo config', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);
    const resolved = resolveRepoConfig(config, 'org/main-repo');

    assert.ok(resolved, 'resolved config should be defined');
    assert.ok(resolved.github, 'github section should be defined');
    assert.ok(resolved.github.events, 'github.events should be defined');

    // Verify all 15 rules are present
    assert.equal(Object.keys(resolved.github.events).length, 15);

    // Spot check specific rules
    assert.equal(resolved.github.events['pull_request.opened'], 'github-ops');
    assert.equal(resolved.github.events['push.default_branch'], 'cicd-pipeline');
    assert.equal(resolved.github.events['push.other'], 'quick-fix');
    assert.equal(resolved.github.events['issues.labeled.bug'], 'tdd-workflow');
    assert.equal(resolved.github.events['pull_request.closed.merged'], 'release-pipeline');
    assert.equal(resolved.github.events['issue_comment.mentions_bot'], 'quick-fix');
    assert.equal(resolved.github.events['workflow_run.failure'], 'quick-fix');
    assert.equal(resolved.github.events['release.published'], 'release-pipeline');
    assert.equal(resolved.github.events['deployment_status.failure'], 'quick-fix');
  });

  it('AC3: should return github as undefined when repo has no github section', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITHOUT_GITHUB);
    const resolved = resolveRepoConfig(config, 'org/my-repo');

    assert.ok(resolved);
    assert.equal(resolved.github, undefined);
  });

  it('should preserve existing Linear config when github section is present', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);

    assert.equal(config.tracker.kind, 'linear');
    assert.equal(config.tracker.team, 'my-team');
    assert.equal(config.polling.intervalMs, 30000);
    assert.equal(config.stall.timeoutMs, 300000);
  });

  it('should handle empty github.events section gracefully', () => {
    const emptyEvents = `---
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
    github:
      events:
---
`;
    const config = parseWorkflowMdString(emptyEvents);
    const resolved = resolveRepoConfig(config, 'org/my-repo');

    assert.ok(resolved);
    // Empty events section -> github is undefined (no entries extracted)
    assert.equal(resolved.github, undefined);
  });

  it('should parse dotted keys in github.events as literal rule keys', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);
    const resolved = resolveRepoConfig(config, 'org/main-repo');

    // The key 'pull_request.closed.merged' should be stored as-is, not nested further
    assert.ok(resolved?.github);
    assert.equal(resolved.github!.events['pull_request.closed.merged'], 'release-pipeline');
  });

  it('repos without github.events do not inherit events from other repos', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);
    const resolved = resolveRepoConfig(config, 'org/secondary-repo');

    assert.ok(resolved);
    assert.equal(resolved.github, undefined);
  });
});
