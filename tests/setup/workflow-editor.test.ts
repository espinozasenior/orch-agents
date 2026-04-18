/**
 * Tests for src/setup/workflow-editor.ts
 *
 * Uses real temp WORKFLOW.md files (mkdtempSync + cleanup in afterEach).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createWorkflowEditor,
  WorkflowEditorError,
} from '../../src/setup/workflow-editor';
import type { RepoConfig } from '../../src/config';

let tmpDir: string;
let workflowPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workflow-editor-test-'));
  workflowPath = join(tmpDir, 'WORKFLOW.md');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: write a minimal valid WORKFLOW.md with repos section. */
function writeWorkflow(repos: Record<string, unknown>, extra?: Record<string, unknown>, body?: string): void {
  const { stringify } = require('yaml') as typeof import('yaml');
  const frontmatter = { ...extra, repos };
  const yaml = stringify(frontmatter, { lineWidth: 120 });
  const content = `---\n${yaml}---\n${body ?? '\n{{ issue.description }}\n'}`;
  writeFileSync(workflowPath, content, 'utf-8');
}

function makeConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    url: 'https://github.com/acme/app',
    defaultBranch: 'main',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listRepos
// ---------------------------------------------------------------------------

describe('listRepos', () => {
  it('parses repos from valid WORKFLOW.md', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
      'acme/lib': { url: 'https://github.com/acme/lib', default_branch: 'develop' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    const repos = editor.listRepos();
    assert.equal(repos.length, 2);
    assert.equal(repos[0].name, 'acme/app');
    assert.equal(repos[0].config.defaultBranch, 'main');
    assert.equal(repos[1].name, 'acme/lib');
    assert.equal(repos[1].config.defaultBranch, 'develop');
  });

  it('returns [] for empty repos section', () => {
    writeWorkflow({});
    const editor = createWorkflowEditor({ workflowPath });
    const repos = editor.listRepos();
    assert.deepEqual(repos, []);
  });
});

// ---------------------------------------------------------------------------
// addRepo
// ---------------------------------------------------------------------------

describe('addRepo', () => {
  it('adds to existing file', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    editor.addRepo('acme/lib', makeConfig({ url: 'https://github.com/acme/lib' }));
    const repos = editor.listRepos();
    assert.equal(repos.length, 2);
    assert.equal(repos[1].name, 'acme/lib');
  });

  it('creates file with defaults if missing', () => {
    const editor = createWorkflowEditor({ workflowPath });
    editor.addRepo('acme/app', makeConfig());
    const repos = editor.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'acme/app');
    assert.equal(repos[0].config.url, 'https://github.com/acme/app');
  });

  it('throws on duplicate repo name', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    assert.throws(
      () => editor.addRepo('acme/app', makeConfig()),
      (err: Error) => err instanceof WorkflowEditorError && err.message.includes('already exists'),
    );
  });

  it('throws on invalid format (no slash)', () => {
    writeWorkflow({});
    const editor = createWorkflowEditor({ workflowPath });
    assert.throws(
      () => editor.addRepo('noslash', makeConfig()),
      (err: Error) => err instanceof WorkflowEditorError && err.message.includes('owner/repo'),
    );
  });
});

// ---------------------------------------------------------------------------
// updateRepo
// ---------------------------------------------------------------------------

describe('updateRepo', () => {
  it('updates existing repo', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    editor.updateRepo('acme/app', makeConfig({ defaultBranch: 'develop' }));
    const repos = editor.listRepos();
    assert.equal(repos[0].config.defaultBranch, 'develop');
  });

  it('throws if repo not found', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    assert.throws(
      () => editor.updateRepo('acme/missing', makeConfig()),
      (err: Error) => err instanceof WorkflowEditorError && err.message.includes('not found'),
    );
  });
});

// ---------------------------------------------------------------------------
// removeRepo
// ---------------------------------------------------------------------------

describe('removeRepo', () => {
  it('removes repo', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
      'acme/lib': { url: 'https://github.com/acme/lib', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    editor.removeRepo('acme/lib');
    const repos = editor.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'acme/app');
  });

  it('throws if last repo', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    assert.throws(
      () => editor.removeRepo('acme/app'),
      (err: Error) => err instanceof WorkflowEditorError && err.message.includes('last repo'),
    );
  });
});

// ---------------------------------------------------------------------------
// addRepoWithTemplate
// ---------------------------------------------------------------------------

describe('addRepoWithTemplate', () => {
  it('inserts active and commented events', () => {
    writeWorkflow({
      'acme/existing': { url: 'https://github.com/acme/existing', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    editor.addRepoWithTemplate('acme/new', {
      url: 'https://github.com/acme/new',
      defaultBranch: 'main',
    });

    const raw = readFileSync(workflowPath, 'utf-8');
    // Active events should be uncommented
    assert.ok(raw.includes('pull_request.opened:'), 'expected active event pull_request.opened');
    assert.ok(raw.includes('issues.opened:'), 'expected active event issues.opened');
    // Commented events should have # prefix
    assert.ok(raw.includes('# pull_request.closed:'), 'expected commented event pull_request.closed');
    assert.ok(raw.includes('# issue_comment.created:'), 'expected commented event issue_comment.created');

    // Re-parse to verify the repo exists in frontmatter
    const repos = editor.listRepos();
    const newRepo = repos.find((r) => r.name === 'acme/new');
    assert.ok(newRepo, 'new repo should appear in listRepos');
  });
});

// ---------------------------------------------------------------------------
// updateTracker
// ---------------------------------------------------------------------------

describe('updateTracker', () => {
  it('merges tracker fields', () => {
    writeWorkflow(
      { 'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' } },
      { tracker: { kind: 'linear', api_key: '$OLD_KEY', team: 'TEAM1' } },
    );
    const editor = createWorkflowEditor({ workflowPath });
    editor.updateTracker({ kind: 'linear', api_key: '$NEW_KEY' });

    const raw = readFileSync(workflowPath, 'utf-8');
    assert.ok(raw.includes('$NEW_KEY'), 'api_key should be updated');
    assert.ok(raw.includes('TEAM1'), 'team should be preserved');
  });
});

// ---------------------------------------------------------------------------
// getServerUrl / setServerUrl
// ---------------------------------------------------------------------------

describe('getServerUrl / setServerUrl', () => {
  it('round-trips server URL', () => {
    writeWorkflow({
      'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' },
    });
    const editor = createWorkflowEditor({ workflowPath });
    assert.equal(editor.getServerUrl(), undefined);

    editor.setServerUrl('https://example.com:3000');
    assert.equal(editor.getServerUrl(), 'https://example.com:3000');
  });
});

// ---------------------------------------------------------------------------
// Body preservation
// ---------------------------------------------------------------------------

describe('body preservation', () => {
  it('prompt template below --- survives operations', () => {
    const promptBody = '\nYou are a helpful assistant.\n\n{{ issue.description }}\n\nDo your best.\n';
    writeWorkflow(
      { 'acme/app': { url: 'https://github.com/acme/app', default_branch: 'main' } },
      {},
      promptBody,
    );
    const editor = createWorkflowEditor({ workflowPath });

    // Perform a mutation
    editor.addRepo('acme/lib', makeConfig({ url: 'https://github.com/acme/lib' }));

    const raw = readFileSync(workflowPath, 'utf-8');
    assert.ok(raw.includes('You are a helpful assistant.'), 'body text should survive addRepo');
    assert.ok(raw.includes('{{ issue.description }}'), 'template variable should survive');
    assert.ok(raw.includes('Do your best.'), 'trailing body text should survive');
  });
});
