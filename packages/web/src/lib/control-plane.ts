/**
 * Server-only proxy to the orch-agents control plane (`/v1/*`).
 *
 * The bearer token (ORCH_API_TOKEN) NEVER reaches the browser. All calls
 * funnel through Next.js API routes that import this module.
 */

import 'server-only';

const CONTROL_PLANE_URL = process.env.ORCH_API_URL ?? 'http://localhost:3002';
const TOKEN = process.env.ORCH_API_TOKEN ?? '';

if (!TOKEN) {
  // eslint-disable-next-line no-console
  console.warn(
    '[orch-agents/web] ORCH_API_TOKEN is not set — /v1/* requests will return 401. Mint one with `orch-setup mint-token`.',
  );
}

export interface ControlPlaneFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/** Generic fetch helper. Throws on non-2xx unless `acceptStatus` is provided. */
export async function controlPlaneFetch(
  path: string,
  options: ControlPlaneFetchOptions = {},
  acceptStatus: number[] = [],
): Promise<Response> {
  const { body, headers, ...rest } = options;
  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok && !acceptStatus.includes(res.status)) {
    const text = await res.text().catch(() => '');
    throw new Error(`control-plane ${path} returned ${res.status}: ${text}`);
  }
  return res;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await controlPlaneFetch(path);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await controlPlaneFetch(path, { method: 'POST', body });
  return (await res.json()) as T;
}

export async function putJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await controlPlaneFetch(path, { method: 'PUT', body });
  return (await res.json()) as T;
}

export async function deleteRequest(path: string): Promise<void> {
  await controlPlaneFetch(path, { method: 'DELETE' });
}

export const CONTROL_PLANE = CONTROL_PLANE_URL;
export const HAS_TOKEN = Boolean(TOKEN);
