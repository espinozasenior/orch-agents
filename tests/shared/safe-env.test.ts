/**
 * Tests for shared/safe-env.ts
 *
 * Verifies that buildSafeEnv filters environment variables to only
 * whitelisted keys and always sets FORCE_COLOR=0.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeEnv, SAFE_ENV_KEYS } from '../../src/shared/safe-env';

describe('buildSafeEnv', () => {
  it('includes whitelisted keys from source', () => {
    const source = { PATH: '/usr/bin', HOME: '/home/user', SHELL: '/bin/bash' };
    const result = buildSafeEnv(source);
    assert.strictEqual(result.PATH, '/usr/bin');
    assert.strictEqual(result.HOME, '/home/user');
    assert.strictEqual(result.SHELL, '/bin/bash');
  });

  it('excludes non-whitelisted keys', () => {
    const source = {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      DATABASE_URL: 'postgres://...',
      API_KEY: 'key-123',
    };
    const result = buildSafeEnv(source);
    assert.strictEqual(result.PATH, '/usr/bin');
    assert.strictEqual(result.GITHUB_TOKEN, undefined);
    assert.strictEqual(result.AWS_SECRET_ACCESS_KEY, undefined);
    assert.strictEqual(result.DATABASE_URL, undefined);
    assert.strictEqual(result.API_KEY, undefined);
  });

  it('always sets FORCE_COLOR to 0', () => {
    const result = buildSafeEnv({});
    assert.strictEqual(result.FORCE_COLOR, '0');
  });

  it('overrides FORCE_COLOR even if source has a different value', () => {
    const result = buildSafeEnv({ FORCE_COLOR: '1' });
    assert.strictEqual(result.FORCE_COLOR, '0');
  });

  it('skips keys with undefined values', () => {
    const source = { PATH: undefined, HOME: '/home/user' };
    const result = buildSafeEnv(source as Record<string, string | undefined>);
    assert.strictEqual(result.PATH, undefined);
    assert.strictEqual(result.HOME, '/home/user');
  });

  it('includes NODE_ENV and NODE_PATH', () => {
    const source = { NODE_ENV: 'production', NODE_PATH: '/app/node_modules' };
    const result = buildSafeEnv(source);
    assert.strictEqual(result.NODE_ENV, 'production');
    assert.strictEqual(result.NODE_PATH, '/app/node_modules');
  });

  it('includes Claude Flow-specific env vars', () => {
    const source = { CLAUDE_FLOW_V3_ENABLED: 'true', CLAUDE_FLOW_HOOKS_ENABLED: 'true' };
    const result = buildSafeEnv(source);
    assert.strictEqual(result.CLAUDE_FLOW_V3_ENABLED, 'true');
    assert.strictEqual(result.CLAUDE_FLOW_HOOKS_ENABLED, 'true');
  });

  it('returns object with only string values (no undefined)', () => {
    const source = { PATH: '/usr/bin' };
    const result = buildSafeEnv(source);
    for (const val of Object.values(result)) {
      assert.strictEqual(typeof val, 'string');
    }
  });

  it('SAFE_ENV_KEYS set has expected minimum keys', () => {
    assert.ok(SAFE_ENV_KEYS.has('PATH'));
    assert.ok(SAFE_ENV_KEYS.has('HOME'));
    assert.ok(SAFE_ENV_KEYS.has('NODE_ENV'));
    assert.ok(SAFE_ENV_KEYS.has('TMPDIR'));
    assert.ok(SAFE_ENV_KEYS.has('GH_TOKEN'), 'GH_TOKEN must be whitelisted for bot identity');
    assert.ok(!SAFE_ENV_KEYS.has('GITHUB_TOKEN'));
    assert.ok(!SAFE_ENV_KEYS.has('AWS_SECRET_ACCESS_KEY'));
  });

  it('passes GH_TOKEN through to child processes (bot identity)', () => {
    const source = { GH_TOKEN: 'ghs_installation_token_abc123' };
    const result = buildSafeEnv(source);
    assert.strictEqual(result.GH_TOKEN, 'ghs_installation_token_abc123');
  });

  it('still blocks GITHUB_TOKEN (not the intentional passthrough)', () => {
    const source = { GITHUB_TOKEN: 'ghp_personal_access_token' };
    const result = buildSafeEnv(source);
    assert.strictEqual(result.GITHUB_TOKEN, undefined);
  });
});
