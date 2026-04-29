import { controlPlaneFetch } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SSE proxy: streams `/v1/runs/:planId/events` straight back to the browser.
 * Forwards `Last-Event-ID` so reconnection / replay works.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ planId: string }> },
): Promise<Response> {
  const { planId } = await context.params;
  const lastEventId = request.headers.get('last-event-id');
  const upstream = await controlPlaneFetch(
    `/v1/runs/${encodeURIComponent(planId)}/events`,
    {
      method: 'GET',
      headers: lastEventId ? { 'last-event-id': lastEventId } : undefined,
    },
  );

  // Pipe the upstream stream straight through. The Node runtime keeps the
  // connection open as long as the client is reading.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
