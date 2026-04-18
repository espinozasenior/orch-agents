import { watch, readFileSync, type FSWatcher } from 'node:fs';
import type { Logger } from '../../shared/logger';
import { parseWorkflowMd, type WorkflowConfig } from '../../config';

export interface WorkflowConfigStoreDeps {
  filePath: string;
  logger: Logger;
  watchFile?: boolean;
}

export interface WorkflowConfigSnapshot {
  readonly filePath: string;
  readonly valid: boolean;
  readonly config?: WorkflowConfig;
  readonly error?: string;
  readonly loadedAt?: string;
}

export interface WorkflowConfigStore {
  start(): void;
  stop(): void;
  reload(): WorkflowConfigSnapshot;
  getSnapshot(): WorkflowConfigSnapshot;
  requireConfig(): WorkflowConfig;
}

export function createWorkflowConfigStore(deps: WorkflowConfigStoreDeps): WorkflowConfigStore {
  const logger = deps.logger.child({ module: 'workflow-config-store' });
  let watcher: FSWatcher | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: WorkflowConfigSnapshot = loadSnapshot(deps.filePath);
  let lastKnownGoodConfig: WorkflowConfig | undefined = snapshot.config;
  let lastKnownGoodLoadedAt: string | undefined = snapshot.loadedAt;
  let lastFileHash: string | undefined;

  function loadSnapshot(filePath: string): WorkflowConfigSnapshot {
    try {
      const config = parseWorkflowMd(filePath);
      return {
        filePath,
        valid: true,
        config,
        loadedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        filePath,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function applyReload(reason: 'startup' | 'manual' | 'watch'): WorkflowConfigSnapshot {
    const nextSnapshot = loadSnapshot(deps.filePath);
    if (nextSnapshot.valid && nextSnapshot.config) {
      lastKnownGoodConfig = nextSnapshot.config;
      lastKnownGoodLoadedAt = nextSnapshot.loadedAt;
      snapshot = nextSnapshot;
    } else if (lastKnownGoodConfig) {
      snapshot = {
        filePath: deps.filePath,
        valid: true,
        config: lastKnownGoodConfig,
        loadedAt: lastKnownGoodLoadedAt,
        error: nextSnapshot.error,
      };
    } else {
      snapshot = nextSnapshot;
    }

    if (nextSnapshot.valid) {
      logger.info('Loaded WORKFLOW.md', {
        reason,
        path: deps.filePath,
        loadedAt: nextSnapshot.loadedAt,
        repos: Object.keys(nextSnapshot.config?.repos ?? {}),
      });
    } else {
      logger.warn('WORKFLOW.md reload failed; keeping last-known-good config', {
        reason,
        path: deps.filePath,
        error: nextSnapshot.error,
      });
    }

    return snapshot;
  }

  function computeFileHash(): string | undefined {
    try {
      const content = readFileSync(deps.filePath, 'utf-8');
      // Simple hash: length + first/last 200 chars. Fast, sufficient for change detection.
      return `${content.length}:${content.slice(0, 200)}:${content.slice(-200)}`;
    } catch {
      return undefined;
    }
  }

  function scheduleReload(): void {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      // Skip reload if file content hasn't changed
      const currentHash = computeFileHash();
      if (currentHash && currentHash === lastFileHash) {
        return;
      }
      lastFileHash = currentHash;
      applyReload('watch');
    }, 2000);

    if (reloadTimer.unref) {
      reloadTimer.unref();
    }
  }

  return {
    start(): void {
      snapshot = applyReload('startup');
      lastFileHash = computeFileHash();
      if (!deps.watchFile) {
        return;
      }

      watcher = watch(deps.filePath, () => {
        scheduleReload();
      });
    },

    stop(): void {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = undefined;
      }
      watcher?.close();
      watcher = undefined;
    },

    reload(): WorkflowConfigSnapshot {
      return applyReload('manual');
    },

    getSnapshot(): WorkflowConfigSnapshot {
      return snapshot;
    },

    requireConfig(): WorkflowConfig {
      if (!snapshot.valid || !snapshot.config) {
        throw new Error(snapshot.error ?? 'WORKFLOW.md is invalid');
      }
      return snapshot.config;
    },
  };
}
