import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeNdjson,
  decodeNdjson,
  decodeNdjsonStream,
} from '../../src/transport/ndjson.js';

describe('NDJSON', () => {
  describe('encodeNdjson', () => {
    it('encodes standard JSON with no special chars unchanged', () => {
      const result = encodeNdjson({ foo: 'bar', num: 42 });
      assert.equal(result, '{"foo":"bar","num":42}\n');
    });

    it('escapes U+2028 (line separator)', () => {
      const result = encodeNdjson({ text: 'hello\u2028world' });
      assert.ok(result.includes('\\u2028'));
      assert.ok(!result.includes('\u2028'));
    });

    it('escapes U+2029 (paragraph separator)', () => {
      const result = encodeNdjson({ text: 'hello\u2029world' });
      assert.ok(result.includes('\\u2029'));
      assert.ok(!result.includes('\u2029'));
    });

    it('escapes both U+2028 and U+2029 in same string', () => {
      const result = encodeNdjson({ text: '\u2028\u2029' });
      assert.ok(result.includes('\\u2028'));
      assert.ok(result.includes('\\u2029'));
    });

    it('ends with newline', () => {
      const result = encodeNdjson({ a: 1 });
      assert.ok(result.endsWith('\n'));
    });
  });

  describe('decodeNdjson', () => {
    it('parses standard JSON line', () => {
      const result = decodeNdjson('{"foo":"bar"}');
      assert.deepEqual(result, { foo: 'bar' });
    });

    it('handles whitespace around the line', () => {
      const result = decodeNdjson('  {"foo":"bar"}  \n');
      assert.deepEqual(result, { foo: 'bar' });
    });

    it('throws on empty line', () => {
      assert.throws(() => decodeNdjson(''), /Empty NDJSON line/);
      assert.throws(() => decodeNdjson('  \n'), /Empty NDJSON line/);
    });

    it('parses escaped U+2028/U+2029 correctly', () => {
      const encoded = encodeNdjson({ text: 'a\u2028b\u2029c' });
      const decoded = decodeNdjson<{ text: string }>(encoded);
      assert.equal(decoded.text, 'a\u2028b\u2029c');
    });
  });

  describe('decodeNdjsonStream', () => {
    it('splits multi-line NDJSON stream correctly', () => {
      const stream = '{"a":1}\n{"b":2}\n{"c":3}\n';
      const result = decodeNdjsonStream(stream);
      assert.deepEqual(result, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    });

    it('skips empty lines', () => {
      const stream = '{"a":1}\n\n{"b":2}\n\n';
      const result = decodeNdjsonStream(stream);
      assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
    });
  });
});
