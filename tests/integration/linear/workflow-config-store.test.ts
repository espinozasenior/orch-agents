import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkflowConfigStore } from '../../../src/integration/linear/workflow-config-store';
import type { Logger } from '../../../src/shared/logger';

function makeLogger(): Logger {
  return {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() { return makeLogger(); },
  };
}

const VALID_WORKFLOW = `---
templates:
  quick-fix:
    - .claude/agents/core/coder.md

tracker:
  kind: linear
  team: my-team

agents:
  routing:
    default: quick-fix
---
Issue {{ issue.identifier }}
`;

describe('workflow-config-store', () => {
  let tempDir: string;
  let workflowPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-config-store-'));
    workflowPath = join(tempDir, 'WORKFLOW.md');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads a valid WORKFLOW.md at startup', () => {
    writeFileSync(workflowPath, VALID_WORKFLOW, 'utf8');
    const store = createWorkflowConfigStore({
      filePath: workflowPath,
      logger: makeLogger(),
      watchFile: false,
    });

    store.start();

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.valid, true);
    assert.equal(snapshot.config?.agents.defaultTemplate, 'quick-fix');
    store.stop();
  });

  it('marks the store invalid after a bad reload instead of keeping the old config', () => {
    writeFileSync(workflowPath, VALID_WORKFLOW, 'utf8');
    const store = createWorkflowConfigStore({
      filePath: workflowPath,
      logger: makeLogger(),
      watchFile: false,
    });
    store.start();

    writeFileSync(workflowPath, `${VALID_WORKFLOW}\n{{ issue.assignee }}`, 'utf8');
    const snapshot = store.reload();

    assert.equal(snapshot.valid, true);
    assert.match(snapshot.error ?? '', /unsupported placeholders/);
    assert.equal(snapshot.config?.agents.defaultTemplate, 'quick-fix');
    assert.equal(store.requireConfig().agents.defaultTemplate, 'quick-fix');
    store.stop();
  });
});
