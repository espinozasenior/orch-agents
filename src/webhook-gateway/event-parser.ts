/**
 * GitHub webhook event parser.
 *
 * Extracts structured data from raw GitHub webhook payloads.
 * Handles all 10 event types from the architecture routing table (Appendix A).
 */

/**
 * Structured representation of a parsed GitHub webhook event.
 */
export interface ParsedGitHubEvent {
  /** GitHub event type (e.g. "push", "pull_request") */
  eventType: string;
  /** Event action (e.g. "opened", "synchronize"). Null for push events. */
  action: string | null;
  /** Delivery ID from X-GitHub-Delivery header */
  deliveryId: string;
  /** Repository full name (owner/repo) */
  repoFullName: string;
  /** Default branch of the repository */
  defaultBranch: string;
  /** The branch this event relates to, if applicable */
  branch: string | null;
  /** Pull request number, if applicable */
  prNumber: number | null;
  /** Issue number, if applicable */
  issueNumber: number | null;
  /** Login of the user who triggered the event */
  sender: string;
  /** Sender user ID (numeric) */
  senderId: number;
  /** Whether the sender is a bot */
  senderIsBot: boolean;
  /** Labels on the issue/PR, if applicable */
  labels: string[];
  /** Changed files, if available */
  files: string[];
  /** Whether the PR was merged (for closed PRs) */
  merged: boolean;
  /** Conclusion of a workflow run or deployment status */
  conclusion: string | null;
  /** The comment body for issue_comment events */
  commentBody: string | null;
  /** Review state for pull_request_review events */
  reviewState: string | null;
  /** Raw payload for downstream use */
  rawPayload: Record<string, unknown>;
}

interface GitHubPayload {
  action?: string;
  ref?: string;
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
  sender?: {
    login?: string;
    id?: number;
    type?: string;
  };
  pull_request?: {
    number?: number;
    merged?: boolean;
    labels?: Array<{ name?: string }>;
    head?: { ref?: string };
    changed_files?: number;
  };
  issue?: {
    number?: number;
    labels?: Array<{ name?: string }>;
  };
  comment?: {
    body?: string;
  };
  review?: {
    state?: string;
  };
  workflow_run?: {
    conclusion?: string;
    head_branch?: string;
  };
  release?: {
    tag_name?: string;
  };
  deployment_status?: {
    state?: string;
  };
  deployment?: {
    ref?: string;
  };
  commits?: Array<{
    added?: string[];
    removed?: string[];
    modified?: string[];
  }>;
}

/**
 * Parse a raw GitHub webhook payload into a structured event.
 *
 * @param eventType - The X-GitHub-Event header value
 * @param deliveryId - The X-GitHub-Delivery header value
 * @param rawPayload - The parsed JSON body from GitHub
 * @returns Structured parsed event
 */
export function parseGitHubEvent(
  eventType: string,
  deliveryId: string,
  rawPayload: Record<string, unknown>,
): ParsedGitHubEvent {
  const payload = rawPayload as unknown as GitHubPayload;

  const repoFullName = payload.repository?.full_name ?? 'unknown/unknown';
  const defaultBranch = payload.repository?.default_branch ?? 'main';
  const sender = payload.sender?.login ?? 'unknown';
  const senderId = payload.sender?.id ?? 0;
  const senderIsBot = payload.sender?.type === 'Bot';
  const action = payload.action ?? null;

  const base: ParsedGitHubEvent = {
    eventType,
    action,
    deliveryId,
    repoFullName,
    defaultBranch,
    branch: null,
    prNumber: null,
    issueNumber: null,
    sender,
    senderId,
    senderIsBot,
    labels: [],
    files: [],
    merged: false,
    conclusion: null,
    commentBody: null,
    reviewState: null,
    rawPayload,
  };

  switch (eventType) {
    case 'push':
      return parsePush(base, payload, defaultBranch);
    case 'pull_request':
      return parsePullRequest(base, payload);
    case 'issues':
      return parseIssues(base, payload);
    case 'issue_comment':
      return parseIssueComment(base, payload);
    case 'pull_request_review':
      return parsePullRequestReview(base, payload);
    case 'workflow_run':
      return parseWorkflowRun(base, payload);
    case 'release':
      return parseRelease(base, payload);
    case 'deployment_status':
      return parseDeploymentStatus(base, payload);
    default:
      // Unknown event type -- return base with what we have
      return base;
  }
}

function parsePush(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
  _defaultBranch: string,
): ParsedGitHubEvent {
  const ref = payload.ref ?? '';
  const branch = ref.replace('refs/heads/', '');

  const files: string[] = [];
  if (payload.commits) {
    for (const commit of payload.commits) {
      if (commit.added) files.push(...commit.added);
      if (commit.modified) files.push(...commit.modified);
      if (commit.removed) files.push(...commit.removed);
    }
  }

  return {
    ...base,
    branch,
    files: [...new Set(files)], // deduplicate
  };
}

function parsePullRequest(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  const pr = payload.pull_request;
  return {
    ...base,
    prNumber: pr?.number ?? null,
    branch: pr?.head?.ref ?? null,
    merged: pr?.merged ?? false,
    labels: (pr?.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
  };
}

function parseIssues(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  const issue = payload.issue;
  return {
    ...base,
    issueNumber: issue?.number ?? null,
    labels: (issue?.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
  };
}

function parseIssueComment(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  return {
    ...base,
    issueNumber: payload.issue?.number ?? null,
    commentBody: payload.comment?.body ?? null,
  };
}

function parsePullRequestReview(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  return {
    ...base,
    prNumber: payload.pull_request?.number ?? null,
    reviewState: payload.review?.state ?? null,
  };
}

function parseWorkflowRun(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  return {
    ...base,
    branch: payload.workflow_run?.head_branch ?? null,
    conclusion: payload.workflow_run?.conclusion ?? null,
  };
}

function parseRelease(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  return {
    ...base,
    branch: payload.release?.tag_name ?? null,
  };
}

function parseDeploymentStatus(
  base: ParsedGitHubEvent,
  payload: GitHubPayload,
): ParsedGitHubEvent {
  return {
    ...base,
    branch: payload.deployment?.ref ?? null,
    conclusion: payload.deployment_status?.state ?? null,
  };
}
