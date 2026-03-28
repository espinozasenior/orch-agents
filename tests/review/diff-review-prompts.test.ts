/**
 * Tests for review/diff-review-prompts.ts
 *
 * Covers prompt building, confidence prompt, and model selection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiffReviewPrompt,
  buildConfidencePrompt,
  selectModel,
} from '../../src/review/diff-review-prompts';
import type { Finding } from '../../src/types';

// ---------------------------------------------------------------------------
// buildDiffReviewPrompt
// ---------------------------------------------------------------------------

describe('buildDiffReviewPrompt', () => {
  const baseContext = { commitSha: 'abc123', attempt: 1 };

  it('includes review categories', () => {
    const prompt = buildDiffReviewPrompt('+ line', baseContext, 'haiku');
    assert.ok(prompt.includes('Logic errors'));
    assert.ok(prompt.includes('Security issues'));
    assert.ok(prompt.includes('Style problems'));
    assert.ok(prompt.includes('Performance concerns'));
    assert.ok(prompt.includes('Test coverage gaps'));
  });

  it('includes diff with boundary markers', () => {
    const diff = '+ added line\n- removed line';
    const prompt = buildDiffReviewPrompt(diff, baseContext, 'haiku');
    assert.ok(prompt.includes('<<<DIFF_START>>>'));
    assert.ok(prompt.includes(diff));
    assert.ok(prompt.includes('<<<DIFF_END>>>'));
  });

  it('includes context fields when provided', () => {
    const context = {
      repo: 'owner/repo',
      branch: 'feature-x',
      prNumber: 42,
      commitSha: 'def456',
      attempt: 2,
    };
    const prompt = buildDiffReviewPrompt('diff', context, 'sonnet');
    assert.ok(prompt.includes('owner/repo'));
    assert.ok(prompt.includes('feature-x'));
    assert.ok(prompt.includes('#42'));
    assert.ok(prompt.includes('def456'));
    assert.ok(prompt.includes('Attempt: 2'));
  });

  it('omits optional context fields when absent', () => {
    const prompt = buildDiffReviewPrompt('diff', baseContext, 'haiku');
    assert.ok(!prompt.includes('Repository:'));
    assert.ok(!prompt.includes('Branch:'));
    assert.ok(!prompt.includes('PR:'));
  });

  it('includes JSON output format instructions', () => {
    const prompt = buildDiffReviewPrompt('diff', baseContext, 'haiku');
    assert.ok(prompt.includes('"findings"'));
    assert.ok(prompt.includes('"severity"'));
    assert.ok(prompt.includes('info|warning|error|critical'));
  });
});

// ---------------------------------------------------------------------------
// buildConfidencePrompt
// ---------------------------------------------------------------------------

describe('buildConfidencePrompt', () => {
  it('lists findings with index numbers', () => {
    const findings: Finding[] = [
      { id: '1', severity: 'error', category: 'logic', message: 'Bug A' },
      { id: '2', severity: 'warning', category: 'style', message: 'Bug B' },
    ];
    const prompt = buildConfidencePrompt(findings);
    assert.ok(prompt.includes('1. [error] logic: Bug A'));
    assert.ok(prompt.includes('2. [warning] style: Bug B'));
  });

  it('requests JSON scores output', () => {
    const findings: Finding[] = [
      { id: '1', severity: 'info', category: 'test', message: 'test' },
    ];
    const prompt = buildConfidencePrompt(findings);
    assert.ok(prompt.includes('"scores"'));
    assert.ok(prompt.includes('one score per finding'));
  });

  it('handles empty findings array', () => {
    const prompt = buildConfidencePrompt([]);
    assert.ok(prompt.includes('Findings'));
    assert.ok(prompt.includes('"scores"'));
  });
});

// ---------------------------------------------------------------------------
// selectModel
// ---------------------------------------------------------------------------

describe('selectModel', () => {
  it('selects haiku for small diffs (< 500 lines)', () => {
    const diff = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = selectModel(diff);
    assert.strictEqual(result.model, 'haiku');
    assert.strictEqual(result.timeout, 60_000);
  });

  it('selects sonnet for large diffs (>= 500 lines)', () => {
    const diff = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    const result = selectModel(diff);
    assert.strictEqual(result.model, 'sonnet');
    assert.strictEqual(result.timeout, 120_000);
  });

  it('selects haiku at boundary (499 lines)', () => {
    const diff = Array.from({ length: 499 }, (_, i) => `line ${i}`).join('\n');
    const result = selectModel(diff);
    assert.strictEqual(result.model, 'haiku');
  });

  it('selects sonnet at boundary (500 lines)', () => {
    const diff = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const result = selectModel(diff);
    assert.strictEqual(result.model, 'sonnet');
  });

  it('handles single-line diff', () => {
    const result = selectModel('single line');
    assert.strictEqual(result.model, 'haiku');
  });

  it('handles empty diff', () => {
    const result = selectModel('');
    assert.strictEqual(result.model, 'haiku');
  });
});
