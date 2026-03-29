/**
 * Tests for WorkflowParser github.events section (GAP-15).
 *
 * Verifies that parseFlatYaml() supports 2-level nesting for the github.events
 * section and that buildConfig() correctly populates WorkflowConfig.github.events.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflowMdString,
} from '../../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKFLOW_WITH_GITHUB = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md
  tdd-workflow:
    - .claude/agents/core/coder.md
  feature-build:
    - .claude/agents/core/coder.md
  security-audit:
    - .claude/agents/core/coder.md
  sparc-full:
    - .claude/agents/core/coder.md
  github-ops:
    - .claude/agents/core/coder.md
  release-pipeline:
    - .claude/agents/core/coder.md
  cicd-pipeline:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: my-team
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

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

agents:
  max_concurrent: 8
  routing:
    bug: tdd-workflow
    feature: feature-build
    security: security-audit
    refactor: sparc-full
    default: quick-fix

polling:
  interval_ms: 30000
  enabled: false

stall:
  timeout_ms: 300000
---

You are an agent.
`;

const WORKFLOW_WITHOUT_GITHUB = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: my-team

agents:
  routing:
    default: quick-fix

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

  it('AC2: should parse github.events section into WorkflowConfig', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);

    assert.ok(config.github, 'github section should be defined');
    assert.ok(config.github.events, 'github.events should be defined');

    // Verify all 15 rules are present
    assert.equal(Object.keys(config.github.events).length, 15);

    // Spot check specific rules
    assert.equal(config.github.events['pull_request.opened'], 'github-ops');
    assert.equal(config.github.events['push.default_branch'], 'cicd-pipeline');
    assert.equal(config.github.events['push.other'], 'quick-fix');
    assert.equal(config.github.events['issues.labeled.bug'], 'tdd-workflow');
    assert.equal(config.github.events['pull_request.closed.merged'], 'release-pipeline');
    assert.equal(config.github.events['issue_comment.mentions_bot'], 'quick-fix');
    assert.equal(config.github.events['workflow_run.failure'], 'quick-fix');
    assert.equal(config.github.events['release.published'], 'release-pipeline');
    assert.equal(config.github.events['deployment_status.failure'], 'quick-fix');
  });

  it('AC3: should return github as undefined when WORKFLOW.md has no github section', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITHOUT_GITHUB);

    assert.equal(config.github, undefined);
  });

  it('should preserve existing Linear config when github section is present', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);

    assert.equal(config.tracker.kind, 'linear');
    assert.equal(config.tracker.team, 'my-team');
    assert.equal(config.agents.defaultTemplate, 'quick-fix');
    assert.equal(config.agents.routing.bug, 'tdd-workflow');
    assert.equal(config.polling.intervalMs, 30000);
    assert.equal(config.stall.timeoutMs, 300000);
  });

  it('should handle empty github.events section gracefully', () => {
    const emptyEvents = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

github:
  events:

agents:
  routing:
    default: quick-fix
---
`;
    const config = parseWorkflowMdString(emptyEvents);

    // Empty events section -> github is undefined (no entries extracted)
    assert.equal(config.github, undefined);
  });

  it('should parse dotted keys in github.events as literal rule keys', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITH_GITHUB);

    // The key 'pull_request.closed.merged' should be stored as-is, not nested further
    assert.ok(config.github);
    assert.equal(config.github.events['pull_request.closed.merged'], 'release-pipeline');
  });

  it('should not break existing parser tests (backward compat)', () => {
    const config = parseWorkflowMdString(WORKFLOW_WITHOUT_GITHUB);

    assert.equal(config.tracker.kind, 'linear');
    assert.equal(config.agents.defaultTemplate, 'quick-fix');
    assert.equal(config.github, undefined);
  });
});
