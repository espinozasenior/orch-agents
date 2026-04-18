/**
 * Tests for WorkflowParser -- WORKFLOW.md parsing into WorkflowConfig.
 *
 * Covers: frontmatter extraction, nested YAML parsing, env var resolution,
 * validation of required fields, default values, repos map parsing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflowMdString,
  WorkflowParseError,
  resolveRepoConfig,
  getRepoNames,
} from '../../../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_WORKFLOW = `---
defaults:
  agents:
    max_concurrent: 8
  stall:
    timeout_ms: 300000
  polling:
    interval_ms: 30000
    enabled: false

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
  somnio-projects/marketplace-monorepo:
    url: git@github.com:somnio-projects/marketplace-monorepo.git
    default_branch: main
    teams: [AUT]
    labels: [marketplace-monorepo, backend, infra]
    github:
      events:
        pull_request.opened: .claude/skills/github-ops/SKILL.md
        pull_request.synchronize: .claude/skills/github-ops/SKILL.md
    tracker:
      team: AUT

  espinozasenior/orch-agents:
    url: git@github.com:espinozasenior/orch-agents.git
    default_branch: main
    labels: [agent, orchestrator, bot]
    github:
      events:
        pull_request.opened: .claude/skills/review/SKILL.md
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
    // $LINEAR_API_KEY is a secret and is NOT in the safe env allowlist,
    // so it resolves to empty string. The app falls back to config.linearApiKey.
    assert.equal(config.tracker.apiKey, '');
    assert.equal(config.tracker.team, 'my-team');
    assert.deepEqual(config.tracker.activeTypes, ['unstarted', 'started']);
    assert.deepEqual(config.tracker.terminalTypes, ['completed', 'canceled']);
    // No active_states/terminal_states in YAML -> defaults from source
    assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(config.tracker.terminalStates, ['Done', 'Cancelled']);
  });

  it('should parse agents section correctly', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.agents.maxConcurrent, 8);
  });

  it('should parse defaults section correctly', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.defaults.agents.maxConcurrentPerOrg, 8);
    assert.equal(config.defaults.stall.timeoutMs, 300000);
    assert.equal(config.defaults.polling.intervalMs, 30000);
    assert.equal(config.defaults.polling.enabled, false);
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

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git

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

  it('should parse multiline hooks', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team

repos:
  org/orch-agents:
    url: git@github.com:org/orch-agents.git

hooks:
  before_run: |
    echo before
    echo after
---
Prompt here.
`;

    const config = parseWorkflowMdString(workflow);

    assert.equal(config.hooks.beforeRun, 'echo before\necho after\n');
  });

  it('should extract prompt template from body', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.ok(config.promptTemplate.includes('{{ issue.identifier }}'));
    assert.ok(config.promptTemplate.includes('{{ issue.description }}'));
  });

  it('should resolve safe environment variables in string values', () => {
    process.env.LINEAR_TEAM = 'resolved-team';
    const teamWorkflow = VALID_WORKFLOW.replace('team: my-team', 'team: $LINEAR_TEAM');
    const config = parseWorkflowMdString(teamWorkflow);

    assert.equal(config.tracker.team, 'resolved-team');
    delete process.env.LINEAR_TEAM;
  });

  it('should NOT resolve secret environment variables (allowlist enforcement)', () => {
    // SECRET env vars like LINEAR_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN
    // must NOT be resolvable via WORKFLOW.md env substitution
    process.env.LINEAR_API_KEY = 'secret-key-should-not-resolve';
    process.env.ANTHROPIC_API_KEY = 'another-secret';
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    // $LINEAR_API_KEY is blocked -> resolves to empty string
    assert.equal(config.tracker.apiKey, '');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should resolve missing env vars to empty string', () => {
    delete process.env.LINEAR_API_KEY;
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    assert.equal(config.tracker.apiKey, '');
  });

  it('should use defaults for optional fields', () => {
    const minimal = `---
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
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
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
`;
    const config = parseWorkflowMdString(minimal);

    // Type defaults are always populated
    assert.deepEqual(config.tracker.activeTypes, ['unstarted', 'started']);
    assert.deepEqual(config.tracker.terminalTypes, ['completed', 'canceled']);
    // Name-based state defaults from source
    assert.deepEqual(config.tracker.activeStates, ['Todo', 'In Progress']);
    assert.deepEqual(config.tracker.terminalStates, ['Done', 'Cancelled']);
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

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
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
tracker:
  kind: jira
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
`;
    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes("must be 'linear'"),
    );
  });

  it('should default tracker.team to empty string when missing', () => {
    const input = `---
tracker:
  kind: linear

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
`;
    const config = parseWorkflowMdString(input);
    assert.equal(config.tracker?.team, '');
  });

  it('should handle quoted values', () => {
    const quoted = `---
tracker:
  kind: "linear"
  team: 'my-team'

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
`;
    const config = parseWorkflowMdString(quoted);

    assert.equal(config.tracker.kind, 'linear');
    assert.equal(config.tracker.team, 'my-team');
  });

  it('should handle polling enabled=true', () => {
    const withPolling = `---
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git

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

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
`;
    const config = parseWorkflowMdString(noBody);

    assert.equal(config.promptTemplate, '');
  });

  // ---------------------------------------------------------------------------
  // SPEC-001: repos map parsing
  // ---------------------------------------------------------------------------

  it('should parse repos map with all fields', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    const repoNames = getRepoNames(config);
    assert.equal(repoNames.length, 2);
    assert.ok(repoNames.includes('somnio-projects/marketplace-monorepo'));
    assert.ok(repoNames.includes('espinozasenior/orch-agents'));

    const marketplace = config.repos['somnio-projects/marketplace-monorepo'];
    assert.equal(marketplace.url, 'git@github.com:somnio-projects/marketplace-monorepo.git');
    assert.equal(marketplace.defaultBranch, 'main');
    assert.deepEqual(marketplace.teams, ['AUT']);
    assert.deepEqual(marketplace.labels, ['marketplace-monorepo', 'backend', 'infra']);
    assert.ok(marketplace.github);
    assert.equal(marketplace.github!.events['pull_request.opened'], '.claude/skills/github-ops/SKILL.md');
    assert.equal(marketplace.tracker?.team, 'AUT');

    const orchAgents = config.repos['espinozasenior/orch-agents'];
    assert.equal(orchAgents.url, 'git@github.com:espinozasenior/orch-agents.git');
    assert.deepEqual(orchAgents.labels, ['agent', 'orchestrator', 'bot']);
    assert.ok(orchAgents.github);
    assert.equal(orchAgents.github!.events['pull_request.opened'], '.claude/skills/review/SKILL.md');
    assert.equal(orchAgents.tracker, undefined);
  });

  it('should parse repos map with minimal fields (url only)', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
Prompt here.
`;
    const config = parseWorkflowMdString(workflow);

    const repoNames = getRepoNames(config);
    assert.equal(repoNames.length, 1);
    assert.equal(repoNames[0], 'org/my-repo');

    const repo = config.repos['org/my-repo'];
    assert.equal(repo.url, 'git@github.com:org/my-repo.git');
    assert.equal(repo.defaultBranch, 'main');
    assert.equal(repo.teams, undefined);
    assert.equal(repo.labels, undefined);
    assert.equal(repo.github, undefined);
    assert.equal(repo.tracker, undefined);
  });

  it('should throw when repos is missing', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('repos'),
    );
  });

  it('should throw when repos is empty', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team

repos: {}
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('repos'),
    );
  });

  it('should throw when repos key is not in owner/repo format', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team

repos:
  my-repo:
    url: git@github.com:org/my-repo.git
---
Prompt here.
`;
    assert.throws(
      () => parseWorkflowMdString(workflow),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('owner/repo'),
    );
  });

  it('should throw when repos entry is missing url', () => {
    const workflow = `---
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    default_branch: main
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
tracker:
  kind: linear
  team: my-team

repos:
  org/my-repo:
    url: git@github.com:org/my-repo.git
---
Issue {{ issue.assignee }}
`;

    assert.throws(
      () => parseWorkflowMdString(bad),
      (err: Error) => err instanceof WorkflowParseError && err.message.includes('unsupported placeholders'),
    );
  });

  // ---------------------------------------------------------------------------
  // resolveRepoConfig
  // ---------------------------------------------------------------------------

  it('resolveRepoConfig returns repo-scoped config with github events', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    const resolved = resolveRepoConfig(config, 'somnio-projects/marketplace-monorepo');
    assert.ok(resolved);
    assert.ok(resolved.github);
    assert.equal(resolved.github!.events['pull_request.opened'], '.claude/skills/github-ops/SKILL.md');
    // tracker.team overridden
    assert.equal(resolved.tracker.team, 'AUT');
  });

  it('resolveRepoConfig returns null for unknown repo', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    const resolved = resolveRepoConfig(config, 'unknown/repo');
    assert.equal(resolved, null);
  });

  it('resolveRepoConfig inherits global tracker when repo has no tracker override', () => {
    const config = parseWorkflowMdString(VALID_WORKFLOW);

    const resolved = resolveRepoConfig(config, 'espinozasenior/orch-agents');
    assert.ok(resolved);
    assert.equal(resolved.tracker.team, 'my-team');
  });
});
