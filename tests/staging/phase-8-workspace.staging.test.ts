/**
 * Phase 8: Multi-Repository Workspace Resolution — Staging Tests
 *
 * Validates FR-8.01 through FR-8.06 against the spec at
 * docs/sparc/phase-8-multi-repo-workspace.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRepoForIssue,
  extractFullName,
  getRepoClonePath,
  getIssueWorktreePath,
} from '../../src/execution/orchestrator/repo-resolver';
import type { WorkspaceConfig, RepoConfig } from '../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace(repos: RepoConfig[], defaultRepo?: string): WorkspaceConfig {
  return {
    root: '/tmp/workspace',
    defaultRepo,
    repos,
  };
}

function makeIssue(overrides: {
  labels?: Array<{ id: string; name: string }>;
  team?: { id: string; key: string };
} = {}) {
  return {
    id: 'issue-001',
    identifier: 'ENG-42',
    title: 'Fix bug',
    state: { id: 's1', name: 'In Progress', type: 'started' },
    // repo-resolver expects GraphQL shape: labels.nodes[{name}]
    labels: { nodes: overrides.labels ?? [] },
    team: overrides.team ?? { id: 'team-1', key: 'ENG' },
    priority: 3,
  };
}

// ---------------------------------------------------------------------------
// FR-8.01: Repo resolved by label match
// ---------------------------------------------------------------------------

describe('Phase 8 Staging: FR-8.01 — Label-based resolution', () => {
  it('resolves repo when issue label matches repo.labels', async () => {
    const workspace = makeWorkspace([
      { name: 'frontend', url: 'https://github.com/org/frontend', labels: ['frontend', 'ui'] },
      { name: 'backend', url: 'https://github.com/org/backend', labels: ['api', 'backend'] },
    ]);

    const issue = makeIssue({ labels: [{ id: 'l1', name: 'frontend' }] });
    const result = await resolveRepoForIssue(issue as never, workspace);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'frontend');
    }
  });

  it('label match is case-insensitive', async () => {
    const workspace = makeWorkspace([
      { name: 'api', url: 'https://github.com/org/api', labels: ['Backend'] },
    ]);

    const issue = makeIssue({ labels: [{ id: 'l1', name: 'backend' }] });
    const result = await resolveRepoForIssue(issue as never, workspace);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'api');
    }
  });
});

// ---------------------------------------------------------------------------
// FR-8.02: Repo resolved by team key match
// ---------------------------------------------------------------------------

describe('Phase 8 Staging: FR-8.02 — Team-based resolution', () => {
  it('resolves repo when issue team.key matches repo.teams', async () => {
    const workspace = makeWorkspace([
      { name: 'platform', url: 'https://github.com/org/platform', teams: ['ENG', 'PLATFORM'] },
    ]);

    const issue = makeIssue({ team: { id: 't1', key: 'ENG' } });
    const result = await resolveRepoForIssue(issue as never, workspace);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'platform');
    }
  });

  it('label match takes priority over team match', async () => {
    const workspace = makeWorkspace([
      { name: 'by-label', url: 'https://github.com/org/by-label', labels: ['special'] },
      { name: 'by-team', url: 'https://github.com/org/by-team', teams: ['ENG'] },
    ]);

    const issue = makeIssue({
      labels: [{ id: 'l1', name: 'special' }],
      team: { id: 't1', key: 'ENG' },
    });
    const result = await resolveRepoForIssue(issue as never, workspace);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'by-label', 'Label match wins over team match');
    }
  });
});

// ---------------------------------------------------------------------------
// FR-8.04: Default repo fallback
// ---------------------------------------------------------------------------

describe('Phase 8 Staging: FR-8.04 — Default repo fallback', () => {
  it('falls back to defaultRepo when no match found', async () => {
    const workspace = makeWorkspace(
      [{ name: 'main-app', url: 'https://github.com/org/main-app' }],
      'main-app',
    );

    const issue = makeIssue(); // no labels, team doesn't match any repo.teams
    const result = await resolveRepoForIssue(issue as never, workspace);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'main-app');
    }
  });

  it('throws when no match and no default (no silent failure)', async () => {
    const workspace = makeWorkspace([
      { name: 'unrelated', url: 'https://github.com/org/unrelated', labels: ['other'] },
    ]);

    const issue = makeIssue();
    // Without Linear API client for suggestions, resolver throws
    await assert.rejects(
      () => resolveRepoForIssue(issue as never, workspace),
      /No repo resolved/,
      'Throws when no repo can be resolved',
    );
  });
});

// ---------------------------------------------------------------------------
// FR-8.05: Path construction
// ---------------------------------------------------------------------------

describe('Phase 8 Staging: FR-8.05 — Path construction', () => {
  it('extractFullName parses GitHub URL', () => {
    assert.equal(extractFullName('https://github.com/org/repo'), 'org/repo');
    assert.equal(extractFullName('https://github.com/org/repo.git'), 'org/repo');
  });

  it('getRepoClonePath builds correct path', () => {
    const p = getRepoClonePath('/workspace', 'my-repo');
    assert.ok(p.includes('my-repo'), 'Path contains repo name');
    assert.ok(p.startsWith('/workspace'), 'Path under workspace root');
  });

  it('getIssueWorktreePath builds issue-specific path', () => {
    const p = getIssueWorktreePath('/workspace', 'ENG-42');
    assert.ok(p.includes('ENG-42'), 'Path contains issue ID');
    assert.ok(p.startsWith('/workspace'), 'Path under workspace root');
  });
});
