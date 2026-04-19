/**
 * Tests for P20 context fetchers.
 *
 * Mock-first London School: every dependency (GitHubClient, Logger) is
 * stubbed so the tests focus on registry lookup, parallelism, isolation,
 * and warning emission.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_FETCHERS,
  fetchContextForSkill,
  type ContextFetcher,
} from '../../src/intake/context-fetchers';
import type { GitHubClient } from '../../src/integration/github-client';
import type { Logger, LogContext } from '../../src/shared/logger';
import type { ParsedGitHubEvent } from '../../src/webhook-gateway/event-parser';
import type { ResolvedSkill } from '../../src/intake/skill-resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger & { warnings: Array<{ message: string; context?: LogContext }> } {
  const warnings: Array<{ message: string; context?: LogContext }> = [];
  const noop = () => undefined;
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (message, context) => { warnings.push({ message, context }); },
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return Object.assign(logger, { warnings });
}

function makeSkill(contextFetchers: string[]): ResolvedSkill {
  return {
    path: '/abs/path/SKILL.md',
    body: 'skill body',
    frontmatter: {
      name: 'test',
      type: null,
      description: null,
      color: null,
      capabilities: [],
      version: null,
      contextFetchers,
      whenToUse: null,
      allowedTools: [],
    },
  };
}

function makeParsed(overrides: Partial<ParsedGitHubEvent> = {}): ParsedGitHubEvent {
  return {
    eventType: 'pull_request',
    action: 'opened',
    deliveryId: 'd',
    repoFullName: 'acme/webapp',
    defaultBranch: 'main',
    branch: 'feat/x',
    prNumber: 17,
    issueNumber: null,
    sender: 'octocat',
    senderId: 1,
    senderIsBot: false,
    labels: [],
    files: [],
    merged: false,
    conclusion: null,
    commentBody: null,
    reviewState: null,
    rawPayload: {},
    ...overrides,
  };
}

function makeGhClient(impls: Partial<GitHubClient>): GitHubClient {
  const noop = async () => { throw new Error('not implemented'); };
  return {
    postPRComment: noop as never,
    postInlineComment: noop as never,
    pushBranch: noop as never,
    submitReview: noop as never,
    prView: noop as never,
    prDiff: noop as never,
    issueView: noop as never,
    prChecks: noop as never,
    ...impls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CONTEXT_FETCHERS registry', () => {
  it('exposes the five built-in fetchers', () => {
    assert.deepEqual(
      Object.keys(CONTEXT_FETCHERS).sort(),
      ['gh-issue-view', 'gh-pr-checks', 'gh-pr-diff', 'gh-pr-view', 'gh-workflow-run'],
    );
  });

  it('gh-pr-view forwards repoFullName + prNumber', async () => {
    const calls: Array<{ repo: string; n: number }> = [];
    const gh = makeGhClient({
      prView: async (repo, n) => {
        calls.push({ repo, n });
        return 'view';
      },
    });
    const result = await CONTEXT_FETCHERS['gh-pr-view'](makeParsed(), gh);
    assert.equal(result, 'view');
    assert.deepEqual(calls, [{ repo: 'acme/webapp', n: 17 }]);
  });

  it('gh-pr-view returns empty string when prNumber is missing', async () => {
    const gh = makeGhClient({});
    const result = await CONTEXT_FETCHERS['gh-pr-view'](makeParsed({ prNumber: null }), gh);
    assert.equal(result, '');
  });

  it('gh-issue-view forwards issueNumber', async () => {
    const gh = makeGhClient({
      issueView: async (_repo, n) => `issue-${n}`,
    });
    const result = await CONTEXT_FETCHERS['gh-issue-view'](
      makeParsed({ prNumber: null, issueNumber: 99 }),
      gh,
    );
    assert.equal(result, 'issue-99');
  });
});

describe('fetchContextForSkill', () => {
  it('returns empty string when skill declares no fetchers', async () => {
    const result = await fetchContextForSkill(makeSkill([]), makeParsed(), makeGhClient({}), makeLogger());
    assert.equal(result, '');
  });

  it('runs fetchers in parallel and joins non-empty results with separator', async () => {
    const startedAt: number[] = [];
    const gh = makeGhClient({
      prView: async () => {
        startedAt.push(Date.now());
        await new Promise((r) => setTimeout(r, 10));
        return 'VIEW';
      },
      prDiff: async () => {
        startedAt.push(Date.now());
        await new Promise((r) => setTimeout(r, 10));
        return 'DIFF';
      },
    });
    const result = await fetchContextForSkill(
      makeSkill(['gh-pr-view', 'gh-pr-diff']),
      makeParsed(),
      gh,
      makeLogger(),
    );
    assert.match(result, /VIEW/);
    assert.match(result, /DIFF/);
    assert.match(result, /\n\n---\n\n/);
    // Both fetchers started before either finished — parallel.
    assert.ok(Math.abs(startedAt[0] - startedAt[1]) < 10);
  });

  it('isolates a failing fetcher and logs a warning', async () => {
    const logger = makeLogger();
    const gh = makeGhClient({
      prView: async () => 'VIEW',
      prDiff: async () => { throw new Error('boom'); },
    });
    const result = await fetchContextForSkill(
      makeSkill(['gh-pr-view', 'gh-pr-diff']),
      makeParsed(),
      gh,
      logger,
    );
    assert.match(result, /VIEW/);
    assert.doesNotMatch(result, /DIFF/);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0].message, /context-fetcher failed/);
    assert.equal((logger.warnings[0].context as { name: string }).name, 'gh-pr-diff');
  });

  it('warns and skips on unknown fetcher names', async () => {
    const logger = makeLogger();
    const result = await fetchContextForSkill(
      makeSkill(['unknown-fetcher']),
      makeParsed(),
      makeGhClient({}),
      logger,
    );
    assert.equal(result, '');
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0].message, /Unknown context-fetcher/);
  });

  it('honors a custom registry override', async () => {
    const custom: Record<string, ContextFetcher> = {
      'custom-one': async () => 'CUSTOM',
    };
    const result = await fetchContextForSkill(
      makeSkill(['custom-one']),
      makeParsed(),
      makeGhClient({}),
      makeLogger(),
      custom,
    );
    assert.equal(result, 'CUSTOM');
  });
});
