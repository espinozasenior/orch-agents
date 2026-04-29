'use client';

import { useEffect, useState } from 'react';

export interface ConfirmMutationModalProps {
  title: string;
  /** Lines of human-readable diff (key/scope before/after, hashes only — never plaintext). */
  body: React.ReactNode;
  cooldownSeconds?: number;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Friction layer for high-risk mutations (secrets, token revoke).
 * The Confirm button is disabled for `cooldownSeconds` (default 5s) with a
 * visible countdown to prevent reflexive click-through.
 */
export function ConfirmMutationModal({
  title,
  body,
  cooldownSeconds = 5,
  onConfirm,
  onCancel,
}: ConfirmMutationModalProps) {
  const [secondsLeft, setSecondsLeft] = useState(cooldownSeconds);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-lg rounded-md border border-border bg-surface p-6 shadow-xl">
        <h3 className="mb-3 text-lg font-semibold">{title}</h3>
        <div className="mb-6 text-sm text-text/90">{body}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-border/30"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={secondsLeft > 0}
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {secondsLeft > 0 ? `Confirm (${secondsLeft}s)` : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
