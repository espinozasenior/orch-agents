/**
 * Frontmatter Parser.
 *
 * Extracts YAML frontmatter from Markdown files used as agent definitions.
 * Uses a lightweight hand-written parser (no external YAML dependency)
 * since agent frontmatter uses only flat key-value pairs and simple arrays.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentFrontmatter {
  name: string | null;
  type: string | null;
  description: string | null;
  color: string | null;
  capabilities: string[];
  version: string | null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from Markdown content.
 *
 * Expects content to start with `---\n` and have a closing `---\n`.
 * Returns null if no valid frontmatter block is found.
 *
 * Only reads the first `maxBytes` of content to avoid parsing
 * large Markdown bodies.
 */
export function parseFrontmatter(
  content: string,
  maxBytes: number = 16384,
): AgentFrontmatter | null {
  const slice = content.slice(0, maxBytes);

  if (!slice.startsWith('---')) return null;

  const endIndex = slice.indexOf('\n---', 3);
  if (endIndex === -1) return null;

  const yamlBlock = slice.slice(slice.indexOf('\n', 0) + 1, endIndex);
  if (yamlBlock.trim() === '') return null;

  return parseSimpleYaml(yamlBlock);
}

// ---------------------------------------------------------------------------
// Simple YAML parser (flat keys + single-level arrays)
// ---------------------------------------------------------------------------

function parseSimpleYaml(yaml: string): AgentFrontmatter {
  const result: AgentFrontmatter = {
    name: null,
    type: null,
    description: null,
    color: null,
    capabilities: [],
    version: null,
  };

  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // Array item: "  - value"
    const arrayMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayMatch && currentKey && currentArray) {
      currentArray.push(unquote(arrayMatch[1].trim()));
      continue;
    }

    // Key-value: "key: value" or "key: \"value\""
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      // Flush previous array
      if (currentKey && currentArray) {
        assignField(result, currentKey, currentArray);
        currentArray = null;
      }

      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '' || value === '|' || value === '>') {
        // Start of array or block scalar — treat as array
        currentKey = key;
        currentArray = [];
      } else {
        currentKey = key;
        currentArray = null;
        assignField(result, key, unquote(value));
      }
      continue;
    }

    // Nested key (indented) that isn't an array item — skip
  }

  // Flush final array
  if (currentKey && currentArray) {
    assignField(result, currentKey, currentArray);
  }

  return result;
}

function assignField(
  result: AgentFrontmatter,
  key: string,
  value: string | string[],
): void {
  switch (key) {
    case 'name':
      if (typeof value === 'string') result.name = value;
      break;
    case 'type':
      if (typeof value === 'string') result.type = value;
      break;
    case 'description':
      if (typeof value === 'string') result.description = value;
      break;
    case 'color':
      if (typeof value === 'string') result.color = value;
      break;
    case 'version':
      if (typeof value === 'string') result.version = value;
      break;
    case 'capabilities':
      if (Array.isArray(value)) result.capabilities = value;
      break;
  }
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
