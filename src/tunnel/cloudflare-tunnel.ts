/**
 * Cloudflare Quick Tunnel Manager.
 *
 * Starts a Cloudflare Quick Tunnel (no account required) that
 * creates a publicly accessible URL pointing to the local server.
 * Uses the `cloudflared` npm package which handles binary download.
 */

import { Tunnel } from 'cloudflared';

export interface TunnelManager {
  /** Start the tunnel. Returns the public URL. */
  start(localPort: number): Promise<string>;
  /** Stop the tunnel process. */
  stop(): void;
  /** Get the current tunnel URL, or null if not started. */
  getUrl(): string | null;
}

export function createTunnelManager(): TunnelManager {
  let publicUrl: string | null = null;
  let activeTunnel: Tunnel | null = null;
  let hasAttemptedRestart = false;

  function attachCrashHandlers(t: Tunnel, localPort: number): void {
    t.on('exit', (code, signal) => {
      // Ignore clean exits triggered by stop()
      if (!activeTunnel) return;

      const deadUrl = publicUrl;
      publicUrl = null;
      activeTunnel = null;

      console.error(
        `[tunnel] cloudflared crashed (code=${code}, signal=${signal}), url=${deadUrl}`,
      );

      if (!hasAttemptedRestart) {
        hasAttemptedRestart = true;
        console.error('[tunnel] Attempting automatic restart in 5 seconds...');
        setTimeout(() => {
          const restart = Tunnel.quick(`http://127.0.0.1:${localPort}`);
          activeTunnel = restart;

          restart.on('url', (url: string) => {
            publicUrl = url;
            console.error(`[tunnel] Restarted successfully, new url=${url}`);
          });

          restart.on('error', (err: Error) => {
            console.error('[tunnel] Restart failed:', err.message);
            publicUrl = null;
            activeTunnel = null;
          });

          attachCrashHandlers(restart, localPort);
        }, 5_000);
      }
    });

    t.on('error', (err: Error) => {
      console.error('[tunnel] cloudflared runtime error:', err.message);
    });
  }

  return {
    async start(localPort: number): Promise<string> {
      const t = Tunnel.quick(`http://127.0.0.1:${localPort}`);
      activeTunnel = t;
      hasAttemptedRestart = false;

      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Tunnel failed to start within 30 seconds'));
        }, 30_000);

        t.on('url', (url: string) => {
          clearTimeout(timeout);
          publicUrl = url;
          attachCrashHandlers(t, localPort);
          resolve(url);
        });

        t.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    },

    stop(): void {
      if (activeTunnel) {
        const t = activeTunnel;
        activeTunnel = null;
        publicUrl = null;
        t.stop();
      }
    },

    getUrl(): string | null {
      return publicUrl;
    },
  };
}
