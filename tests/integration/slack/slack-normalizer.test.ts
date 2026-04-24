/**
 * Tests for Slack normalizer — London School TDD.
 *
 * Covers: repo resolution, message parsing, metadata extraction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlackEvent } from '../../../src/integration/slack/slack-normalizer';
import type { SlackAppMention, SlackMessage } from '../../../src/integration/slack/types';
import type { WorkflowConfig } from '../../../src/config';

// ---------------------------------------------------------------------------
// Test workflow config
// ---------------------------------------------------------------------------

function makeWorkflowConfig(repos: Record<string, { url: string; defaultBranch: string }>): WorkflowConfig {
  return {
    repos: Object.fromEntries(
      Object.entries(repos).map(([key, val]) => [key, { ...val }]),
    ),
    defaults: {
      agents: { maxConcurrentPerOrg: 8 },
      stall: { timeoutMs: 300_000 },
      polling: { intervalMs: 30_000, enabled: false },
    },
    agents: { maxConcurrent: 8 },
    agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 300_000, maxTurns: 20 },
    polling: { intervalMs: 30_000, enabled: false },
    stall: { timeoutMs: 300_000 },
    agentRunner: { stallTimeoutMs: 300_000, command: 'claude', turnTimeoutMs: 3_600_000 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
    promptTemplate: '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackNormalizer', () => {
  it('should normalize app_mention event and strip bot mention', () => {
    const event: SlackAppMention = {
      type: 'app_mention',
      user: 'U123',
      text: '<@B456> fix the login bug in my-repo',
      ts: '1234567890.123',
      channel: 'C789',
    };
    const config = makeWorkflowConfig({ 'org/my-repo': { url: 'https://github.com/org/my-repo', defaultBranch: 'main' } });

    const result = normalizeSlackEvent(event, config);

    assert.equal(result.source, 'slack');
    assert.equal(result.rawText, 'fix the login bug in my-repo');
    assert.equal(result.sourceMetadata.source, 'slack');
    if (result.sourceMetadata.source === 'slack') {
      assert.equal(result.sourceMetadata.channelId, 'C789');
      assert.equal(result.sourceMetadata.threadTs, '1234567890.123');
      assert.equal(result.sourceMetadata.userId, 'U123');
    }
  });

  it('should resolve repo from explicit "in <repo>" pattern', () => {
    const event: SlackAppMention = {
      type: 'app_mention',
      user: 'U123',
      text: '<@B456> fix the bug in my-repo',
      ts: '1234567890.123',
      channel: 'C789',
    };
    const config = makeWorkflowConfig({
      'org/my-repo': { url: 'https://github.com/org/my-repo', defaultBranch: 'main' },
      'org/other-repo': { url: 'https://github.com/org/other-repo', defaultBranch: 'main' },
    });

    const result = normalizeSlackEvent(event, config);

    assert.equal(result.entities.repo, 'org/my-repo');
  });

  it('should return undefined repo when ambiguous', () => {
    const event: SlackMessage = {
      type: 'message',
      user: 'U123',
      text: 'fix something',
      ts: '1234567890.123',
      channel: 'C789',
    };
    const config = makeWorkflowConfig({
      'org/repo-a': { url: 'https://github.com/org/repo-a', defaultBranch: 'main' },
      'org/repo-b': { url: 'https://github.com/org/repo-b', defaultBranch: 'main' },
    });

    const result = normalizeSlackEvent(event, config);

    assert.equal(result.entities.repo, undefined);
  });

  it('should default to single configured repo', () => {
    const event: SlackMessage = {
      type: 'message',
      user: 'U123',
      text: 'fix something',
      ts: '1234567890.123',
      channel: 'C789',
    };
    const config = makeWorkflowConfig({
      'org/only-repo': { url: 'https://github.com/org/only-repo', defaultBranch: 'main' },
    });

    const result = normalizeSlackEvent(event, config);

    assert.equal(result.entities.repo, 'org/only-repo');
  });

  it('should use thread_ts when present', () => {
    const event: SlackAppMention = {
      type: 'app_mention',
      user: 'U123',
      text: '<@B456> help',
      ts: '111.111',
      channel: 'C789',
      thread_ts: '999.999',
    };
    const config = makeWorkflowConfig({});

    const result = normalizeSlackEvent(event, config);

    if (result.sourceMetadata.source === 'slack') {
      assert.equal(result.sourceMetadata.threadTs, '999.999');
    }
  });

  it('should sanitize dangerous content from message text', () => {
    // HTML comments and invisible Unicode are stripped by sanitize()
    const event: SlackMessage = {
      type: 'message',
      user: 'U123',
      text: 'Hello <!-- hidden injection -->world\u200Bfoo',
      ts: '111.111',
      channel: 'C789',
    };
    const config = makeWorkflowConfig({
      'org/repo': { url: 'https://github.com/org/repo', defaultBranch: 'main' },
    });

    const result = normalizeSlackEvent(event, config);

    assert.ok(!result.rawText.includes('<!--'), `rawText should not contain HTML comments, got: ${result.rawText}`);
    assert.ok(!result.rawText.includes('hidden injection'), `rawText should strip comment content, got: ${result.rawText}`);
    assert.ok(!result.rawText.includes('\u200B'), `rawText should strip zero-width spaces, got: ${result.rawText}`);
    assert.ok(result.rawText.includes('Hello'), 'rawText should preserve safe content');
    assert.ok(result.rawText.includes('worldfoo'), 'rawText should preserve visible content');
  });

  it('should set author from Slack user ID', () => {
    const event: SlackMessage = {
      type: 'message',
      user: 'U_ALICE',
      text: 'deploy latest',
      ts: '111.111',
      channel: 'C789',
    };
    const config = makeWorkflowConfig({});

    const result = normalizeSlackEvent(event, config);

    assert.equal(result.entities.author, 'U_ALICE');
  });
});
