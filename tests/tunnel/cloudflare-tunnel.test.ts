/**
 * Unit tests for the Cloudflare Quick Tunnel Manager.
 *
 * Mocks `Tunnel.quick()` from the `cloudflared` package to avoid
 * real network calls and binary downloads.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Tunnel } from 'cloudflared';
import { createTunnelManager } from '../../src/tunnel/cloudflare-tunnel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => void;

/** Minimal fake Tunnel that mimics the event-emitter interface + stop(). */
function createFakeTunnel() {
  const listeners: Record<string, EventHandler[]> = {};

  const fake = {
    on(event: string, handler: EventHandler) {
      (listeners[event] ??= []).push(handler);
      return fake;
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of listeners[event] ?? []) h(...args);
    },
    stop: mock.fn(),
  };

  return fake;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudflareTunnelManager', () => {
  let restoreQuick: () => void;

  afterEach(() => {
    restoreQuick?.();
  });

  // -- start(): url event fires -> resolves with URL -----------------------

  it('start() resolves with the public URL when the url event fires', async () => {
    const fake = createFakeTunnel();
    const mockedQuick = mock.method(Tunnel, 'quick', () => fake);
    restoreQuick = () => mockedQuick.mock.restore();

    const mgr = createTunnelManager();
    const startPromise = mgr.start(3000);

    // Simulate cloudflared emitting the url event
    fake.emit('url', 'https://abc123.trycloudflare.com');

    const url = await startPromise;
    assert.equal(url, 'https://abc123.trycloudflare.com');
    assert.equal(mgr.getUrl(), 'https://abc123.trycloudflare.com');
    assert.equal(mockedQuick.mock.callCount(), 1);
    assert.equal(mockedQuick.mock.calls[0].arguments[0], 'http://127.0.0.1:3000');
  });

  // -- start(): error event fires -> rejects --------------------------------

  it('start() rejects when the error event fires', async () => {
    const fake = createFakeTunnel();
    const mockedQuick = mock.method(Tunnel, 'quick', () => fake);
    restoreQuick = () => mockedQuick.mock.restore();

    const mgr = createTunnelManager();
    const startPromise = mgr.start(8080);

    fake.emit('error', new Error('binary download failed'));

    await assert.rejects(startPromise, { message: 'binary download failed' });
  });

  // -- start(): timeout (no events) -> rejects ------------------------------

  it('start() rejects after timeout when no events fire', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    const fake = createFakeTunnel();
    const mockedQuick = mock.method(Tunnel, 'quick', () => fake);
    restoreQuick = () => {
      mockedQuick.mock.restore();
      mock.timers.reset();
    };

    const mgr = createTunnelManager();
    const startPromise = mgr.start(3000);

    // Advance past the 30-second timeout
    mock.timers.tick(30_001);

    await assert.rejects(startPromise, {
      message: 'Tunnel failed to start within 30 seconds',
    });
  });

  // -- stop(): clears state, calls tunnel.stop() ----------------------------

  it('stop() clears url and calls tunnel.stop()', async () => {
    const fake = createFakeTunnel();
    const mockedQuick = mock.method(Tunnel, 'quick', () => fake);
    restoreQuick = () => mockedQuick.mock.restore();

    const mgr = createTunnelManager();
    const startPromise = mgr.start(3000);
    fake.emit('url', 'https://xyz.trycloudflare.com');
    await startPromise;

    assert.equal(mgr.getUrl(), 'https://xyz.trycloudflare.com');

    mgr.stop();

    assert.equal(mgr.getUrl(), null);
    assert.equal(fake.stop.mock.callCount(), 1);
  });

  // -- stop(): double stop is safe (no-op) ----------------------------------

  it('stop() called twice does not throw', async () => {
    const fake = createFakeTunnel();
    const mockedQuick = mock.method(Tunnel, 'quick', () => fake);
    restoreQuick = () => mockedQuick.mock.restore();

    const mgr = createTunnelManager();
    const startPromise = mgr.start(3000);
    fake.emit('url', 'https://xyz.trycloudflare.com');
    await startPromise;

    mgr.stop();
    mgr.stop(); // second call should be a no-op

    assert.equal(fake.stop.mock.callCount(), 1);
    assert.equal(mgr.getUrl(), null);
  });

  // -- getUrl(): returns null before start, URL after -----------------------

  it('getUrl() returns null before start and URL after', async () => {
    const fake = createFakeTunnel();
    const mockedQuick = mock.method(Tunnel, 'quick', () => fake);
    restoreQuick = () => mockedQuick.mock.restore();

    const mgr = createTunnelManager();
    assert.equal(mgr.getUrl(), null);

    const startPromise = mgr.start(3000);
    fake.emit('url', 'https://tunnel.trycloudflare.com');
    await startPromise;

    assert.equal(mgr.getUrl(), 'https://tunnel.trycloudflare.com');
  });

  // -- Crash recovery: exit event -> logs warning ---------------------------

  it('exit event logs a warning and clears state', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });

    const fake = createFakeTunnel();
    // The restart path calls Tunnel.quick again — provide a new fake for that
    const restartFake = createFakeTunnel();
    let callCount = 0;
    const mockedQuick = mock.method(Tunnel, 'quick', () => {
      callCount++;
      return callCount === 1 ? fake : restartFake;
    });
    restoreQuick = () => {
      mockedQuick.mock.restore();
      mock.timers.reset();
    };

    // Capture console.error calls to verify warning
    const errorCalls: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map(String).join(' '));
    };

    const mgr = createTunnelManager();
    const startPromise = mgr.start(3000);

    // The start() timeout fires at 30s — we need to emit 'url' before that
    fake.emit('url', 'https://tunnel.trycloudflare.com');
    await startPromise;

    assert.equal(mgr.getUrl(), 'https://tunnel.trycloudflare.com');

    // Simulate crash: emit exit event
    fake.emit('exit', 1, null);

    // State should be cleared immediately
    assert.equal(mgr.getUrl(), null);

    // Should have logged the crash warning
    const crashLog = errorCalls.find((m) => m.includes('cloudflared crashed'));
    assert.ok(crashLog, 'Expected a crash warning log');
    assert.ok(crashLog.includes('code=1'), 'Log should contain exit code');

    // Should have logged restart attempt
    const restartLog = errorCalls.find((m) => m.includes('Attempting automatic restart'));
    assert.ok(restartLog, 'Expected a restart log');

    console.error = origError;
  });
});
