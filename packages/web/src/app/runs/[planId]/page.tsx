'use client';

import { use, useMemo } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { RunSummaryDto } from '@orch-agents/shared';
import { jsonFetcher } from '@/lib/swr-fetcher';
import { useRunStream, type RunStreamEvent } from '@/hooks/use-run-stream';
import { RunStatusBadge } from '@/components/run-status-badge';

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ planId: string }>;
}) {
  const { planId } = use(params);
  const { data, error, isLoading } = useSWR<RunSummaryDto>(
    `/api/runs/${encodeURIComponent(planId)}`,
    jsonFetcher,
  );
  const { status, events, gap, droppedCount } = useRunStream(planId);

  const liveAgentTimeline = useMemo(() => buildAgentTimeline(events), [events]);

  return (
    <div className="px-8 py-6">
      <Link href="/" className="text-xs text-muted hover:text-text">
        ← all runs
      </Link>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          Failed to load run: {error.message}
        </div>
      )}
      {isLoading && <div className="mt-4 text-sm text-muted">Loading…</div>}

      {data && (
        <>
          <header className="mt-3 flex items-baseline gap-3">
            <h2 className="text-2xl font-semibold">{data.title}</h2>
            <RunStatusBadge status={data.status} />
          </header>
          <div className="mt-1 text-xs text-muted">
            {data.source} · {data.repo ?? '—'} · started{' '}
            {new Date(data.startedAt).toLocaleString()}
            {data.durationMs && ` · ${(data.durationMs / 1000).toFixed(1)}s total`}
          </div>

          {(gap || droppedCount > 0) && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              {gap && (
                <div>
                  History truncated — server retains events {gap.currentMinId} onward, you last
                  saw {gap.lastSeenId}. <button onClick={() => window.location.reload()} className="underline">Refresh to resync</button>
                </div>
              )}
              {droppedCount > 0 && (
                <div>{droppedCount} event(s) dropped under load on this connection.</div>
              )}
            </div>
          )}

          <div className="mt-3 text-xs text-muted">
            stream:{' '}
            <span className={status === 'open' ? 'text-success' : status === 'error' ? 'text-danger' : 'text-muted'}>
              {status}
            </span>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
                Live timeline
              </h3>
              <ol className="space-y-2 rounded-md border border-border bg-surface p-4">
                {events.length === 0 && (
                  <li className="text-sm text-muted">
                    Waiting for events… (this run may have already completed before you opened
                    the page; the snapshot above shows the final state)
                  </li>
                )}
                {events.map((event) => (
                  <li key={event.seq} className="font-mono text-xs">
                    <span className="text-muted">#{event.seq}</span>{' '}
                    <span className="text-accent">{event.type}</span>{' '}
                    <span className="text-muted">{summarizeEvent(event)}</span>
                  </li>
                ))}
              </ol>
            </section>

            <aside className="space-y-6">
              <SummarySection title="Phases">
                {data.phases.length === 0 && <Empty>No phases yet</Empty>}
                {data.phases.map((phase) => (
                  <li key={phase.phaseId} className="text-xs">
                    <span className="font-medium">{phase.phaseType}</span>{' '}
                    <span className="text-muted">— {phase.status}</span>
                    {phase.durationMs !== undefined && (
                      <span className="text-muted"> · {(phase.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </li>
                ))}
              </SummarySection>

              <SummarySection title="Agents">
                {data.agents.length === 0 && liveAgentTimeline.length === 0 && (
                  <Empty>No agent activity yet</Empty>
                )}
                {(data.agents.length > 0 ? data.agents : liveAgentTimeline).map((agent) => (
                  <li key={agent.execId} className="text-xs">
                    <span className="font-medium">{agent.agentRole}</span>{' '}
                    <span className="text-muted">— {agent.status}</span>
                    {agent.durationMs !== undefined && (
                      <span className="text-muted"> · {(agent.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </li>
                ))}
              </SummarySection>

              {data.failureReason && (
                <SummarySection title="Failure">
                  <li className="text-xs text-danger">{data.failureReason}</li>
                </SummarySection>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="space-y-1 rounded-md border border-border bg-surface px-3 py-2">{children}</ul>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li className="text-xs text-muted">{children}</li>;
}

function summarizeEvent(event: RunStreamEvent): string {
  const data = event.data as { payload?: Record<string, unknown> } | null;
  const payload = data?.payload;
  if (!payload) return '';
  if ('agentRole' in payload) return String(payload.agentRole);
  if ('phaseType' in payload) return String(payload.phaseType);
  if ('failureReason' in payload) return String(payload.failureReason);
  if ('totalDuration' in payload) return `${(Number(payload.totalDuration) / 1000).toFixed(1)}s`;
  return '';
}

function buildAgentTimeline(events: RunStreamEvent[]) {
  // Reconstruct an agent list from the live event stream when the snapshot
  // hasn't caught up yet (the SSE feed beats SWR's polled view).
  const agents = new Map<string, { execId: string; agentRole: string; status: string; durationMs?: number }>();
  for (const event of events) {
    const payload = (event.data as { payload?: Record<string, unknown> } | null)?.payload;
    if (!payload || !('execId' in payload)) continue;
    const execId = String(payload.execId);
    const role = String(payload.agentRole ?? 'agent');
    const existing = agents.get(execId) ?? { execId, agentRole: role, status: 'spawned' };
    if (event.type === 'AgentSpawned') existing.status = 'spawned';
    if (event.type === 'AgentCompleted') {
      existing.status = 'completed';
      if ('duration' in payload) existing.durationMs = Number(payload.duration);
    }
    if (event.type === 'AgentFailed') existing.status = 'failed';
    if (event.type === 'AgentCancelled') existing.status = 'cancelled';
    agents.set(execId, existing);
  }
  return [...agents.values()];
}
