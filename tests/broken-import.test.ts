import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoName } from '../src/config/workflow-config';

describe('validateRepoName', () => {
  it('should accept valid repo names', () => {
    assert.doesNotThrow(() => validateRepoName('owner/repo'));
  });

  it('should reject invalid repo names', () => {
    assert.throws(() => validateRepoName('no-slash'));
  });
});
