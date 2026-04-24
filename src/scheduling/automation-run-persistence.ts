/**
 * SQLite persistence for automation run history and state.
 *
 * Follows the same factory + DatabaseSync pattern as oauth-token-persistence.
 * Uses Node 22 built-in node:sqlite (no external deps).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../shared/sqlite';
import type { Logger } from '../shared/logger';
import type { AutomationState } from './automation-state-machine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutomationRun {
  runId: string;
  automationId: string;
  repoName: string;
  trigger: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  durationMs?: number;
  error?: string;
  output?: string;
}

export interface AutomationRunPersistence {
  saveRun(run: AutomationRun): void;
  loadState(automationId: string): AutomationState | undefined;
  saveState(state: AutomationState): void;
  getRunHistory(automationId: string, limit?: number): AutomationRun[];
  close(): void;
}

export interface AutomationRunPersistenceDeps {
  dbPath?: string;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAutomationRunPersistence(
  deps: AutomationRunPersistenceDeps = {},
): AutomationRunPersistence {
  const dbPath = deps.dbPath ?? './data/automation-runs.db';
  const logger = deps.logger;

  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER,
      error TEXT,
      output TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_state (
      automation_id TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      paused_at TEXT,
      last_run_at TEXT
    )
  `);

  const saveRunStmt = db.prepare(`
    INSERT INTO automation_runs (run_id, automation_id, repo_name, trigger_type, status, started_at, duration_ms, error, output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status = excluded.status,
      duration_ms = excluded.duration_ms,
      error = excluded.error,
      output = excluded.output
  `);

  const loadStateStmt = db.prepare(
    'SELECT automation_id, consecutive_failures, paused, paused_at, last_run_at FROM automation_state WHERE automation_id = ?',
  );

  const saveStateStmt = db.prepare(`
    INSERT INTO automation_state (automation_id, consecutive_failures, paused, paused_at, last_run_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(automation_id) DO UPDATE SET
      consecutive_failures = excluded.consecutive_failures,
      paused = excluded.paused,
      paused_at = excluded.paused_at,
      last_run_at = excluded.last_run_at
  `);

  const getHistoryStmt = db.prepare(
    'SELECT run_id, automation_id, repo_name, trigger_type, status, started_at, duration_ms, error, output FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?',
  );

  logger?.info('Automation run persistence initialized', { dbPath });

  return {
    saveRun(run: AutomationRun): void {
      saveRunStmt.run(
        run.runId,
        run.automationId,
        run.repoName,
        run.trigger,
        run.status,
        run.startedAt,
        run.durationMs ?? null,
        run.error ?? null,
        run.output ?? null,
      );
    },

    loadState(automationId: string): AutomationState | undefined {
      const row = loadStateStmt.get(automationId) as {
        automation_id: string;
        consecutive_failures: number;
        paused: number;
        paused_at: string | null;
        last_run_at: string | null;
      } | undefined;

      if (!row) return undefined;

      return {
        automationId: row.automation_id,
        consecutiveFailures: row.consecutive_failures,
        paused: row.paused === 1,
        ...(row.paused_at ? { pausedAt: row.paused_at } : {}),
        ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
      };
    },

    saveState(state: AutomationState): void {
      saveStateStmt.run(
        state.automationId,
        state.consecutiveFailures,
        state.paused ? 1 : 0,
        state.pausedAt ?? null,
        state.lastRunAt ?? null,
      );
    },

    getRunHistory(automationId: string, limit = 20): AutomationRun[] {
      const rows = getHistoryStmt.all(automationId, limit) as Array<{
        run_id: string;
        automation_id: string;
        repo_name: string;
        trigger_type: string;
        status: string;
        started_at: string;
        duration_ms: number | null;
        error: string | null;
        output: string | null;
      }>;

      return rows.map((row) => ({
        runId: row.run_id,
        automationId: row.automation_id,
        repoName: row.repo_name,
        trigger: row.trigger_type,
        status: row.status as AutomationRun['status'],
        startedAt: row.started_at,
        ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.output ? { output: row.output } : {}),
      }));
    },

    close(): void {
      db.close();
    },
  };
}
