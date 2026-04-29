import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_URL = process.env.ORCH_ADMIN_URL ?? 'http://127.0.0.1:3001';

/**
 * Token CRUD goes through the *admin* surface (127.0.0.1-only) so the web
 * app process must be co-located with the api or have a reverse-tunnel.
 * We don't proxy this through the bearer-protected /v1/* surface because
 * mint/revoke is intentionally a higher-trust action.
 */

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${ADMIN_URL}/admin/web-tokens`, { cache: 'no-store' });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const payload = await request.json();
    const res = await fetch(`${ADMIN_URL}/admin/web-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
