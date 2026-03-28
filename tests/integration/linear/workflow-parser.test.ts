/**
 * Tests for WorkflowParser -- WORKFLOW.md parsing into WorkflowConfig.
 *
 * Covers: frontmatter extraction, nested YAML parsing, env var resolution,
 * validation of required fields, default values.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflowMdString,
  WorkflowParseError,
} from '../../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_WORKFLOW = `---
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

You are an autonomous development agent working on {{ issue.identifier }}.

{{ issue.description }}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowParser', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'test-api-key-123';
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('should parse a valid WORKFLOW.md with all fields', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.tracker.kind, 'linear');
    assert.equal(config.tracker.apiKey, 'test-api-key-123');
    assert.equal(config.tracker.team, 'my-team');
    assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(config.tracker.terminalStates, ['Done', 'Cancelled']);
    assert.deepEqual(config.tracker.activeTypes, ['unstarted', 'started']);
    assert.deepEqual(config.tracker.terminalTypes, ['completed', 'canceled']);
  });

  it('should parse agents section correctly', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.agents.maxConcurrent, 8);
    assert.equal(config.agents.routing.bug, 'tdd-workflow');
    assert.equal(config.agents.routing.feature, 'feature-build');
    assert.equal(config.agents.routing.security, 'security-audit');
    assert.equal(config.agents.routing.refactor, 'sparc-full');
    assert.equal(config.agents.defaultTemplate, 'quick-fix');
  });

  it('should parse polling section correctly', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.polling.intervalMs, 30000);
    assert.equal(config.polling.enabled, false);
  });

  it('should parse stall section correctly', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.stall.timeoutMs, 300000);
  });

  it('should extract prompt template from body', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.ok(config.promptTemplate.includes('{{ issue.identifier }}'));
    assert.ok(config.promptTemplate.includes('{{ issue.description }}'));
  });

  it('should resolve environment variables in string values', () => {
    process.env.LINEAR_API_KEY = 'resolved-key';
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.tracker.apiKey, 'resolved-key');
  });

  it('should resolve missing env vars to empty string', () => {
    delete process.env.LINEAR_API_KEY;
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.tracker.apiKey, '');
  });

  it('should use defaults for optional polling fields', () => {
    const minimal = `---
tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
---

Prompt here.
`;
    const config = parseWorkflowMdString(minimal);

    assert.equal(config.polling.intervalMs, 30000);
    assert.equal(config.polling.enabled, false);
    assert.equal(config.stall.timeoutMs, 300000);
    assert.equal(config.agents.maxConcurrent, 8);
  });

  it('should use default active/terminal states when not specified', () => {
    const minimal = `---
tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
---
`;
    const config = parseWorkflowMdString(minimal);

    assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(config.tracker.terminalStates, ['Done', 'Cancelled']);
    // Type defaults are always populated
    assert.deepEqual(config.tracker.activeTypes, ['unstarted', 'started']);
    assert.deepEqual(config.tracker.terminalTypes, ['completed', 'canceled']);
  });

  it('should throw for missing frontmatter delimiters', () => {
    assert.throws(
      () => parseWorkflowMdString('no frontmatter here'),
      (err: Error) => err instanceof WorkflowParseError,
    );
  });

  it('should throw for missing closing frontmatter delimiter', () => {
    assert.throws(
      () => parseWorkflowMdString('---\ntracker:\n  kind: linear\n'),
      (err: Error) => err instanceof WorkflowParseError,
    );
  });

  it('should throw when tracker.kind is not linear', () => {
    const bad = `---
tracker:
  kind: jira
  team: my-team

agents:
  routing:
    default: quick-fix
---
`;
    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes("must be 'linear'"),
    );
  });

  it('should throw when tracker.team is missing', () => {
    const bad = `---
tracker:
  kind: linear

agents:
  routing:
    default: quick-fix
---
`;
    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('tracker.team'),
    );
  });

  it('should throw when agents.routing.default is missing', () => {
    const bad = `---
tracker:
  kind: linear
  team: my-team

agents:
  routing:
    bug: tdd-workflow
---
`;
    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('routing.default'),
    );
  });

  it('should handle quoted values', () => {
    const quoted = `---
tracker:
  kind: "linear"
  team: 'my-team'

agents:
  routing:
    default: "quick-fix"
---
`;
    const config = parseWorkflowMdString(quoted);

    assert.equal(config.tracker.kind, 'linear');
    assert.equal(config.tracker.team, 'my-team');
    assert.equal(config.agents.defaultTemplate, 'quick-fix');
  });

  it('should handle polling enabled=true', () => {
    const withPolling = `---
tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

polling:
  interval_ms: 60000
  enabled: true
---
`;
    const config = parseWorkflowMdString(withPolling);

    assert.equal(config.polling.intervalMs, 60000);
    assert.equal(config.polling.enabled, true);
  });

  it('should handle empty body after frontmatter', () => {
    const noBody = `---
tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
---
`;
    const config = parseWorkflowMdString(noBody);

    assert.equal(config.promptTemplate, '');
  });
});
