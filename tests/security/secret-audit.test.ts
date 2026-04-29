import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSecretAuditLog, type SecretAuditLog } from '../../src/security/secret-audit';
import { openDatabase } from '../../src/shared/sqlite';

const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

describe('createSecretAuditLog', () => {
  let tmp: string;
  let dbPath: string;
  let log: SecretAuditLog;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'secret-audit-'));
    dbPath = join(tmp, 'audit.db');
    log = createSecretAuditLog(dbPath);
  });

  afterEach(() => {
    log.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records hashes for set actions, never plaintext', () => {
    log.record({
      tokenId: 'tok-abc',
      action: 'set',
      key: 'GITHUB_TOKEN',
      scope: 'global',
      beforeValue: 'old-value',
      afterValue: 'new-value',
    });
    const entries = log.list();
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.tokenId, 'tok-abc');
    assert.equal(e.action, 'set');
    assert.equal(e.key, 'GITHUB_TOKEN');
    assert.equal(e.beforeHash, sha('old-value'));
    assert.equal(e.afterHash, sha('new-value'));
    // Plaintext must not appear in any persisted field
    const json = JSON.stringify(e);
    assert.equal(json.includes('old-value'), false);
    assert.equal(json.includes('new-value'), false);
  });

  it('records null hashes for delete (no afterValue)', () => {
    log.record({
      tokenId: 'tok-xyz',
      action: 'delete',
      key: 'STALE_KEY',
      scope: 'repo',
      repo: 'acme/app',
      beforeValue: 'sensitive-old',
    });
    const e = log.list()[0];
    assert.equal(e.action, 'delete');
    assert.equal(e.repo, 'acme/app');
    assert.equal(e.beforeHash, sha('sensitive-old'));
    assert.equal(e.afterHash, null);
  });

  it('handles inserts without a tokenId (e.g. CLI-driven mutations)', () => {
    log.record({
      tokenId: null,
      action: 'set',
      key: 'X',
      scope: 'global',
      afterValue: 'v',
    });
    const e = log.list()[0];
    assert.equal(e.tokenId, null);
    assert.equal(e.afterHash, sha('v'));
  });

  it('list() returns most-recent first, respects limit', () => {
    for (let i = 0; i < 10; i++) {
      log.record({
        tokenId: 't',
        action: 'set',
        key: `K${i}`,
        scope: 'global',
        afterValue: `v${i}`,
      });
    }
    assert.equal(log.count(), 10);
    const recent = log.list(3);
    assert.equal(recent.length, 3);
    assert.deepEqual(
      recent.map((e) => e.key),
      ['K9', 'K8', 'K7'],
    );
  });

  it('rejects UPDATE attempts at the SQLite layer (append-only)', () => {
    log.record({ tokenId: 't', action: 'set', key: 'K', scope: 'global', afterValue: 'v' });
    log.close();

    const db = openDatabase(dbPath);
    try {
      assert.throws(
        () => db.exec("UPDATE secret_audit SET key = 'tampered' WHERE id = 1"),
        /append-only/i,
      );
    } finally {
      db.close();
    }
    log = createSecretAuditLog(dbPath);
  });

  it('rejects DELETE attempts at the SQLite layer (append-only)', () => {
    log.record({ tokenId: 't', action: 'set', key: 'K', scope: 'global', afterValue: 'v' });
    log.close();

    const db = openDatabase(dbPath);
    try {
      assert.throws(
        () => db.exec('DELETE FROM secret_audit WHERE id = 1'),
        /append-only/i,
      );
    } finally {
      db.close();
    }
    log = createSecretAuditLog(dbPath);
  });
});
