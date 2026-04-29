'use client';

import useSWR from 'swr';
import { useState } from 'react';
import type { SecretMetaDto } from '@orch-agents/shared';
import { jsonFetcher } from '@/lib/swr-fetcher';
import { ConfirmMutationModal } from '@/components/confirm-mutation-modal';

export default function SecretsPage() {
  const { data, error, isLoading, mutate } = useSWR<{
    secrets: SecretMetaDto[];
    notConfigured?: boolean;
    reason?: string;
  }>('/api/secrets', jsonFetcher);
  const [draft, setDraft] = useState({ key: '', value: '', scope: 'global' as 'global' | 'repo', repo: '' });
  const [pending, setPending] = useState<
    | { kind: 'set'; key: string; scope: 'global' | 'repo'; repo: string; value: string; existed: boolean }
    | { kind: 'delete'; key: string; scope: 'global' | 'repo'; repo: string }
    | null
  >(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  function startSet(): void {
    if (!draft.key || !draft.value) return;
    const existed = (data?.secrets ?? []).some(
      (s) => s.key === draft.key && s.scope === draft.scope && (s.repo ?? '') === (draft.repo ?? ''),
    );
    setPending({ kind: 'set', key: draft.key, scope: draft.scope, repo: draft.repo, value: draft.value, existed });
  }

  function startDelete(s: SecretMetaDto): void {
    setPending({ kind: 'delete', key: s.key, scope: s.scope, repo: s.repo ?? '' });
  }

  async function commit(): Promise<void> {
    if (!pending) return;
    try {
      if (pending.kind === 'set') {
        const body = { value: pending.value, scope: pending.scope, ...(pending.scope === 'repo' ? { repo: pending.repo } : {}) };
        const res = await fetch(`/api/secrets/${encodeURIComponent(pending.key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        setFeedback(`Saved ${pending.key}`);
        setDraft({ key: '', value: '', scope: 'global', repo: '' });
      } else {
        const qs = new URLSearchParams({ scope: pending.scope });
        if (pending.repo) qs.set('repo', pending.repo);
        const res = await fetch(`/api/secrets/${encodeURIComponent(pending.key)}?${qs.toString()}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(await res.text());
        setFeedback(`Deleted ${pending.key}`);
      }
      await mutate();
    } catch (err) {
      setFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="px-8 py-6">
      <header className="mb-6">
        <h2 className="text-2xl font-semibold">Secrets</h2>
        <p className="text-xs text-muted">
          Encrypted secrets injected into agent runs. Mutations require a 5-second confirmation.
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
        <div className="mb-6 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          <div className="font-semibold">Secret store not configured</div>
          <div className="mt-1 text-xs">{data.reason}</div>
        </div>
      )}

      <fieldset
        disabled={data?.notConfigured}
        className="mb-6 rounded-md border border-border bg-surface p-4 disabled:opacity-50"
      >
        <h3 className="mb-3 text-sm font-semibold">Add or update</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto_1fr_auto]">
          <input
            value={draft.key}
            onChange={(e) => setDraft({ ...draft, key: e.target.value })}
            placeholder="KEY"
            className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm"
          />
          <input
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            placeholder="value"
            type="password"
            className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm"
          />
          <select
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as 'global' | 'repo' })}
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm"
          >
            <option value="global">global</option>
            <option value="repo">repo</option>
          </select>
          {draft.scope === 'repo' && (
            <input
              value={draft.repo}
              onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
              placeholder="owner/repo"
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm"
            />
          )}
          <button
            onClick={startSet}
            disabled={!draft.key || !draft.value || (draft.scope === 'repo' && !draft.repo)}
            className="rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            Save…
          </button>
        </div>
      </fieldset>

      {isLoading && <div className="text-sm text-muted">Loading…</div>}
      {data && (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {data.secrets.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted">No secrets yet</li>
          )}
          {data.secrets.map((s) => (
            <li
              key={`${s.scope}:${s.repo ?? ''}:${s.key}`}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="font-mono text-sm">{s.key}</div>
                <div className="text-xs text-muted">
                  {s.scope}
                  {s.repo && ` · ${s.repo}`} · updated {new Date(s.updatedAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => startDelete(s)}
                className="rounded-md border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10"
              >
                Delete…
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending && (
        <ConfirmMutationModal
          title={pending.kind === 'set' ? 'Confirm secret write' : 'Confirm secret delete'}
          body={
            <div className="space-y-1 font-mono text-xs">
              <div>key: {pending.key}</div>
              <div>scope: {pending.scope}</div>
              {pending.scope === 'repo' && pending.repo && <div>repo: {pending.repo}</div>}
              {pending.kind === 'set' && (
                <div className="mt-2 text-text/70">
                  This will {pending.existed ? 'overwrite the existing value' : 'create a new entry'}. The
                  audit log will record only SHA-256 hashes — never the plaintext.
                </div>
              )}
              {pending.kind === 'delete' && (
                <div className="mt-2 text-text/70">
                  Deletion is irreversible. The audit log will record the action with a hash of the
                  prior value.
                </div>
              )}
            </div>
          }
          onConfirm={commit}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
