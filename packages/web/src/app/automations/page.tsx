'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { jsonFetcher } from '@/lib/swr-fetcher';

interface SchedulerSnapshot {
  automations: Array<{
    repoName: string;
    name: string;
    schedule?: string;
    trigger?: string;
    state: { consecutiveFailures: number; paused: boolean; pausedAt?: string };
  }>;
  notConfigured?: boolean;
  reason?: string;
}

export default function AutomationsPage() {
  const { data, error, isLoading, mutate } = useSWR<SchedulerSnapshot>(
    '/api/automations',
    jsonFetcher,
    { refreshInterval: 5000 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function trigger(automationId: string): Promise<void> {
    setBusy(automationId);
    setFeedback(null);
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(automationId)}/trigger`, {
        method: 'POST',
      });
      const body = await res.json();
      if (!res.ok) {
        setFeedback(`Trigger failed: ${body.error ?? res.status}`);
      } else {
        setFeedback(`Triggered — runId ${body.runId}`);
        await mutate();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-8 py-6">
      <header className="mb-6">
        <h2 className="text-2xl font-semibold">Automations</h2>
        <p className="text-xs text-muted">
          Cron + webhook + manual triggers for the configured automations
        </p>
      </header>

      {feedback && (
        <div className="mb-4 rounded-md border border-accent/40 bg-accent/10 p-3 text-sm text-accent">
          {feedback}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error.message}
        </div>
      )}
      {data?.notConfigured && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          <div className="font-semibold">No cron scheduler configured</div>
          <div className="mt-1 text-xs">{data.reason}</div>
        </div>
      )}
      {isLoading && <div className="text-sm text-muted">Loading…</div>}

      {data && data.automations.length === 0 && (
        <div className="rounded-md border border-border bg-surface p-8 text-center text-muted">
          No automations configured. Add some in WORKFLOW.md.
        </div>
      )}

      {data && data.automations.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {data.automations.map((a) => {
            const id = `${a.repoName}/${a.name}`;
            return (
              <li key={id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted">
                    {a.repoName} · {a.schedule ?? a.trigger ?? 'manual'}
                    {a.state.paused && ` · PAUSED (${a.state.consecutiveFailures} consecutive failures)`}
                  </div>
                </div>
                <button
                  onClick={() => trigger(id)}
                  disabled={busy === id}
                  className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
                >
                  {busy === id ? 'Triggering…' : 'Trigger now'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
