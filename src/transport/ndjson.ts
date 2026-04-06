/**
 * NDJSON encoding/decoding with U+2028/U+2029 escaping.
 * FR-9E.10: NDJSON wire format with Unicode escaping for safe newline-delimited splitting.
 */

/**
 * Encode an object as an NDJSON line.
 * Escapes U+2028 (line separator) and U+2029 (paragraph separator) to prevent
 * line-split errors in newline-delimited streams.
 */
export function encodeNdjson(obj: unknown): string {
  const json = JSON.stringify(obj);
  // U+2028 and U+2029 are valid in JSON but act as line terminators in some contexts
  return json
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029') + '\n';
}

/**
 * Decode a single NDJSON line back to an object.
 * Safe after escaping on the write side.
 */
export function decodeNdjson<T = unknown>(line: string): T {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error('Empty NDJSON line');
  }
  return JSON.parse(trimmed) as T;
}

/**
 * Split a multi-line NDJSON string into individual parsed objects.
 * Skips empty lines.
 */
export function decodeNdjsonStream<T = unknown>(stream: string): T[] {
  return stream
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => decodeNdjson<T>(line));
}
