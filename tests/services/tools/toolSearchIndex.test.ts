/**
 * Phase 9G -- tests for ToolSearchIndex.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolSearchIndex } from '../../../src/services/tools/toolSearchIndex';
import type { DeferredToolDefinition } from '../../../src/services/tools/deferredTypes';

function makeTool(name: string, description: string): DeferredToolDefinition {
  return {
    name,
    description,
    shouldDefer: true,
    concurrencySafe: true,
    interruptBehavior: 'cancel',
    persistResultToDisk: false,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: 'ok' }),
  };
}

function buildIndex(): ToolSearchIndex {
  const idx = new ToolSearchIndex();
  idx.add(makeTool('Read', 'Read a file from the filesystem'));
  idx.add(makeTool('Write', 'Write a file to the filesystem'));
  idx.add(makeTool('Edit', 'Edit an existing file with replacements'));
  idx.add(makeTool('Grep', 'Search file contents with regex'));
  idx.add(makeTool('Glob', 'Find files by glob pattern'));
  idx.add(makeTool('Bash', 'Execute a shell command'));
  idx.add(makeTool('FileSearch', 'Search for files by name'));
  return idx;
}

describe('ToolSearchIndex.parseQuery', () => {
  const idx = new ToolSearchIndex();

  it('select: mode for "select:Read,Edit"', () => {
    const q = idx.parseQuery('select:Read,Edit');
    assert.equal(q.mode, 'select');
    assert.deepEqual(q.names, ['Read', 'Edit']);
  });

  it('keyword mode for "file read"', () => {
    const q = idx.parseQuery('file read');
    assert.equal(q.mode, 'keyword');
    assert.deepEqual(q.keywords, ['file', 'read']);
  });

  it('required mode for "+file search"', () => {
    const q = idx.parseQuery('+file search');
    assert.equal(q.mode, 'required');
    assert.equal(q.requiredKeyword, 'file');
    assert.deepEqual(q.keywords, ['search']);
  });

  it('sets maxResults from parameter', () => {
    const q = idx.parseQuery('test query', 10);
    assert.equal(q.maxResults, 10);
  });
});

describe('ToolSearchIndex.search', () => {
  it('select mode returns exact matches', () => {
    const idx = buildIndex();
    const results = idx.search({ mode: 'select', names: ['Read', 'Grep'] });
    assert.equal(results.length, 2);
    const names = results.map((r) => r.name);
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Grep'));
  });

  it('select mode is case-insensitive', () => {
    const idx = buildIndex();
    const results = idx.search({ mode: 'select', names: ['read', 'GREP'] });
    assert.equal(results.length, 2);
  });

  it('select mode returns empty for nonexistent tool', () => {
    const idx = buildIndex();
    const results = idx.search({ mode: 'select', names: ['DoesNotExist'] });
    assert.equal(results.length, 0);
  });

  it('keyword mode returns tools ranked by relevance', () => {
    const idx = buildIndex();
    const results = idx.search({ mode: 'keyword', keywords: ['file', 'read'], maxResults: 5 });
    assert.ok(results.length > 0);
    // Read should be top result (matches both "file" and "read" in description + name)
    assert.equal(results[0].name, 'Read');
  });

  it('keyword mode respects maxResults', () => {
    const idx = buildIndex();
    const results = idx.search({ mode: 'keyword', keywords: ['file'], maxResults: 2 });
    assert.ok(results.length <= 2);
  });

  it('keyword mode returns empty for no-match query', () => {
    const idx = buildIndex();
    const results = idx.search({ mode: 'keyword', keywords: ['zzzzz'], maxResults: 5 });
    assert.equal(results.length, 0);
  });

  it('required mode filters to tools with required keyword in name', () => {
    const idx = buildIndex();
    const results = idx.search({
      mode: 'required',
      requiredKeyword: 'file',
      keywords: ['search'],
      maxResults: 5,
    });
    // Only FileSearch has "file" in its name
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.ok(r.name.toLowerCase().includes('file'));
    }
  });

  it('required mode ranks by remaining keywords', () => {
    const idx = buildIndex();
    // Add another tool with "file" in name
    idx.add(makeTool('FileWriter', 'Write data to a file output'));

    const results = idx.search({
      mode: 'required',
      requiredKeyword: 'file',
      keywords: ['search'],
      maxResults: 5,
    });

    // FileSearch should rank higher because "search" matches its description
    assert.equal(results[0].name, 'FileSearch');
  });
});
