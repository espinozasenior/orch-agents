/**
 * Configuration loader for the Orch-Agents system.
 *
 * Reads from environment variables with sensible defaults.
 * Validates required variables and provides typed access.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type NodeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  /** HTTP server port */
  readonly port: number;
  /** Node environment */
  readonly nodeEnv: NodeEnv;
  /** Structured log level */
  readonly logLevel: LogLevel;
  /** GitHub webhook HMAC-SHA256 secret */
  readonly webhookSecret: string;
  /** GitHub personal access token */
  readonly githubToken: string;
  /** Bot username for loop prevention (optional) */
  readonly botUsername?: string;
  /** Enable Claude-powered diff review (opt-in, default false) */
  readonly enableClaudeDiffReview: boolean;
  /** Enable Linear integration (opt-in, default false) */
  readonly linearEnabled: boolean;
  /** Linear webhook HMAC signing secret */
  readonly linearWebhookSecret: string;
  /** Linear API key for GraphQL API */
  readonly linearApiKey: string;
  /** Linear team ID for polling */
  readonly linearTeamId: string;
  /** @deprecated Use WORKFLOW.md polling.interval_ms instead */
  readonly linearPollIntervalMs: number;
  /** Linear bot user ID for loop prevention */
  readonly linearBotUserId: string;
  /** Enable Linear polling fallback (default false) */
  readonly linearPollingEnabled: boolean;
  /** Path to WORKFLOW.md (default: 'WORKFLOW.md' in project root) */
  readonly workflowMdPath: string;
  /** Enable GitHub routing via WORKFLOW.md (default false, uses config/github-routing.json) */
  readonly workflowMdGithub: boolean;
  /** GitHub App ID for bot authentication (optional) */
  readonly githubAppId?: string;
  /** Path to GitHub App private key PEM file (optional) */
  readonly githubAppPrivateKeyPath?: string;
  /** GitHub App installation ID (optional) */
  readonly githubAppInstallationId?: string;
  /** Linear auth mode: 'apiKey' (default) or 'oauth' (actor=app) */
  readonly linearAuthMode: 'apiKey' | 'oauth';
  /** Linear OAuth client ID */
  readonly linearClientId: string;
  /** Linear OAuth client secret */
  readonly linearClientSecret: string;
  /** Linear OAuth redirect URI for code exchange */
  readonly linearRedirectUri: string;
}

const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'trace', 'debug', 'info', 'warn', 'error', 'fatal',
];

const VALID_NODE_ENVS: readonly NodeEnv[] = [
  'development', 'production', 'test',
];

/**
 * Load configuration from environment variables with defaults.
 *
 * Throws if a required variable is missing in production mode.
 * In development/test, uses placeholder defaults for optional secrets.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === 'production';

  const port = parsePort(env.PORT);
  const logLevel = parseLogLevel(env.LOG_LEVEL);

  const webhookSecret = env.GITHUB_WEBHOOK_SECRET ?? env.WEBHOOK_SECRET ?? '';
  if (isProduction && !webhookSecret) {
    throw new Error('GITHUB_WEBHOOK_SECRET (or WEBHOOK_SECRET) is required in production');
  }

  const githubToken = env.GITHUB_TOKEN ?? '';
  const githubAppId = env.GITHUB_APP_ID ?? undefined;
  const githubAppPrivateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH ?? undefined;
  const githubAppInstallationId = env.GITHUB_APP_INSTALLATION_ID ?? undefined;
  if (isProduction && !githubToken && !githubAppId) {
    throw new Error('GITHUB_TOKEN or GITHUB_APP_ID is required in production');
  }

  const botUsername = env.BOT_USERNAME ?? undefined;
  const enableClaudeDiffReview = env.ENABLE_CLAUDE_DIFF_REVIEW === 'true';

  const linearEnabled = env.LINEAR_ENABLED === 'true';
  const linearWebhookSecret = env.LINEAR_WEBHOOK_SECRET ?? '';
  const linearApiKey = env.LINEAR_API_KEY ?? '';
  const linearTeamId = env.LINEAR_TEAM_ID ?? '';
  const linearPollIntervalMs = parsePollInterval(env.LINEAR_POLL_INTERVAL_MS);
  const linearBotUserId = env.LINEAR_BOT_USER_ID ?? '';
  const linearPollingEnabled = env.LINEAR_POLLING_ENABLED === 'true';
  const workflowMdPath = env.WORKFLOW_MD_PATH ?? 'WORKFLOW.md';
  const workflowMdGithub = env.WORKFLOW_MD_GITHUB === 'true';

  const linearAuthMode = (env.LINEAR_AUTH_MODE === 'oauth' ? 'oauth' : 'apiKey') as 'apiKey' | 'oauth';
  const linearClientId = env.LINEAR_CLIENT_ID ?? '';
  const linearClientSecret = env.LINEAR_CLIENT_SECRET ?? '';
  const linearRedirectUri = env.LINEAR_REDIRECT_URI ?? '';

  if (isProduction && linearAuthMode === 'oauth' && (!linearClientId || !linearClientSecret)) {
    throw new Error('LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are required when LINEAR_AUTH_MODE=oauth');
  }

  return Object.freeze({
    port,
    nodeEnv,
    logLevel,
    webhookSecret,
    githubToken,
    botUsername,
    enableClaudeDiffReview,
    linearEnabled,
    linearWebhookSecret,
    linearApiKey,
    linearTeamId,
    linearPollIntervalMs,
    linearBotUserId,
    linearPollingEnabled,
    workflowMdPath,
    workflowMdGithub,
    githubAppId,
    githubAppPrivateKeyPath,
    githubAppInstallationId,
    linearAuthMode,
    linearClientId,
    linearClientSecret,
    linearRedirectUri,
  });
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: '${value}'. Must be 1-65535.`);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) return 'info';
  const lower = value.toLowerCase() as LogLevel;
  if (!VALID_LOG_LEVELS.includes(lower)) {
    throw new Error(
      `Invalid LOG_LEVEL: '${value}'. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`,
    );
  }
  return lower;
}

function parsePollInterval(value: string | undefined): number {
  if (!value) return 30_000;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1000) {
    throw new Error(`Invalid LINEAR_POLL_INTERVAL_MS: '${value}'. Must be >= 1000.`);
  }
  return parsed;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (!value) return 'development';
  const lower = value.toLowerCase() as NodeEnv;
  if (!VALID_NODE_ENVS.includes(lower)) {
    throw new Error(
      `Invalid NODE_ENV: '${value}'. Must be one of: ${VALID_NODE_ENVS.join(', ')}`,
    );
  }
  return lower;
}
