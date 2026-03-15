/**
 * Directory Scanner.
 *
 * Recursively scans `.claude/agents/` for Markdown agent definitions
 * and extracts frontmatter metadata from each file.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, basename, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter-parser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  /** Canonical identifier from frontmatter `name:` field (or filename fallback) */
  name: string;
  /** Frontmatter `type:` field (e.g., "developer", "analyst") */
  type: string;
  /** Human-readable description from frontmatter */
  description: string;
  /** Capability tags from frontmatter */
  capabilities: string[];
  /** UI color hint */
  color: string;
  /** Derived from first-level subdirectory (core, sparc, github, v3, etc.) */
  category: string;
  /** Absolute path to the .md file */
  filePath: string;
  /** Frontmatter version string */
  version: string;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan a directory recursively for `*.md` files with YAML frontmatter.
 *
 * Returns a sorted, deduplicated array of AgentDefinition objects.
 * Files without frontmatter or without a `name` field (and no parseable
 * filename) are skipped with a warning via the optional logger.
 */
export function scanAgentDirectory(
  baseDir: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): AgentDefinition[] {
  if (!existsSync(baseDir)) return [];

  const results: AgentDefinition[] = [];
  const seen = new Set<string>();
  const mdFiles = collectMdFiles(baseDir);

  for (const filePath of mdFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);

      if (!frontmatter) {
        logger?.warn('Skipping file with no frontmatter', { file: filePath });
        continue;
      }

      // Derive category from first-level subdirectory
      const relPath = relative(baseDir, filePath);
      const parts = dirname(relPath).split(sep);
      const category = parts[0] === '.' ? 'uncategorized' : parts[0];

      // Canonical name: frontmatter name > filename without extension
      const name = frontmatter.name ?? basename(filePath, '.md');

      if (seen.has(name)) {
        logger?.warn('Duplicate agent name, skipping', { name, file: filePath });
        continue;
      }
      seen.add(name);

      results.push({
        name,
        type: frontmatter.type ?? 'generic',
        description: frontmatter.description ?? '',
        capabilities: frontmatter.capabilities,
        color: frontmatter.color ?? '#888888',
        category,
        filePath,
        version: frontmatter.version ?? '1.0.0',
      });
    } catch (err) {
      logger?.warn('Failed to read agent file', {
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectMdFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectMdFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}
