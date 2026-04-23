/**
 * Shared formatting utilities.
 *
 * Extracted to eliminate duplication across bounded contexts.
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Examples:
 *   123 -> "123ms"
 *   5000 -> "5s"
 *   125000 -> "2m 5s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
// test: verify bot identity on PR review
