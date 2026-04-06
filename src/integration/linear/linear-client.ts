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
import type { OAuthTokenStore } from './oauth-token-store';
import type {
  AgentActivityContent,
  AgentActivityOptions,
  AgentSessionUpdateInput,
  AgentSessionActivity,
  FetchSessionActivitiesResult,
  RepositoryCandidate,
  RepositorySuggestion,
} from './types';
import {
  FETCH_ISSUE_QUERY,
  FETCH_ACTIVE_ISSUES_QUERY,
  FETCH_TEAM_STATES_QUERY,
  FETCH_ISSUES_BY_STATES_QUERY,
  FETCH_ISSUE_STATES_BY_IDS_QUERY,
  FETCH_COMMENTS_QUERY,
  CREATE_COMMENT_MUTATION,
  REPLY_TO_COMMENT_MUTATION,
  UPDATE_COMMENT_MUTATION,
  UPDATE_ISSUE_STATE_MUTATION,
  AGENT_ACTIVITY_CREATE_MUTATION,
  AGENT_SESSION_UPDATE_MUTATION,
  AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
  AGENT_SESSION_CREATE_ON_COMMENT_MUTATION,
  FETCH_SESSION_ACTIVITIES_QUERY,
  ISSUE_REPOSITORY_SUGGESTIONS_QUERY,
  ISSUE_UPDATE_MUTATION,
  FETCH_VIEWER_QUERY,
} from './graphql-queries';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LinearClient {
  /** Fetch a single issue by ID. */
  fetchIssue(issueId: string): Promise<LinearIssueResponse>;
  /** Fetch workflow states for a team. */
  fetchTeamStates(teamId: string): Promise<Array<{ id: string; name: string; type?: string; position?: number }>>;
  /** Fetch all active issues for a team. */
  fetchActiveIssues(teamId: string): Promise<LinearIssueResponse[]>;
  /** Fetch candidate issues for the configured active states. */
  fetchIssuesByStates(teamId: string, stateNames: string[]): Promise<LinearIssueResponse[]>;
  /** Fetch only issue IDs and state names for reconciliation. */
  fetchIssueStatesByIds(issueIds: string[]): Promise<Array<{ id: string; state: string }>>;
  /** Fetch comments on an issue. */
  fetchComments(issueId: string): Promise<LinearCommentResponse[]>;
  /** Create a comment on an issue. */
  createComment(issueId: string, body: string): Promise<string>;
  /** Reply to an existing comment thread. */
  replyToComment(issueId: string, body: string, parentId: string): Promise<string>;
  /** Update an existing comment. */
  updateComment(commentId: string, body: string): Promise<void>;
  /** Update issue state. */
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  /** Optional attachment creation hook for richer tool bridges. */
  createAttachment?(issueId: string, title: string, url: string): Promise<string>;
  /** Create a typed agent activity in a session. */
  createAgentActivity(sessionId: string, content: AgentActivityContent, options?: AgentActivityOptions): Promise<string>;
  /** Update an agent session (plan, external URLs). */
  agentSessionUpdate(id: string, updates: AgentSessionUpdateInput): Promise<void>;
  /** Proactively create an agent session on an issue. */
  agentSessionCreateOnIssue(issueId: string): Promise<string>;
  /** Create an agent session from a comment thread. */
  agentSessionCreateOnComment(commentId: string): Promise<string>;
  /** Fetch paginated activity history for a session. */
  fetchSessionActivities(sessionId: string, options?: { after?: string }): Promise<FetchSessionActivitiesResult>;
  /** Get ranked repository suggestions for an issue. */
  issueRepositorySuggestions(issueId: string, sessionId: string, candidates: RepositoryCandidate[]): Promise<RepositorySuggestion[]>;
  /** Update an issue (delegate, state, etc). */
  issueUpdate(issueId: string, input: { delegateId?: string; stateId?: string }): Promise<void>;
  /** Fetch the authenticated viewer's user ID and organization. */
  fetchViewer(): Promise<{ id: string; organization?: { id: string; name: string } }>;
}

export type LinearToolOperation =
  | { kind: 'comment.create'; issueId: string; body: string }
  | { kind: 'comment.update'; commentId: string; body: string }
  | { kind: 'issue.updateState'; issueId: string; stateId: string }
  | { kind: 'attachment.create'; issueId: string; title: string; url: string };

export type LinearToolResult =
  | { ok: true; resourceId?: string }
  | { ok: false; error: string };

export interface LinearToolBridge {
  invoke(operation: LinearToolOperation): Promise<LinearToolResult>;
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
  delegate?: { id: string; name?: string } | null;
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

// ---------------------------------------------------------------------------
// Auth strategy types
// ---------------------------------------------------------------------------

export type LinearAuthStrategy =
  | { mode: 'apiKey'; apiKey: string }
  | {
      mode: 'oauth';
      clientId: string;
      clientSecret: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };

export interface LinearClientDeps {
  /** API key for legacy auth mode. Optional when authStrategy is provided. */
  apiKey?: string;
  logger?: Logger;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** Base URL for Linear API (default: https://api.linear.app) */
  baseUrl?: string;
  /** Auth strategy — takes precedence over apiKey when provided. */
  authStrategy?: LinearAuthStrategy;
  /** OAuth token store for refresh logic. Required when authStrategy.mode === 'oauth'. */
  tokenStore?: OAuthTokenStore;
}

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
  const baseUrl = deps.baseUrl ?? 'https://api.linear.app';
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  // Resolve auth strategy: explicit strategy > legacy apiKey
  const resolvedStrategy: LinearAuthStrategy | undefined = deps.authStrategy
    ?? (deps.apiKey ? { mode: 'apiKey', apiKey: deps.apiKey } : undefined);

  if (!resolvedStrategy) {
    throw new LinearApiError('LinearClient requires either authStrategy or apiKey', 400);
  }

  const authStrategy: LinearAuthStrategy = resolvedStrategy;
  const tokenStore = deps.tokenStore;

  async function getAuthHeader(): Promise<string> {
    if (authStrategy.mode === 'apiKey') {
      return authStrategy.apiKey;
    }
    // OAuth mode: proactively refresh if needed, then return Bearer token
    if (tokenStore) {
      const currentToken = tokenStore.getAccessToken();
      if (!currentToken) {
        // OAuth tokens not yet available (pre-authorization).
        // Fall back to API key if one was provided alongside OAuth config.
        if (deps.apiKey) {
          return deps.apiKey;
        }
        log?.warn('linear-client: no OAuth token and no API key fallback');
        return '';
      }
      try {
        await tokenStore.refreshIfNeeded();
      } catch (err) {
        // Refresh failed — use current token if still valid, or fall back to API key
        log?.warn('linear-client: token refresh failed, using current token or API key fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!tokenStore.getAccessToken() && deps.apiKey) {
          return deps.apiKey;
        }
      }
      return `Bearer ${tokenStore.getAccessToken()}`;
    }
    return `Bearer ${authStrategy.accessToken}`;
  }

  const rateLimitState: RateLimitState = {
    requestCount: 0,
    windowStart: Date.now(),
    backoffMs: BASE_BACKOFF_MS,
  };

  async function doFetch<T>(query: string, variables: Record<string, unknown>, authHeader: string): Promise<{ response: Response; parsed?: { data?: T; errors?: Array<{ message: string }> } }> {
    const response = await fetchFn(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ query, variables }),
    });
    return { response };
  }

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

    let authHeader = await getAuthHeader();
    let { response } = await doFetch<T>(query, variables, authHeader);

    // 401 retry for OAuth mode: force-refresh token and retry once
    if (response.status === 401 && authStrategy.mode === 'oauth' && tokenStore) {
      log?.debug('linear-client: 401 received, attempting token refresh and retry');
      await tokenStore.refreshIfNeeded(true);
      authHeader = await getAuthHeader();
      ({ response } = await doFetch<T>(query, variables, authHeader));

      if (response.status === 401) {
        throw new LinearAuthError('Authentication failed after token refresh', 401);
      }
    }

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

    async fetchTeamStates(teamId) {
      const data = await graphql<{
        team: { states: { nodes: Array<{ id: string; name: string; type?: string; position?: number }> } };
      }>(FETCH_TEAM_STATES_QUERY, { teamId });
      return data.team.states.nodes;
    },

    async fetchIssuesByStates(teamId, stateNames) {
      const data = await graphql<{
        team: { issues: { nodes: LinearIssueResponse[] } };
      }>(FETCH_ISSUES_BY_STATES_QUERY, { teamId, stateNames });
      return data.team.issues.nodes;
    },

    async fetchIssueStatesByIds(issueIds) {
      if (issueIds.length === 0) {
        return [];
      }
      const data = await graphql<{
        issues: { nodes: Array<{ id: string; state?: { name: string } | null } | null> };
      }>(FETCH_ISSUE_STATES_BY_IDS_QUERY, { issueIds });
      return data.issues.nodes
        .filter((node): node is { id: string; state?: { name: string } | null } => node !== null)
        .map((node) => ({
          id: node.id,
          state: node.state?.name ?? '',
        }));
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

    async replyToComment(issueId, body, parentId) {
      const data = await graphql<{
        commentCreate: { success: boolean; comment: { id: string } | null };
      }>(REPLY_TO_COMMENT_MUTATION, { issueId, body, parentId });
      if (!data.commentCreate.success || !data.commentCreate.comment) {
        log?.warn('replyToComment: mutation returned success=false or null comment', {
          issueId, parentId, success: data.commentCreate.success,
        });
        throw new Error('Reply comment creation failed');
      }
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

    // Agent Activity API (Phase 7B)

    async createAgentActivity(sessionId, content, options) {
      const input: Record<string, unknown> = {
        agentSessionId: sessionId,
        content,
      };
      if (options?.ephemeral) {
        input.ephemeral = true;
      }
      if (options?.signal) {
        input.signal = options.signal;
        if (options.signalMetadata) {
          input.signalMetadata = options.signalMetadata;
        }
      }
      const data = await graphql<{
        agentActivityCreate: { success: boolean; agentActivity: { id: string } };
      }>(AGENT_ACTIVITY_CREATE_MUTATION, { input });
      return data.agentActivityCreate.agentActivity.id;
    },

    async agentSessionUpdate(id, updates) {
      await graphql<{ agentSessionUpdate: { success: boolean } }>(
        AGENT_SESSION_UPDATE_MUTATION,
        { id, input: updates },
      );
    },

    async agentSessionCreateOnIssue(issueId) {
      const data = await graphql<{
        agentSessionCreateOnIssue: { success: boolean; agentSession: { id: string } };
      }>(AGENT_SESSION_CREATE_ON_ISSUE_MUTATION, { issueId });
      return data.agentSessionCreateOnIssue.agentSession.id;
    },

    async agentSessionCreateOnComment(commentId) {
      const data = await graphql<{
        agentSessionCreateOnComment: { success: boolean; agentSession: { id: string } };
      }>(AGENT_SESSION_CREATE_ON_COMMENT_MUTATION, { commentId });
      return data.agentSessionCreateOnComment.agentSession.id;
    },

    async fetchSessionActivities(sessionId, options) {
      const variables: Record<string, unknown> = { sessionId };
      if (options?.after) {
        variables.after = options.after;
      }
      const data = await graphql<{
        agentSession: {
          activities: {
            nodes: Array<{ content: Record<string, unknown> }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      }>(FETCH_SESSION_ACTIVITIES_QUERY, variables);

      const activities: AgentSessionActivity[] = data.agentSession.activities.nodes.map(
        (node) => node.content as unknown as AgentSessionActivity,
      );
      const { hasNextPage, endCursor } = data.agentSession.activities.pageInfo;
      return {
        activities,
        hasNextPage,
        endCursor: endCursor ?? undefined,
      };
    },

    async issueRepositorySuggestions(issueId, sessionId, candidates) {
      const data = await graphql<{
        issueRepositorySuggestions: {
          suggestions: RepositorySuggestion[];
        };
      }>(ISSUE_REPOSITORY_SUGGESTIONS_QUERY, {
        issueId,
        agentSessionId: sessionId,
        candidates,
      });
      return data.issueRepositorySuggestions.suggestions;
    },

    async issueUpdate(issueId, input) {
      await graphql<{ issueUpdate: { success: boolean } }>(
        ISSUE_UPDATE_MUTATION,
        { id: issueId, input },
      );
    },

    async fetchViewer() {
      const data = await graphql<{
        viewer: { id: string; organization?: { id: string; name: string } };
      }>(FETCH_VIEWER_QUERY, {});
      return data.viewer;
    },
  };
}

export function createLinearToolBridge(
  client: Pick<LinearClient, 'createComment' | 'updateComment' | 'updateIssueState'> & {
    createAttachment?: (issueId: string, title: string, url: string) => Promise<string>;
  },
): LinearToolBridge {
  return {
    async invoke(operation: LinearToolOperation): Promise<LinearToolResult> {
      switch (operation.kind) {
        case 'comment.create':
          return { ok: true, resourceId: await client.createComment(operation.issueId, operation.body) };
        case 'comment.update':
          await client.updateComment(operation.commentId, operation.body);
          return { ok: true };
        case 'issue.updateState':
          await client.updateIssueState(operation.issueId, operation.stateId);
          return { ok: true };
        case 'attachment.create':
          if (!client.createAttachment) {
            return { ok: false, error: 'Linear attachment bridge is not configured' };
          }
          return {
            ok: true,
            resourceId: await client.createAttachment(operation.issueId, operation.title, operation.url),
          };
      }
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

export class LinearAuthError extends LinearApiError {
  constructor(message: string, statusCode: number, options: { cause?: unknown } = {}) {
    super(message, statusCode);
    this.name = 'LinearAuthError';
    if (options.cause) {
      // Attach cause for debugging without exposing secrets
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
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
