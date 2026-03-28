/**
 * WORKFLOW.md parser for Linear integration.
 *
 * Parses a Symphony-inspired WORKFLOW.md file with YAML frontmatter
 * into a typed WorkflowConfig object. Uses a lightweight hand-written
 * parser (no external YAML dependency) following the pattern from
 * src/agent-registry/frontmatter-parser.ts.
 *
 * Supports:
 * - Nested YAML keys (one level deep with dotted path)
 * - Simple arrays (  - value)
 * - Environment variable resolution ($VAR_NAME)
 * - Prompt template from markdown body after frontmatter
 */

import { readFileSync } from 'node:fs';
import { AppError } from '../../shared/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid Linear workflow state types (immutable regardless of display name). */
export type LinearStateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface WorkflowConfig {
  templates: Record<string, string[]>;
  tracker: {
    kind: 'linear';
    apiKey: string;
    team: string;
    /** @deprecated Use activeTypes instead. Kept for backward compat. */
    activeStates: string[];
    /** @deprecated Use terminalTypes instead. Kept for backward compat. */
    terminalStates: string[];
    /** State types that represent actionable work (preferred over activeStates). */
    activeTypes: LinearStateType[];
    /** State types that represent finished work (preferred over terminalTypes). */
    terminalTypes: LinearStateType[];
  };
  github?: {
    events: Record<string, string>;
  };
  agents: {
    maxConcurrent: number;
    routing: Record<string, string>;
    defaultTemplate: string;
  };
  polling: {
    intervalMs: number;
    enabled: boolean;
  };
  stall: {
    timeoutMs: number;
  };
  promptTemplate: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a WORKFLOW.md file from disk into a WorkflowConfig.
 */
export function parseWorkflowMd(filePath: string): WorkflowConfig {
  const content = readFileSync(filePath, 'utf-8');
  return parseWorkflowMdString(content);
}

/**
 * Parse WORKFLOW.md content (string) into a WorkflowConfig.
 * Useful for testing without disk I/O.
 */
export function parseWorkflowMdString(content: string): WorkflowConfig {
  const { frontmatter, body } = extractFrontmatter(content);
  const flat = parseFlatYaml(frontmatter);
  return buildConfig(flat, body);
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new WorkflowParseError('WORKFLOW.md must start with --- frontmatter delimiter');
  }

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    throw new WorkflowParseError('WORKFLOW.md frontmatter is incomplete');
  }

  const endIndex = trimmed.indexOf('\n---', firstNewline);
  if (endIndex === -1) {
    throw new WorkflowParseError('WORKFLOW.md missing closing --- frontmatter delimiter');
  }

  const frontmatter = trimmed.slice(firstNewline + 1, endIndex);

  if (frontmatter.trim().length === 0) {
    throw new WorkflowParseError('WORKFLOW.md frontmatter is empty');
  }

  const body = trimmed.slice(endIndex + 4).trim(); // skip \n---

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Simple nested YAML parser
// ---------------------------------------------------------------------------

interface FlatMap {
  [key: string]: string | string[];
}

/**
 * Parse simple YAML into a flat map with dotted keys.
 * Supports one level of nesting and simple arrays.
 *
 * Example:
 *   tracker:
 *     kind: linear
 *     active_types:
 *       - unstarted
 *       - started
 *
 * Produces:
 *   { 'tracker.kind': 'linear', 'tracker.active_types': ['unstarted', 'started'] }
 */
function parseFlatYaml(yaml: string): FlatMap {
  const result: FlatMap = {};
  const lines = yaml.split('\n');

  let parentKey: string | null = null;
  let subParentKey: string | null = null;
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // Array item: "  - value" or "    - value"
    const arrayMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      if (!currentArray) {
        currentArray = [];
      }
      currentArray.push(unquote(arrayMatch[1].trim()));
      continue;
    }

    // Flush previous array (only if it has items — empty arrays from section
    // headers should not overwrite scalar values already set for the key)
    if (currentKey && currentArray && currentArray.length > 0) {
      result[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    } else if (currentArray && currentArray.length === 0) {
      // Discard empty arrays from section headers without overwriting
      currentArray = null;
      currentKey = null;
    }

    const indent = line.search(/\S/);

    // Third-level key-value (indent 4+): "    some.dotted.key: value"
    if (indent >= 4 && subParentKey) {
      const match = line.match(/^\s{4,}(\S[\S.]*)\s*:\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        const fullKey = `${subParentKey}.${key}`;

        if (value === '' || value === '|') {
          currentKey = fullKey;
          currentArray = [];
        } else {
          result[fullKey] = unquote(value);
          currentKey = fullKey;
        }
        continue;
      }
    }

    // Indented key-value (nested): "  key: value"
    const nestedMatch = line.match(/^(\s{2,3})(\w[\w_-]*)\s*:\s*(.*)$/);
    if (nestedMatch && parentKey) {
      const key = nestedMatch[2];
      const value = nestedMatch[3].trim();
      const fullKey = `${parentKey}.${key}`;

      if (value === '' || value === '|' || value === '>') {
        // This is a sub-section header (second-level nesting).
        // It may be followed by key-value pairs (map) or array items.
        // Set currentKey so array items can be collected if they follow.
        subParentKey = fullKey;
        currentKey = fullKey;
        currentArray = [];
      } else {
        result[fullKey] = unquote(value);
        currentKey = fullKey;
        subParentKey = null;
      }
      continue;
    }

    // Top-level key: "key: value" or "key:"
    const topMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.*)$/);
    if (topMatch) {
      const key = topMatch[1];
      const value = topMatch[2].trim();

      if (value === '' || value === '|' || value === '>') {
        // Section header or array start
        parentKey = key;
        subParentKey = null;
        currentKey = null;
        currentArray = null;
      } else {
        parentKey = null;
        subParentKey = null;
        result[key] = unquote(value);
        currentKey = key;
      }
      continue;
    }
  }

  // Flush final array
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function buildConfig(flat: FlatMap, body: string): WorkflowConfig {
  // Required fields
  const kind = resolveEnv(getString(flat, 'tracker.kind'));
  if (kind !== 'linear') {
    throw new WorkflowParseError(`tracker.kind must be 'linear', got '${kind}'`);
  }

  const team = resolveEnv(getString(flat, 'tracker.team'));
  if (!team) {
    throw new WorkflowParseError('tracker.team is required');
  }

  const routingMap = extractRouting(flat);
  if (!routingMap.default) {
    throw new WorkflowParseError('agents.routing.default is required');
  }

  const defaultTemplate = routingMap.default;
  delete routingMap.default;

  const githubEvents = extractGitHubEvents(flat);
  const templates = extractTemplates(flat);

  const config: WorkflowConfig = {
    templates,
    tracker: {
      kind: 'linear',
      apiKey: resolveEnv(getStringOptional(flat, 'tracker.api_key') ?? ''),
      team,
      activeTypes: (getArray(flat, 'tracker.active_types') ?? ['unstarted', 'started']) as LinearStateType[],
      terminalTypes: (getArray(flat, 'tracker.terminal_types') ?? ['completed', 'canceled']) as LinearStateType[],
      // Deprecated: kept for backward compat. Falls back to empty when only types are specified.
      activeStates: getArray(flat, 'tracker.active_states') ?? [],
      terminalStates: getArray(flat, 'tracker.terminal_states') ?? [],
    },
    ...(githubEvents ? { github: { events: githubEvents } } : {}),
    agents: {
      maxConcurrent: getNumber(flat, 'agents.max_concurrent') ?? 8,
      routing: routingMap,
      defaultTemplate,
    },
    polling: {
      intervalMs: getNumber(flat, 'polling.interval_ms') ?? 30_000,
      enabled: getBoolean(flat, 'polling.enabled') ?? false,
    },
    stall: {
      timeoutMs: getNumber(flat, 'stall.timeout_ms') ?? 300_000,
    },
    promptTemplate: body,
  };

  return config;
}

/**
 * Extract routing entries from flat map.
 * Keys like 'agents.routing.bug' -> { bug: 'tdd-workflow' }
 */
function extractRouting(flat: FlatMap): Record<string, string> {
  const routing: Record<string, string> = {};
  const prefix = 'agents.routing.';

  for (const key of Object.keys(flat)) {
    if (key.startsWith(prefix)) {
      const routeKey = key.slice(prefix.length);
      const value = flat[key];
      if (typeof value === 'string') {
        routing[routeKey] = value;
      }
    }
  }

  // Also check for nested routing under 'routing' parent when agents is the parent
  // This handles the case where "routing:" is a sub-section of "agents:"
  // and contains key-value pairs like "bug: tdd-workflow"
  if (Object.keys(routing).length === 0) {
    for (const key of Object.keys(flat)) {
      if (key.startsWith('routing.')) {
        const routeKey = key.slice('routing.'.length);
        const value = flat[key];
        if (typeof value === 'string') {
          routing[routeKey] = value;
        }
      }
    }
  }

  return routing;
}

/**
 * Extract github.events entries from flat map.
 * Keys like 'github.events.pull_request.opened' -> { 'pull_request.opened': 'github-ops' }
 */
function extractGitHubEvents(flat: FlatMap): Record<string, string> | undefined {
  const events: Record<string, string> = {};
  const prefix = 'github.events.';

  for (const key of Object.keys(flat)) {
    if (key.startsWith(prefix)) {
      const ruleKey = key.slice(prefix.length);
      const value = flat[key];
      if (typeof value === 'string') {
        events[ruleKey] = value;
      }
    }
  }

  if (Object.keys(events).length === 0) {
    return undefined;
  }

  return events;
}

/**
 * Extract templates entries from flat map.
 * Keys like 'templates.tdd-workflow' -> { 'tdd-workflow': ['coder', 'tester'] }
 */
function extractTemplates(flat: FlatMap): Record<string, string[]> {
  const templates: Record<string, string[]> = {};
  const prefix = 'templates.';

  for (const key of Object.keys(flat)) {
    if (key.startsWith(prefix)) {
      const templateName = key.slice(prefix.length);
      const value = flat[key];
      if (Array.isArray(value)) {
        templates[templateName] = value;
      } else if (typeof value === 'string') {
        // Single-agent template written as a scalar
        templates[templateName] = [value];
      }
    }
  }

  return templates;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function getString(flat: FlatMap, key: string): string {
  const value = flat[key];
  if (value === undefined || value === null) {
    throw new WorkflowParseError(`Required field '${key}' is missing`);
  }
  if (typeof value !== 'string') {
    throw new WorkflowParseError(`Field '${key}' must be a string`);
  }
  return value;
}

function getStringOptional(flat: FlatMap, key: string): string | undefined {
  const value = flat[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  return value;
}

function getNumber(flat: FlatMap, key: string): number | undefined {
  const value = flat[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new WorkflowParseError(`Field '${key}' must be a number, got '${value}'`);
  }
  return parsed;
}

function getBoolean(flat: FlatMap, key: string): boolean | undefined {
  const value = flat[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  return value === 'true';
}

function getArray(flat: FlatMap, key: string): string[] | undefined {
  const value = flat[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  return undefined;
}

/**
 * Resolve $VAR_NAME references from process.env.
 */
function resolveEnv(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName) => {
    return process.env[varName] ?? '';
  });
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class WorkflowParseError extends AppError {
  constructor(message: string) {
    super(`WORKFLOW.md parse error: ${message}`, {
      code: 'ERR_CONFIG',
      statusCode: 400,
      isOperational: true,
    });
    this.name = 'WorkflowParseError';
  }
}
