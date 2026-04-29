'use client';

import useSWR from 'swr';
import { useState } from 'react';
import type { WebTokenSummaryDto } from '@orch-agents/shared';
import { jsonFetcher } from '@/lib/swr-fetcher';
import { ConfirmMutationModal } from '@/components/confirm-mutation-modal';

const ALL_SCOPES = [
  'runs:read',
  'automations:write',
  'secrets:read',
  'secrets:write',
  'workflow:read',
] as const;

interface MintedToken {
  id: string;
  token: string;
  label: string;
  scopes: string[];
  createdAt: string;
}

export default function TokensPage() {
  const { data, error, mutate } = useSWR<{ tokens: WebTokenSummaryDto[] }>(
    '/api/web-tokens',
    jsonFetcher,
  );
  const [draft, setDraft] = useState({ label: '', scopes: new Set<string>(['runs:read']) });
  const [justMinted, setJustMinted] = useState<MintedToken | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; label: string; typed: string } | null>(null);

  function toggleScope(scope: string): void {
    const next = new Set(draft.scopes);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    setDraft({ ...draft, scopes: next });
  }

  async function mint(): Promise<void> {
    const res = await fetch('/api/web-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: draft.label, scopes: [...draft.scopes] }),
    });
    const body = await res.json();
    if (!res.ok) {
      alert(body.error ?? 'mint failed');
      return;
    }
    setJustMinted(body as MintedToken);
    setDraft({ label: '', scopes: new Set(['runs:read']) });
    await mutate();
  }

  async function revoke(): Promise<void> {
    if (!revoking || revoking.typed !== revoking.label) return;
    await fetch(`/api/web-tokens/${encodeURIComponent(revoking.id)}`, { method: 'DELETE' });
    setRevoking(null);
    await mutate();
  }

  return (
    <div className="px-8 py-6">
      <header className="mb-6">
        <h2 className="text-2xl font-semibold">Web API Tokens</h2>
        <p className="text-xs text-muted">
          Bearer tokens for the /v1/* API. Minted tokens display once — copy them immediately.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error.message}
        </div>
      )}

      <div className="mb-6 rounded-md border border-border bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Mint new token</h3>
        <div className="grid grid-cols-1 gap-3">
          <input
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            placeholder="label (e.g. ‘web-bff-prod’)"
            className="rounded-md border border-border bg-bg px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {ALL_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={draft.scopes.has(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span className="font-mono">{scope}</span>
              </label>
            ))}
          </div>
          <button
            onClick={mint}
            disabled={!draft.label || draft.scopes.size === 0}
            className="self-start rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            Mint token
          </button>
        </div>
      </div>

      <ul className="divide-y divide-border rounded-md border border-border bg-surface">
        {(data?.tokens ?? []).length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted">No tokens yet</li>
        )}
        {(data?.tokens ?? []).map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="font-medium">{t.label}</div>
              <div className="text-xs text-muted">
                <span className="font-mono">{t.scopes.join(', ')}</span> · created{' '}
                {new Date(t.createdAt).toLocaleString()} · last used{' '}
                {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}
              </div>
            </div>
            <button
              onClick={() => setRevoking({ id: t.id, label: t.label, typed: '' })}
              className="rounded-md border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10"
            >
              Revoke…
            </button>
          </li>
        ))}
      </ul>

      {justMinted && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-xl rounded-md border border-warning/40 bg-surface p-6 shadow-xl">
            <h3 className="mb-3 text-lg font-semibold text-warning">
              Token minted — copy it now
            </h3>
            <p className="mb-3 text-xs text-muted">
              This is the only time you will see this value. Store it in your secrets manager
              before closing this dialog.
            </p>
            <pre className="mb-4 overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-sm">
              {justMinted.token}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => navigator.clipboard.writeText(justMinted.token)}
                className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
              >
                Copy
              </button>
              <button
                onClick={() => setJustMinted(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-border/30"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {revoking && (
        <ConfirmMutationModal
          title={`Revoke token "${revoking.label}"?`}
          body={
            <div className="space-y-2 text-sm">
              <p>
                This is irreversible. Any process using this token will get 401s on the next
                request.
              </p>
              <label className="block text-xs">
                Type the label <code className="font-mono">{revoking.label}</code> to confirm:
              </label>
              <input
                value={revoking.typed}
                onChange={(e) => setRevoking({ ...revoking, typed: e.target.value })}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm"
              />
            </div>
          }
          onConfirm={revoke}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
