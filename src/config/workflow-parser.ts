import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AppError } from '../kernel/errors';
import { validateWorkflowPromptTemplate } from '../integration/linear/workflow-prompt';
import type { WorkflowConfig, RepoConfig } from './workflow-config';
import { WORKFLOW_SAFE_ENV_VARS } from './workflow-config';

// ---------------------------------------------------------------------------
// Internal document shape
// ---------------------------------------------------------------------------

interface WorkflowDocument {
  defaults?: Record<string, unknown>;
  repos?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  polling?: Record<string, unknown>;
  stall?: Record<string, unknown>;
  agent_runner?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseWorkflowMd(filePath: string): WorkflowConfig {
  return parseWorkflowMdString(readFileSync(filePath, 'utf-8'));
}

export function parseWorkflowMdString(content: string): WorkflowConfig {
  const { frontmatter, body } = extractFrontmatter(content);
  const document = parseWorkflowDocument(frontmatter);
  validatePromptTemplate(body);
  return buildConfig(resolveEnvInValue(document) as WorkflowDocument, body);
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new WorkflowParseError('WORKFLOW.md must start with --- frontmatter delimiter');
  }

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    throw new WorkflowParseError('WORKFLOW.md frontmatter is incomplete');
  }

  const endIndex = trimmed.indexOf('\n---', firstNewline);
  if (endIndex === -1) {
    throw new WorkflowParseError('WORKFLOW.md missing closing --- frontmatter delimiter');
  }

  const frontmatter = trimmed.slice(firstNewline + 1, endIndex);
  if (!frontmatter.trim()) {
    throw new WorkflowParseError('WORKFLOW.md frontmatter is empty');
  }

  return {
    frontmatter,
    body: trimmed.slice(endIndex + 4).trim(),
  };
}

function parseWorkflowDocument(frontmatter: string): WorkflowDocument {
  try {
    const parsed = parseYaml(frontmatter);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkflowParseError('frontmatter must be a YAML object');
    }
    return parsed as WorkflowDocument;
  } catch (error) {
    if (error instanceof WorkflowParseError) {
      throw error;
    }
    throw new WorkflowParseError(
      `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function buildConfig(document: WorkflowDocument, body: string): WorkflowConfig {
  // tracker (optional — Linear integration is opt-in)
  const trackerRecord = asOptionalRecord(document.tracker);
  let trackerConfig: WorkflowConfig['tracker'] | undefined;
  if (trackerRecord) {
    const kind = readOptionalString(trackerRecord.kind) ?? 'linear';
    if (kind !== 'linear') {
      throw new WorkflowParseError(`tracker.kind must be 'linear', got '${kind}'`);
    }
    trackerConfig = {
      kind: 'linear',
      apiKey: readOptionalString(trackerRecord.api_key) ?? '',
      team: readOptionalString(trackerRecord.team) ?? '',
      activeStates: readStringArray(trackerRecord.active_states, 'tracker.active_states', ['Todo', 'In Progress']),
      terminalStates: readStringArray(trackerRecord.terminal_states, 'tracker.terminal_states', ['Done', 'Cancelled']),
      activeTypes: readStringArray(trackerRecord.active_types, 'tracker.active_types', ['unstarted', 'started']),
      terminalTypes: readStringArray(trackerRecord.terminal_types, 'tracker.terminal_types', ['completed', 'canceled']),
    };
  }

  // repos (required)
  if (!document.repos || typeof document.repos !== 'object') {
    throw new WorkflowParseError('repos is required and must be a non-empty object');
  }
  const reposRecord = asRecord(document.repos, 'repos');
  if (Object.keys(reposRecord).length === 0) {
    throw new WorkflowParseError('repos is required and must be a non-empty object');
  }
  const repos = buildReposMap(reposRecord);

  // defaults (optional, with fallbacks)
  const defaults = asOptionalRecord(document.defaults);
  const defaultsAgents = asOptionalRecord(defaults?.agents);
  const defaultsStall = asOptionalRecord(defaults?.stall);
  const defaultsPolling = asOptionalRecord(defaults?.polling);

  const hooks = asOptionalRecord(document.hooks);
  const agent = asOptionalRecord(document.agent);
  const agentRunner = asOptionalRecord(document.agent_runner);
  const polling = asOptionalRecord(document.polling);
  const stall = asOptionalRecord(document.stall);

  const maxConcurrent = readNumber(
    defaultsAgents?.max_concurrent ?? agent?.max_concurrent_agents ?? document.agents?.max_concurrent,
    'defaults.agents.max_concurrent',
    8,
  );
  const maxConcurrentPerOrg = readNumber(
    defaultsAgents?.max_concurrent_per_org,
    'defaults.agents.max_concurrent_per_org',
    maxConcurrent,
  );
  const stallTimeoutMs = readNumber(
    defaultsStall?.timeout_ms ?? agentRunner?.stall_timeout_ms ?? stall?.timeout_ms,
    'defaults.stall.timeout_ms',
    300_000,
  );
  const pollingIntervalMs = readNumber(
    defaultsPolling?.interval_ms ?? polling?.interval_ms,
    'defaults.polling.interval_ms',
    30_000,
  );
  const pollingEnabled = readBoolean(
    defaultsPolling?.enabled ?? polling?.enabled,
    false,
  );

  return {
    repos,
    defaults: {
      agents: { maxConcurrent, maxConcurrentPerOrg },
      stall: { timeoutMs: stallTimeoutMs },
      polling: { intervalMs: pollingIntervalMs, enabled: pollingEnabled },
    },
    ...(trackerConfig ? { tracker: trackerConfig } : {}),
    agents: {
      maxConcurrent,
    },
    agent: {
      maxConcurrentAgents: maxConcurrent,
      maxRetryBackoffMs: readNumber(agent?.max_retry_backoff_ms, 'agent.max_retry_backoff_ms', 300_000),
      maxTurns: readNumber(agent?.max_turns, 'agent.max_turns', 20),
    },
    polling: {
      intervalMs: pollingIntervalMs,
      enabled: pollingEnabled,
    },
    stall: {
      timeoutMs: stallTimeoutMs,
    },
    agentRunner: {
      stallTimeoutMs,
      command: readOptionalString(agentRunner?.command) ?? 'claude',
      turnTimeoutMs: readNumber(agentRunner?.turn_timeout_ms, 'agent_runner.turn_timeout_ms', 3_600_000),
    },
    hooks: {
      afterCreate: readOptionalString(hooks?.after_create) ?? null,
      beforeRun: readOptionalString(hooks?.before_run) ?? null,
      afterRun: readOptionalString(hooks?.after_run) ?? null,
      beforeRemove: readOptionalString(hooks?.before_remove) ?? null,
      timeoutMs: readNumber(hooks?.timeout_ms, 'hooks.timeout_ms', 60_000),
    },
    promptTemplate: body,
  };
}

// ---------------------------------------------------------------------------
// Repos map builder
// ---------------------------------------------------------------------------

function buildReposMap(repos: Record<string, unknown>): Record<string, RepoConfig> {
  const result: Record<string, RepoConfig> = {};
  for (const [repoFullName, rawEntry] of Object.entries(repos)) {
    if (!repoFullName.includes('/')) {
      throw new WorkflowParseError(`repos key '${repoFullName}' must be in owner/repo format`);
    }
    const entry = asRecord(rawEntry, `repos.${repoFullName}`);
    const url = readString(entry.url, `repos.${repoFullName}.url`);
    const defaultBranch = readOptionalString(entry.default_branch) ?? 'main';
    const teams = entry.teams != null ? readStringArray(entry.teams, `repos.${repoFullName}.teams`, []) : undefined;
    const labels = entry.labels != null ? readStringArray(entry.labels, `repos.${repoFullName}.labels`, []) : undefined;
    const github = buildGitHubConfig(entry.github);
    const trackerOverride = asOptionalRecord(entry.tracker);

    result[repoFullName] = {
      url,
      defaultBranch,
      ...(teams && teams.length > 0 ? { teams } : {}),
      ...(labels && labels.length > 0 ? { labels } : {}),
      ...(github ? { github } : {}),
      ...(trackerOverride ? { tracker: { team: readOptionalString(trackerOverride.team) } } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// GitHub config builder
// ---------------------------------------------------------------------------

function buildGitHubConfig(github: unknown): { events: Record<string, string> } | undefined {
  const record = asOptionalRecord(github);
  if (!record) return undefined;
  const events = asOptionalRecord(record.events);
  if (!events) return undefined;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(events)) {
    if (typeof value === 'string' && value.length > 0) {
      normalized[key] = value;
    }
  }

  if (Object.keys(normalized).length === 0) return undefined;
  return { events: normalized };
}

// ---------------------------------------------------------------------------
// Prompt template validation
// ---------------------------------------------------------------------------

function validatePromptTemplate(body: string): void {
  const unsupported = validateWorkflowPromptTemplate(body);
  if (unsupported.length > 0) {
    throw new WorkflowParseError(`promptTemplate contains unsupported placeholders: ${unsupported.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

function resolveEnvInValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName) => {
      if (!WORKFLOW_SAFE_ENV_VARS.has(varName)) {
        return '';
      }
      return process.env[varName] ?? '';
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvInValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvInValue(entry)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowParseError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkflowParseError(`${field} is required`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringArray(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new WorkflowParseError(`${field} must be a string[]`);
  }
  return value;
}

function readNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new WorkflowParseError(`${field} must be a number`);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value === 'true';
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class WorkflowParseError extends AppError {
  constructor(message: string) {
    super(`WORKFLOW.md parse error: ${message}`, {
      code: 'ERR_CONFIG',
      statusCode: 400,
      isOperational: true,
    });
    this.name = 'WorkflowParseError';
  }
}
