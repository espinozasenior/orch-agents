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
} from '../../../src/integration/linear/linear-client';
import type {
  LinearClient,
  LinearClientDeps,
} from '../../../src/integration/linear/linear-client';

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
    state: { id: 'state-1', name: 'Todo' },
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
});
