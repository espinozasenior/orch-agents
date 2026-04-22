// ---------------------------------------------------------------------------
// SPEC-001: Multi-repo workflow config types
// ---------------------------------------------------------------------------

export interface RepoConfig {
  url: string;
  defaultBranch: string;
  teams?: string[];
  labels?: string[];
  github?: {
    events: Record<string, string>;
  };
  tracker?: {
    team?: string;
  };
  lifecycle?: LifecycleConfig;
}

export interface LifecycleConfig {
  setup?: string;
  start?: string;
  setupTimeout?: number;  // ms, default 300_000
  startTimeout?: number;  // ms, default 120_000
}

export interface WorkflowConfig {
  repos: Record<string, RepoConfig>;
  /** Present only on repo-resolved configs (via resolveRepoConfig). */
  github?: {
    events: Record<string, string>;
  };
  defaults: {
    agents: { maxConcurrentPerOrg: number };
    stall: { timeoutMs: number };
    polling: { intervalMs: number; enabled: boolean };
  };
  tracker?: {
    kind: 'linear';
    apiKey: string;
    team: string;
    activeStates: string[];
    terminalStates: string[];
    activeTypes: string[];
    terminalTypes: string[];
  };
  agents: {
    maxConcurrent: number;
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

// ---------------------------------------------------------------------------
// Repo resolution helpers
// ---------------------------------------------------------------------------

export function resolveRepoConfig(config: WorkflowConfig, repoFullName: string): WorkflowConfig | null {
  const repoEntry = config.repos[repoFullName];
  if (!repoEntry) return null;

  // Merge: repo's github.events (never inherited),
  // repo's tracker.team overrides global tracker.team,
  // everything else comes from the parent config
  return {
    ...config,
    ...(repoEntry.github ? { github: repoEntry.github } : {}),
    ...(config.tracker ? {
      tracker: {
        ...config.tracker,
        ...(repoEntry.tracker?.team ? { team: repoEntry.tracker.team } : {}),
      },
    } : {}),
  };
}

export function getRepoNames(config: WorkflowConfig): string[] {
  return Object.keys(config.repos);
}

// ---------------------------------------------------------------------------
// Environment variable allowlist
// ---------------------------------------------------------------------------

/**
 * Allowlist of environment variable names that may be substituted in WORKFLOW.md.
 * Prevents leaking sensitive secrets (API keys, tokens) if an attacker controls
 * WORKFLOW.md content. Only non-secret, configuration-level variables are allowed.
 */
/**
 * Validates that a repository full name (owner/repo) matches the expected
 * format and does not contain path-traversal or URL-encoding sequences.
 */
export function validateRepoName(repoFullName: string): void {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoFullName)) {
    throw new Error(`Invalid repo name format: '${repoFullName}'`);
  }
}

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
