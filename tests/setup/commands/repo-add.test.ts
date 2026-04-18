/**
 * Tests for src/setup/commands/repo-add.ts
 *
 * All external dependencies are mocked via mock.module() (requires
 * --experimental-test-module-mocks, already enabled in npm test script).
 * process.exit is mocked to throw so we can assert exit calls.
 */

import { describe, it, before, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — registered via mock.module() before the SUT is imported.
// Specifiers must be absolute paths so they resolve correctly regardless
// of the test file location.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..', '..', '..');

const mockReadEnvFile = mock.fn<(path: string) => Record<string, string>>();
const mockCreateGitHubAppTokenProvider = mock.fn();
const mockValidateRepoName = mock.fn();
const mockGithubFetch = mock.fn();
const mockAddRepoWithTemplate = mock.fn();
const mockCreateWorkflowEditor = mock.fn(() => ({
  addRepoWithTemplate: mockAddRepoWithTemplate,
}));

mock.module(resolve(ROOT, 'src/setup/env-writer'), {
  namedExports: { readEnvFile: mockReadEnvFile },
});

mock.module(resolve(ROOT, 'src/integration/github-app-auth'), {
  namedExports: { createGitHubAppTokenProvider: mockCreateGitHubAppTokenProvider },
});

mock.module(resolve(ROOT, 'src/config/workflow-config'), {
  namedExports: { validateRepoName: mockValidateRepoName },
});

mock.module(resolve(ROOT, 'src/integration/github-api'), {
  namedExports: {
    githubFetch: mockGithubFetch,
    ALL_WEBHOOK_EVENTS: ['push', 'pull_request'],
  },
});

mock.module(resolve(ROOT, 'src/setup/workflow-editor'), {
  namedExports: { createWorkflowEditor: mockCreateWorkflowEditor },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRepoAdd', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runRepoAdd: (repoFullName: string) => Promise<void>;
  let consoleLogMock: ReturnType<typeof mock.method>;
  let consoleErrorMock: ReturnType<typeof mock.method>;
  let processExitMock: ReturnType<typeof mock.method>;
  let savedWebhookUrl: string | undefined;

  before(async () => {
    // Dynamic import so mock.module() registrations take effect first.
    const mod = await import(resolve(ROOT, 'src/setup/commands/repo-add'));
    runRepoAdd = mod.runRepoAdd;
  });

  beforeEach(() => {
    consoleLogMock = mock.method(console, 'log', () => {});
    consoleErrorMock = mock.method(console, 'error', () => {});
    processExitMock = mock.method(process, 'exit', (() => {
      throw new Error('process.exit');
    }) as () => never);

    savedWebhookUrl = process.env.WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;

    mockReadEnvFile.mock.resetCalls();
    mockCreateGitHubAppTokenProvider.mock.resetCalls();
    mockValidateRepoName.mock.resetCalls();
    mockGithubFetch.mock.resetCalls();
    mockAddRepoWithTemplate.mock.resetCalls();
    mockCreateWorkflowEditor.mock.resetCalls();
  });

  afterEach(() => {
    consoleLogMock.mock.restore();
    consoleErrorMock.mock.restore();
    processExitMock.mock.restore();

    if (savedWebhookUrl !== undefined) {
      process.env.WEBHOOK_URL = savedWebhookUrl;
    } else {
      delete process.env.WEBHOOK_URL;
    }
  });

  it('invalid format (no slash) calls process.exit(1)', async () => {
    await assert.rejects(
      () => runRepoAdd('no-slash'),
      { message: 'process.exit' },
    );

    assert.equal(processExitMock.mock.calls.length, 1);
    assert.deepEqual(processExitMock.mock.calls[0].arguments, [1]);
  });

  it('missing credentials (no GITHUB_TOKEN, no APP vars) calls process.exit(1)', async () => {
    mockReadEnvFile.mock.mockImplementation(() => ({}));

    await assert.rejects(
      () => runRepoAdd('owner/repo'),
      { message: 'process.exit' },
    );

    assert.equal(processExitMock.mock.calls.length, 1);
    assert.deepEqual(processExitMock.mock.calls[0].arguments, [1]);
  });

  it('repo not found (GitHub 404) calls process.exit(1)', async () => {
    mockReadEnvFile.mock.mockImplementation(() => ({ GITHUB_TOKEN: 'ghp_test123' }));
    mockGithubFetch.mock.mockImplementation(async () =>
      makeErrorResponse(404, '{"message":"Not Found"}'),
    );

    await assert.rejects(
      () => runRepoAdd('owner/repo'),
      { message: 'process.exit' },
    );

    assert.equal(processExitMock.mock.calls.length, 1);
    assert.deepEqual(processExitMock.mock.calls[0].arguments, [1]);
    assert.equal(mockGithubFetch.mock.calls.length, 1);
    assert.equal(mockGithubFetch.mock.calls[0].arguments[0], '/repos/owner/repo');
  });

  it('valid repo with PAT auth fetches metadata and writes WORKFLOW.md', async () => {
    mockReadEnvFile.mock.mockImplementation(() => ({ GITHUB_TOKEN: 'ghp_test123' }));
    mockGithubFetch.mock.mockImplementation(async () =>
      makeOkResponse({ default_branch: 'main', ssh_url: 'git@github.com:owner/repo.git' }),
    );

    await runRepoAdd('owner/repo');

    // githubFetch called with repo path and token
    assert.equal(mockGithubFetch.mock.calls.length, 1);
    assert.equal(mockGithubFetch.mock.calls[0].arguments[0], '/repos/owner/repo');
    assert.equal(mockGithubFetch.mock.calls[0].arguments[1], 'ghp_test123');

    // validateRepoName called
    assert.equal(mockValidateRepoName.mock.calls.length, 1);
    assert.equal(mockValidateRepoName.mock.calls[0].arguments[0], 'owner/repo');

    // editor.addRepoWithTemplate called with correct metadata
    assert.equal(mockAddRepoWithTemplate.mock.calls.length, 1);
    assert.equal(mockAddRepoWithTemplate.mock.calls[0].arguments[0], 'owner/repo');
    assert.deepEqual(mockAddRepoWithTemplate.mock.calls[0].arguments[1], {
      url: 'git@github.com:owner/repo.git',
      defaultBranch: 'main',
    });

    // process.exit was NOT called
    assert.equal(processExitMock.mock.calls.length, 0);
  });

  it('webhook skipped when WEBHOOK_URL not set (no POST call made)', async () => {
    delete process.env.WEBHOOK_URL;

    mockReadEnvFile.mock.mockImplementation(() => ({
      GITHUB_TOKEN: 'ghp_test123',
      GITHUB_WEBHOOK_SECRET: 'secret123',
    }));
    mockGithubFetch.mock.mockImplementation(async () =>
      makeOkResponse({ default_branch: 'main', ssh_url: 'git@github.com:owner/repo.git' }),
    );

    await runRepoAdd('owner/repo');

    // Only one fetch call — the GET for repo metadata, no POST for webhook
    assert.equal(mockGithubFetch.mock.calls.length, 1);
    assert.equal(mockGithubFetch.mock.calls[0].arguments[0], '/repos/owner/repo');

    // No third argument (options with method: POST)
    const callOpts = mockGithubFetch.mock.calls[0].arguments[2];
    assert.equal(callOpts, undefined);
  });

  it('webhook creation succeeds when WEBHOOK_URL set (POST called with correct body)', async () => {
    process.env.WEBHOOK_URL = 'https://example.com';

    mockReadEnvFile.mock.mockImplementation(() => ({
      GITHUB_TOKEN: 'ghp_test123',
      GITHUB_WEBHOOK_SECRET: 'whsec_abc',
    }));

    // First call: GET repo metadata; second call: POST webhook
    let callCount = 0;
    mockGithubFetch.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeOkResponse({ default_branch: 'develop', ssh_url: 'git@github.com:org/app.git' });
      }
      return makeOkResponse({ id: 42 });
    });

    await runRepoAdd('org/app');

    // Two githubFetch calls
    assert.equal(mockGithubFetch.mock.calls.length, 2);

    // Second call is POST to hooks endpoint
    const webhookCall = mockGithubFetch.mock.calls[1];
    assert.equal(webhookCall.arguments[0], '/repos/org/app/hooks');
    assert.equal(webhookCall.arguments[1], 'ghp_test123');

    const opts = webhookCall.arguments[2] as RequestInit;
    assert.equal(opts.method, 'POST');

    const body = JSON.parse(opts.body as string);
    assert.equal(body.name, 'web');
    assert.equal(body.active, true);
    assert.deepEqual(body.events, ['push', 'pull_request']);
    assert.equal(body.config.url, 'https://example.com/webhooks/github');
    assert.equal(body.config.content_type, 'json');
    assert.equal(body.config.secret, 'whsec_abc');
    assert.equal(body.config.insecure_ssl, '0');

    // Workflow editor still called
    assert.equal(mockAddRepoWithTemplate.mock.calls.length, 1);
    assert.equal(processExitMock.mock.calls.length, 0);
  });
});
