import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMintToken } from '../../src/setup/commands/mint-token';
import { createWebTokenStore } from '../../src/web-api/web-auth';

describe('runMintToken', () => {
  let tmp: string;
  let dbPath: string;
  let logSpy: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mint-token-'));
    dbPath = join(tmp, 'secrets.db');
    logSpy = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logSpy.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('mints a token and prints plaintext to stdout (default mode)', async () => {
    await runMintToken({ label: 'dev', scopes: 'runs:read,secrets:write', dbPath });

    // The default mode prints exactly one line: the plaintext token
    assert.equal(logSpy.length, 1);
    assert.match(logSpy[0], /^orch_[A-Za-z0-9_-]+$/);

    // Token is persisted and validatable
    const plaintext = logSpy[0];
    const store = createWebTokenStore(dbPath);
    try {
      const result = store.validate(plaintext);
      assert.ok(result, 'minted token should validate');
      assert.deepEqual(result!.scopes.sort(), ['runs:read', 'secrets:write']);
    } finally {
      store.close();
    }
  });

  it('writes ORCH_API_TOKEN to .env when --to-env is provided', async () => {
    const envPath = join(tmp, '.env');
    await runMintToken({ label: 'dev', scopes: 'runs:read', dbPath, toEnv: envPath });

    assert.ok(existsSync(envPath));
    const contents = readFileSync(envPath, 'utf-8');
    const match = contents.match(/^ORCH_API_TOKEN=(orch_[A-Za-z0-9_-]+)$/m);
    assert.ok(match, '.env should contain ORCH_API_TOKEN line');

    // The actual token is not echoed in the human-readable output
    const fullOut = logSpy.join('\n');
    assert.equal(fullOut.includes(match![1]), false, 'plaintext token must NOT be in stdout when --to-env is used');
  });

  it('rejects invalid scopes', async () => {
    await assert.rejects(
      () => runMintToken({ label: 'dev', scopes: 'runs:read,bogus:scope', dbPath }),
      /unknown scope/,
    );
  });

  it('rejects empty label', async () => {
    await assert.rejects(
      () => runMintToken({ label: '', scopes: 'runs:read', dbPath }),
      /--label is required/,
    );
  });

  it('rejects empty scopes', async () => {
    await assert.rejects(
      () => runMintToken({ label: 'dev', scopes: '', dbPath }),
      /--scopes is required/,
    );
  });
});
