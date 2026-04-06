/**
 * Phase 9G -- tests for DiskResultCache.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DiskResultCache } from '../../../src/services/tools/diskResultCache';

function uniqueCacheDir(): string {
  return join(tmpdir(), `orch-agents-test-${randomUUID()}`);
}

describe('DiskResultCache', () => {
  const caches: DiskResultCache[] = [];

  afterEach(() => {
    for (const c of caches) c.cleanup();
    caches.length = 0;
  });

  it('creates cache directory if it does not exist', () => {
    const dir = uniqueCacheDir();
    assert.equal(existsSync(dir), false);
    const cache = new DiskResultCache(dir);
    caches.push(cache);
    assert.equal(existsSync(dir), true);
  });

  it('shouldSpill returns false for small results', () => {
    const cache = new DiskResultCache(uniqueCacheDir());
    caches.push(cache);
    assert.equal(cache.shouldSpill({ content: 'small' }), false);
  });

  it('shouldSpill returns true for results > 1MB', () => {
    const cache = new DiskResultCache(uniqueCacheDir());
    caches.push(cache);
    const bigContent = 'x'.repeat(1_100_000);
    assert.equal(cache.shouldSpill({ content: bigContent }), true);
  });

  it('spill writes to disk and returns SpilledResult', () => {
    const dir = uniqueCacheDir();
    const cache = new DiskResultCache(dir);
    caches.push(cache);
    const result = { content: 'spilled-data' };
    const ref = cache.spill('tool-1', result);
    assert.equal(ref.type, 'disk_ref');
    assert.ok(ref.path.startsWith(dir));
    assert.ok(ref.size > 0);
    assert.ok(existsSync(ref.path));
  });

  it('retrieve reads back the original result', () => {
    const cache = new DiskResultCache(uniqueCacheDir());
    caches.push(cache);
    const original = { content: 'round-trip-data', is_error: false };
    const ref = cache.spill('tool-2', original);
    const retrieved = cache.retrieve(ref);
    assert.deepEqual(retrieved, original);
  });

  it('cleanup removes all temp files', () => {
    const cache = new DiskResultCache(uniqueCacheDir());
    caches.push(cache);
    const ref1 = cache.spill('t1', { content: 'a' });
    const ref2 = cache.spill('t2', { content: 'b' });
    assert.ok(existsSync(ref1.path));
    assert.ok(existsSync(ref2.path));
    cache.cleanup();
    assert.equal(existsSync(ref1.path), false);
    assert.equal(existsSync(ref2.path), false);
  });

  it('spill generates unique filenames', () => {
    const cache = new DiskResultCache(uniqueCacheDir());
    caches.push(cache);
    const ref1 = cache.spill('same-id', { content: 'a' });
    const ref2 = cache.spill('same-id', { content: 'b' });
    assert.notEqual(ref1.path, ref2.path);
  });
});
