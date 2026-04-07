/**
 * P13 — LocalShellTask guards: cwd allowlist + env builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCwdAllowed,
  buildEnv,
  CwdNotAllowedError,
  DEFAULT_ENV_ALLOWLIST,
  SECRET_KEY_PATTERN,
} from '../../../src/tasks/local-shell/guards';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'p13-guards-'));
}

describe('assertCwdAllowed', () => {
  it('accepts cwd equal to an allowed root', () => {
    const root = makeTmp();
    try {
      assert.doesNotThrow(() => assertCwdAllowed(root, [root]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts cwd inside an allowed root', () => {
    const root = makeTmp();
    const inside = join(root, 'sub');
    mkdirSync(inside);
    try {
      assert.doesNotThrow(() => assertCwdAllowed(inside, [root]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects cwd outside any allowed root', () => {
    const root = makeTmp();
    const other = makeTmp();
    try {
      assert.throws(() => assertCwdAllowed(other, [root]), CwdNotAllowedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects empty allowedRoots', () => {
    const root = makeTmp();
    try {
      assert.throws(() => assertCwdAllowed(root, []), CwdNotAllowedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects path traversal via .. (realpath resolves the escape)', () => {
    const root = makeTmp();
    const other = makeTmp();
    const escape = join(root, '..', other.split('/').pop() ?? '');
    try {
      assert.throws(() => assertCwdAllowed(escape, [root]), CwdNotAllowedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects symlink escape', () => {
    const root = makeTmp();
    const target = makeTmp();
    const link = join(root, 'link-out');
    try {
      symlinkSync(target, link);
      assert.throws(() => assertCwdAllowed(link, [root]), CwdNotAllowedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects nonexistent path', () => {
    const root = makeTmp();
    try {
      assert.throws(
        () => assertCwdAllowed(join(root, 'no-such-dir'), [root]),
        CwdNotAllowedError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildEnv', () => {
  it('inherits only allowlisted parent env vars', () => {
    const env = buildEnv(undefined, ['PATH', 'HOME'], {
      PATH: '/usr/bin',
      HOME: '/home/user',
      SECRET_X: 'leak-me',
      RANDOM: 'no',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/user');
    assert.equal(env.SECRET_X, undefined);
    assert.equal(env.RANDOM, undefined);
  });

  it('payload values override parent values', () => {
    const env = buildEnv({ PATH: '/custom/bin' }, ['PATH'], { PATH: '/usr/bin' });
    assert.equal(env.PATH, '/custom/bin');
  });

  it('strips secret-pattern keys from parent inheritance', () => {
    const env = buildEnv(undefined, ['PATH', 'GITHUB_TOKEN', 'MY_API_KEY'], {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_xxx',
      MY_API_KEY: 'key',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.MY_API_KEY, undefined);
  });

  it('strips secret-pattern keys even when supplied via payload', () => {
    const env = buildEnv(
      { CUSTOM_SECRET: 'oops', NORMAL: 'ok' },
      ['PATH'],
      { PATH: '/usr/bin' },
    );
    assert.equal(env.NORMAL, 'ok');
    assert.equal(env.CUSTOM_SECRET, undefined);
  });

  it('uses DEFAULT_ENV_ALLOWLIST when none specified', () => {
    const env = buildEnv(undefined, undefined, {
      PATH: '/usr/bin',
      HOME: '/home/u',
      RANDOM: 'no',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/u');
    assert.equal(env.RANDOM, undefined);
  });

  it('SECRET_KEY_PATTERN matches expected variants', () => {
    assert.match('GITHUB_TOKEN', SECRET_KEY_PATTERN);
    assert.match('MY_SECRET', SECRET_KEY_PATTERN);
    assert.match('api_key', SECRET_KEY_PATTERN);
    assert.match('PASSWORD', SECRET_KEY_PATTERN);
    assert.match('AWS_CREDENTIAL', SECRET_KEY_PATTERN);
    assert.doesNotMatch('PATH', SECRET_KEY_PATTERN);
    assert.doesNotMatch('HOME', SECRET_KEY_PATTERN);
  });

  it('ignores non-string parent values', () => {
    const env = buildEnv(undefined, ['PATH'], { PATH: undefined });
    assert.equal(env.PATH, undefined);
    assert.equal(Object.keys(env).length, 0);
  });

  it('DEFAULT_ENV_ALLOWLIST contains the expected POSIX basics', () => {
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes('PATH'));
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes('HOME'));
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes('LANG'));
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes('SHELL'));
  });
});
