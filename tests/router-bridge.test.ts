import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDecision,
  classifyDomain,
  classifyComplexity,
  selectTemplate,
  detectAmbiguity,
  getTeamTemplates,
} from '../src/router-bridge';

describe('router-bridge', () => {
  describe('makeDecision', () => {
    it('should return a decision object with expected keys', () => {
      const decision = makeDecision('fix typo in readme');
      assert.ok(decision.template);
      assert.ok(decision.classification);
      assert.ok(decision.classification.domain);
      assert.ok(decision.classification.complexity);
      assert.ok(typeof decision.classification.complexity.level === 'string');
      assert.ok(typeof decision.classification.complexity.percentage === 'number');
    });

    it('should route "fix typo in readme" to quick-fix', () => {
      const decision = makeDecision('fix typo in readme');
      assert.equal(decision.template, 'quick-fix');
    });

    it('should route high-complexity tasks to sparc templates', () => {
      const decision = makeDecision('coordinate sparc methodology for new system');
      assert.equal(decision.classification.complexity.level, 'high');
    });
  });

  describe('classifyDomain', () => {
    it('should classify "write unit tests" as testing', () => {
      assert.equal(classifyDomain('write unit tests for auth'), 'testing');
    });

    it('should classify "write architecture doc" as docs', () => {
      assert.equal(classifyDomain('write architecture doc'), 'docs');
    });
  });

  describe('classifyComplexity', () => {
    it('should return level and percentage', () => {
      const result = classifyComplexity('fix typo');
      assert.ok(['low', 'medium', 'high'].includes(result.level));
      assert.ok(typeof result.percentage === 'number');
      assert.ok(result.percentage >= 0 && result.percentage <= 100);
    });

    it('should classify "fix typo" as low', () => {
      const result = classifyComplexity('fix typo');
      assert.equal(result.level, 'low');
    });
  });

  describe('selectTemplate', () => {
    it('should select testing-sprint for testing domain', () => {
      const result = selectTemplate({
        domain: 'testing',
        complexity: { level: 'medium', percentage: 40 },
        scope: 'multi-file',
        risk: 'low',
      });
      assert.equal(result, 'testing-sprint');
    });
  });

  describe('detectAmbiguity', () => {
    it('should return ambiguity assessment', () => {
      const result = detectAmbiguity('do something');
      assert.ok(typeof result.score === 'number');
      assert.ok(typeof result.needsClarification === 'boolean');
    });
  });

  describe('getTeamTemplates', () => {
    it('should return a non-empty templates object', () => {
      const templates = getTeamTemplates();
      assert.ok(typeof templates === 'object');
      assert.ok(Object.keys(templates).length > 0);
    });

    it('should contain known template keys', () => {
      const templates = getTeamTemplates();
      assert.ok('quick-fix' in templates);
      assert.ok('sparc-full-cycle' in templates);
      assert.ok('testing-sprint' in templates);
    });
  });
});
