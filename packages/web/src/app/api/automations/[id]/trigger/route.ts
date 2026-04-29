import { NextResponse } from 'next/server';
import { postJson } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const data = await postJson<{ runId: string }>(
      `/v1/automations/${encodeURIComponent(id)}/trigger`,
    );
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
