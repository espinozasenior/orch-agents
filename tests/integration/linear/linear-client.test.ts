/**
 * Tests for LinearClient -- London School TDD with mocked fetch.
 *
 * Covers: AC11 (rate limit handling), all CRUD operations.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLinearClient,
  LinearRateLimitError,
  LinearApiError,
  LinearAuthError,
} from '../../../src/integration/linear/linear-client';
import type {
  LinearClient,
  LinearClientDeps,
  LinearAuthStrategy,
} from '../../../src/integration/linear/linear-client';
import type { OAuthTokenStore } from '../../../src/integration/linear/oauth-token-store';
import type {
  AgentActivityContent,
  AgentActivityOptions,
  AgentSessionUpdateInput,
} from '../../../src/integration/linear/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createMockFetch(responseData: unknown, status = 200) {
  const calls: FetchCall[] = [];
  const fetchFn: LinearClientDeps['fetchFn'] = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['retry-after', '30']]) as unknown as Headers,
      json: async () => ({ data: responseData }),
      text: async () => JSON.stringify({ data: responseData }),
    } as unknown as Response;
  };
  return { fetchFn, calls };
}

function createErrorFetch(status: number, body = 'error') {
  const fetchFn: LinearClientDeps['fetchFn'] = async () => {
    const headers = new Map([['retry-after', '30']]);
    return {
      ok: false,
      status,
      headers: headers as unknown as Headers,
      json: async () => ({ errors: [{ message: body }] }),
      text: async () => body,
    } as unknown as Response;
  };
  return fetchFn;
}

function makeIssueResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Test issue',
    priority: 2,
    updatedAt: '2026-01-01T00:00:00Z',
    state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
    assignee: null,
    creator: { id: 'user-1', name: 'Test User' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinearClient', () => {
  describe('fetchIssue', () => {
    it('sends GraphQL query with issue ID', async () => {
      const issue = makeIssueResponse();
      const { fetchFn, calls } = createMockFetch({ issue });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchIssue('issue-1');

      assert.equal(result.id, 'issue-1');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.linear.app/graphql');

      const body = JSON.parse(calls[0].init.body as string);
      assert.equal(body.variables.id, 'issue-1');
    });

    it('includes Authorization header', async () => {
      const { fetchFn, calls } = createMockFetch({ issue: makeIssueResponse() });
      const client = createLinearClient({ apiKey: 'lin_api_test123', fetchFn });

      await client.fetchIssue('issue-1');

      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'lin_api_test123');
    });
  });

  describe('fetchActiveIssues', () => {
    it('fetches active issues for a team', async () => {
      const issues = [makeIssueResponse(), makeIssueResponse({ id: 'issue-2' })];
      const { fetchFn } = createMockFetch({ team: { issues: { nodes: issues } } });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchActiveIssues('team-1');

      assert.equal(result.length, 2);
    });
  });

  describe('fetchTeamStates', () => {
    it('fetches workflow states for a team', async () => {
      const { fetchFn, calls } = createMockFetch({
        team: {
          states: {
            nodes: [
              { id: 'state-1', name: 'Todo', type: 'unstarted' },
              { id: 'state-2', name: 'In Progress', type: 'started' },
            ],
          },
        },
      });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchTeamStates('team-1');

      assert.deepEqual(result, [
        { id: 'state-1', name: 'Todo', type: 'unstarted' },
        { id: 'state-2', name: 'In Progress', type: 'started' },
      ]);
      const body = JSON.parse(calls[0].init.body as string);
      assert.equal(body.variables.teamId, 'team-1');
    });
  });

  describe('fetchIssuesByStates', () => {
    it('fetches candidate issues for specific states', async () => {
      const issues = [makeIssueResponse(), makeIssueResponse({ id: 'issue-2' })];
      const { fetchFn, calls } = createMockFetch({ team: { issues: { nodes: issues } } });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchIssuesByStates('team-1', ['Todo', 'In Progress']);

      assert.equal(result.length, 2);
      const body = JSON.parse(calls[0].init.body as string);
      assert.deepEqual(body.variables, {
        teamId: 'team-1',
        stateNames: ['Todo', 'In Progress'],
      });
    });
  });

  describe('fetchIssueStatesByIds', () => {
    it('returns id/state pairs for reconciliation', async () => {
      const { fetchFn } = createMockFetch({
        issues: {
          nodes: [
            { id: 'issue-1', state: { name: 'Todo' } },
            { id: 'issue-2', state: { name: 'Done' } },
          ],
        },
      });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchIssueStatesByIds(['issue-1', 'issue-2']);

      assert.deepEqual(result, [
        { id: 'issue-1', state: 'Todo' },
        { id: 'issue-2', state: 'Done' },
      ]);
    });

    it('returns an empty array when no ids are provided', async () => {
      const { fetchFn } = createMockFetch({ issues: { nodes: [] } });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchIssueStatesByIds([]);

      assert.deepEqual(result, []);
    });
  });

  describe('fetchComments', () => {
    it('fetches comments for an issue', async () => {
      const comments = [
        { id: 'comment-1', body: 'Hello', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ];
      const { fetchFn } = createMockFetch({
        issue: { comments: { nodes: comments } },
      });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const result = await client.fetchComments('issue-1');

      assert.equal(result.length, 1);
      assert.equal(result[0].body, 'Hello');
    });
  });

  describe('createComment', () => {
    it('creates a comment and returns ID', async () => {
      const { fetchFn } = createMockFetch({
        commentCreate: { success: true, comment: { id: 'new-comment-1' } },
      });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      const commentId = await client.createComment('issue-1', 'Test comment');

      assert.equal(commentId, 'new-comment-1');
    });
  });

  describe('updateComment', () => {
    it('updates a comment', async () => {
      const { fetchFn, calls } = createMockFetch({
        commentUpdate: { success: true },
      });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      await client.updateComment('comment-1', 'Updated body');

      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body as string);
      assert.equal(body.variables.commentId, 'comment-1');
      assert.equal(body.variables.body, 'Updated body');
    });
  });

  describe('updateIssueState', () => {
    it('updates issue state', async () => {
      const { fetchFn, calls } = createMockFetch({
        issueUpdate: { success: true },
      });
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      await client.updateIssueState('issue-1', 'state-done');

      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body as string);
      assert.equal(body.variables.issueId, 'issue-1');
      assert.equal(body.variables.stateId, 'state-done');
    });
  });

  // AC11: Rate limit handling
  describe('rate limit handling (AC11)', () => {
    it('throws LinearRateLimitError on 429 response', async () => {
      const fetchFn = createErrorFetch(429, 'rate limited');
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      await assert.rejects(
        () => client.fetchIssue('issue-1'),
        (err: unknown) => {
          assert.ok(err instanceof LinearRateLimitError);
          assert.equal(err.retryAfter, 30);
          return true;
        },
      );
    });

    it('throws LinearApiError on non-200 non-429 response', async () => {
      const fetchFn = createErrorFetch(500, 'internal server error');
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      await assert.rejects(
        () => client.fetchIssue('issue-1'),
        (err: unknown) => {
          assert.ok(err instanceof LinearApiError);
          assert.equal(err.statusCode, 500);
          return true;
        },
      );
    });
  });

  describe('custom base URL', () => {
    it('uses custom base URL', async () => {
      const { fetchFn, calls } = createMockFetch({ issue: makeIssueResponse() });
      const client = createLinearClient({
        apiKey: 'test-key',
        fetchFn,
        baseUrl: 'https://custom.linear.app',
      });

      await client.fetchIssue('issue-1');

      assert.equal(calls[0].url, 'https://custom.linear.app/graphql');
    });
  });

  describe('GraphQL errors', () => {
    it('throws on GraphQL errors in response', async () => {
      const fetchFn: LinearClientDeps['fetchFn'] = async () => {
        return {
          ok: true,
          status: 200,
          headers: new Map() as unknown as Headers,
          json: async () => ({
            data: null,
            errors: [{ message: 'Field not found' }],
          }),
          text: async () => '',
        } as unknown as Response;
      };
      const client = createLinearClient({ apiKey: 'test-key', fetchFn });

      await assert.rejects(
        () => client.fetchIssue('issue-1'),
        (err: unknown) => {
          assert.ok(err instanceof LinearApiError);
          assert.ok(err.message.includes('Field not found'));
          return true;
        },
      );
    });
  });

  // -----------------------------------------------------------------------
  // Auth strategy tests (Phase 7A)
  // -----------------------------------------------------------------------

  describe('auth strategy', () => {
    it('API key mode: Authorization header is the raw key', async () => {
      const { fetchFn, calls } = createMockFetch({ issue: makeIssueResponse() });
      const client = createLinearClient({
        authStrategy: { mode: 'apiKey', apiKey: 'lin_api_raw_key' },
        fetchFn,
      });

      await client.fetchIssue('issue-1');

      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'lin_api_raw_key');
    });

    it('OAuth mode: Authorization header is Bearer token', async () => {
      const { fetchFn, calls } = createMockFetch({ issue: makeIssueResponse() });
      const mockTokenStore: OAuthTokenStore = {
        getAccessToken: () => 'oauth-access-token',
        getTokenSet: () => ({ accessToken: 'oauth-access-token', refreshToken: 'r', expiresAt: Date.now() + 3600000 }),
        refreshIfNeeded: async () => {},
        exchangeCode: async () => ({ accessToken: '', refreshToken: '', expiresAt: 0 }),
        revokeToken: async () => {},
      };

      const client = createLinearClient({
        authStrategy: {
          mode: 'oauth',
          clientId: 'cid',
          clientSecret: 'csec',
          accessToken: 'oauth-access-token',
          refreshToken: 'r',
          expiresAt: Date.now() + 3600000,
        },
        tokenStore: mockTokenStore,
        fetchFn,
      });

      await client.fetchIssue('issue-1');

      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer oauth-access-token');
    });

    it('OAuth mode: calls refreshIfNeeded before each request', async () => {
      const { fetchFn } = createMockFetch({ issue: makeIssueResponse() });
      let refreshCallCount = 0;
      const mockTokenStore: OAuthTokenStore = {
        getAccessToken: () => 'token',
        getTokenSet: () => ({ accessToken: 'token', refreshToken: 'r', expiresAt: Date.now() + 3600000 }),
        refreshIfNeeded: async () => { refreshCallCount++; },
        exchangeCode: async () => ({ accessToken: '', refreshToken: '', expiresAt: 0 }),
        revokeToken: async () => {},
      };

      const client = createLinearClient({
        authStrategy: {
          mode: 'oauth', clientId: 'c', clientSecret: 's',
          accessToken: 'token', refreshToken: 'r', expiresAt: Date.now() + 3600000,
        },
        tokenStore: mockTokenStore,
        fetchFn,
      });

      await client.fetchIssue('issue-1');
      await client.fetchIssue('issue-1');

      assert.equal(refreshCallCount, 2);
    });

    it('OAuth mode: 401 triggers force refresh and retries once', async () => {
      let callCount = 0;
      const fetchFn: LinearClientDeps['fetchFn'] = async (url, init) => {
        callCount++;
        if (callCount === 1) {
          // First call returns 401
          return {
            ok: false,
            status: 401,
            headers: new Map() as unknown as Headers,
            json: async () => ({}),
            text: async () => 'Unauthorized',
          } as unknown as Response;
        }
        // Retry succeeds
        return {
          ok: true,
          status: 200,
          headers: new Map() as unknown as Headers,
          json: async () => ({ data: { issue: makeIssueResponse() } }),
          text: async () => '',
        } as unknown as Response;
      };

      let forceRefreshCalled = false;
      const mockTokenStore: OAuthTokenStore = {
        getAccessToken: () => 'refreshed-token',
        getTokenSet: () => ({ accessToken: 'refreshed-token', refreshToken: 'r', expiresAt: Date.now() + 3600000 }),
        refreshIfNeeded: async (force) => { if (force) forceRefreshCalled = true; },
        exchangeCode: async () => ({ accessToken: '', refreshToken: '', expiresAt: 0 }),
        revokeToken: async () => {},
      };

      const client = createLinearClient({
        authStrategy: {
          mode: 'oauth', clientId: 'c', clientSecret: 's',
          accessToken: 'expired', refreshToken: 'r', expiresAt: Date.now() + 3600000,
        },
        tokenStore: mockTokenStore,
        fetchFn,
      });

      const result = await client.fetchIssue('issue-1');

      assert.equal(callCount, 2);
      assert.ok(forceRefreshCalled);
      assert.equal(result.id, 'issue-1');
    });

    it('OAuth mode: second 401 after retry throws (no infinite loop)', async () => {
      const fetchFn: LinearClientDeps['fetchFn'] = async () => {
        return {
          ok: false,
          status: 401,
          headers: new Map() as unknown as Headers,
          json: async () => ({}),
          text: async () => 'Unauthorized',
        } as unknown as Response;
      };

      const mockTokenStore: OAuthTokenStore = {
        getAccessToken: () => 'token',
        getTokenSet: () => ({ accessToken: 'token', refreshToken: 'r', expiresAt: Date.now() + 3600000 }),
        refreshIfNeeded: async () => {},
        exchangeCode: async () => ({ accessToken: '', refreshToken: '', expiresAt: 0 }),
        revokeToken: async () => {},
      };

      const client = createLinearClient({
        authStrategy: {
          mode: 'oauth', clientId: 'c', clientSecret: 's',
          accessToken: 'bad', refreshToken: 'r', expiresAt: Date.now() + 3600000,
        },
        tokenStore: mockTokenStore,
        fetchFn,
      });

      await assert.rejects(
        () => client.fetchIssue('issue-1'),
        (err: unknown) => {
          assert.ok(err instanceof LinearAuthError);
          assert.equal(err.statusCode, 401);
          return true;
        },
      );
    });

    it('authStrategy takes precedence over apiKey dep', async () => {
      const { fetchFn, calls } = createMockFetch({ issue: makeIssueResponse() });
      const client = createLinearClient({
        apiKey: 'should-not-be-used',
        authStrategy: { mode: 'apiKey', apiKey: 'strategy-key' },
        fetchFn,
      });

      await client.fetchIssue('issue-1');

      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'strategy-key');
    });
  });

  // -----------------------------------------------------------------------
  // Agent Activity API tests (Phase 7B)
  // -----------------------------------------------------------------------

  describe('Agent Activity API', () => {
    describe('createAgentActivity', () => {
      it('creates a thought activity with body', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-1' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const id = await client.createAgentActivity('session-1', { type: 'thought', body: 'Analyzing issue...' });

        assert.equal(id, 'activity-1');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.input.agentSessionId, 'session-1');
        assert.deepEqual(body.variables.input.content, { type: 'thought', body: 'Analyzing issue...' });
      });

      it('creates an action activity with action, parameter, and result', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-2' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const content: AgentActivityContent = {
          type: 'action',
          action: 'read_file',
          parameter: 'src/index.ts',
          result: 'file contents here',
        };
        const id = await client.createAgentActivity('session-1', content);

        assert.equal(id, 'activity-2');
        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(body.variables.input.content, content);
      });

      it('creates an elicitation activity with body', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-3' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const id = await client.createAgentActivity('session-1', { type: 'elicitation', body: 'Which approach?' });

        assert.equal(id, 'activity-3');
        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(body.variables.input.content, { type: 'elicitation', body: 'Which approach?' });
      });

      it('creates a response activity with body', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-4' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const id = await client.createAgentActivity('session-1', { type: 'response', body: 'Done.' });

        assert.equal(id, 'activity-4');
        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(body.variables.input.content, { type: 'response', body: 'Done.' });
      });

      it('creates an error activity with body', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-5' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const id = await client.createAgentActivity('session-1', { type: 'error', body: 'Build failed' });

        assert.equal(id, 'activity-5');
        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(body.variables.input.content, { type: 'error', body: 'Build failed' });
      });

      it('creates an ephemeral thought activity', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-6' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const id = await client.createAgentActivity(
          'session-1',
          { type: 'thought', body: 'internal note' },
          { ephemeral: true },
        );

        assert.equal(id, 'activity-6');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.input.ephemeral, true);
      });

      it('creates an activity with auth signal and signalMetadata', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentActivityCreate: { success: true, agentActivity: { id: 'activity-7' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const options: AgentActivityOptions = {
          signal: 'auth',
          signalMetadata: { provider: 'github', scopes: ['repo'] },
        };
        const id = await client.createAgentActivity(
          'session-1',
          { type: 'thought', body: 'Need auth' },
          options,
        );

        assert.equal(id, 'activity-7');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.input.signal, 'auth');
        assert.deepEqual(body.variables.input.signalMetadata, { provider: 'github', scopes: ['repo'] });
      });
    });

    describe('agentSessionUpdate', () => {
      it('updates session with plan steps', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentSessionUpdate: { success: true },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const updates: AgentSessionUpdateInput = {
          plan: [
            { content: 'Read the code', status: 'completed' },
            { content: 'Write tests', status: 'inProgress' },
            { content: 'Implement', status: 'pending' },
          ],
        };
        await client.agentSessionUpdate('session-1', updates);

        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.id, 'session-1');
        assert.deepEqual(body.variables.input.plan, updates.plan);
      });

      it('updates session with externalUrls', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentSessionUpdate: { success: true },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const updates: AgentSessionUpdateInput = {
          externalUrls: [{ label: 'PR #42', url: 'https://github.com/org/repo/pull/42' }],
        };
        await client.agentSessionUpdate('session-1', updates);

        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(body.variables.input.externalUrls, updates.externalUrls);
      });
    });

    describe('agentSessionCreateOnIssue', () => {
      it('creates session on issue and returns session ID', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentSessionCreateOnIssue: { success: true, agentSession: { id: 'session-new-1' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const sessionId = await client.agentSessionCreateOnIssue('issue-1');

        assert.equal(sessionId, 'session-new-1');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.issueId, 'issue-1');
      });
    });

    describe('agentSessionCreateOnComment', () => {
      it('creates session on comment and returns session ID', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentSessionCreateOnComment: { success: true, agentSession: { id: 'session-new-2' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const sessionId = await client.agentSessionCreateOnComment('comment-1');

        assert.equal(sessionId, 'session-new-2');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.commentId, 'comment-1');
      });
    });

    describe('fetchSessionActivities', () => {
      it('returns paginated activities', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentSession: {
            activities: {
              nodes: [
                { content: { body: 'thinking...' } },
                { content: { action: 'read_file', parameter: 'src/index.ts', result: 'ok' } },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-abc' },
            },
          },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const result = await client.fetchSessionActivities('session-1', { after: 'cursor-prev' });

        assert.equal(result.activities.length, 2);
        assert.equal(result.hasNextPage, true);
        assert.equal(result.endCursor, 'cursor-abc');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.sessionId, 'session-1');
        assert.equal(body.variables.after, 'cursor-prev');
      });

      it('returns activities without cursor when no after option', async () => {
        const { fetchFn, calls } = createMockFetch({
          agentSession: {
            activities: {
              nodes: [{ content: { body: 'response text' } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const result = await client.fetchSessionActivities('session-1');

        assert.equal(result.activities.length, 1);
        assert.equal(result.hasNextPage, false);
        assert.equal(result.endCursor, undefined);
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.after, undefined);
      });
    });

    // -----------------------------------------------------------------
    // Phase 7H: issueUpdate + fetchViewer
    // -----------------------------------------------------------------

    describe('issueUpdate', () => {
      it('sends correct mutation with delegateId', async () => {
        const { fetchFn, calls } = createMockFetch({
          issueUpdate: { success: true },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        await client.issueUpdate('issue-1', { delegateId: 'agent-user-1' });

        assert.equal(calls.length, 1);
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.id, 'issue-1');
        assert.deepEqual(body.variables.input, { delegateId: 'agent-user-1' });
      });

      it('sends correct mutation with stateId', async () => {
        const { fetchFn, calls } = createMockFetch({
          issueUpdate: { success: true },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        await client.issueUpdate('issue-1', { stateId: 'state-started' });

        const body = JSON.parse(calls[0].init.body as string);
        assert.deepEqual(body.variables.input, { stateId: 'state-started' });
      });
    });

    describe('fetchViewer', () => {
      it('returns viewer id and organization', async () => {
        const { fetchFn } = createMockFetch({
          viewer: { id: 'viewer-1', organization: { id: 'org-1', name: 'My Org' } },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const result = await client.fetchViewer();

        assert.equal(result.id, 'viewer-1');
        assert.deepEqual(result.organization, { id: 'org-1', name: 'My Org' });
      });

      it('returns viewer without organization', async () => {
        const { fetchFn } = createMockFetch({
          viewer: { id: 'viewer-2' },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const result = await client.fetchViewer();

        assert.equal(result.id, 'viewer-2');
        assert.equal(result.organization, undefined);
      });
    });

    describe('issueRepositorySuggestions', () => {
      it('returns ranked repository suggestions', async () => {
        const { fetchFn, calls } = createMockFetch({
          issueRepositorySuggestions: {
            suggestions: [
              { repositoryFullName: 'org/repo-a', hostname: 'github.com', confidence: 0.95 },
              { repositoryFullName: 'org/repo-b', hostname: 'github.com', confidence: 0.42 },
            ],
          },
        });
        const client = createLinearClient({ apiKey: 'test-key', fetchFn });

        const candidates = [
          { hostname: 'github.com', repositoryFullName: 'org/repo-a' },
          { hostname: 'github.com', repositoryFullName: 'org/repo-b' },
        ];
        const result = await client.issueRepositorySuggestions('issue-1', 'session-1', candidates);

        assert.equal(result.length, 2);
        assert.equal(result[0].confidence, 0.95);
        assert.equal(result[0].repositoryFullName, 'org/repo-a');
        const body = JSON.parse(calls[0].init.body as string);
        assert.equal(body.variables.issueId, 'issue-1');
        assert.equal(body.variables.agentSessionId, 'session-1');
        assert.deepEqual(body.variables.candidates, candidates);
      });
    });
  });
});
