import { NextResponse } from 'next/server';
import { controlPlaneFetch } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const res = await controlPlaneFetch('/v1/automations', {}, [404]);
    if (res.status === 404) {
      return NextResponse.json({
        automations: [],
        notConfigured: true,
        reason: 'No cron scheduler is configured for this orch-agents instance.',
      });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
