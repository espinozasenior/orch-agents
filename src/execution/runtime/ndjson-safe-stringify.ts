/**
 * NDJSON-safe JSON serialization.
 *
 * Phase P7: NDJSON Permission Negotiation (FR-P7-007)
 *
 * U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are valid JSON
 * but break line-splitting receivers. This function escapes them so that
 * every encoded message is guaranteed to occupy exactly one line.
 */

export function ndjsonSafeStringify(obj: unknown): string {
  const raw = JSON.stringify(obj);
  // Replace literal U+2028 / U+2029 with their escaped forms
  const safe = raw.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return safe + '\n';
}
