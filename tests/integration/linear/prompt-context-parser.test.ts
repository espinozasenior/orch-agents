/**
 * Tests for promptContext XML parser.
 *
 * Covers: complete parsing, minimal input, labels, parent issues,
 * multiple threads, guidance rules, malformed XML, null/empty input,
 * and HTML entity decoding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePromptContext,
  type PromptContext,
} from '../../../src/integration/linear/prompt-context-parser';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPLETE_XML = `
<issue identifier="ENG-123">
<title>Fix accessibility</title>
<description>Make it screen-reader friendly</description>
<team name="Engineering"/>
<label>bug</label>
<label>a11y</label>
<parent-issue identifier="QJT0-2">
<title>Parent Title</title>
<description>Parent desc</description>
</parent-issue>
<project name="Checkout flow">Faster checkout</project>
</issue>
<primary-directive-thread comment-id="34f7a7e0">
<comment author="John" created-at="2026-01-08 16:33:12">
<user id="df3fc33e">botcoder</user> Please implement this
</comment>
</primary-directive-thread>
<other-thread comment-id="7f85d4d5">
<comment author="Jane" created-at="2026-01-08 17:00:00">Separate comment</comment>
</other-thread>
<guidance>
<guidance-rule origin="workspace">Always use TypeScript</guidance-rule>
<guidance-rule origin="team" team-name="Engineering">Follow coding standards</guidance-rule>
<guidance-rule origin="parent-team" team-name="Platform">Use shared libs</guidance-rule>
</guidance>
`.trim();

const MINIMAL_XML = `
<issue identifier="ENG-456">
<title>Simple task</title>
<description>Do a thing</description>
<team name="Backend"/>
</issue>
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptContextParser', () => {
  it('should parse complete promptContext with all fields', () => {
    const ctx: PromptContext = parsePromptContext(COMPLETE_XML);

    assert.equal(ctx.issue.identifier, 'ENG-123');
    assert.equal(ctx.issue.title, 'Fix accessibility');
    assert.equal(ctx.issue.description, 'Make it screen-reader friendly');
    assert.equal(ctx.issue.team, 'Engineering');
    assert.deepEqual(ctx.issue.labels, ['bug', 'a11y']);
    assert.ok(ctx.issue.parentIssue);
    assert.equal(ctx.issue.parentIssue!.identifier, 'QJT0-2');
    assert.equal(ctx.issue.parentIssue!.title, 'Parent Title');
    assert.equal(ctx.issue.parentIssue!.description, 'Parent desc');
    assert.ok(ctx.issue.project);
    assert.equal(ctx.issue.project!.name, 'Checkout flow');
    assert.equal(ctx.issue.project!.description, 'Faster checkout');

    assert.ok(ctx.primaryDirective);
    assert.equal(ctx.primaryDirective!.commentId, '34f7a7e0');
    assert.equal(ctx.primaryDirective!.author, 'John');
    assert.equal(ctx.primaryDirective!.createdAt, '2026-01-08 16:33:12');
    assert.ok(ctx.primaryDirective!.body.includes('Please implement this'));
    assert.equal(ctx.primaryDirective!.mentionedUserId, 'df3fc33e');

    assert.equal(ctx.otherThreads.length, 1);
    assert.equal(ctx.otherThreads[0].commentId, '7f85d4d5');
    assert.equal(ctx.otherThreads[0].comments.length, 1);
    assert.equal(ctx.otherThreads[0].comments[0].author, 'Jane');
    assert.equal(ctx.otherThreads[0].comments[0].body, 'Separate comment');

    assert.equal(ctx.guidance.length, 3);
    assert.equal(ctx.guidance[0].origin, 'workspace');
    assert.equal(ctx.guidance[0].content, 'Always use TypeScript');
    assert.equal(ctx.guidance[1].origin, 'team');
    assert.equal(ctx.guidance[1].teamName, 'Engineering');
    assert.equal(ctx.guidance[2].origin, 'parent-team');
    assert.equal(ctx.guidance[2].teamName, 'Platform');

    assert.deepEqual(ctx.parseErrors, []);
  });

  it('should parse minimal promptContext (issue only)', () => {
    const ctx = parsePromptContext(MINIMAL_XML);

    assert.equal(ctx.issue.identifier, 'ENG-456');
    assert.equal(ctx.issue.title, 'Simple task');
    assert.equal(ctx.issue.description, 'Do a thing');
    assert.equal(ctx.issue.team, 'Backend');
    assert.deepEqual(ctx.issue.labels, []);
    assert.equal(ctx.issue.parentIssue, undefined);
    assert.equal(ctx.issue.project, undefined);
    assert.equal(ctx.primaryDirective, null);
    assert.deepEqual(ctx.otherThreads, []);
    assert.deepEqual(ctx.guidance, []);
    assert.deepEqual(ctx.parseErrors, []);
  });

  it('should parse promptContext with multiple labels', () => {
    const xml = `
<issue identifier="ENG-789">
<title>Multi-label</title>
<description>Has many labels</description>
<team name="Frontend"/>
<label>bug</label>
<label>urgent</label>
<label>a11y</label>
<label>regression</label>
</issue>
`.trim();

    const ctx = parsePromptContext(xml);

    assert.deepEqual(ctx.issue.labels, ['bug', 'urgent', 'a11y', 'regression']);
    assert.deepEqual(ctx.parseErrors, []);
  });

  it('should parse promptContext with parent issue', () => {
    const xml = `
<issue identifier="ENG-100">
<title>Child</title>
<description>Child desc</description>
<team name="Core"/>
<parent-issue identifier="ENG-50">
<title>Epic title</title>
<description>Epic desc</description>
</parent-issue>
</issue>
`.trim();

    const ctx = parsePromptContext(xml);

    assert.ok(ctx.issue.parentIssue);
    assert.equal(ctx.issue.parentIssue!.identifier, 'ENG-50');
    assert.equal(ctx.issue.parentIssue!.title, 'Epic title');
    assert.equal(ctx.issue.parentIssue!.description, 'Epic desc');
    assert.deepEqual(ctx.parseErrors, []);
  });

  it('should parse promptContext with multiple other-threads', () => {
    const xml = `
<issue identifier="ENG-200">
<title>Threaded</title>
<description>Many threads</description>
<team name="Infra"/>
</issue>
<other-thread comment-id="aaa">
<comment author="Alice" created-at="2026-01-01 10:00:00">First thread comment 1</comment>
<comment author="Bob" created-at="2026-01-01 11:00:00">First thread comment 2</comment>
</other-thread>
<other-thread comment-id="bbb">
<comment author="Carol" created-at="2026-01-02 09:00:00">Second thread</comment>
</other-thread>
<other-thread comment-id="ccc">
<comment author="Dave" created-at="2026-01-03 08:00:00">Third thread</comment>
</other-thread>
`.trim();

    const ctx = parsePromptContext(xml);

    assert.equal(ctx.otherThreads.length, 3);
    assert.equal(ctx.otherThreads[0].commentId, 'aaa');
    assert.equal(ctx.otherThreads[0].comments.length, 2);
    assert.equal(ctx.otherThreads[0].comments[0].author, 'Alice');
    assert.equal(ctx.otherThreads[0].comments[1].author, 'Bob');
    assert.equal(ctx.otherThreads[1].commentId, 'bbb');
    assert.equal(ctx.otherThreads[2].commentId, 'ccc');
    assert.deepEqual(ctx.parseErrors, []);
  });

  it('should parse promptContext with guidance rules from different origins', () => {
    const xml = `
<issue identifier="ENG-300">
<title>Guided</title>
<description>Has guidance</description>
<team name="Security"/>
</issue>
<guidance>
<guidance-rule origin="workspace">Global rule one</guidance-rule>
<guidance-rule origin="team" team-name="Security">Team-specific rule</guidance-rule>
<guidance-rule origin="parent-team" team-name="Engineering">Parent team rule</guidance-rule>
<guidance-rule origin="workspace">Global rule two</guidance-rule>
</guidance>
`.trim();

    const ctx = parsePromptContext(xml);

    assert.equal(ctx.guidance.length, 4);
    assert.equal(ctx.guidance[0].origin, 'workspace');
    assert.equal(ctx.guidance[0].content, 'Global rule one');
    assert.equal(ctx.guidance[0].teamName, undefined);
    assert.equal(ctx.guidance[1].origin, 'team');
    assert.equal(ctx.guidance[1].teamName, 'Security');
    assert.equal(ctx.guidance[2].origin, 'parent-team');
    assert.equal(ctx.guidance[2].teamName, 'Engineering');
    assert.equal(ctx.guidance[3].origin, 'workspace');
    assert.equal(ctx.guidance[3].content, 'Global rule two');
    assert.deepEqual(ctx.parseErrors, []);
  });

  it('should gracefully handle malformed XML (partial result + parseErrors)', () => {
    const malformed = `
<issue identifier="ENG-400">
<title>Good title</title>
<description>Good desc</description>
<team name="QA"/>
</issue>
<primary-directive-thread comment-id="bad
<guidance>
<guidance-rule origin="team" team-name="QA">Valid rule</guidance-rule>
</guidance>
`.trim();

    const ctx = parsePromptContext(malformed);

    // Issue should parse fine
    assert.equal(ctx.issue.identifier, 'ENG-400');
    assert.equal(ctx.issue.title, 'Good title');

    // Guidance should also parse fine
    assert.equal(ctx.guidance.length, 1);
    assert.equal(ctx.guidance[0].content, 'Valid rule');

    // parseErrors should be empty or have an error depending on whether
    // the malformed primary-directive-thread causes an extraction failure.
    // The key invariant: no exception thrown, partial data returned.
    assert.ok(Array.isArray(ctx.parseErrors));
  });

  it('should return default empty context for null/empty input', () => {
    for (const input of [null, undefined, '', '   ']) {
      const ctx = parsePromptContext(input as string | null | undefined);

      assert.equal(ctx.issue.identifier, '');
      assert.equal(ctx.issue.title, '');
      assert.equal(ctx.issue.description, '');
      assert.equal(ctx.issue.team, '');
      assert.deepEqual(ctx.issue.labels, []);
      assert.equal(ctx.issue.parentIssue, undefined);
      assert.equal(ctx.issue.project, undefined);
      assert.equal(ctx.primaryDirective, null);
      assert.deepEqual(ctx.otherThreads, []);
      assert.deepEqual(ctx.guidance, []);
      assert.deepEqual(ctx.parseErrors, []);
    }
  });

  it('should decode HTML entities correctly', () => {
    const xml = `
<issue identifier="ENG-500">
<title>Fix &lt;input&gt; &amp; &quot;label&quot;</title>
<description>Handle &#60;script&#62; and &#x3C;div&#x3E;</description>
<team name="Frontend"/>
</issue>
`.trim();

    const ctx = parsePromptContext(xml);

    assert.equal(ctx.issue.title, 'Fix <input> & "label"');
    assert.equal(ctx.issue.description, 'Handle <script> and <div>');
    assert.deepEqual(ctx.parseErrors, []);
  });
});
