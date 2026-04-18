/**
 * Cloudflare Quick Tunnel Manager.
 *
 * Starts a Cloudflare Quick Tunnel (no account required) that
 * creates a publicly accessible URL pointing to the local server.
 * Uses the `cloudflared` npm package which handles binary download.
 */

import { Tunnel, type Connection } from 'cloudflared';

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
  const connections: Connection[] = [];

  return {
    async start(localPort: number): Promise<string> {
      const t = Tunnel.quick(`http://127.0.0.1:${localPort}`);
      activeTunnel = t;

      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Tunnel failed to start within 30 seconds'));
        }, 30_000);

        t.on('url', (url: string) => {
          clearTimeout(timeout);
          publicUrl = url;
          resolve(url);
        });

        t.on('connected', (conn: Connection) => {
          connections.push(conn);
        });

        t.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    },

    stop(): void {
      if (activeTunnel) {
        activeTunnel.stop();
        activeTunnel = null;
        publicUrl = null;
        connections.length = 0;
      }
    },

    getUrl(): string | null {
      return publicUrl;
    },
  };
}
