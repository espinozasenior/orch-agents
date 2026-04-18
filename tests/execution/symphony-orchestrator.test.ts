import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSymphonyOrchestrator,
  sortForDispatch,
  type OrchestratorSnapshot,
  type SymphonyOrchestrator,
  type WorkerLike,
} from '../../src/execution/orchestrator/symphony-orchestrator';
import type { WorkflowConfig } from '../../src/config';
import type { LinearClient, LinearIssueResponse } from '../../src/integration/linear/linear-client';
import type { Logger } from '../../src/shared/logger';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';

class MockWorker implements WorkerLike {
  private readonly listeners: Record<string, Array<(value: unknown) => void>> = {
    message: [],
    error: [],
    exit: [],
  };
  public terminated = 0;
  public postedMessages: unknown[] = [];

  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): WorkerLike {
    this.listeners[event].push(listener);
    return this;
  }

  async terminate(): Promise<number> {
    this.terminated += 1;
    return 0;
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.message) {
      listener(message);
    }
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) {
      listener(code);
    }
  }
}

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

function makeWorkflowConfig(): WorkflowConfig {
  return {
    repos: {
      'test-org/test-repo': {
        url: 'git@github.com:test-org/test-repo.git',
        defaultBranch: 'main',
      },
    },
    defaults: {
      agents: { maxConcurrent: 1, maxConcurrentPerOrg: 1 },
      stall: { timeoutMs: 300000 },
      polling: { intervalMs: 1000, enabled: true },
    },
    tracker: {
      kind: 'linear',
      apiKey: 'test-key',
      team: 'team-1',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      activeTypes: ['unstarted', 'started'],
      terminalTypes: ['completed', 'canceled'],
    },
    agents: {
      maxConcurrent: 1,
    },
    agent: {
      maxConcurrentAgents: 1,
      maxRetryBackoffMs: 1,
      maxTurns: 20,
    },
    polling: {
      intervalMs: 1000,
      enabled: true,
    },
    stall: {
      timeoutMs: 300000,
    },
    agentRunner: {
      stallTimeoutMs: 300000,
      command: 'claude',
      turnTimeoutMs: 60000,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    promptTemplate: '',
  };
}

function makeIssue(overrides: Partial<LinearIssueResponse> = {}): LinearIssueResponse {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Test issue',
    description: 'desc',
    priority: 2,
    updatedAt: '2026-03-28T00:00:00Z',
    state: { id: 'state-1', name: 'Todo' },
    labels: { nodes: [] },
    assignee: null,
    creator: null,
    team: { id: 'team-1', key: 'ENG' },
    project: null,
    ...overrides,
  };
}

function makeLinearClient(overrides: Partial<LinearClient> = {}): LinearClient {
  return {
    fetchIssue: async () => makeIssue(),
    fetchActiveIssues: async () => [],
    fetchIssuesByStates: async () => [makeIssue()],
    fetchIssueStatesByIds: async () => [],
    fetchComments: async () => [],
    createComment: async () => 'comment-1',
    updateComment: async () => {},
    updateIssueState: async () => {},
    ...overrides,
  };
}

function sanitizePlanId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

describe('SymphonyOrchestrator', () => {
  it('dispatches eligible issues on tick', async () => {
    const workers: MockWorker[] = [];
    const linearClient: LinearClient = {
      fetchIssue: async () => makeIssue(),
      fetchActiveIssues: async () => [],
      fetchIssuesByStates: async () => [makeIssue()],
      fetchIssueStatesByIds: async () => [{ id: 'issue-1', state: 'Todo' }],
      fetchComments: async () => [],
      createComment: async () => 'comment-1',
      updateComment: async () => {},
      updateIssueState: async () => {},
    };

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient,
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();

    const state = orchestrator.getState();
    assert.equal(workers.length, 1);
    assert.equal(state.running.size, 1);
    assert.equal(state.claimed.has('issue-1'), true);
    await orchestrator.stop();
  });

  it('retries failed workers with backoff', async () => {
    const workers: MockWorker[] = [];
    let fetchCount = 0;
    const linearClient: LinearClient = {
      fetchIssue: async () => makeIssue(),
      fetchActiveIssues: async () => [],
      fetchIssuesByStates: async () => {
        fetchCount++;
        return [makeIssue()];
      },
      fetchIssueStatesByIds: async () => [{ id: 'issue-1', state: 'Todo' }],
      fetchComments: async () => [],
      createComment: async () => 'comment-1',
      updateComment: async () => {},
      updateIssueState: async () => {},
    };

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient,
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    workers[0].emitExit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(fetchCount >= 2);
    assert.equal(workers.length, 2);
    await orchestrator.stop();
  });

  it('sorts issues by priority then timestamp then identifier', () => {
    const sorted = sortForDispatch([
      makeIssue({ id: 'issue-2', identifier: 'ENG-2', priority: 3 }),
      makeIssue({ id: 'issue-3', identifier: 'ENG-3', priority: 1 }),
      makeIssue({ id: 'issue-1', identifier: 'ENG-1', priority: 3, updatedAt: '2026-03-27T00:00:00Z' }),
    ]);

    assert.deepEqual(sorted.map((issue) => issue.id), ['issue-3', 'issue-1', 'issue-2']);
  });

  it('does not dispatch when workflow state is invalid', async () => {
    const workers: MockWorker[] = [];
    const linearClient: LinearClient = {
      fetchIssue: async () => makeIssue(),
      fetchActiveIssues: async () => [],
      fetchIssuesByStates: async () => [makeIssue()],
      fetchIssueStatesByIds: async () => [],
      fetchComments: async () => [],
      createComment: async () => 'comment-1',
      updateComment: async () => {},
      updateIssueState: async () => {},
    };

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      workflowState: () => ({ valid: false, error: 'unsupported placeholders' }),
      linearClient,
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();

    assert.equal(workers.length, 0);
    assert.equal(orchestrator.getState().running.size, 0);
    await orchestrator.stop();
  });

  it('queues continuation after a clean worker exit when the issue remains active', async () => {
    const workers: MockWorker[] = [];
    let fetchCount = 0;
    const linearClient = makeLinearClient({
      fetchIssuesByStates: async () => {
        fetchCount += 1;
        return [makeIssue()];
      },
      fetchIssueStatesByIds: async () => [{ id: 'issue-1', state: 'Todo' }],
    });

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient,
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    workers[0].emitMessage({ type: 'completed', issueId: 'issue-1', status: 'completed', totalDuration: 10 });
    workers[0].emitExit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(fetchCount >= 2);
    assert.equal(workers.length, 2);
    assert.equal(orchestrator.getState().completed.has('issue-1'), false);
    await orchestrator.stop();
  });

  it('cleans up terminal issues during reconciliation', async () => {
    const workers: MockWorker[] = [];
    const worktreeBasePath = mkdtempSync(joinPath(tmpdir(), 'orch-orch-'));
    const workspacePath = joinPath(worktreeBasePath, sanitizePlanId('issue-1'));
    mkdirSync(workspacePath);

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      worktreeBasePath,
      linearClient: makeLinearClient({
        fetchIssuesByStates: async () => [makeIssue()],
        fetchIssueStatesByIds: async () => [{ id: 'issue-1', state: 'Done' }],
      }),
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    await orchestrator.onTick();

    assert.equal(workers[0].terminated, 1);
    assert.equal(orchestrator.getState().completed.has('issue-1'), true);
  });

  it('enforces blocker and per-state dispatch gating', async () => {
    const workers: MockWorker[] = [];
    const issueTodoBlocked = makeIssue({
      id: 'issue-1',
      identifier: 'ENG-1',
      labels: { nodes: [{ id: 'label-1', name: 'blocked' }] },
    });
    const issueTodoRunnable = makeIssue({
      id: 'issue-2',
      identifier: 'ENG-2',
      updatedAt: '2026-03-27T00:00:00Z',
    });
    const issueInProgress = makeIssue({
      id: 'issue-3',
      identifier: 'ENG-3',
      state: { id: 'state-2', name: 'In Progress' },
      updatedAt: '2026-03-26T00:00:00Z',
    });

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient: makeLinearClient({
        fetchIssuesByStates: async () => [issueTodoBlocked, issueTodoRunnable, issueInProgress],
      }),
      logger: makeLogger(),
      workerFactory: (_workerPath, workerData) => {
        const worker = new MockWorker();
        workers.push(worker);
        const issue = workerData.issue as LinearIssueResponse;
        if (issue.id === 'issue-2') {
          return worker;
        }
        return worker;
      },
    });

    await orchestrator.onTick();
    const runningIssues = Array.from(orchestrator.getState().running.values()).map((entry) => entry.issue.id);

    assert.deepEqual(runningIssues, ['issue-2']);
    assert.equal(workers.length, 1);
    await orchestrator.stop();
  });

  it('returns a snapshot containing running entries, token totals, retry due times, and last event timestamps', async () => {
    const workers: MockWorker[] = [];
    const workflowConfig = makeWorkflowConfig();
    workflowConfig.agent.maxConcurrentAgents = 2;
    workflowConfig.agent.maxRetryBackoffMs = 50;
    workflowConfig.defaults.agents.maxConcurrentPerOrg = 2;

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig,
      linearClient: makeLinearClient({
        fetchIssuesByStates: async () => [
          makeIssue({ id: 'issue-1', identifier: 'ENG-1' }),
          makeIssue({ id: 'issue-2', identifier: 'ENG-2', updatedAt: '2026-03-28T01:00:00Z' }),
        ],
      }),
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    workers[0].emitMessage({
      type: 'progress',
      sessionId: 'session-1',
      output: 'working',
      timestamp: Date.now(),
    });
    workers[0].emitMessage({
      type: 'tokenUsage',
      sessionId: 'session-1',
      usage: { input: 11, output: 7 },
      timestamp: Date.now(),
    });
    workers[1].emitMessage({
      type: 'completed',
      issueId: 'issue-2',
      status: 'failed',
      totalDuration: 5,
    });
    workers[1].emitExit(1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const snapshot = orchestrator.getSnapshot();
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0]?.sessionId, 'session-1');
    assert.deepEqual(snapshot.running[0]?.tokenUsage, { input: 11, output: 7 });
    assert.equal(typeof snapshot.running[0]?.lastEventTimestamp, 'number');
    assert.equal(snapshot.running[0]?.lastEventType, 'tokenUsage');
    assert.equal(snapshot.running[0]?.turnCount, 2);
    assert.equal(snapshot.retries.length, 1);
    assert.equal(snapshot.retries[0]?.issueId, 'issue-2');
    assert.equal(typeof snapshot.retries[0]?.dueAt, 'number');
    assert.equal(snapshot.workflow.valid, true);
    await orchestrator.stop();
  });

  it('forwards AgentPrompted event to running worker via postMessage', async () => {
    const workers: MockWorker[] = [];
    const linearClient = makeLinearClient({
      fetchIssuesByStates: async () => [makeIssue()],
      fetchIssueStatesByIds: async () => [{ id: 'issue-1', state: 'Todo' }],
    });

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient,
      logger: makeLogger(),
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    assert.equal(workers.length, 1);

    // Forward an AgentPrompted event
    orchestrator.forwardPromptedMessage('issue-1', {
      body: 'Please also add tests',
      agentSessionId: 'session-1',
    });

    assert.equal(workers[0].postedMessages.length, 1);
    const msg = workers[0].postedMessages[0] as { type: string; body: string; agentSessionId: string };
    assert.equal(msg.type, 'prompted');
    assert.equal(msg.body, 'Please also add tests');
    assert.equal(msg.agentSessionId, 'session-1');
    await orchestrator.stop();
  });

  // ---------------------------------------------------------------------------
  // Phase 7G: WorkCancelled → stop forwarding tests
  // ---------------------------------------------------------------------------

  it('forwards stop message to running worker when WorkCancelled event is received (Phase 7G)', async () => {
    const workers: MockWorker[] = [];
    const { createEventBus } = await import('../../src/kernel/event-bus');
    const eventBus = createEventBus();

    const linearClient = makeLinearClient({
      fetchIssuesByStates: async () => [makeIssue()],
      fetchIssueStatesByIds: async () => [{ id: 'issue-1', state: 'Todo' }],
    });

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient,
      logger: makeLogger(),
      eventBus,
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    assert.equal(workers.length, 1);

    // Simulate WorkCancelled event (as published by webhook handler on stop signal)
    const { createDomainEvent } = await import('../../src/kernel/event-bus');
    eventBus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'linear-session-session-abc',
      cancellationReason: 'User sent stop signal via Linear',
    }));

    // The orchestrator should find the worker by session and forward stop
    // For this test, we need a mapping from session to issue. We simulate that
    // by forwarding the stop to the worker that has a matching session.
    // First, update the worker entry with a sessionId
    const state = orchestrator.getState();
    const entry = state.running.get('issue-1');
    if (entry) {
      (entry as unknown as Record<string, unknown>).sessionId = 'session-abc';
      (entry as unknown as Record<string, unknown>).agentSessionId = 'session-abc';
    }

    // Re-publish to trigger the handler with the updated sessionId
    eventBus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'linear-session-session-abc',
      cancellationReason: 'User sent stop signal via Linear',
    }));

    // Worker should have received a stop message
    const stopMessages = workers[0].postedMessages.filter(
      (msg: unknown) => (msg as { type: string }).type === 'stop',
    );
    assert.ok(stopMessages.length > 0, 'Worker should receive a stop message');
    const stopMsg = stopMessages[0] as { type: string; reason: string };
    assert.equal(stopMsg.type, 'stop');
    assert.ok(stopMsg.reason.includes('stop signal'));

    await orchestrator.stop();
  });

  it('does not crash when WorkCancelled is received for unknown issue (Phase 7G)', async () => {
    const workers: MockWorker[] = [];
    const { createEventBus } = await import('../../src/kernel/event-bus');
    const eventBus = createEventBus();

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      linearClient: makeLinearClient({
        fetchIssuesByStates: async () => [],
        fetchIssueStatesByIds: async () => [],
      }),
      logger: makeLogger(),
      eventBus,
      workerFactory: () => {
        const worker = new MockWorker();
        workers.push(worker);
        return worker;
      },
    });

    await orchestrator.onTick();
    assert.equal(workers.length, 0);

    // Publish WorkCancelled for a non-existent session — should be a no-op
    const { createDomainEvent } = await import('../../src/kernel/event-bus');
    eventBus.publish(createDomainEvent('WorkCancelled', {
      workItemId: 'linear-session-unknown-session',
      cancellationReason: 'User sent stop signal via Linear',
    }));

    // Should not throw; orchestrator state should be unchanged
    assert.equal(orchestrator.getState().running.size, 0);
    await orchestrator.stop();
  });

  it('cleans up terminal workspaces on startup', async () => {
    const worktreeBasePath = mkdtempSync(joinPath(tmpdir(), 'orch-startup-'));
    mkdirSync(joinPath(worktreeBasePath, sanitizePlanId('terminal-issue')));
    mkdirSync(joinPath(worktreeBasePath, sanitizePlanId('active-issue')));

    const linearClient = makeLinearClient({
      fetchIssuesByStates: async () => [makeIssue({ id: 'active-issue', identifier: 'ENG-2' })],
      fetchIssueStatesByIds: async (issueIds) => issueIds.map((issueId) => ({
        id: issueId,
        state: issueId === 'active-issue' ? 'Todo' : 'Done',
      })),
    });

    const orchestrator = createSymphonyOrchestrator({
      workflowConfig: makeWorkflowConfig(),
      worktreeBasePath,
      linearClient,
      logger: makeLogger(),
      workerFactory: () => new MockWorker(),
    });

    orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapshot: OrchestratorSnapshot = orchestrator.getSnapshot();

    assert.equal(snapshot.starting, false);
    assert.equal(snapshot.startup.cleanedWorkspaces.includes('terminal-issue'), true);
    assert.equal(snapshot.startup.cleanedWorkspaces.includes('active-issue'), false);
    await orchestrator.stop();
  });
});
