/**
 * TDD: Tests for output-parser — pure functions for detecting patterns in CLI output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChunk, tryParseTokens } from '../../src/execution/output-parser';

// ---------------------------------------------------------------------------
// parseChunk
// ---------------------------------------------------------------------------

describe('parseChunk', () => {
  it('detects tool_use in JSON format', () => {
    const chunk = '{"type": "tool_use", "name": "read_file"}';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.toolUse, true);
    assert.equal(signals.thinking, false);
  });

  it('detects tool_use in compact JSON format', () => {
    const chunk = '{"type":"tool_use","name":"bash"}';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.toolUse, true);
  });

  it('detects tool_use in XML format', () => {
    const chunk = '<tool_use>read_file</tool_use>';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.toolUse, true);
  });

  it('detects thinking in JSON format', () => {
    const chunk = '{"type": "thinking", "content": "Let me analyze..."}';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.thinking, true);
    assert.equal(signals.toolUse, false);
  });

  it('detects thinking in compact JSON format', () => {
    const chunk = '{"type":"thinking"}';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.thinking, true);
  });

  it('detects thinking in XML format', () => {
    const chunk = '<thinking>Let me think about this...</thinking>';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.thinking, true);
  });

  it('detects JSON completion when buffer + chunk forms valid JSON', () => {
    const buffer = '{"status": "ok", "data":';
    const chunk = ' 42}';
    const signals = parseChunk(chunk, buffer);
    assert.equal(signals.jsonComplete, true);
  });

  it('does not detect JSON completion for incomplete JSON', () => {
    const buffer = '{"status": "ok"';
    const chunk = ', "more": ';
    const signals = parseChunk(chunk, buffer);
    assert.equal(signals.jsonComplete, false);
  });

  it('returns all false for plain text', () => {
    const signals = parseChunk('Hello world, analyzing code...', '');
    assert.equal(signals.toolUse, false);
    assert.equal(signals.thinking, false);
    assert.equal(signals.jsonComplete, false);
  });

  it('detects multiple signals in one chunk', () => {
    const chunk = '{"type": "tool_use", "thinking": true, "type": "thinking"}';
    // This chunk contains both patterns
    const signals = parseChunk(chunk, '');
    assert.equal(signals.toolUse, true);
    assert.equal(signals.thinking, true);
  });

  it('handles empty chunk', () => {
    const signals = parseChunk('', '');
    assert.equal(signals.toolUse, false);
    assert.equal(signals.thinking, false);
    assert.equal(signals.jsonComplete, false);
  });

  it('handles empty buffer with complete JSON chunk', () => {
    const signals = parseChunk('{"result": true}', '');
    assert.equal(signals.jsonComplete, true);
  });
});

// ---------------------------------------------------------------------------
// tryParseTokens
// ---------------------------------------------------------------------------

describe('tryParseTokens', () => {
  it('extracts tokens from JSON format', () => {
    const stderr = '{"usage": {"input_tokens": 1500, "output_tokens": 800}}';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 1500, output: 800 });
  });

  it('extracts tokens from multiline JSON format', () => {
    const stderr = [
      'Some debug output',
      '{"model": "claude-3", "usage": {"input_tokens": 2000, "output_tokens": 1200}}',
      'More output',
    ].join('\n');
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 2000, output: 1200 });
  });

  it('extracts tokens from text format', () => {
    const stderr = 'Input tokens: 500\nOutput tokens: 300';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 500, output: 300 });
  });

  it('extracts tokens from case-insensitive text format', () => {
    const stderr = 'input token: 100\noutput token: 50';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 100, output: 50 });
  });

  it('returns undefined for unrecognized input', () => {
    const result = tryParseTokens('Some random stderr output');
    assert.equal(result, undefined);
  });

  it('returns undefined for empty string', () => {
    const result = tryParseTokens('');
    assert.equal(result, undefined);
  });

  it('returns undefined when only input tokens present', () => {
    const result = tryParseTokens('"input_tokens": 500');
    assert.equal(result, undefined);
  });

  it('returns undefined when only output tokens present', () => {
    const result = tryParseTokens('"output_tokens": 300');
    assert.equal(result, undefined);
  });

  it('handles large token counts', () => {
    const stderr = '{"usage": {"input_tokens": 100000, "output_tokens": 50000}}';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 100000, output: 50000 });
  });

  it('extracts tokens when mixed with other JSON fields', () => {
    const stderr = '{"model":"claude-4","input_tokens":750,"output_tokens":300,"stop_reason":"end"}';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 750, output: 300 });
  });

  it('extracts tokens from text with extra whitespace', () => {
    const stderr = 'Input tokens:   1234\nOutput tokens:   567';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 1234, output: 567 });
  });

  it('returns undefined when text has only input tokens line', () => {
    const result = tryParseTokens('Input tokens: 500\nSome other line');
    assert.equal(result, undefined);
  });

  it('returns undefined when text has only output tokens line', () => {
    const result = tryParseTokens('Some line\nOutput tokens: 300');
    assert.equal(result, undefined);
  });

  it('handles zero token counts', () => {
    const stderr = '{"usage": {"input_tokens": 0, "output_tokens": 0}}';
    const result = tryParseTokens(stderr);
    assert.deepEqual(result, { input: 0, output: 0 });
  });
});

// ---------------------------------------------------------------------------
// parseChunk — additional edge cases
// ---------------------------------------------------------------------------

describe('parseChunk — edge cases', () => {
  it('does not detect jsonComplete when buffer starts with { but combined does not end with }', () => {
    const signals = parseChunk('more data', '{"partial":');
    assert.equal(signals.jsonComplete, false);
  });

  it('does not detect jsonComplete when malformed JSON has matching braces', () => {
    // Braces match but content is not valid JSON
    const signals = parseChunk('}', '{not valid json');
    assert.equal(signals.jsonComplete, false);
  });

  it('does not detect jsonComplete for array JSON', () => {
    // Only objects starting with { are checked
    const signals = parseChunk('[1, 2, 3]', '');
    assert.equal(signals.jsonComplete, false);
  });

  it('detects jsonComplete with whitespace padding', () => {
    const signals = parseChunk('  ', '  {"ok": true}  ');
    assert.equal(signals.jsonComplete, true);
  });

  it('does not false-positive tool_use in unrelated text', () => {
    const signals = parseChunk('The user wanted to use a tool for analysis', '');
    assert.equal(signals.toolUse, false);
    assert.equal(signals.thinking, false);
  });

  it('handles very large chunks without crashing', () => {
    const largeChunk = 'x'.repeat(100_000);
    const signals = parseChunk(largeChunk, '');
    assert.equal(signals.toolUse, false);
    assert.equal(signals.thinking, false);
    assert.equal(signals.jsonComplete, false);
  });

  it('detects tool_use mid-chunk among other text', () => {
    const chunk = 'Some text before {"type": "tool_use", "name": "bash"} and after';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.toolUse, true);
  });

  it('detects thinking mid-chunk among other text', () => {
    const chunk = 'prefix <thinking>some thought</thinking> suffix';
    const signals = parseChunk(chunk, '');
    assert.equal(signals.thinking, true);
  });

  it('does not detect jsonComplete when combined starts with { from buffer but chunk has no }', () => {
    const signals = parseChunk('"value": 42, "more":', '{"key":');
    assert.equal(signals.jsonComplete, false);
  });
});
