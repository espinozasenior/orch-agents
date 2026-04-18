/**
 * Unit tests for the Webhook Updater.
 *
 * Uses mock.module() to intercept githubFetch, createJWT, and
 * readFileSync before the module under test is loaded.
 */

import { describe, it, mock, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RepoConfig } from '../../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepos(...names: string[]): Record<string, RepoConfig> {
  const repos: Record<string, RepoConfig> = {};
  for (const name of names) {
    repos[name] = { url: `https://github.com/${name}`, defaultBranch: 'main' };
  }
  return repos;
}

function fakeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
    redirected: false,
    statusText: '',
    type: 'basic' as ResponseType,
    url: '',
    clone: () => fakeResponse(status, body),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bytes: async () => new Uint8Array(),
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks — must be set up BEFORE the module under test is loaded
// ---------------------------------------------------------------------------

const mockGithubFetch = mock.fn(async () => fakeResponse(200, []));

// @ts-expect-error mock.module is experimental and lacks type declarations
mock.module('../../src/integration/github-api', {
  namedExports: {
    githubFetch: mockGithubFetch,
    ALL_WEBHOOK_EVENTS: [
      'pull_request', 'issues', 'issue_comment', 'push',
      'pull_request_review', 'workflow_run', 'release',
    ],
  },
});

const mockCreateJWT = mock.fn(() => 'fake.jwt.token');

// @ts-expect-error mock.module is experimental and lacks type declarations
mock.module('../../src/integration/github-app-auth', {
  namedExports: {
    createJWT: mockCreateJWT,
  },
});

const mockReadFileSync = mock.fn(() => 'fake-private-key');

// @ts-expect-error mock.module is experimental and lacks type declarations
mock.module('node:fs', {
  namedExports: {
    readFileSync: mockReadFileSync,
  },
});

// Module under test — loaded AFTER mocks are wired
let updateRepoWebhooks: typeof import('../../src/tunnel/webhook-updater').updateRepoWebhooks;
let updateAppWebhook: typeof import('../../src/tunnel/webhook-updater').updateAppWebhook;

// ---------------------------------------------------------------------------
// updateRepoWebhooks
// ---------------------------------------------------------------------------

describe('updateRepoWebhooks', () => {
  const stubGetToken = mock.fn(async (_repo: string) => 'ghs_fake_token');

  before(async () => {
    const mod = await import('../../src/tunnel/webhook-updater');
    updateRepoWebhooks = mod.updateRepoWebhooks;
    updateAppWebhook = mod.updateAppWebhook;
  });

  beforeEach(() => {
    mockGithubFetch.mock.resetCalls();
    stubGetToken.mock.resetCalls();
  });

  // -- Single repo, no existing hook -> POST creates -----------------------

  it('creates a new webhook when none exists', async () => {
    mockGithubFetch.mock.mockImplementation(async (path: string, _token: string, opts?: RequestInit) => {
      if (!opts?.method) {
        return fakeResponse(200, []); // list hooks — empty
      }
      if (opts.method === 'POST') {
        return fakeResponse(201, { id: 42 });
      }
      return fakeResponse(404);
    });

    const repos = makeRepos('acme/app');
    const results = await updateRepoWebhooks(repos, 'https://tunnel.example.com', stubGetToken, 'secret');

    assert.equal(results.length, 1);
    assert.equal(results[0].repo, 'acme/app');
    assert.equal(results[0].action, 'created');
    assert.equal(results[0].hookId, 42);
  });

  // -- Single repo, existing hook -> PATCH updates -------------------------

  it('updates an existing webhook via PATCH', async () => {
    mockGithubFetch.mock.mockImplementation(async (path: string, _token: string, opts?: RequestInit) => {
      if (!opts?.method) {
        return fakeResponse(200, [
          { id: 1, config: { url: 'https://old.example.com/webhooks/github' } },
        ]);
      }
      if (opts.method === 'PATCH') {
        return fakeResponse(200, { id: 1 });
      }
      return fakeResponse(404);
    });

    const repos = makeRepos('acme/app');
    const results = await updateRepoWebhooks(repos, 'https://tunnel.example.com', stubGetToken, 'secret');

    assert.equal(results.length, 1);
    assert.equal(results[0].repo, 'acme/app');
    assert.equal(results[0].action, 'updated');
    assert.equal(results[0].hookId, 1);
  });

  // -- Single repo, list hooks fails -> returns skipped with error ---------

  it('returns skipped when listing hooks fails', async () => {
    mockGithubFetch.mock.mockImplementation(async () => {
      return fakeResponse(403, { message: 'Resource not accessible' });
    });

    const repos = makeRepos('acme/app');
    const results = await updateRepoWebhooks(repos, 'https://tunnel.example.com', stubGetToken, 'secret');

    assert.equal(results.length, 1);
    assert.equal(results[0].repo, 'acme/app');
    assert.equal(results[0].action, 'skipped');
    assert.ok(results[0].error?.includes('403'));
  });

  // -- Multiple repos — batches of 5 (verify parallel execution) ----------

  it('processes repos in batches of 5', async () => {
    const concurrencyLog: number[] = [];
    let inFlight = 0;

    mockGithubFetch.mock.mockImplementation(async (_path: string, _token: string, opts?: RequestInit) => {
      if (!opts?.method) {
        inFlight++;
        concurrencyLog.push(inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return fakeResponse(200, []);
      }
      if (opts.method === 'POST') {
        return fakeResponse(201, { id: Math.floor(Math.random() * 1000) });
      }
      return fakeResponse(200);
    });

    // 7 repos -> first batch of 5, second batch of 2
    const repos = makeRepos(
      'org/repo-1', 'org/repo-2', 'org/repo-3', 'org/repo-4', 'org/repo-5',
      'org/repo-6', 'org/repo-7',
    );

    const results = await updateRepoWebhooks(repos, 'https://tunnel.example.com', stubGetToken, 'secret');

    assert.equal(results.length, 7);
    for (const r of results) {
      assert.equal(r.action, 'created');
    }
    assert.ok(
      Math.max(...concurrencyLog) <= 5,
      `Max concurrency was ${Math.max(...concurrencyLog)}, expected <= 5`,
    );
  });

  // -- Mixed success/failure — results collected correctly -----------------

  it('collects mixed success and failure results', async () => {
    mockGithubFetch.mock.mockImplementation(async (path: string, _token: string, opts?: RequestInit) => {
      const repo = path.replace('/repos/', '').replace('/hooks', '').split('/hooks/')[0];

      if (!opts?.method) {
        if (repo === 'org/fail-repo') {
          return fakeResponse(500, { message: 'Internal error' });
        }
        return fakeResponse(200, []);
      }
      if (opts.method === 'POST') {
        return fakeResponse(201, { id: 99 });
      }
      return fakeResponse(200);
    });

    const repos = makeRepos('org/good-repo', 'org/fail-repo');
    const results = await updateRepoWebhooks(repos, 'https://tunnel.example.com', stubGetToken, 'secret');

    assert.equal(results.length, 2);

    const good = results.find((r) => r.repo === 'org/good-repo');
    const bad = results.find((r) => r.repo === 'org/fail-repo');

    assert.ok(good);
    assert.equal(good.action, 'created');

    assert.ok(bad);
    assert.equal(bad.action, 'skipped');
    assert.ok(bad.error?.includes('500'));
  });
});

// ---------------------------------------------------------------------------
// updateAppWebhook
// ---------------------------------------------------------------------------

describe('updateAppWebhook', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockReadFileSync.mock.resetCalls();
    mockCreateJWT.mock.resetCalls();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -- success returns updated ---------------------------------------------

  it('returns updated on successful PATCH', async () => {
    mockReadFileSync.mock.mockImplementation(() => 'fake-private-key');
    mockCreateJWT.mock.mockImplementation(() => 'fake.jwt.token');
    globalThis.fetch = mock.fn(async () => fakeResponse(200, { url: 'https://tunnel.example.com/webhooks/github' })) as typeof fetch;

    const result = await updateAppWebhook(
      'https://tunnel.example.com',
      'app-123',
      '/path/to/key.pem',
      'webhook-secret',
    );

    assert.equal(result.action, 'updated');
    assert.equal(result.error, undefined);

    const fetchMock = globalThis.fetch as ReturnType<typeof mock.fn>;
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://api.github.com/app/hook/config');

    const fetchOpts = fetchMock.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(fetchOpts.method, 'PATCH');
    assert.ok(fetchOpts.headers && 'Authorization' in (fetchOpts.headers as Record<string, string>));
  });

  // -- API failure returns skipped -----------------------------------------

  it('returns skipped when API returns non-OK status', async () => {
    mockReadFileSync.mock.mockImplementation(() => 'fake-private-key');
    mockCreateJWT.mock.mockImplementation(() => 'fake.jwt.token');
    globalThis.fetch = mock.fn(async () => fakeResponse(422, { message: 'Validation failed' })) as typeof fetch;

    const result = await updateAppWebhook(
      'https://tunnel.example.com',
      'app-123',
      '/path/to/key.pem',
      'webhook-secret',
    );

    assert.equal(result.action, 'skipped');
    assert.ok(result.error?.includes('422'));
  });

  // -- exception caught ----------------------------------------------------

  it('returns skipped when an exception is thrown', async () => {
    mockReadFileSync.mock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    const result = await updateAppWebhook(
      'https://tunnel.example.com',
      'app-123',
      '/nonexistent/key.pem',
      'webhook-secret',
    );

    assert.equal(result.action, 'skipped');
    assert.ok(result.error?.includes('ENOENT'));
  });
});
