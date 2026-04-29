import { NextResponse } from 'next/server';
import { getJson } from '@/lib/control-plane';
import type { RunSummaryDto } from '@orch-agents/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ planId: string }> },
): Promise<NextResponse> {
  try {
    const { planId } = await context.params;
    const data = await getJson<RunSummaryDto>(`/v1/runs/${encodeURIComponent(planId)}`);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
