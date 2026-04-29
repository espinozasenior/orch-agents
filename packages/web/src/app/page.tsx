'use client';

import Link from 'next/link';
import useSWR from 'swr';
import type { RunSummaryDto } from '@orch-agents/shared';
import { jsonFetcher } from '@/lib/swr-fetcher';
import { RunStatusBadge } from '@/components/run-status-badge';

export default function RunsPage() {
  const { data, error, isLoading } = useSWR<{ runs: RunSummaryDto[] }>(
    '/api/runs',
    jsonFetcher,
    { refreshInterval: 5000 },
  );

  return (
    <div className="px-8 py-6">
      <header className="mb-6 flex items-baseline justify-between">
        <h2 className="text-2xl font-semibold">Runs</h2>
        <span className="text-xs text-muted">refreshes every 5s</span>
      </header>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Failed to load runs: {error.message}
        </div>
      )}

      {isLoading && <div className="text-sm text-muted">Loading…</div>}

      {data && data.runs.length === 0 && (
        <div className="rounded-md border border-border bg-surface p-8 text-center text-muted">
          No runs yet. Trigger a webhook to see one appear here.
        </div>
      )}

      {data && data.runs.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {data.runs.map((run) => (
            <li key={run.correlationId}>
              <Link
                href={`/runs/${encodeURIComponent(run.planId ?? run.correlationId)}`}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-border/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <RunStatusBadge status={run.status} />
                    <span className="truncate font-medium">{run.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {run.source} · started {new Date(run.startedAt).toLocaleTimeString()}
                    {run.durationMs && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
                    {run.failureReason && ` · ${run.failureReason}`}
                  </div>
                </div>
                <div className="text-xs text-muted">
                  {run.phases.length} phase{run.phases.length === 1 ? '' : 's'} ·{' '}
                  {run.agents.length} agent{run.agents.length === 1 ? '' : 's'}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
