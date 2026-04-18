/**
 * SPEC-001: Multi-Repository Resolution -- Staging Tests
 *
 * Validates repo resolution by label, team, and fallback using
 * the new repos: Record<string, RepoConfig> map format.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRepoForIssue,
  extractFullName,
  getRepoClonePath,
  getIssueWorktreePath,
} from '../../src/execution/orchestrator/repo-resolver';
import type { RepoConfig } from '../../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReposMap(repos: Record<string, Partial<RepoConfig>>): Record<string, RepoConfig> {
  const result: Record<string, RepoConfig> = {};
  for (const [name, partial] of Object.entries(repos)) {
    result[name] = {
      url: partial.url ?? `https://github.com/${name}`,
      defaultBranch: partial.defaultBranch ?? 'main',
      ...partial,
    };
  }
  return result;
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
    labels: { nodes: overrides.labels ?? [] },
    team: overrides.team ?? { id: 'team-1', key: 'ENG' },
    priority: 3,
  };
}

// ---------------------------------------------------------------------------
// FR-8.01: Repo resolved by label match
// ---------------------------------------------------------------------------

describe('SPEC-001 Staging: Label-based resolution', () => {
  it('resolves repo when issue label matches repo.labels', async () => {
    const repos = makeReposMap({
      'org/frontend': { labels: ['frontend', 'ui'] },
      'org/backend': { labels: ['api', 'backend'] },
    });

    const issue = makeIssue({ labels: [{ id: 'l1', name: 'frontend' }] });
    const result = await resolveRepoForIssue(issue as never, repos);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'org/frontend');
    }
  });

  it('label match is case-insensitive', async () => {
    const repos = makeReposMap({
      'org/api': { labels: ['Backend'] },
    });

    const issue = makeIssue({ labels: [{ id: 'l1', name: 'backend' }] });
    const result = await resolveRepoForIssue(issue as never, repos);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'org/api');
    }
  });
});

// ---------------------------------------------------------------------------
// FR-8.02: Repo resolved by team key match
// ---------------------------------------------------------------------------

describe('SPEC-001 Staging: Team-based resolution', () => {
  it('resolves repo when issue team.key matches repo.teams', async () => {
    const repos = makeReposMap({
      'org/platform': { teams: ['ENG', 'PLATFORM'] },
    });

    const issue = makeIssue({ team: { id: 't1', key: 'ENG' } });
    const result = await resolveRepoForIssue(issue as never, repos);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'org/platform');
    }
  });

  it('label match takes priority over team match', async () => {
    const repos = makeReposMap({
      'org/by-label': { labels: ['special'] },
      'org/by-team': { teams: ['ENG'] },
    });

    const issue = makeIssue({
      labels: [{ id: 'l1', name: 'special' }],
      team: { id: 't1', key: 'ENG' },
    });
    const result = await resolveRepoForIssue(issue as never, repos);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'org/by-label', 'Label match wins over team match');
    }
  });
});

// ---------------------------------------------------------------------------
// FR-8.04: Fallback to first repo
// ---------------------------------------------------------------------------

describe('SPEC-001 Staging: First repo fallback', () => {
  it('falls back to first repo when no match found', async () => {
    const repos = makeReposMap({
      'org/main-app': {},
    });

    const issue = makeIssue(); // no labels, team doesn't match any repo.teams
    const result = await resolveRepoForIssue(issue as never, repos);

    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
      assert.equal(result.repo.name, 'org/main-app');
    }
  });

  it('throws when repos map is empty', async () => {
    const issue = makeIssue();
    await assert.rejects(
      () => resolveRepoForIssue(issue as never, {}),
      /repos is required/,
      'Throws when repos map is empty',
    );
  });
});

// ---------------------------------------------------------------------------
// FR-8.05: Path construction
// ---------------------------------------------------------------------------

describe('SPEC-001 Staging: Path construction', () => {
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
