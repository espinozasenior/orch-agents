/**
 * Tests for Slack webhook handler — London School TDD.
 *
 * Covers: URL verification, event handling, signature verification.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { slackWebhookHandler } from '../../../src/integration/slack/slack-webhook-handler';
import { createEventBus } from '../../../src/kernel/event-bus';
import type { Logger } from '../../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => createTestLogger(),
  } as unknown as Logger;
}

function signPayload(body: string, secret: string, timestamp?: string): { signature: string; ts: string } {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sigBasestring = `v0:${ts}:${body}`;
  const signature = 'v0=' + createHmac('sha256', secret).update(sigBasestring).digest('hex');
  return { signature, ts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackWebhookHandler', () => {
  const SIGNING_SECRET = 'test-signing-secret';
  let eventBus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    eventBus = createEventBus();
  });

  it('should respond to URL verification challenge', async () => {
    const app = Fastify();
    await app.register(slackWebhookHandler, {
      logger: createTestLogger(),
      eventBus,
      slackSigningSecret: SIGNING_SECRET,
    });

    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const { signature, ts } = signPayload(body, SIGNING_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    assert.equal(response.statusCode, 200);
    const result = JSON.parse(response.body);
    assert.equal(result.challenge, 'abc123');

    await app.close();
  });

  it('should reject invalid signature', async () => {
    const app = Fastify();
    await app.register(slackWebhookHandler, {
      logger: createTestLogger(),
      eventBus,
      slackSigningSecret: SIGNING_SECRET,
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', user: 'U1', text: 'hello', ts: '1.1', channel: 'C1' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=invalid',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 401);

    await app.close();
  });

  it('should process app_mention event and publish IntakeCompleted', async () => {
    const app = Fastify();
    await app.register(slackWebhookHandler, {
      logger: createTestLogger(),
      eventBus,
      slackSigningSecret: SIGNING_SECRET,
    });

    let published = false;
    eventBus.subscribe('IntakeCompleted', () => {
      published = true;
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', user: 'U1', text: '<@B1> do something', ts: '1.1', channel: 'C1' },
    });
    const { signature, ts } = signPayload(body, SIGNING_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    assert.equal(response.statusCode, 200);
    assert.ok(published, 'IntakeCompleted event should have been published');

    await app.close();
  });

  it('should reject stale timestamp (>5 minutes old)', async () => {
    const app = Fastify();
    await app.register(slackWebhookHandler, {
      logger: createTestLogger(),
      eventBus,
      slackSigningSecret: SIGNING_SECRET,
    });

    const staleTs = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', user: 'U1', text: 'hello', ts: '1.1', channel: 'C1' },
    });
    const { signature } = signPayload(body, SIGNING_SECRET, staleTs);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': staleTs,
      },
      payload: body,
    });

    assert.equal(response.statusCode, 401);
    const result = JSON.parse(response.body);
    assert.ok(result.error.includes('stale'), 'Error message should mention stale timestamp');

    await app.close();
  });

  it('should reject request missing signature and timestamp headers', async () => {
    const app = Fastify();
    await app.register(slackWebhookHandler, {
      logger: createTestLogger(),
      eventBus,
      slackSigningSecret: SIGNING_SECRET,
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', user: 'U1', text: 'hello', ts: '1.1', channel: 'C1' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/slack',
      headers: {
        'content-type': 'application/json',
        // No x-slack-signature or x-slack-request-timestamp
      },
      payload: body,
    });

    assert.equal(response.statusCode, 401);
    const result = JSON.parse(response.body);
    assert.ok(result.error.includes('Missing'), 'Error message should mention missing signature');

    await app.close();
  });

  it('should skip bot_message subtypes', async () => {
    const app = Fastify();
    await app.register(slackWebhookHandler, {
      logger: createTestLogger(),
      eventBus,
      slackSigningSecret: SIGNING_SECRET,
    });

    let published = false;
    eventBus.subscribe('IntakeCompleted', () => {
      published = true;
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', subtype: 'bot_message', user: 'B1', text: 'bot says', ts: '1.1', channel: 'C1' },
    });
    const { signature, ts } = signPayload(body, SIGNING_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });

    assert.equal(response.statusCode, 200);
    assert.ok(!published, 'Bot messages should not publish IntakeCompleted');

    await app.close();
  });
});
