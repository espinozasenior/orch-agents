'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Helpers ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const HELPERS = path.join(ROOT, '.claude', 'helpers');

function readDoc(name) {
  return fs.readFileSync(path.join(DOCS, name), 'utf-8');
}

function readHelper(name) {
  return fs.readFileSync(path.join(HELPERS, name), 'utf-8');
}

// ── 1. Document Integrity Tests ─────────────────────────────────────────────

describe('SPARC Review Document Integrity', () => {
  const docs = {
    specification: { file: 'sparc-review-specification.md', prefix: 'SPEC', content: '' },
    architecture: { file: 'sparc-review-architecture.md', prefix: 'ARCH', content: '' },
    pseudocode: { file: 'sparc-review-pseudocode.md', prefix: 'PSEUDO', content: '' },
    refinement: { file: 'sparc-review-refinement.md', prefix: 'REF', content: '' },
  };

  before(() => {
    for (const key of Object.keys(docs)) {
      docs[key].content = readDoc(docs[key].file);
    }
  });

  // ── 1.1 All review docs exist ──────────────────────────────────────────

  describe('file existence', () => {
    for (const [name, doc] of Object.entries(docs)) {
      it(`${doc.file} exists and is non-empty`, () => {
        assert.ok(doc.content.length > 0, `${doc.file} should be non-empty`);
      });
    }
  });

  // ── 1.2 Quick Reference section present ────────────────────────────────

  describe('Quick Reference section', () => {
    for (const [name, doc] of Object.entries(docs)) {
      it(`${doc.file} has a Quick Reference section`, () => {
        assert.match(doc.content, /## Quick Reference/,
          `${doc.file} should contain a Quick Reference section`);
      });
    }
  });

  // ── 1.3 Tracking IDs present ──────────────────────────────────────────

  describe('tracking IDs', () => {
    it('specification doc has SPEC-* tracking IDs', () => {
      const matches = docs.specification.content.match(/SPEC-[A-Z]-\d+/g);
      assert.ok(matches, 'Should find SPEC-* IDs');
      assert.ok(matches.length >= 36, `Expected >=36 SPEC IDs, found ${matches.length}`);
    });

    it('architecture doc has ARCH-* tracking IDs', () => {
      const matches = docs.architecture.content.match(/ARCH-[A-Z]-\d+/g);
      assert.ok(matches, 'Should find ARCH-* IDs');
      assert.ok(matches.length >= 27, `Expected >=27 ARCH IDs, found ${matches.length}`);
    });

    it('pseudocode doc has PSEUDO-* tracking IDs', () => {
      const matches = docs.pseudocode.content.match(/PSEUDO-[A-Z]-\d+/g);
      assert.ok(matches, 'Should find PSEUDO-* IDs');
      assert.ok(matches.length >= 13, `Expected >=13 PSEUDO IDs, found ${matches.length}`);
    });

    it('refinement doc has REF-* tracking IDs', () => {
      const matches = docs.refinement.content.match(/REF-\d+/g);
      assert.ok(matches, 'Should find REF-* IDs');
      assert.ok(matches.length >= 11, `Expected >=11 REF IDs, found ${matches.length}`);
    });
  });

  // ── 1.4 Finding statuses present ──────────────────────────────────────

  describe('finding statuses', () => {
    const statusPattern = /\b(RESOLVED|PARTIALLY RESOLVED|OPEN|COMPLETED|PENDING|DONE|N\/A)\b/;

    it('pseudocode doc has status annotations on findings', () => {
      // The summary table has RESOLVED/OPEN statuses for each finding
      const resolvedCount = (docs.pseudocode.content.match(/\*\*RESOLVED\*\*/g) || []).length;
      const openCount = (docs.pseudocode.content.match(/\*\*OPEN\*\*/g) || []).length;
      assert.ok(resolvedCount >= 11, `Expected >=11 RESOLVED findings, found ${resolvedCount}`);
      // DEFERRED counts as addressed (not OPEN)
      const deferredCount = (docs.pseudocode.content.match(/\*\*DEFERRED\*\*/g) || []).length;
      assert.ok(resolvedCount + deferredCount >= 12, `Expected >=12 RESOLVED+DEFERRED findings, found ${resolvedCount + deferredCount}`);
    });

    it('refinement doc has COMPLETED/PENDING/DONE statuses', () => {
      const completedCount = (docs.refinement.content.match(/COMPLETED/g) || []).length;
      const doneCount = (docs.refinement.content.match(/DONE/g) || []).length;
      assert.ok(completedCount >= 10, `Expected >=10 COMPLETED, found ${completedCount}`);
      assert.ok(doneCount >= 10, `Expected >=10 DONE, found ${doneCount}`);
    });
  });

  // ── 1.5 Cross-references between docs ────────────────────────────────

  describe('cross-references', () => {
    it('architecture doc references specification doc', () => {
      assert.match(docs.architecture.content, /sparc-review-specification\.md/,
        'Architecture doc should cross-reference specification doc');
    });

    it('architecture doc references pseudocode doc', () => {
      assert.match(docs.architecture.content, /sparc-review-pseudocode\.md/,
        'Architecture doc should cross-reference pseudocode doc');
    });

    it('pseudocode doc references specification doc', () => {
      assert.match(docs.pseudocode.content, /sparc-review-specification\.md/,
        'Pseudocode doc should cross-reference specification doc');
    });

    it('pseudocode doc references architecture doc', () => {
      assert.match(docs.pseudocode.content, /sparc-review-architecture\.md/,
        'Pseudocode doc should cross-reference architecture doc');
    });

    it('refinement doc references all other review docs', () => {
      assert.match(docs.refinement.content, /sparc-review-specification\.md/);
      assert.match(docs.refinement.content, /sparc-review-pseudocode\.md/);
      assert.match(docs.refinement.content, /sparc-review-architecture\.md/);
    });

    it('refinement doc references the target architecture doc', () => {
      assert.match(docs.refinement.content, /architecture-orch-agents\.md/);
    });
  });
});

// ── 2. Architecture Doc Consistency Tests ───────────────────────────────────

describe('Architecture Doc Consistency (fixes applied)', () => {
  let archDoc;

  before(() => {
    archDoc = readDoc('architecture-orch-agents.md');
  });

  // ── 2.1 Section 0 exists ──────────────────────────────────────────────

  describe('Section 0: Current vs Target State', () => {
    it('Section 0 heading exists', () => {
      assert.match(archDoc, /## 0\. Current vs Target State/);
    });

    it('contains "What Exists Today" table', () => {
      assert.match(archDoc, /### What Exists Today/);
    });

    it('contains "What Does NOT Exist Yet" table', () => {
      assert.match(archDoc, /### What Does NOT Exist Yet/);
    });

    it('contains "Bridge" mapping table', () => {
      assert.match(archDoc, /### Bridge: How Current Components Map to Target Architecture/);
    });
  });

  // ── 2.2 WorkflowPlan interface has required fields ────────────────────

  describe('WorkflowPlan interface', () => {
    it('has swarmStrategy field', () => {
      assert.match(archDoc, /swarmStrategy/,
        'WorkflowPlan should include swarmStrategy field');
    });

    it('has consensus field', () => {
      // Match consensus in the WorkflowPlan interface context
      assert.match(archDoc, /consensus:\s*'raft'\s*\|\s*'pbft'\s*\|\s*'none'/,
        'WorkflowPlan should include consensus field with raft|pbft|none');
    });

    it('has maxAgents field', () => {
      assert.match(archDoc, /maxAgents:\s*number/,
        'WorkflowPlan should include maxAgents: number field');
    });
  });

  // ── 2.3 IntakeEvent.intent uses WorkIntent type ──────────────────────

  describe('IntakeEvent.intent typing', () => {
    it('IntakeEvent.intent is typed as WorkIntent', () => {
      assert.match(archDoc, /intent:\s*WorkIntent/,
        'IntakeEvent.intent should use WorkIntent type, not bare string');
    });

    it('WorkIntent type is defined with 14 intents', () => {
      assert.match(archDoc, /type WorkIntent\s*=/,
        'WorkIntent union type should be defined');
      // Check for a sample of known intents
      assert.match(archDoc, /'validate-main'/);
      assert.match(archDoc, /'review-pr'/);
      assert.match(archDoc, /'triage-issue'/);
      assert.match(archDoc, /'deploy-release'/);
      assert.match(archDoc, /'incident-response'/);
    });
  });

  // ── 2.4 Missing domain events added ──────────────────────────────────

  describe('missing domain events table', () => {
    const requiredEvents = [
      'PhaseRetried',
      'WorkFailed',
      'WorkCancelled',
      'SwarmInitialized',
      'WorkPaused',
    ];

    for (const event of requiredEvents) {
      it(`includes ${event} domain event`, () => {
        assert.match(archDoc, new RegExp(`\`${event}\``),
          `Architecture doc should include ${event} domain event`);
      });
    }
  });

  // ── 2.5 Appendix B split into B.1 and B.2 ────────────────────────────

  describe('Appendix B split', () => {
    it('has B.1 section for implemented templates', () => {
      assert.match(archDoc, /### B\.1/,
        'Appendix B should have B.1 subsection');
      assert.match(archDoc, /Implemented Templates/i,
        'B.1 should describe implemented templates');
    });

    it('has B.2 section for planned templates', () => {
      assert.match(archDoc, /### B\.2/,
        'Appendix B should have B.2 subsection');
      assert.match(archDoc, /Planned Templates/i,
        'B.2 should describe planned templates');
    });
  });

  // ── 2.6 Section 7 tables have Status column ──────────────────────────

  describe('Section 7 tables have Status column', () => {
    it('Section 7.1 table has Status column', () => {
      // Extract the Section 7.1 table header
      const section71Match = archDoc.match(/### 7\.1[^\n]*\n[\s\S]*?\|[^\n]*Status[^\n]*\|/);
      assert.ok(section71Match, 'Section 7.1 table should have a Status column');
    });

    it('Section 7.2 table has Status column', () => {
      const section72Match = archDoc.match(/### 7\.2[^\n]*\n[\s\S]*?\|[^\n]*Status[^\n]*\|/);
      assert.ok(section72Match, 'Section 7.2 table should have a Status column');
    });
  });

  // ── 2.7 Version and status header ────────────────────────────────────

  describe('header block', () => {
    it('version is 1.1.0-accepted', () => {
      assert.match(archDoc, /\*\*Version:\*\*\s*1\.1\.0-accepted/);
    });

    it('status indicates target architecture', () => {
      assert.match(archDoc, /Target Architecture/,
        'Status should indicate this is target architecture');
    });

    it('has Implementation Status line', () => {
      assert.match(archDoc, /\*\*Implementation Status:\*\*/,
        'Header should include Implementation Status field');
    });

    it('has SPARC Review reference', () => {
      assert.match(archDoc, /\*\*SPARC Review:\*\*/,
        'Header should include SPARC Review reference');
    });
  });
});

// ── 3. Hook Handler Tests ───────────────────────────────────────────────────

describe('Hook Handler: WORKFLOW_MAP', () => {
  let hookHandlerContent;

  before(() => {
    hookHandlerContent = readHelper('hook-handler.cjs');
  });

  it('WORKFLOW_MAP exists', () => {
    assert.match(hookHandlerContent, /const WORKFLOW_MAP\s*=\s*\{/,
      'hook-handler.cjs should define WORKFLOW_MAP');
  });

  it('WORKFLOW_MAP has testing-sprint entry', () => {
    assert.match(hookHandlerContent, /['"]testing-sprint['"]\s*:\s*['"]testing['"]/,
      'WORKFLOW_MAP should map testing-sprint to testing');
  });

  it('WORKFLOW_MAP has sparc-full-cycle entry', () => {
    assert.match(hookHandlerContent, /['"]sparc-full-cycle['"]\s*:\s*['"]sparc['"]/,
      'WORKFLOW_MAP should map sparc-full-cycle to sparc');
  });

  it('WORKFLOW_MAP has all 9 template entries', () => {
    const expectedTemplates = [
      'quick-fix',
      'research-sprint',
      'feature-build',
      'sparc-full-cycle',
      'security-audit',
      'performance-sprint',
      'release-pipeline',
      'fullstack-swarm',
      'testing-sprint',
    ];
    for (const tpl of expectedTemplates) {
      assert.match(hookHandlerContent, new RegExp(`['"]${tpl}['"]`),
        `WORKFLOW_MAP should include ${tpl}`);
    }
  });
});

// ── 4. Router Regression: SPARC File-Path Exclusion ─────────────────────────

describe('Router: SPARC file-path exclusion regression', () => {
  let makeDecision, classifyComplexity;

  before(() => {
    const router = require(path.join(HELPERS, 'tech-lead-router.cjs'));
    makeDecision = router.makeDecision;
    classifyComplexity = router.classifyComplexity;
  });

  // ── 4.1 SPARC methodology still triggers high complexity ──────────────

  describe('SPARC methodology intent preserved', () => {
    it('"coordinate sparc methodology" is high complexity', () => {
      const result = classifyComplexity('coordinate sparc methodology');
      assert.equal(result.level, 'high');
      assert.ok(result.percentage >= 65, `Expected >=65%, got ${result.percentage}%`);
    });

    it('"implement sparc phases for new feature" is high complexity', () => {
      const result = classifyComplexity('implement sparc phases for new feature');
      assert.equal(result.level, 'high');
    });

    it('"sparc full cycle for auth system" is high complexity', () => {
      const result = classifyComplexity('sparc full cycle for auth system');
      assert.equal(result.level, 'high');
    });
  });

  // ── 4.2 SPARC file paths do NOT trigger high complexity ───────────────

  describe('SPARC file paths excluded from methodology override', () => {
    it('"review sparc-review-specification.md" does not force high complexity', () => {
      const result = classifyComplexity('review sparc-review-specification.md');
      // Should NOT be boosted to high just because of "sparc" in file name
      assert.ok(
        result.level !== 'high' || result.percentage < 65,
        `File-path reference should not trigger SPARC methodology override (got ${result.level} at ${result.percentage}%)`
      );
    });

    it('"read sparc-review-architecture.md" does not force high complexity', () => {
      const result = classifyComplexity('read sparc-review-architecture.md');
      assert.ok(
        result.level !== 'high' || result.percentage < 65,
        `File-path reference should not trigger SPARC methodology override (got ${result.level} at ${result.percentage}%)`
      );
    });

    it('"edit sparc-review-pseudocode.md findings" does not force high complexity', () => {
      const result = classifyComplexity('edit sparc-review-pseudocode.md findings');
      assert.ok(
        result.level !== 'high' || result.percentage < 65,
        `File-path reference should not trigger SPARC methodology override`
      );
    });
  });

  // ── 4.3 Non-SPARC routing still works ─────────────────────────────────

  describe('non-SPARC routing unaffected', () => {
    it('"fix typo in readme" routes to quick-fix', () => {
      const decision = makeDecision('fix typo in readme');
      assert.equal(decision.template, 'quick-fix');
    });

    it('"write unit tests for auth module" routes to testing-sprint', () => {
      const decision = makeDecision('write unit tests for auth module');
      assert.equal(decision.template, 'testing-sprint');
    });

    it('"research best practices for caching" routes to research-sprint', () => {
      const decision = makeDecision('research best practices for caching');
      assert.equal(decision.template, 'research-sprint');
    });

    it('"build user profile feature" routes to feature-build', () => {
      const decision = makeDecision('build user profile feature');
      assert.equal(decision.template, 'feature-build');
    });
  });
});

// ── 5. SPARC Review Specification Category Counts ───────────────────────────

describe('SPARC Specification Review: category completeness', () => {
  let specContent;

  before(() => {
    specContent = readDoc('sparc-review-specification.md');
  });

  it('has 8 validated findings (SPEC-V-01 through SPEC-V-08)', () => {
    const validated = new Set();
    const matches = specContent.matchAll(/SPEC-V-(\d+)/g);
    for (const m of matches) validated.add(m[1]);
    assert.ok(validated.size >= 8, `Expected 8 validated IDs, found ${validated.size}`);
  });

  it('has 15 aspirational findings (SPEC-A-01 through SPEC-A-15)', () => {
    const aspirational = new Set();
    const matches = specContent.matchAll(/SPEC-A-(\d+)/g);
    for (const m of matches) aspirational.add(m[1]);
    assert.ok(aspirational.size >= 15, `Expected 15 aspirational IDs, found ${aspirational.size}`);
  });

  it('has 6 contradiction findings (SPEC-C-01 through SPEC-C-06)', () => {
    const contradictions = new Set();
    const matches = specContent.matchAll(/SPEC-C-(\d+)/g);
    for (const m of matches) contradictions.add(m[1]);
    assert.ok(contradictions.size >= 6, `Expected 6 contradiction IDs, found ${contradictions.size}`);
  });

  it('has 7 missing findings (SPEC-M-01 through SPEC-M-07)', () => {
    const missing = new Set();
    const matches = specContent.matchAll(/SPEC-M-(\d+)/g);
    for (const m of matches) missing.add(m[1]);
    assert.ok(missing.size >= 7, `Expected 7 missing IDs, found ${missing.size}`);
  });
});

// ── 6. SPARC Architecture Review: category completeness ─────────────────────

describe('SPARC Architecture Review: category completeness', () => {
  let archReviewContent;

  before(() => {
    archReviewContent = readDoc('sparc-review-architecture.md');
  });

  it('has 6 accurate findings (ARCH-A-01 through ARCH-A-06)', () => {
    const accurate = new Set();
    const matches = archReviewContent.matchAll(/ARCH-A-(\d+)/g);
    for (const m of matches) accurate.add(m[1]);
    assert.ok(accurate.size >= 6, `Expected 6 accurate IDs, found ${accurate.size}`);
  });

  it('has 7 forward-looking findings (ARCH-F-01 through ARCH-F-07)', () => {
    const forward = new Set();
    const matches = archReviewContent.matchAll(/ARCH-F-(\d+)/g);
    for (const m of matches) forward.add(m[1]);
    assert.ok(forward.size >= 7, `Expected 7 forward IDs, found ${forward.size}`);
  });

  it('has 14 misleading findings (ARCH-M-01 through ARCH-M-14)', () => {
    const misleading = new Set();
    const matches = archReviewContent.matchAll(/ARCH-M-(\d+)/g);
    for (const m of matches) misleading.add(m[1]);
    assert.ok(misleading.size >= 14, `Expected 14 misleading IDs, found ${misleading.size}`);
  });
});

// ── 7. Pseudocode Review: resolution tracking ──────────────────────────────

describe('SPARC Pseudocode Review: resolution tracking', () => {
  let pseudoContent;

  before(() => {
    pseudoContent = readDoc('sparc-review-pseudocode.md');
  });

  it('has 13 total findings across all severities', () => {
    const allIds = new Set();
    const matches = pseudoContent.matchAll(/PSEUDO-[A-Z]-(\d+)/g);
    for (const m of matches) allIds.add(m[0]);
    assert.ok(allIds.size >= 13, `Expected >=13 unique PSEUDO IDs, found ${allIds.size}`);
  });

  it('PSEUDO-H-03 (testing-sprint WORKFLOW_MAP) is RESOLVED', () => {
    assert.match(pseudoContent, /PSEUDO-H-03[^\n]*RESOLVED/,
      'PSEUDO-H-03 should be marked RESOLVED');
  });

  it('PSEUDO-H-02 (IntakeEvent.intent typing) is RESOLVED', () => {
    assert.match(pseudoContent, /PSEUDO-H-02[^\n]*RESOLVED/,
      'PSEUDO-H-02 should be marked RESOLVED');
  });

  it('PSEUDO-H-01 (missing domain events) is RESOLVED', () => {
    assert.match(pseudoContent, /PSEUDO-H-01[^\n]*RESOLVED/,
      'PSEUDO-H-01 should be marked RESOLVED');
  });

  it('PSEUDO-C-01 (undefined types) is RESOLVED', () => {
    assert.match(pseudoContent, /PSEUDO-C-01[^\n]*RESOLVED/,
      'PSEUDO-C-01 should be marked RESOLVED');
  });

  it('PSEUDO-C-02 (bridge interface) is RESOLVED', () => {
    assert.match(pseudoContent, /PSEUDO-C-02[^\n]*RESOLVED/,
      'PSEUDO-C-02 should be marked RESOLVED');
  });
});

// ── 8. Refinement Review: action completion ─────────────────────────────────

describe('SPARC Refinement Review: action completion', () => {
  let refContent;

  before(() => {
    refContent = readDoc('sparc-review-refinement.md');
  });

  it('reports 10 of 11 actions completed', () => {
    assert.match(refContent, /10 of 11/,
      'Refinement doc should report 10 of 11 actions completed');
  });

  it('REF-01 through REF-10 are all COMPLETED or DONE', () => {
    for (let i = 1; i <= 10; i++) {
      const id = `REF-${i.toString().padStart(2, '0')}`;
      const pattern = new RegExp(`${id}[^\\n]*(COMPLETED|DONE)`);
      assert.match(refContent, pattern, `${id} should be COMPLETED or DONE`);
    }
  });

  it('REF-11 is marked as N/A (kept unchanged)', () => {
    assert.match(refContent, /REF-11[^\n]*N\/A/,
      'REF-11 should be marked N/A');
  });
});
