import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/shared/config';

describe('loadConfig', () => {
  describe('defaults', () => {
    it('should return defaults when env is empty', () => {
      const config = loadConfig({});
      assert.equal(config.port, 3000);
      assert.equal(config.nodeEnv, 'development');
      assert.equal(config.logLevel, 'info');
      assert.equal(config.webhookSecret, '');
      assert.equal(config.githubToken, '');
    });
  });

  describe('PORT parsing', () => {
    it('should parse valid PORT', () => {
      const config = loadConfig({ PORT: '8080' });
      assert.equal(config.port, 8080);
    });

    it('should reject non-numeric PORT', () => {
      assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
    });

    it('should reject PORT out of range', () => {
      assert.throws(() => loadConfig({ PORT: '0' }), /Invalid PORT/);
      assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
    });
  });

  describe('LOG_LEVEL parsing', () => {
    it('should parse valid LOG_LEVEL', () => {
      const config = loadConfig({ LOG_LEVEL: 'debug' });
      assert.equal(config.logLevel, 'debug');
    });

    it('should be case-insensitive', () => {
      const config = loadConfig({ LOG_LEVEL: 'WARN' });
      assert.equal(config.logLevel, 'warn');
    });

    it('should reject invalid LOG_LEVEL', () => {
      assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), /Invalid LOG_LEVEL/);
    });
  });

  describe('NODE_ENV parsing', () => {
    it('should parse valid NODE_ENV', () => {
      const config = loadConfig({ NODE_ENV: 'test' });
      assert.equal(config.nodeEnv, 'test');
    });

    it('should reject invalid NODE_ENV', () => {
      assert.throws(() => loadConfig({ NODE_ENV: 'staging' }), /Invalid NODE_ENV/);
    });
  });

  describe('production requirements', () => {
    it('should require WEBHOOK_SECRET in production', () => {
      assert.throws(
        () => loadConfig({ NODE_ENV: 'production', GITHUB_TOKEN: 'ghp_test' }),
        /WEBHOOK_SECRET is required/,
      );
    });

    it('should require GITHUB_TOKEN in production', () => {
      assert.throws(
        () => loadConfig({ NODE_ENV: 'production', WEBHOOK_SECRET: 'secret' }),
        /GITHUB_TOKEN is required/,
      );
    });

    it('should succeed with all required vars in production', () => {
      const config = loadConfig({
        NODE_ENV: 'production',
        WEBHOOK_SECRET: 'secret',
        GITHUB_TOKEN: 'ghp_test',
      });
      assert.equal(config.nodeEnv, 'production');
      assert.equal(config.webhookSecret, 'secret');
    });
  });

  describe('frozen config', () => {
    it('should return a frozen object', () => {
      const config = loadConfig({});
      assert.ok(Object.isFrozen(config));
    });
  });
});
