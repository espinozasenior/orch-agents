import type { RunStatus } from '@orch-agents/shared';

const STATUS_STYLES: Record<RunStatus, string> = {
  pending: 'bg-muted/20 text-muted',
  running: 'bg-accent/20 text-accent',
  completed: 'bg-success/20 text-success',
  failed: 'bg-danger/20 text-danger',
  cancelled: 'bg-warning/20 text-warning',
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}
