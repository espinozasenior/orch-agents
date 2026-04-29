import { NextResponse } from 'next/server';
import { controlPlaneFetch } from '@/lib/control-plane';
import type { SecretMetaDto } from '@orch-agents/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    const repo = url.searchParams.get('repo');
    const qs = new URLSearchParams();
    if (scope) qs.set('scope', scope);
    if (repo) qs.set('repo', repo);
    const path = `/v1/secrets${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await controlPlaneFetch(path, {}, [404]);
    if (res.status === 404) {
      // Secrets surface isn't mounted (SECRETS_MASTER_KEY not set in API .env).
      // Don't 502 the UI — surface configuration status instead.
      return NextResponse.json({
        secrets: [] as SecretMetaDto[],
        notConfigured: true,
        reason: 'SECRETS_MASTER_KEY is not set in the API .env. Add it and restart the API.',
      });
    }
    const data = (await res.json()) as { secrets: SecretMetaDto[] };
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
