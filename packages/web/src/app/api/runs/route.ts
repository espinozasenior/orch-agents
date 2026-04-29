import { NextResponse } from 'next/server';
import { getJson } from '@/lib/control-plane';
import type { RunSummaryDto } from '@orch-agents/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const data = await getJson<{ runs: RunSummaryDto[] }>('/v1/runs');
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
