/**
 * Phase 9G -- DiskResultCache: spill large tool results to temp files.
 *
 * When a tool result exceeds 1 MB (1_048_576 bytes), it is serialized
 * to a temp file and a SpilledResult reference is returned instead.
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolResult } from './types';
import type { SpilledResult } from './deferredTypes';

const SPILL_THRESHOLD = 1_048_576; // 1 MB

export class DiskResultCache {
  private readonly cacheDir: string;
  private readonly files: string[] = [];

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? join(tmpdir(), 'orch-agents-tool-results');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Returns true when the result content exceeds the 1 MB threshold.
   */
  shouldSpill(result: ToolResult): boolean {
    const serialized = JSON.stringify(result.content);
    return serialized.length > SPILL_THRESHOLD;
  }

  /**
   * Write a tool result to disk and return a spilled reference.
   */
  spill(toolUseId: string, result: ToolResult): SpilledResult {
    const filename = `${toolUseId}-${randomUUID()}.json`;
    const filePath = join(this.cacheDir, filename);
    const data = JSON.stringify(result);
    writeFileSync(filePath, data, 'utf-8');
    this.files.push(filePath);
    return {
      type: 'disk_ref',
      path: filePath,
      size: Buffer.byteLength(data, 'utf-8'),
    };
  }

  /**
   * Retrieve a tool result from a spilled reference.
   */
  retrieve(ref: SpilledResult): ToolResult {
    const data = readFileSync(ref.path, 'utf-8');
    return JSON.parse(data) as ToolResult;
  }

  /**
   * Delete all temp files created by this cache instance.
   * Intended to be called on process exit or session end.
   */
  cleanup(): void {
    for (const f of this.files) {
      try {
        if (existsSync(f)) {
          rmSync(f);
        }
      } catch {
        // Best-effort cleanup
      }
    }
    this.files.length = 0;
  }
}
