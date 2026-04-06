/**
 * P6 -- Task Output Writer: JSONL append-only writer with delta reads.
 *
 * Each task's output is written as one JSON object per line to:
 *   {dataDir}/task-output/{taskId}.jsonl
 *
 * Delta reads use byte offsets so consumers only get new data since
 * their last read position.
 */

import { appendFileSync, mkdirSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TaskOutputDelta {
  data: string;
  newOffset: number;
}

export interface TaskOutputWriter {
  /** Append a JSON line to the task's output file. */
  append(taskId: string, data: Record<string, unknown>): void;
  /** Read new bytes from `byteOffset`. Returns data and the new offset. */
  getDelta(taskId: string, byteOffset: number): TaskOutputDelta;
  /** Delete the output file for a task. No-op if file doesn't exist. */
  cleanup(taskId: string): void;
  /** Return the file path for a given taskId. */
  getOutputPath(taskId: string): string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskOutputWriter(opts: { dataDir: string }): TaskOutputWriter {
  const outputDir = join(opts.dataDir, 'task-output');
  let dirEnsured = false;

  function ensureDir(): void {
    if (!dirEnsured) {
      mkdirSync(outputDir, { recursive: true });
      dirEnsured = true;
    }
  }

  function filePath(taskId: string): string {
    // Sanitize taskId to prevent directory traversal
    const safe = taskId.replace(/[^a-zA-Z0-9._-]/g, '-');
    return join(outputDir, `${safe}.jsonl`);
  }

  return {
    append(taskId: string, data: Record<string, unknown>): void {
      ensureDir();
      const line = JSON.stringify({ ...data, timestamp: data.timestamp ?? Date.now() }) + '\n';
      appendFileSync(filePath(taskId), line, 'utf-8');
    },

    getDelta(taskId: string, byteOffset: number): TaskOutputDelta {
      const fp = filePath(taskId);
      try {
        const stat = statSync(fp);
        if (byteOffset >= stat.size) {
          return { data: '', newOffset: byteOffset };
        }
        const buf = Buffer.alloc(stat.size - byteOffset);
        const fd = openSync(fp, 'r');
        try {
          readSync(fd, buf, 0, buf.length, byteOffset);
        } finally {
          closeSync(fd);
        }
        return { data: buf.toString('utf-8'), newOffset: stat.size };
      } catch {
        return { data: '', newOffset: byteOffset };
      }
    },

    cleanup(taskId: string): void {
      try {
        unlinkSync(filePath(taskId));
      } catch {
        // File may not exist; that's fine.
      }
    },

    getOutputPath(taskId: string): string {
      return filePath(taskId);
    },
  };
}
