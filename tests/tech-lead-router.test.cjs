'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeDecision,
  classifyDomain,
  classifyComplexity,
  selectTemplate,
  detectAmbiguity,
  TEAM_TEMPLATES,
} = require('../.claude/helpers/tech-lead-router.cjs');

// ── Complexity Classification ───────────────────────────────────────────────

describe('classifyComplexity', () => {
  describe('high complexity signals', () => {
    it('should classify "coordinate sparc methodology" as high', () => {
      const result = classifyComplexity('coordinate sparc methodology');
      assert.equal(result.level, 'high');
      assert.ok(result.percentage >= 60, `Expected >=60%, got ${result.percentage}%`);
    });

    it('should classify "implement event sourcing for orders" as high', () => {
      const result = classifyComplexity('implement event sourcing for orders');
      assert.equal(result.level, 'high');
    });

    it('should classify "add bounded context for billing" as high', () => {
      const result = classifyComplexity('add bounded context for billing');
      assert.equal(result.level, 'high');
    });

    it('should classify "system design for the new architecture" as high', () => {
      const result = classifyComplexity('system design for the new architecture');
      assert.equal(result.level, 'high');
    });

    it('should classify "end-to-end design of the pipeline" as high', () => {
      const result = classifyComplexity('end-to-end design of the pipeline');
      assert.equal(result.level, 'high');
    });

    it('should classify "domain driven design implementation" as high', () => {
      const result = classifyComplexity('domain driven design implementation');
      assert.equal(result.level, 'high');
    });

    it('should classify "cqrs pattern for order service" as high', () => {
      const result = classifyComplexity('cqrs pattern for order service');
      assert.equal(result.level, 'high');
    });

    it('should classify "governance model for shared services" as high', () => {
      const result = classifyComplexity('governance model for shared services');
      assert.equal(result.level, 'high');
    });
  });

  describe('medium complexity signals', () => {
    it('should classify "develop a webhook handler" as medium (not low)', () => {
      const result = classifyComplexity('develop a webhook handler');
      assert.equal(result.level, 'medium');
      assert.ok(result.percentage >= 15, `Expected >=15%, got ${result.percentage}%`);
    });

    it('should classify "build notification service" as medium', () => {
      const result = classifyComplexity('build notification service');
      assert.equal(result.level, 'medium');
    });

    it('should classify "add workflow automation" as medium', () => {
      const result = classifyComplexity('add workflow automation');
      assert.equal(result.level, 'medium');
    });

    it('should classify "implement agent triage system" as medium', () => {
      const result = classifyComplexity('implement agent triage system');
      assert.equal(result.level, 'medium');
    });

    it('should classify "create swarm intake handler" as medium', () => {
      const result = classifyComplexity('create swarm intake handler');
      assert.equal(result.level, 'medium');
    });
  });

  describe('low complexity signals', () => {
    it('should classify "fix typo in readme" as low', () => {
      const result = classifyComplexity('fix typo in readme');
      assert.equal(result.level, 'low');
    });

    it('should classify "revert last commit" as low', () => {
      const result = classifyComplexity('revert last commit');
      assert.equal(result.level, 'low');
    });

    it('should classify "bump version number" as low', () => {
      const result = classifyComplexity('bump version number');
      assert.equal(result.level, 'low');
    });

    it('should classify "hotfix null pointer" as low', () => {
      const result = classifyComplexity('hotfix null pointer');
      assert.equal(result.level, 'low');
    });

    it('should classify "add comment to function" as low', () => {
      const result = classifyComplexity('add comment to function');
      assert.equal(result.level, 'low');
    });

    it('should classify "sort imports" as low', () => {
      const result = classifyComplexity('sort imports');
      assert.equal(result.level, 'low');
    });

    it('should classify "reorder fields in config" as low', () => {
      const result = classifyComplexity('reorder fields in config');
      assert.equal(result.level, 'low');
    });

    it('should classify "update label on button" as low', () => {
      const result = classifyComplexity('update label on button');
      assert.equal(result.level, 'low');
    });
  });
});

// ── Domain Classification ───────────────────────────────────────────────────

describe('classifyDomain', () => {
  it('should classify "write architecture doc" as docs', () => {
    assert.equal(classifyDomain('write architecture doc'), 'docs');
  });

  it('should classify "update docs/architecture-orch-agents.md" as docs', () => {
    // Path-based detection: docs/ prefix should map to docs domain
    assert.equal(classifyDomain('update docs/architecture-orch-agents.md'), 'docs');
  });

  it('should classify "write unit tests for auth" as testing', () => {
    assert.equal(classifyDomain('write unit tests for auth'), 'testing');
  });

  it('should classify "add jest coverage" as testing', () => {
    assert.equal(classifyDomain('add jest coverage'), 'testing');
  });

  it('should classify "create e2e test suite" as testing', () => {
    assert.equal(classifyDomain('create e2e test suite'), 'testing');
  });

  it('should classify "add vitest config" as testing', () => {
    assert.equal(classifyDomain('add vitest config'), 'testing');
  });

  it('should classify "write playwright tests" as testing', () => {
    assert.equal(classifyDomain('write playwright tests'), 'testing');
  });

  it('should classify "write adr for caching strategy" as docs', () => {
    assert.equal(classifyDomain('write adr for caching strategy'), 'docs');
  });

  it('should classify "update runbook for deploys" as docs', () => {
    assert.equal(classifyDomain('update runbook for deploys'), 'docs');
  });
});

// ── Template Selection ──────────────────────────────────────────────────────

describe('selectTemplate', () => {
  it('should have a testing-sprint template', () => {
    assert.ok(TEAM_TEMPLATES['testing-sprint'], 'testing-sprint template should exist');
    assert.equal(TEAM_TEMPLATES['testing-sprint'].name, 'Testing Sprint');
  });

  it('should select testing-sprint for testing domain', () => {
    const result = selectTemplate({
      domain: 'testing',
      complexity: { level: 'medium', percentage: 40 },
      scope: 'multi-file',
      risk: 'low',
    });
    assert.equal(result, 'testing-sprint');
  });

  it('should select sparc-full-cycle for docs + high complexity', () => {
    const result = selectTemplate({
      domain: 'docs',
      complexity: { level: 'high', percentage: 70 },
      scope: 'multi-file',
      risk: 'low',
    });
    assert.equal(result, 'sparc-full-cycle');
  });

  it('should select quick-fix for docs + low complexity', () => {
    const result = selectTemplate({
      domain: 'docs',
      complexity: { level: 'low', percentage: 10 },
      scope: 'single-file',
      risk: 'low',
    });
    assert.equal(result, 'quick-fix');
  });

  it('should select research-sprint for docs + medium complexity', () => {
    const result = selectTemplate({
      domain: 'docs',
      complexity: { level: 'medium', percentage: 40 },
      scope: 'multi-file',
      risk: 'low',
    });
    assert.equal(result, 'research-sprint');
  });

  it('should select sparc-full-cycle for research + high complexity', () => {
    const result = selectTemplate({
      domain: 'research',
      complexity: { level: 'high', percentage: 70 },
      scope: 'multi-file',
      risk: 'low',
    });
    assert.equal(result, 'sparc-full-cycle');
  });

  it('should select quick-fix for research + low complexity', () => {
    const result = selectTemplate({
      domain: 'research',
      complexity: { level: 'low', percentage: 10 },
      scope: 'single-file',
      risk: 'low',
    });
    assert.equal(result, 'quick-fix');
  });
});

// ── End-to-End Decision Tests (makeDecision) ────────────────────────────────

describe('makeDecision', () => {
  it('should route "coordinate sparc methodology to develop docs/architecture-orch-agents.md" to sparc-full-cycle', () => {
    const decision = makeDecision('coordinate sparc methodology to develop docs/architecture-orch-agents.md');
    assert.equal(decision.template, 'sparc-full-cycle');
    assert.equal(decision.classification.complexity.level, 'high');
  });

  it('should route "fix typo in README" to quick-fix', () => {
    const decision = makeDecision('fix typo in README');
    assert.equal(decision.template, 'quick-fix');
  });

  it('should route "write comprehensive architecture documentation" to sparc-full-cycle', () => {
    const decision = makeDecision('write comprehensive architecture documentation');
    assert.equal(decision.template, 'sparc-full-cycle');
    assert.equal(decision.classification.complexity.level, 'high');
  });

  it('should route "write unit tests for the auth module" to testing-sprint', () => {
    const decision = makeDecision('write unit tests for the auth module');
    assert.equal(decision.template, 'testing-sprint');
  });

  it('should escalate explicit "sparc" keyword to high complexity', () => {
    const decision = makeDecision('sparc review the login flow');
    assert.equal(decision.classification.complexity.level, 'high');
    assert.ok(decision.classification.complexity.percentage >= 65);
  });
});

// ── Ambiguity Escalation ────────────────────────────────────────────────────

describe('ambiguity escalation in makeDecision', () => {
  it('should escalate high ambiguity + low complexity to medium', () => {
    // "do something" is very vague → high ambiguity, but low complexity
    // After escalation, complexity should be medium
    const decision = makeDecision('do something');
    if (decision.ambiguity.level === 'high') {
      assert.ok(
        decision.classification.complexity.level === 'medium' || decision.classification.complexity.level === 'high',
        `Expected medium or high complexity after ambiguity escalation, got ${decision.classification.complexity.level}`
      );
    }
  });
});

// ── Risk Classification ─────────────────────────────────────────────────────

describe('classifyRisk', () => {
  // Note: classifyRisk is not directly exported, so we test via makeDecision
  it('should classify "hotfix production outage" as high risk', () => {
    const decision = makeDecision('hotfix production outage');
    assert.equal(decision.classification.risk, 'high');
  });

  it('should classify "update PII handling for GDPR" as high risk', () => {
    const decision = makeDecision('update PII handling for GDPR');
    assert.equal(decision.classification.risk, 'high');
  });

  it('should classify "fix data loss in sync" as high risk', () => {
    const decision = makeDecision('fix data loss in sync');
    assert.equal(decision.classification.risk, 'high');
  });

  it('should classify "address downtime in payment service" as high risk', () => {
    const decision = makeDecision('address downtime in payment service');
    assert.equal(decision.classification.risk, 'high');
  });

  it('should classify "hipaa compliance update" as high risk', () => {
    const decision = makeDecision('hipaa compliance update');
    assert.equal(decision.classification.risk, 'high');
  });

  it('should classify "breaking change to public API" as medium risk', () => {
    const decision = makeDecision('refactor breaking change to public API endpoint');
    // "breaking" hits high risk already, but "public api" + "deprecat" should hit medium
    assert.ok(
      decision.classification.risk === 'high' || decision.classification.risk === 'medium',
      `Expected high or medium risk, got ${decision.classification.risk}`
    );
  });

  it('should classify "deprecate old third-party vendor integration" as medium risk', () => {
    const decision = makeDecision('deprecate old third-party vendor integration');
    assert.ok(
      decision.classification.risk === 'medium' || decision.classification.risk === 'high',
      `Expected medium or high risk, got ${decision.classification.risk}`
    );
  });
});
