/**
 * Linear GraphQL client adapter.
 *
 * Typed wrapper for Linear's GraphQL API with injectable fetch
 * for testing. Uses dependency injection following the same
 * factory-DI pattern as github-client.ts.
 *
 * Factory: createLinearClient(deps) => LinearClient
 */

import type { Logger } from '../../shared/logger';
import { AppError } from '../../shared/errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LinearClient {
  /** Fetch a single issue by ID. */
  fetchIssue(issueId: string): Promise<LinearIssueResponse>;
  /** Fetch all active issues for a team. */
  fetchActiveIssues(teamId: string): Promise<LinearIssueResponse[]>;
  /** Fetch comments on an issue. */
  fetchComments(issueId: string): Promise<LinearCommentResponse[]>;
  /** Create a comment on an issue. */
  createComment(issueId: string, body: string): Promise<string>;
  /** Update an existing comment. */
  updateComment(commentId: string, body: string): Promise<void>;
  /** Update issue state. */
  updateIssueState(issueId: string, stateId: string): Promise<void>;
}

export interface LinearIssueResponse {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  priority: number;
  state: { id: string; name: string; type?: string };
  labels: { nodes: Array<{ id: string; name: string }> };
  assignee?: { id: string; name?: string } | null;
  creator?: { id: string; name?: string } | null;
  team?: { id: string; key: string; name?: string } | null;
  project?: { id: string; name?: string } | null;
  updatedAt: string;
}

export interface LinearCommentResponse {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; name?: string };
}

export interface LinearClientDeps {
  apiKey: string;
  logger?: Logger;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** Base URL for Linear API (default: https://api.linear.app) */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { id name type }
  labels { nodes { id name } }
  assignee { id name }
  creator { id name }
  team { id key name }
  project { id name }
`;

const FETCH_ISSUE_QUERY = `
  query FetchIssue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }
`;

const FETCH_ACTIVE_ISSUES_QUERY = `
  query FetchActiveIssues($teamId: String!) {
    team(id: $teamId) {
      issues(filter: { state: { type: { nin: ["completed", "canceled"] } } }, first: 100) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

const FETCH_COMMENTS_QUERY = `
  query FetchComments($issueId: String!) {
    issue(id: $issueId) {
      comments { nodes { id body createdAt updatedAt user { id name } } }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

const UPDATE_COMMENT_MUTATION = `
  mutation UpdateComment($commentId: String!, $body: String!) {
    commentUpdate(id: $commentId, input: { body: $body }) {
      success
    }
  }
`;

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation UpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`;

// ---------------------------------------------------------------------------
// Rate limit handling
// ---------------------------------------------------------------------------

interface RateLimitState {
  requestCount: number;
  windowStart: number;
  backoffMs: number;
}

const MAX_REQUESTS_PER_HOUR = 1800;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 120_000;
const JITTER_FACTOR = 0.25;

function calculateBackoff(currentBackoffMs: number): number {
  const nextBackoff = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
  const jitter = nextBackoff * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, nextBackoff + jitter);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLinearClient(deps: LinearClientDeps): LinearClient {
  const log = deps.logger;
  const apiKey = deps.apiKey;
  const baseUrl = deps.baseUrl ?? 'https://api.linear.app';
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  const rateLimitState: RateLimitState = {
    requestCount: 0,
    windowStart: Date.now(),
    backoffMs: BASE_BACKOFF_MS,
  };

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Rate limit tracking
    const now = Date.now();
    if (now - rateLimitState.windowStart > 3_600_000) {
      rateLimitState.requestCount = 0;
      rateLimitState.windowStart = now;
    }

    if (rateLimitState.requestCount >= MAX_REQUESTS_PER_HOUR) {
      const retryAfter = Math.ceil(
        (3_600_000 - (now - rateLimitState.windowStart)) / 1000,
      );
      throw new LinearRateLimitError(retryAfter);
    }

    rateLimitState.requestCount++;

    log?.debug('linear-client graphql', { query: query.slice(0, 50), variables });

    const response = await fetchFn(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') ?? '60', 10);
      rateLimitState.backoffMs = calculateBackoff(rateLimitState.backoffMs);
      throw new LinearRateLimitError(retryAfter);
    }

    if (!response.ok) {
      const text = await response.text();
      log?.error('linear-client graphql error', { status: response.status, body: text });
      throw new LinearApiError(`Linear API error: ${response.status}`, response.status);
    }

    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join('; ');
      log?.error('linear-client graphql errors', { errors: json.errors });
      throw new LinearApiError(`Linear GraphQL errors: ${msg}`, 400);
    }

    rateLimitState.backoffMs = BASE_BACKOFF_MS; // Reset on success
    return json.data as T;
  }

  return {
    async fetchIssue(issueId) {
      const data = await graphql<{ issue: LinearIssueResponse }>(
        FETCH_ISSUE_QUERY,
        { id: issueId },
      );
      return data.issue;
    },

    async fetchActiveIssues(teamId) {
      const data = await graphql<{
        team: { issues: { nodes: LinearIssueResponse[] } };
      }>(FETCH_ACTIVE_ISSUES_QUERY, { teamId });
      return data.team.issues.nodes;
    },

    async fetchComments(issueId) {
      const data = await graphql<{
        issue: { comments: { nodes: LinearCommentResponse[] } };
      }>(FETCH_COMMENTS_QUERY, { issueId });
      return data.issue.comments.nodes;
    },

    async createComment(issueId, body) {
      const data = await graphql<{
        commentCreate: { success: boolean; comment: { id: string } };
      }>(CREATE_COMMENT_MUTATION, { issueId, body });
      return data.commentCreate.comment.id;
    },

    async updateComment(commentId, body) {
      await graphql<{ commentUpdate: { success: boolean } }>(
        UPDATE_COMMENT_MUTATION,
        { commentId, body },
      );
    },

    async updateIssueState(issueId, stateId) {
      await graphql<{ issueUpdate: { success: boolean } }>(
        UPDATE_ISSUE_STATE_MUTATION,
        { issueId, stateId },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class LinearApiError extends AppError {
  constructor(message: string, statusCode: number) {
    super(message, {
      code: 'ERR_LINEAR_API',
      statusCode,
      isOperational: true,
    });
    this.name = 'LinearApiError';
  }
}

export class LinearRateLimitError extends LinearApiError {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`Linear API rate limited. Retry after ${retryAfter}s`, 429);
    this.name = 'LinearRateLimitError';
    this.retryAfter = retryAfter;
  }
}
