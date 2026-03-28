import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../src/shared/logger';

describe('createLogger', () => {
  // Capture console output
  let logs: string[];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => logs.push(String(args[0]));
    console.error = (...args: unknown[]) => logs.push(String(args[0]));
    console.warn = (...args: unknown[]) => logs.push(String(args[0]));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  });

  it('should output JSON lines', () => {
    const logger = createLogger({ level: 'info' });
    logger.info('hello world');

    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]);
    assert.equal(entry.level, 'info');
    assert.equal(entry.msg, 'hello world');
    assert.ok(entry.time);
  });

  it('should respect log level', () => {
    const logger = createLogger({ level: 'warn' });
    logger.debug('ignored');
    logger.info('also ignored');
    logger.warn('visible');

    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]);
    assert.equal(entry.level, 'warn');
  });

  it('should include context fields', () => {
    const logger = createLogger({ level: 'info' });
    logger.info('test', { requestId: 'req-1', method: 'POST' });

    const entry = JSON.parse(logs[0]);
    assert.equal(entry.requestId, 'req-1');
    assert.equal(entry.method, 'POST');
  });

  it('should include name binding', () => {
    const logger = createLogger({ level: 'info', name: 'webhook' });
    logger.info('started');

    const entry = JSON.parse(logs[0]);
    assert.equal(entry.name, 'webhook');
  });

  describe('child logger', () => {
    it('should inherit parent bindings', () => {
      const parent = createLogger({ level: 'info', name: 'app' });
      const child = parent.child({ component: 'triage' });
      child.info('processing');

      const entry = JSON.parse(logs[0]);
      assert.equal(entry.name, 'app');
      assert.equal(entry.component, 'triage');
    });

    it('should override parent bindings', () => {
      const parent = createLogger({
        level: 'info',
        bindings: { requestId: 'old' },
      });
      const child = parent.child({ requestId: 'new' });
      child.info('test');

      const entry = JSON.parse(logs[0]);
      assert.equal(entry.requestId, 'new');
    });
  });

  describe('error and fatal use console.error', () => {
    it('should log error level', () => {
      const logger = createLogger({ level: 'error' });
      logger.error('failure', { code: 'ERR_TEST' });

      assert.equal(logs.length, 1);
      const entry = JSON.parse(logs[0]);
      assert.equal(entry.level, 'error');
    });

    it('should log fatal level', () => {
      const logger = createLogger({ level: 'fatal' });
      logger.fatal('crash');

      assert.equal(logs.length, 1);
      const entry = JSON.parse(logs[0]);
      assert.equal(entry.level, 'fatal');
    });
  });
});
