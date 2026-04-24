import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/shared/sqlite';

describe('openDatabase', () => {
  it('applies WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sqlite-helper-'));
    const dbPath = path.join(dir, 'pragma-check.db');
    const db = openDatabase(dbPath);
    try {
      const journal = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
      assert.equal(journal.journal_mode, 'wal');

      const busy = db.prepare('PRAGMA busy_timeout;').get() as { timeout: number };
      assert.equal(busy.timeout, 5000);

      const fk = db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };
      assert.equal(fk.foreign_keys, 1);

      // synchronous: NORMAL = 1, FULL = 2, OFF = 0
      const sync = db.prepare('PRAGMA synchronous;').get() as { synchronous: number };
      assert.equal(sync.synchronous, 1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
