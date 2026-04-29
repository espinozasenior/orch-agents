import { NextResponse } from 'next/server';
import { putJson, controlPlaneFetch } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PutBody {
  value?: string;
  scope?: 'global' | 'repo';
  repo?: string;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  try {
    const { key } = await context.params;
    const body = (await request.json()) as PutBody;
    const data = await putJson<unknown>(`/v1/secrets/${encodeURIComponent(key)}`, body);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<NextResponse> {
  try {
    const { key } = await context.params;
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    const repo = url.searchParams.get('repo');
    if (!scope) {
      return NextResponse.json({ error: 'scope is required' }, { status: 400 });
    }
    const qs = new URLSearchParams({ scope });
    if (repo) qs.set('repo', repo);
    await controlPlaneFetch(`/v1/secrets/${encodeURIComponent(key)}?${qs.toString()}`, {
      method: 'DELETE',
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
