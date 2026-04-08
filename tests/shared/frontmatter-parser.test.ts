/**
 * Frontmatter Parser tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/shared/frontmatter-parser';

describe('parseFrontmatter', () => {
  it('parses valid frontmatter with all fields', () => {
    const content = `---
name: coder
type: developer
color: "#FF6B35"
description: Implementation specialist for writing clean code
version: "3.0.0"
capabilities:
  - code_generation
  - refactoring
  - optimization
---

# Coder Agent

Body content here.
`;
    const result = parseFrontmatter(content);
    assert.notEqual(result, null);
    assert.equal(result!.name, 'coder');
    assert.equal(result!.type, 'developer');
    assert.equal(result!.color, '#FF6B35');
    assert.equal(result!.description, 'Implementation specialist for writing clean code');
    assert.equal(result!.version, '3.0.0');
    assert.deepEqual(result!.capabilities, ['code_generation', 'refactoring', 'optimization']);
  });

  it('returns null for content without frontmatter', () => {
    const result = parseFrontmatter('# Just a heading\n\nSome content.');
    assert.equal(result, null);
  });

  it('returns null for empty frontmatter', () => {
    const result = parseFrontmatter('---\n---\n\nContent.');
    assert.equal(result, null);
  });

  it('returns null for missing closing delimiter', () => {
    const result = parseFrontmatter('---\nname: test\nNo closing delimiter');
    assert.equal(result, null);
  });

  it('handles frontmatter with no name field', () => {
    const content = `---
type: developer
description: A generic agent
---
Body.
`;
    const result = parseFrontmatter(content);
    assert.notEqual(result, null);
    assert.equal(result!.name, null);
    assert.equal(result!.type, 'developer');
  });

  it('handles quoted string values', () => {
    const content = `---
name: "backend-dev"
description: 'Backend API developer'
---
Body.
`;
    const result = parseFrontmatter(content);
    assert.notEqual(result, null);
    assert.equal(result!.name, 'backend-dev');
    assert.equal(result!.description, 'Backend API developer');
  });

  it('handles empty capabilities array', () => {
    const content = `---
name: minimal
capabilities:
---
Body.
`;
    const result = parseFrontmatter(content);
    assert.notEqual(result, null);
    assert.equal(result!.name, 'minimal');
    assert.deepEqual(result!.capabilities, []);
  });

  it('ignores unknown fields gracefully', () => {
    const content = `---
name: test-agent
unknown_field: some value
priority: high
triggers:
  - keyword1
  - keyword2
---
Body.
`;
    const result = parseFrontmatter(content);
    assert.notEqual(result, null);
    assert.equal(result!.name, 'test-agent');
  });

  it('respects maxBytes parameter', () => {
    // Put closing --- far beyond maxBytes
    const content = '---\nname: test\n' + 'x'.repeat(100) + '\n---\nBody.';
    const result = parseFrontmatter(content, 20);
    // Should fail because closing --- is beyond 20 bytes
    assert.equal(result, null);
  });
});
