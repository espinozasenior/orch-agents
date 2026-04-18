/**
 * Tests for src/setup/env-writer.ts
 *
 * Uses real temp files (mkdtempSync + cleanup in afterEach).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readEnvFile, writeEnvFile } from '../../src/setup/env-writer';

let tmpDir: string;
let envPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'env-writer-test-'));
  envPath = join(tmpDir, '.env');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readEnvFile
// ---------------------------------------------------------------------------

describe('readEnvFile', () => {
  it('returns {} for a missing file', () => {
    const result = readEnvFile(join(tmpDir, 'nonexistent'));
    assert.deepEqual(result, {});
  });

  it('parses simple KEY=value pairs', () => {
    writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n', 'utf-8');
    const result = readEnvFile(envPath);
    assert.deepEqual(result, { FOO: 'bar', BAZ: 'qux' });
  });

  it('strips double-quoted values', () => {
    writeFileSync(envPath, 'KEY="hello world"\n', 'utf-8');
    const result = readEnvFile(envPath);
    assert.equal(result.KEY, 'hello world');
  });

  it('strips single-quoted values', () => {
    writeFileSync(envPath, "KEY='hello world'\n", 'utf-8');
    const result = readEnvFile(envPath);
    assert.equal(result.KEY, 'hello world');
  });

  it('skips comments and blank lines', () => {
    writeFileSync(envPath, '# comment\n\nKEY=val\n  \n# another\n', 'utf-8');
    const result = readEnvFile(envPath);
    assert.deepEqual(result, { KEY: 'val' });
  });

  it('skips lines without = sign', () => {
    writeFileSync(envPath, 'NO_EQUALS\nGOOD=yes\n', 'utf-8');
    const result = readEnvFile(envPath);
    assert.deepEqual(result, { GOOD: 'yes' });
  });
});

// ---------------------------------------------------------------------------
// writeEnvFile
// ---------------------------------------------------------------------------

describe('writeEnvFile', () => {
  it('creates a new file with variables', () => {
    writeEnvFile(envPath, { A: '1', B: '2' });
    const content = readFileSync(envPath, 'utf-8');
    assert.ok(content.includes('A=1'));
    assert.ok(content.includes('B=2'));
  });

  it('merges: updates known keys, preserves unknown', () => {
    writeFileSync(envPath, 'EXISTING=old\nKEPT=yes\n', 'utf-8');
    writeEnvFile(envPath, { EXISTING: 'new', ADDED: 'fresh' });
    const result = readEnvFile(envPath);
    assert.equal(result.EXISTING, 'new');
    assert.equal(result.KEPT, 'yes');
    assert.equal(result.ADDED, 'fresh');
  });

  it('preserves comments and ordering', () => {
    writeFileSync(envPath, '# header\nFIRST=1\n# mid\nSECOND=2\n', 'utf-8');
    writeEnvFile(envPath, { SECOND: 'updated' });
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    assert.equal(lines[0], '# header');
    assert.equal(lines[1], 'FIRST=1');
    assert.equal(lines[2], '# mid');
    assert.equal(lines[3], 'SECOND=updated');
  });

  it('quotes values with spaces, #, or double quotes', () => {
    writeEnvFile(envPath, {
      SPACED: 'hello world',
      HASH: 'foo#bar',
      QUOTED: 'say "hi"',
    });
    const raw = readFileSync(envPath, 'utf-8');
    assert.ok(raw.includes('SPACED="hello world"'));
    assert.ok(raw.includes('HASH="foo#bar"'));
    assert.ok(raw.includes('QUOTED="say \\"hi\\""'));
  });

  it('ensures trailing newline', () => {
    writeEnvFile(envPath, { KEY: 'val' });
    const content = readFileSync(envPath, 'utf-8');
    assert.ok(content.endsWith('\n'));
  });
});
