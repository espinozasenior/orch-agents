/**
 * Workflow Editor — reads and writes the `repos:` section of WORKFLOW.md.
 *
 * Parses YAML frontmatter, modifies the in-memory object, and re-serializes
 * while preserving the body (prompt template) below the closing `---`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { RepoConfig } from '../config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkflowEditorDeps {
  workflowPath?: string;
}

export interface WorkflowEditor {
  /** List all configured repos */
  listRepos(): Array<{ name: string; config: RepoConfig }>;
  /** Add a new repo section. Throws if repo already exists. */
  addRepo(repoFullName: string, config: RepoConfig): void;
  /** Update an existing repo section. Throws if repo not found. */
  updateRepo(repoFullName: string, config: RepoConfig): void;
  /** Remove a repo. Throws if repo not found or if it's the last one. */
  removeRepo(repoFullName: string): void;
  /** Update the tracker section */
  updateTracker(tracker: { kind: 'linear'; api_key?: string; team?: string }): void;
  /** Get the server URL if stored (from a custom field) */
  getServerUrl(): string | undefined;
  /** Set the server URL */
  setServerUrl(url: string): void;
  /** Add a repo with commented events template (preserves YAML comments via string interpolation). */
  addRepoWithTemplate(repoFullName: string, metadata: { url: string; defaultBranch: string }): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const ACTIVE_EVENTS = [
  'pull_request.opened',
  'pull_request.synchronize',
  'issues.opened',
];

const COMMENTED_EVENTS = [
  'pull_request.ready_for_review',
  'pull_request.closed',
  'issue_comment.created',
  'push.default_branch',
  'pull_request_review.submitted',
  'workflow_run.completed',
  'release.published',
];

const DEFAULT_SKILL = '.claude/skills/github-ops/SKILL.md';

export function createWorkflowEditor(deps?: WorkflowEditorDeps): WorkflowEditor {
  const workflowPath = resolve(deps?.workflowPath ?? 'WORKFLOW.md');

  // -- Internal helpers -----------------------------------------------------

  function readDocument(): { frontmatter: Record<string, unknown>; body: string } {
    if (!existsSync(workflowPath)) {
      throw new WorkflowEditorError(`WORKFLOW.md not found at ${workflowPath}`);
    }

    const raw = readFileSync(workflowPath, 'utf-8');
    return splitFrontmatter(raw);
  }

  function writeDocument(frontmatter: Record<string, unknown>, body: string): void {
    const yamlStr = stringifyYaml(frontmatter, { lineWidth: 120 });
    const content = `---\n${yamlStr}---\n${body}`;
    writeFileSync(workflowPath, content, 'utf-8');
  }

  function ensureFileWithDefaults(): Record<string, unknown> {
    const defaults: Record<string, unknown> = {
      defaults: {
        agents: { max_concurrent: 8 },
        stall: { timeout_ms: 300_000 },
        polling: { interval_ms: 30_000, enabled: false },
      },
      tracker: {
        kind: 'linear',
        api_key: '$LINEAR_API_KEY',
        team: '$LINEAR_TEAM_ID',
        active_types: ['unstarted', 'started'],
        terminal_types: ['completed', 'canceled'],
      },
      repos: {},
    };
    return defaults;
  }

  function repoConfigToYaml(config: RepoConfig): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      url: config.url,
      default_branch: config.defaultBranch,
    };
    if (config.teams && config.teams.length > 0) {
      entry.teams = config.teams;
    }
    if (config.labels && config.labels.length > 0) {
      entry.labels = config.labels;
    }
    if (config.github) {
      entry.github = { events: config.github.events };
    }
    if (config.tracker) {
      entry.tracker = { team: config.tracker.team };
    }
    return entry;
  }

  function yamlToRepoConfig(raw: unknown): RepoConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new WorkflowEditorError('Invalid repo config: expected an object');
    }
    const record = raw as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url : '';
    const defaultBranch = typeof record.default_branch === 'string' ? record.default_branch : 'main';

    const result: RepoConfig = { url, defaultBranch };

    if (Array.isArray(record.teams)) {
      result.teams = record.teams.filter((t): t is string => typeof t === 'string');
    }
    if (Array.isArray(record.labels)) {
      result.labels = record.labels.filter((l): l is string => typeof l === 'string');
    }
    if (record.github && typeof record.github === 'object' && !Array.isArray(record.github)) {
      const gh = record.github as Record<string, unknown>;
      if (gh.events && typeof gh.events === 'object' && !Array.isArray(gh.events)) {
        const events: Record<string, string> = {};
        for (const [k, v] of Object.entries(gh.events as Record<string, unknown>)) {
          if (typeof v === 'string') events[k] = v;
        }
        if (Object.keys(events).length > 0) {
          result.github = { events };
        }
      }
    }
    if (record.tracker && typeof record.tracker === 'object' && !Array.isArray(record.tracker)) {
      const t = record.tracker as Record<string, unknown>;
      result.tracker = { team: typeof t.team === 'string' ? t.team : undefined };
    }

    return result;
  }

  function getReposRecord(frontmatter: Record<string, unknown>): Record<string, unknown> {
    if (!frontmatter.repos || typeof frontmatter.repos !== 'object' || Array.isArray(frontmatter.repos)) {
      return {};
    }
    return frontmatter.repos as Record<string, unknown>;
  }

  function validateRepoName(repoFullName: string): void {
    if (!repoFullName.includes('/')) {
      throw new WorkflowEditorError(`Repo name '${repoFullName}' must be in owner/repo format`);
    }
  }

  // -- Editor implementation ------------------------------------------------

  return {
    listRepos(): Array<{ name: string; config: RepoConfig }> {
      const { frontmatter } = readDocument();
      const repos = getReposRecord(frontmatter);
      return Object.entries(repos).map(([name, raw]) => ({
        name,
        config: yamlToRepoConfig(raw),
      }));
    },

    addRepo(repoFullName: string, config: RepoConfig): void {
      validateRepoName(repoFullName);

      let frontmatter: Record<string, unknown>;
      let body: string;

      if (existsSync(workflowPath)) {
        const doc = readDocument();
        frontmatter = doc.frontmatter;
        body = doc.body;
      } else {
        frontmatter = ensureFileWithDefaults();
        body = '\n{{ issue.description }}\n';
      }

      const repos = getReposRecord(frontmatter);
      if (repos[repoFullName] !== undefined) {
        throw new WorkflowEditorError(`Repo '${repoFullName}' already exists in WORKFLOW.md`);
      }

      repos[repoFullName] = repoConfigToYaml(config);
      frontmatter.repos = repos;
      writeDocument(frontmatter, body);
    },

    updateRepo(repoFullName: string, config: RepoConfig): void {
      validateRepoName(repoFullName);

      const { frontmatter, body } = readDocument();
      const repos = getReposRecord(frontmatter);

      if (repos[repoFullName] === undefined) {
        throw new WorkflowEditorError(`Repo '${repoFullName}' not found in WORKFLOW.md`);
      }

      repos[repoFullName] = repoConfigToYaml(config);
      frontmatter.repos = repos;
      writeDocument(frontmatter, body);
    },

    removeRepo(repoFullName: string): void {
      validateRepoName(repoFullName);

      const { frontmatter, body } = readDocument();
      const repos = getReposRecord(frontmatter);

      if (repos[repoFullName] === undefined) {
        throw new WorkflowEditorError(`Repo '${repoFullName}' not found in WORKFLOW.md`);
      }

      const repoKeys = Object.keys(repos);
      if (repoKeys.length <= 1) {
        throw new WorkflowEditorError('Cannot remove the last repo from WORKFLOW.md');
      }

      delete repos[repoFullName];
      frontmatter.repos = repos;
      writeDocument(frontmatter, body);
    },

    updateTracker(tracker: { kind: 'linear'; api_key?: string; team?: string }): void {
      const { frontmatter, body } = readDocument();

      const existing =
        frontmatter.tracker && typeof frontmatter.tracker === 'object' && !Array.isArray(frontmatter.tracker)
          ? (frontmatter.tracker as Record<string, unknown>)
          : {};

      if (tracker.api_key !== undefined) {
        existing.api_key = tracker.api_key;
      }
      if (tracker.team !== undefined) {
        existing.team = tracker.team;
      }
      existing.kind = tracker.kind;

      frontmatter.tracker = existing;
      writeDocument(frontmatter, body);
    },

    getServerUrl(): string | undefined {
      const { frontmatter } = readDocument();
      if (frontmatter.server && typeof frontmatter.server === 'object' && !Array.isArray(frontmatter.server)) {
        const server = frontmatter.server as Record<string, unknown>;
        return typeof server.url === 'string' ? server.url : undefined;
      }
      return typeof frontmatter.server_url === 'string' ? frontmatter.server_url : undefined;
    },

    setServerUrl(url: string): void {
      const { frontmatter, body } = readDocument();
      frontmatter.server_url = url;
      writeDocument(frontmatter, body);
    },

    addRepoWithTemplate(repoFullName: string, metadata: { url: string; defaultBranch: string }): void {
      validateRepoName(repoFullName);

      let frontmatter: Record<string, unknown>;
      let body: string;

      if (existsSync(workflowPath)) {
        const doc = readDocument();
        frontmatter = doc.frontmatter;
        body = doc.body;
      } else {
        frontmatter = ensureFileWithDefaults();
        body = '\n{{ issue.description }}\n';
      }

      const repos = getReposRecord(frontmatter);
      if (repos[repoFullName] !== undefined) {
        throw new WorkflowEditorError(`Repo '${repoFullName}' already exists in WORKFLOW.md`);
      }

      // Add repo WITHOUT events (we'll splice events as raw text to preserve comments)
      repos[repoFullName] = {
        url: metadata.url,
        default_branch: metadata.defaultBranch,
      };
      frontmatter.repos = repos;

      // Serialize YAML, then splice in the commented events block
      const yamlStr = stringifyYaml(frontmatter, { lineWidth: 120 });

      // Build the events block with active + commented entries
      const indent = '        '; // 8 spaces (repos > repo > github > events > entry)
      const activeLines = ACTIVE_EVENTS.map(
        (e) => `${indent}${e}: ${DEFAULT_SKILL}`,
      );
      const commentedLines = COMMENTED_EVENTS.map(
        (e) => `${indent}# ${e}: ${DEFAULT_SKILL}`,
      );
      const eventsBlock = [
        '    github:',
        '      events:',
        ...activeLines,
        ...commentedLines,
      ].join('\n');

      // Find the line with "default_branch:" for this repo and insert after it
      const lines = yamlStr.split('\n');
      let insertAfter = -1;
      let inTargetRepo = false;

      for (let i = 0; i < lines.length; i++) {
        // Match the repo key line (e.g., "  owner/repo:" or "  \"owner/repo\":")
        const repoKeyPattern = repoFullName.replace('/', '\\/');
        if (lines[i].match(new RegExp(`^\\s+"?${repoKeyPattern}"?:`))) {
          inTargetRepo = true;
        }
        if (inTargetRepo && lines[i].includes('default_branch:')) {
          insertAfter = i;
          break;
        }
      }

      if (insertAfter === -1) {
        // Fallback: just add events via YAML (no comments preserved)
        repos[repoFullName] = repoConfigToYaml({
          url: metadata.url,
          defaultBranch: metadata.defaultBranch,
          github: {
            events: Object.fromEntries(
              ACTIVE_EVENTS.map((e) => [e, DEFAULT_SKILL]),
            ),
          },
        });
        frontmatter.repos = repos;
        writeDocument(frontmatter, body);
        return;
      }

      // Splice the events block after the default_branch line
      lines.splice(insertAfter + 1, 0, eventsBlock);
      const finalYaml = lines.join('\n');
      const content = `---\n${finalYaml}---\n${body}`;
      writeFileSync(workflowPath, content, 'utf-8');
    },
  };
}

// ---------------------------------------------------------------------------
// Frontmatter split — preserves body below closing ---
// ---------------------------------------------------------------------------

function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new WorkflowEditorError('WORKFLOW.md must start with --- frontmatter delimiter');
  }

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    throw new WorkflowEditorError('WORKFLOW.md frontmatter is incomplete');
  }

  const endIndex = trimmed.indexOf('\n---', firstNewline);
  if (endIndex === -1) {
    throw new WorkflowEditorError('WORKFLOW.md missing closing --- frontmatter delimiter');
  }

  const yamlStr = trimmed.slice(firstNewline + 1, endIndex);
  if (!yamlStr.trim()) {
    throw new WorkflowEditorError('WORKFLOW.md frontmatter is empty');
  }

  const parsed = parseYaml(yamlStr);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowEditorError('WORKFLOW.md frontmatter must be a YAML object');
  }

  // Body is everything after the closing "---\n"
  const body = trimmed.slice(endIndex + 4);

  return {
    frontmatter: parsed as Record<string, unknown>,
    body,
  };
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class WorkflowEditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowEditorError';
  }
}
