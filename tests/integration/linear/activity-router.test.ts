/**
 * Tests for activity-router.ts — platform-routed response posting.
 *
 * Covers FR-10A.01 (platform routing), FR-10A.02 (streaming thoughts),
 * and FR-10A.05 (createComment reserved for GitHub).
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  postAgentResponse,
  emitThought,
  type ActivityLinearClient,
  type ActivityGitHubClient,
} from '../../../src/integration/linear/activity-router';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockLinearClient(): ActivityLinearClient & {
  createAgentActivity: ReturnType<typeof mock.fn>;
  createComment: ReturnType<typeof mock.fn>;
} {
  return {
    createAgentActivity: mock.fn(async () => 'activity-id'),
    createComment: mock.fn(async () => 'comment-id'),
  };
}

function createMockGitHubClient(): ActivityGitHubClient & {
  postPRComment: ReturnType<typeof mock.fn>;
} {
  return {
    postPRComment: mock.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// postAgentResponse
// ---------------------------------------------------------------------------

describe('postAgentResponse', () => {
  let linearClient: ReturnType<typeof createMockLinearClient>;
  let githubClient: ReturnType<typeof createMockGitHubClient>;

  beforeEach(() => {
    linearClient = createMockLinearClient();
    githubClient = createMockGitHubClient();
  });

  it('routes Linear source with agentSessionId to createAgentActivity', async () => {
    await postAgentResponse(
      'linear',
      'session-123',
      'Here is the answer',
      linearClient,
      githubClient,
      { issueId: 'issue-1' },
    );

    assert.equal(linearClient.createAgentActivity.mock.callCount(), 1);
    const [sessionId, content] = linearClient.createAgentActivity.mock.calls[0].arguments;
    assert.equal(sessionId, 'session-123');
    assert.deepStrictEqual(content, { type: 'response', body: 'Here is the answer' });

    // createComment must NOT be called
    assert.equal(linearClient.createComment.mock.callCount(), 0);
    // GitHub must NOT be called
    assert.equal(githubClient.postPRComment.mock.callCount(), 0);
  });

  it('does NOT include bot marker in createAgentActivity responses', async () => {
    await postAgentResponse(
      'linear',
      'session-123',
      'Answer text',
      linearClient,
      githubClient,
      { issueId: 'issue-1' },
    );

    const [, content] = linearClient.createAgentActivity.mock.calls[0].arguments;
    assert.ok(!content.body.includes('<!-- '), 'body must not contain bot marker');
  });

  it('routes GitHub source to postPRComment with bot marker', async () => {
    await postAgentResponse(
      'github',
      undefined,
      'PR feedback',
      linearClient,
      githubClient,
      { repo: 'org/repo', prNumber: 42 },
    );

    assert.equal(githubClient.postPRComment.mock.callCount(), 1);
    const [repo, prNumber, body] = githubClient.postPRComment.mock.calls[0].arguments;
    assert.equal(repo, 'org/repo');
    assert.equal(prNumber, 42);
    assert.ok(body.includes('PR feedback'), 'body must contain original text');
    assert.ok(body.includes('<!-- '), 'body must contain bot marker');

    // Linear must NOT be called
    assert.equal(linearClient.createAgentActivity.mock.callCount(), 0);
    assert.equal(linearClient.createComment.mock.callCount(), 0);
  });

  it('falls back to createComment when Linear source has no session', async () => {
    await postAgentResponse(
      'linear',
      undefined,
      'State change result',
      linearClient,
      githubClient,
      { issueId: 'issue-1' },
    );

    assert.equal(linearClient.createComment.mock.callCount(), 1);
    const [issueId, body] = linearClient.createComment.mock.calls[0].arguments;
    assert.equal(issueId, 'issue-1');
    assert.ok(body.includes('State change result'), 'body must contain text');
    assert.ok(body.includes('<!-- '), 'fallback must include bot marker');

    // createAgentActivity must NOT be called
    assert.equal(linearClient.createAgentActivity.mock.callCount(), 0);
  });

  it('does nothing when no clients match the source', async () => {
    await postAgentResponse(
      'system',
      undefined,
      'Some response',
      undefined,
      undefined,
      {},
    );

    // No errors thrown, no clients called
  });

  it('does nothing for GitHub source without repo/prNumber', async () => {
    await postAgentResponse(
      'github',
      undefined,
      'PR feedback',
      linearClient,
      githubClient,
      { repo: undefined, prNumber: undefined },
    );

    // Falls through to fallback but no issueId either
    assert.equal(githubClient.postPRComment.mock.callCount(), 0);
    assert.equal(linearClient.createComment.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// emitThought
// ---------------------------------------------------------------------------

describe('emitThought', () => {
  it('emits thought activity when agentSessionId is present', async () => {
    const linearClient = createMockLinearClient();

    await emitThought('session-456', 'Analyzing...', linearClient);

    assert.equal(linearClient.createAgentActivity.mock.callCount(), 1);
    const [sessionId, content] = linearClient.createAgentActivity.mock.calls[0].arguments;
    assert.equal(sessionId, 'session-456');
    assert.deepStrictEqual(content, { type: 'thought', body: 'Analyzing...' });
  });

  it('is a no-op when agentSessionId is undefined', async () => {
    const linearClient = createMockLinearClient();

    await emitThought(undefined, 'Analyzing...', linearClient);

    assert.equal(linearClient.createAgentActivity.mock.callCount(), 0);
  });

  it('is a no-op when linearClient is undefined', async () => {
    await emitThought('session-456', 'Analyzing...', undefined);
    // No error thrown
  });

  it('swallows errors and logs a warning', async () => {
    const linearClient = createMockLinearClient();
    linearClient.createAgentActivity = mock.fn(async () => {
      throw new Error('API failure');
    });
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => { warnings.push(args); } } as never;

    await emitThought('session-456', 'Analyzing...', linearClient, logger);

    assert.equal(warnings.length, 1);
  });
});
