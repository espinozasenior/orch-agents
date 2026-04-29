import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_URL = process.env.ORCH_ADMIN_URL ?? 'http://127.0.0.1:3001';

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const res = await fetch(`${ADMIN_URL}/admin/web-tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.status === 204) return new NextResponse(null, { status: 204 });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
