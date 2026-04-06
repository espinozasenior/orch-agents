import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AppError } from '../../shared/errors';
import { validateWorkflowPromptTemplate } from './workflow-prompt';

// ---------------------------------------------------------------------------
// Phase 8: Multi-Repository Workspace types
// ---------------------------------------------------------------------------

export interface RepoConfig {
  name: string;
  url: string;
  teams?: string[];
  labels?: string[];
  defaultBranch?: string;
}

export interface WorkspaceConfig {
  root: string;
  defaultRepo?: string;
  repos: RepoConfig[];
}

export interface WorkflowConfig {
  templates: Record<string, string[]>;
  tracker: {
    kind: 'linear';
    apiKey: string;
    team: string;
    activeStates: string[];
    terminalStates: string[];
    activeTypes: string[];
    terminalTypes: string[];
  };
  github?: {
    events: Record<string, string>;
  };
  workspace?: WorkspaceConfig;
  agents: {
    maxConcurrent: number;
    routing: Record<string, string>;
    defaultTemplate: string;
  };
  agent: {
    maxConcurrentAgents: number;
    maxRetryBackoffMs: number;
    maxTurns: number;
  };
  polling: {
    intervalMs: number;
    enabled: boolean;
  };
  stall: {
    timeoutMs: number;
  };
  agentRunner: {
    stallTimeoutMs: number;
    command: string;
    turnTimeoutMs: number;
  };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  promptTemplate: string;
}

interface WorkflowDocument {
  templates?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
  github?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  polling?: Record<string, unknown>;
  stall?: Record<string, unknown>;
  agent_runner?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

export function parseWorkflowMd(filePath: string): WorkflowConfig {
  return parseWorkflowMdString(readFileSync(filePath, 'utf-8'));
}

export function parseWorkflowMdString(content: string): WorkflowConfig {
  const { frontmatter, body } = extractFrontmatter(content);
  const document = parseWorkflowDocument(frontmatter);
  validatePromptTemplate(body);
  return buildConfig(resolveEnvInValue(document) as WorkflowDocument, body);
}

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

function buildConfig(document: WorkflowDocument, body: string): WorkflowConfig {
  const tracker = asRecord(document.tracker, 'tracker');
  const kind = readString(tracker.kind, 'tracker.kind');
  if (kind !== 'linear') {
    throw new WorkflowParseError(`tracker.kind must be 'linear', got '${kind}'`);
  }

  const team = readString(tracker.team, 'tracker.team');
  const templates = readTemplates(document.templates);
  const routing = readRouting(document.agents);
  const defaultTemplate = routing.default;
  if (!defaultTemplate) {
    throw new WorkflowParseError('agents.routing.default is required');
  }
  delete routing.default;
  validateTemplateRouting(templates, routing, defaultTemplate);

  const workspace = asOptionalRecord(document.workspace);
  const hooks = asOptionalRecord(document.hooks);
  const agent = asOptionalRecord(document.agent);
  const agentRunner = asOptionalRecord(document.agent_runner);
  const polling = asOptionalRecord(document.polling);
  const stall = asOptionalRecord(document.stall);

  const maxConcurrent = readNumber(
    agent?.max_concurrent_agents ?? document.agents?.max_concurrent,
    'agent.max_concurrent_agents',
    8,
  );
  const stallTimeoutMs = readNumber(
    agentRunner?.stall_timeout_ms ?? stall?.timeout_ms,
    'agent_runner.stall_timeout_ms',
    300_000,
  );

  return {
    templates,
    tracker: {
      kind: 'linear',
      apiKey: readOptionalString(tracker.api_key) ?? '',
      team,
      activeStates: readStringArray(tracker.active_states, 'tracker.active_states', ['Todo', 'In Progress']),
      terminalStates: readStringArray(tracker.terminal_states, 'tracker.terminal_states', ['Done', 'Cancelled']),
      activeTypes: readStringArray(tracker.active_types, 'tracker.active_types', ['unstarted', 'started']),
      terminalTypes: readStringArray(tracker.terminal_types, 'tracker.terminal_types', ['completed', 'canceled']),
    },
    ...(buildGitHubConfig(document.github) ? { github: buildGitHubConfig(document.github) } : {}),
    ...(workspace ? { workspace: buildWorkspaceConfig(workspace) } : {}),
    agents: {
      maxConcurrent,
      routing,
      defaultTemplate,
    },
    agent: {
      maxConcurrentAgents: maxConcurrent,
      maxRetryBackoffMs: readNumber(agent?.max_retry_backoff_ms, 'agent.max_retry_backoff_ms', 300_000),
      maxTurns: readNumber(agent?.max_turns, 'agent.max_turns', 20),
    },
    polling: {
      intervalMs: readNumber(polling?.interval_ms, 'polling.interval_ms', 30_000),
      enabled: readBoolean(polling?.enabled, false),
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

function buildWorkspaceConfig(workspace: Record<string, unknown>): WorkspaceConfig {
  const root = readString(workspace.root, 'workspace.root');
  const defaultRepo = readOptionalString(workspace.default_repo);
  const rawRepos = workspace.repos;

  if (!rawRepos || !Array.isArray(rawRepos) || rawRepos.length === 0) {
    throw new WorkflowParseError('workspace.repos is required and must be a non-empty array');
  }

  const repos: RepoConfig[] = rawRepos.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WorkflowParseError(`workspace.repos[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = readString(record.name, `workspace.repos[${index}].name`);
    const url = readString(record.url, `workspace.repos[${index}].url`);
    const teams = record.teams != null ? readStringArray(record.teams, `workspace.repos[${index}].teams`, []) : undefined;
    const labels = record.labels != null ? readStringArray(record.labels, `workspace.repos[${index}].labels`, []) : undefined;
    const defaultBranch = readOptionalString(record.default_branch);

    const repo: RepoConfig = { name, url };
    if (teams && teams.length > 0) repo.teams = teams;
    if (labels && labels.length > 0) repo.labels = labels;
    if (defaultBranch) repo.defaultBranch = defaultBranch;
    return repo;
  });

  return { root, defaultRepo, repos };
}

function buildGitHubConfig(github: unknown): WorkflowConfig['github'] | undefined {
  const record = asOptionalRecord(github);
  const events = asOptionalRecord(record?.events);
  if (!events) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(events)) {
    if (typeof value === 'string' && value.length > 0) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? { events: normalized } : undefined;
}

function readTemplates(value: unknown): Record<string, string[]> {
  const templates = asRecord(value, 'templates');
  const normalized = Object.fromEntries(
    Object.entries(templates).map(([templateName, members]) => {
      if (typeof members === 'string') {
        return [templateName, [members]];
      }
      if (Array.isArray(members) && members.every((member) => typeof member === 'string')) {
        return [templateName, members];
      }
      throw new WorkflowParseError(`templates.${templateName} must be a string or string[]`);
    }),
  );

  if (Object.keys(normalized).length === 0) {
    throw new WorkflowParseError('templates section must define at least one template');
  }

  return normalized;
}

function readRouting(value: unknown): Record<string, string> {
  const agents = asRecord(value, 'agents');
  const routing = asRecord(agents.routing, 'agents.routing');
  return Object.fromEntries(
    Object.entries(routing).map(([route, templateName]) => [route, readString(templateName, `agents.routing.${route}`)]),
  );
}

function validateTemplateRouting(
  templates: Record<string, string[]>,
  routing: Record<string, string>,
  defaultTemplate: string,
): void {
  const templateNames = new Set(Object.keys(templates));
  if (!templateNames.has(defaultTemplate)) {
    throw new WorkflowParseError(`agents.routing.default references unknown template '${defaultTemplate}'`);
  }

  for (const [route, templateName] of Object.entries(routing)) {
    if (!templateNames.has(templateName)) {
      throw new WorkflowParseError(`agents.routing.${route} references unknown template '${templateName}'`);
    }
  }
}

function validatePromptTemplate(body: string): void {
  const unsupported = validateWorkflowPromptTemplate(body);
  if (unsupported.length > 0) {
    throw new WorkflowParseError(`promptTemplate contains unsupported placeholders: ${unsupported.join(', ')}`);
  }
}

/**
 * Allowlist of environment variable names that may be substituted in WORKFLOW.md.
 * Prevents leaking sensitive secrets (API keys, tokens) if an attacker controls
 * WORKFLOW.md content. Only non-secret, configuration-level variables are allowed.
 */
export const WORKFLOW_SAFE_ENV_VARS = new Set([
  // Runtime / system
  'NODE_ENV', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'PATH',
  // Project-level config (non-secret)
  'LINEAR_TEAM', 'LINEAR_TEAM_ID', 'LINEAR_ENABLED',
  'GITHUB_OWNER', 'GITHUB_REPO',
  'WEBHOOK_PORT', 'LOG_LEVEL',
  'BOT_USERNAME',
  'WORKSPACE_ROOT',
  // Claude Flow feature flags
  'CLAUDE_FLOW_V3_ENABLED', 'CLAUDE_FLOW_HOOKS_ENABLED',
]);

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
