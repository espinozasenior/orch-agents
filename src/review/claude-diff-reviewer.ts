/**
 * Claude-Powered DiffReviewer — replaces the stub with real AI code review.
 *
 * Implements the DiffReviewer interface from review-gate.ts.
 * Uses 3-tier model routing (Haiku for small diffs, Sonnet for large),
 * structured response parsing, confidence filtering, and large diff chunking.
 *
 * Factory-DI pattern: createClaudeDiffReviewer(opts) -> DiffReviewer
 *
 * Bounded context: Review
 */

import { spawn as _spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../shared/logger';
import type { Finding } from '../types';
import type { DiffReviewer, ReviewContext } from './review-gate';
import { buildSafeEnv } from '../shared/safe-env';
import { createAgentSandbox, type AgentSandbox } from '../execution/runtime/agent-sandbox';

// Re-export pure functions for backward compatibility
export { toFinding, parseFindings, deduplicateFindings } from './diff-review-parser';
export { buildDiffReviewPrompt, buildConfidencePrompt, selectModel } from './diff-review-prompts';

// Internal imports used by this module
import { parseFindings, deduplicateFindings, parseConfidenceScores } from './diff-review-parser';
import { buildDiffReviewPrompt, buildConfidencePrompt } from './diff-review-prompts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeDiffReviewerOpts {
  logger?: Logger;
  /** Path to claude CLI binary. Default: 'claude'. */
  cliBin?: string;
  /** Extra CLI arguments before the trailing '-'. Default: []. */
  cliArgs?: string[];
  /** Confidence threshold for Haiku filtering. Default: 0.7. */
  confidenceThreshold?: number;
  /** Override model for small diffs. Default: 'haiku'. */
  smallModel?: string;
  /** Override model for large diffs. Default: 'sonnet'. */
  largeModel?: string;
}

// ---------------------------------------------------------------------------
// Pure functions (kept in this file — tightly coupled to the reviewer)
// ---------------------------------------------------------------------------

/**
 * Detect whether a diff is binary (non-reviewable).
 * Checks for null bytes, "Binary files differ", and "GIT binary patch".
 */
export function isBinaryDiff(diff: string): boolean {
  if (diff.includes('\x00')) return true;
  if (diff.includes('Binary files') && diff.includes('differ')) return true;
  if (diff.includes('GIT binary patch')) return true;
  return false;
}

/**
 * Split a large diff into chunks at file boundaries (diff --git markers).
 * Each chunk stays under targetChunkSize lines where possible.
 */
export function splitAtFileBoundaries(diff: string, targetChunkSize: number): string[] {
  // Split on 'diff --git' markers, keeping the marker with the following segment
  const parts = diff.split(/(?=^diff --git )/m);
  const files = parts.filter((p) => p.length > 0);

  if (files.length === 0) {
    // No file headers — return the whole diff as one chunk
    return diff.trim().length > 0 ? [diff] : [];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  let currentLines = 0;

  for (const file of files) {
    const fileLines = file.split('\n').length;

    if (currentLines + fileLines > targetChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = file;
      currentLines = fileLines;
    } else {
      currentChunk += file;
      currentLines += fileLines;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Claude invocation (side-effecting — uses child_process)
// ---------------------------------------------------------------------------

export interface InvokeClaudeOpts {
  cliBin: string;
  cliArgs: string[];
  logger?: Logger;
  spawn?: typeof _spawn;
}

/**
 * Invoke Claude CLI with a prompt via stdin.
 * Returns raw stdout on success, or an error message on failure/timeout.
 */
export function invokeClaude(
  prompt: string,
  model: string,
  timeout: number,
  opts: InvokeClaudeOpts,
): Promise<string> {
  const { cliBin, cliArgs, logger } = opts;
  const spawnFn = opts.spawn ?? _spawn;

  return new Promise<string>((resolve) => {
    let sandbox: AgentSandbox | undefined;

    try {
      sandbox = createAgentSandbox();

      const args = [...cliArgs, '--print', '--model', model, '-'];
      const child = spawnFn(cliBin, args, {
        cwd: sandbox.cwd,
        timeout,
        env: buildSafeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      logger?.debug('ClaudeDiffReviewer: process spawned', {
        pid: child.pid,
        model,
        timeoutMs: timeout,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (output: string) => {
        if (settled) return;
        settled = true;
        sandbox?.cleanup();
        resolve(output);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        logger?.error('ClaudeDiffReviewer: spawn error', { error: err.message, model });
        const isTimeout = err.message.includes('ETIMEDOUT') || err.message.includes('timeout');
        const msg = isTimeout ? `timeout: Claude ${model} timed out after ${timeout}ms` : `error: ${err.message}`;
        finish(msg);
      });

      child.on('close', (code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          logger?.warn('ClaudeDiffReviewer: process killed', { signal, model });
          finish(`timeout: Claude ${model} timed out after ${timeout}ms`);
          return;
        }

        if (code !== 0) {
          logger?.warn('ClaudeDiffReviewer: process failed', {
            exitCode: code,
            stderrPreview: stderr.slice(0, 300),
            model,
          });
          finish(`error: Claude exited with code ${code}: ${stderr.slice(0, 200)}`);
          return;
        }

        logger?.debug('ClaudeDiffReviewer: process completed', {
          model,
          stdoutLen: stdout.length,
        });
        finish(stdout);
      });

      // Write prompt via stdin
      child.stdin?.write(prompt);
      child.stdin?.end();

    } catch (err) {
      sandbox?.cleanup();
      const message = err instanceof Error ? err.message : String(err);
      resolve(`error: ${message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Confidence filtering
// ---------------------------------------------------------------------------

export interface FilterByConfidenceOpts {
  cliBin: string;
  cliArgs: string[];
  logger?: Logger;
  spawn?: typeof _spawn;
}

/**
 * Filter findings by confidence via Haiku batch classification.
 * If classification fails, all findings pass through (defense-in-depth).
 */
export async function filterByConfidence(
  findings: Finding[],
  threshold: number,
  opts: FilterByConfidenceOpts,
): Promise<Finding[]> {
  if (findings.length === 0) return [];

  try {
    const prompt = buildConfidencePrompt(findings);
    const rawOutput = await invokeClaude(prompt, 'haiku', 60_000, opts);

    // If invocation returned an error string, pass all findings through
    if (rawOutput.startsWith('error:') || rawOutput.startsWith('timeout:')) {
      opts.logger?.warn('ClaudeDiffReviewer: confidence filtering failed, passing all findings', {
        reason: rawOutput.slice(0, 100),
      });
      return findings;
    }

    const scores = parseConfidenceScores(rawOutput);

    if (scores.length === 0) {
      // Could not parse scores — pass all findings through
      return findings;
    }

    return findings.filter((_f, i) => {
      // If score is missing for this index, keep the finding
      if (i >= scores.length) return true;
      return scores[i] >= threshold;
    });

  } catch (err) {
    // On any failure, pass all findings through
    opts.logger?.warn('ClaudeDiffReviewer: confidence filtering error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return findings;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Claude-powered DiffReviewer that sends diffs to Claude for analysis.
 *
 * Features:
 * - 3-tier model routing (Haiku for <500 lines, Sonnet for >=500)
 * - Large diff chunking at file boundaries (>10K lines)
 * - Structured response parsing (JSON + markdown + fallback)
 * - Confidence filtering via Haiku classification
 * - Binary diff detection
 * - Timeout handling (produces error finding, not exception)
 */
export function createClaudeDiffReviewer(opts: ClaudeDiffReviewerOpts = {}): DiffReviewer {
  const {
    logger,
    cliBin = 'claude',
    cliArgs = [],
    confidenceThreshold = 0.7,
    smallModel = 'haiku',
    largeModel = 'sonnet',
  } = opts;

  const invokeOpts: InvokeClaudeOpts = { cliBin, cliArgs, logger };
  const filterOpts: FilterByConfidenceOpts = { cliBin, cliArgs, logger };

  return {
    async review(diff: string, context: ReviewContext): Promise<Finding[]> {
      // Guard: empty diff
      if (!diff || diff.trim().length === 0) {
        logger?.debug('ClaudeDiffReviewer: empty diff, skipping');
        return [];
      }

      // Guard: binary diff
      if (isBinaryDiff(diff)) {
        logger?.info('ClaudeDiffReviewer: binary diff detected, skipping AI review');
        return [{
          id: randomUUID(),
          severity: 'info',
          category: 'diff-review',
          message: 'Binary diff detected, skipping AI review',
        }];
      }

      // Step 1: Model selection
      const lineCount = diff.split('\n').length;
      const model = lineCount < 500 ? smallModel : largeModel;
      const timeout = model === smallModel ? 60_000 : 120_000;

      logger?.info('ClaudeDiffReviewer: starting review', {
        lineCount,
        model,
        timeoutMs: timeout,
        repo: context.repo,
        prNumber: context.prNumber,
      });

      // Step 2: Chunk if needed (>10K lines)
      const chunks = lineCount > 10_000
        ? splitAtFileBoundaries(diff, 2000)
        : [diff];

      logger?.debug('ClaudeDiffReviewer: chunk plan', {
        totalChunks: chunks.length,
        lineCount,
      });

      // Step 3: Review each chunk
      const allFindings: Finding[] = [];

      for (const chunk of chunks) {
        const prompt = buildDiffReviewPrompt(chunk, context, model);
        const rawOutput = await invokeClaude(prompt, model, timeout, invokeOpts);

        // Check for timeout/error
        if (rawOutput.startsWith('timeout:')) {
          allFindings.push({
            id: randomUUID(),
            severity: 'error',
            category: 'diff-review',
            message: rawOutput,
          });
          continue;
        }

        if (rawOutput.startsWith('error:')) {
          allFindings.push({
            id: randomUUID(),
            severity: 'error',
            category: 'diff-review',
            message: rawOutput,
          });
          continue;
        }

        const findings = parseFindings(rawOutput);
        allFindings.push(...findings);
      }

      // Step 4: Confidence filtering
      const filtered = await filterByConfidence(allFindings, confidenceThreshold, filterOpts);

      // Step 5: Deduplicate
      const result = deduplicateFindings(filtered);

      logger?.info('ClaudeDiffReviewer: review complete', {
        rawFindingCount: allFindings.length,
        filteredCount: filtered.length,
        finalCount: result.length,
      });

      return result;
    },
  };
}
