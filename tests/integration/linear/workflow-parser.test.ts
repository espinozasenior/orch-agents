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
    assert.deepEqual(config.tracker.activeTypes, ['unstarted', 'started']);
    assert.deepEqual(config.tracker.terminalTypes, ['completed', 'canceled']);
    // No active_states/terminal_states in YAML → defaults to empty
    assert.deepEqual(config.tracker.activeStates, []);
    assert.deepEqual(config.tracker.terminalStates, []);
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
    assert.equal(config.agentRunner.stallTimeoutMs, 300000);
  });

  it('should expose Symphony-aligned agent defaults', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.agent.maxConcurrentAgents, 8);
    assert.equal(config.agent.maxRetryBackoffMs, 300000);
    assert.equal(config.agent.maxTurns, 20);
    assert.equal(config.agentRunner.command, 'claude');
    assert.equal(config.agentRunner.turnTimeoutMs, 3600000);
    assert.equal(config.hooks.timeoutMs, 60000);
    assert.equal(config.hooks.beforeRun, null);
  });

  it('should accept new Symphony key names', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team

templates:
  quick-fix:
    - .claude/agents/core/coder.md

agents:
  routing:
    default: quick-fix

agent:
  max_concurrent_agents: 3
  max_retry_backoff_ms: 120000
  max_turns: 11

agent_runner:
  stall_timeout_ms: 45000
  command: claude
  turn_timeout_ms: 123000

hooks:
  before_run: echo before
  timeout_ms: 4500
---
Prompt here.
`;
    const config = parseWorkflowMdString(workflow);

    assert.equal(config.agent.maxConcurrentAgents, 3);
    assert.equal(config.agents.maxConcurrent, 3);
    assert.equal(config.agent.maxRetryBackoffMs, 120000);
    assert.equal(config.agent.maxTurns, 11);
    assert.equal(config.agentRunner.stallTimeoutMs, 45000);
    assert.equal(config.stall.timeoutMs, 45000);
    assert.equal(config.agentRunner.turnTimeoutMs, 123000);
    assert.equal(config.hooks.beforeRun, 'echo before');
    assert.equal(config.hooks.timeoutMs, 4500);
  });

  it('should parse workspace settings and multiline hooks with a real YAML path', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
  repos:
    - name: orch-agents
      url: git@github.com:org/orch-agents.git

hooks:
  before_run: |
    echo before
    echo after
---
Prompt here.
`;

    const config = parseWorkflowMdString(workflow);

    assert.equal(config.workspace?.root, '/tmp/orch-agents');
    assert.ok(config.workspace?.repos.length === 1);
    assert.equal(config.hooks.beforeRun, 'echo before\necho after\n');
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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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
    assert.equal(config.agent.maxConcurrentAgents, 8);
    assert.equal(config.agent.maxRetryBackoffMs, 300000);
    assert.equal(config.agent.maxTurns, 20);
    assert.equal(config.agentRunner.command, 'claude');
    assert.equal(config.agentRunner.turnTimeoutMs, 3600000);
    assert.equal(config.hooks.timeoutMs, 60000);
  });

  it('should use default active/terminal types when not specified', () => {
    const minimal = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
---
`;
    const config = parseWorkflowMdString(minimal);

    // Type defaults are always populated
    assert.deepEqual(config.tracker.activeTypes, ['unstarted', 'started']);
    assert.deepEqual(config.tracker.terminalTypes, ['completed', 'canceled']);
    // No name-based states → empty (deprecated)
    assert.deepEqual(config.tracker.activeStates, []);
    assert.deepEqual(config.tracker.terminalStates, []);
  });

  it('should still parse legacy active_states/terminal_states for backward compat', () => {
    const legacy = `---
tracker:
  kind: linear
  team: my-team
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

agents:
  routing:
    default: quick-fix
---
`;
    const config = parseWorkflowMdString(legacy);

    assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(config.tracker.terminalStates, ['Done', 'Cancelled']);
    // Types still get defaults
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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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
templates:
  quick-fix:
    - .claude/agents/core/coder.md

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

  it('should reject unknown routed templates', () => {
    const bad = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
    bug: missing-template
---
Prompt here.
`;

    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('unknown template'),
    );
  });

  // ---------------------------------------------------------------------------
  // Phase 8: workspace.repos parsing
  // ---------------------------------------------------------------------------

  it('should parse workspace.repos with all fields', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
  default_repo: orch-agents
  repos:
    - name: orch-agents
      url: git@github.com:espinozasenior/orch-agents.git
      teams: [AUT]
      labels: [backend, agent, infra]
      default_branch: main
    - name: frontend-app
      url: git@github.com:espinozasenior/frontend-app.git
      teams: [FE]
      labels: [frontend, ui]
      default_branch: main
---
Prompt here.
`;
    const config = parseWorkflowMdString(workflow);

    assert.ok(config.workspace);
    assert.equal(config.workspace.root, '/tmp/orch-agents');
    assert.equal(config.workspace.defaultRepo, 'orch-agents');
    assert.ok(config.workspace.repos);
    assert.equal(config.workspace.repos.length, 2);
    assert.equal(config.workspace.repos[0].name, 'orch-agents');
    assert.equal(config.workspace.repos[0].url, 'git@github.com:espinozasenior/orch-agents.git');
    assert.deepEqual(config.workspace.repos[0].teams, ['AUT']);
    assert.deepEqual(config.workspace.repos[0].labels, ['backend', 'agent', 'infra']);
    assert.equal(config.workspace.repos[0].defaultBranch, 'main');
    assert.equal(config.workspace.repos[1].name, 'frontend-app');
    assert.deepEqual(config.workspace.repos[1].teams, ['FE']);
    assert.deepEqual(config.workspace.repos[1].labels, ['frontend', 'ui']);
  });

  it('should parse workspace.repos with minimal fields (name + url only)', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
  repos:
    - name: my-repo
      url: git@github.com:org/my-repo.git
---
Prompt here.
`;
    const config = parseWorkflowMdString(workflow);

    assert.ok(config.workspace);
    assert.equal(config.workspace.repos.length, 1);
    assert.equal(config.workspace.repos[0].name, 'my-repo');
    assert.equal(config.workspace.repos[0].url, 'git@github.com:org/my-repo.git');
    assert.equal(config.workspace.repos[0].teams, undefined);
    assert.equal(config.workspace.repos[0].labels, undefined);
    assert.equal(config.workspace.repos[0].defaultBranch, undefined);
    assert.equal(config.workspace.defaultRepo, undefined);
  });

  it('should throw when workspace.repos is missing (workspace present but no repos)', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('workspace.repos'),
    );
  });

  it('should throw when workspace.repos is an empty array', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
  repos: []
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('workspace.repos'),
    );
  });

  it('should throw when workspace.repos entry is missing name', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
  repos:
    - url: git@github.com:org/my-repo.git
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('name'),
    );
  });

  it('should throw when workspace.repos entry is missing url', () => {
    const workflow = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix

workspace:
  root: /tmp/orch-agents
  repos:
    - name: my-repo
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('url'),
    );
  });

  it('should reject unsupported prompt placeholders', () => {
    const bad = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
---
Issue {{ issue.assignee }}
`;

    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('unsupported placeholders'),
    );
  });
});
