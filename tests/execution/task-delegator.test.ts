/**
 * TDD: Tests for TaskDelegator -- creates tasks from a plan, assigns them
 * to spawned agents, and collects results.
 *
 * London School: McpClient is fully mocked.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowPlan, PlannedPhase, Artifact } from '../../src/types';
import type { McpClient, TaskStatusResult } from '../../src/execution/mcp-client';
import type { Logger } from '../../src/shared/logger';
import {
  type TaskDelegator,
  type TaskDelegatorDeps,
  type DelegatedTask,
  type TaskResult,
  type SpawnedAgentRef,
  createTaskDelegator,
} from '../../src/execution/task-delegator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-001',
    workItemId: 'work-item-42',
    methodology: 'sparc-full',
    template: 'github-ops',
    topology: 'hierarchical',
    swarmStrategy: 'specialized',
    consensus: 'raft',
    maxAgents: 4,
    phases: [
      { type: 'specification', agents: ['architect'], gate: 'spec-approved', skippable: true },
      { type: 'refinement', agents: ['coder', 'tester'], gate: 'tests-pass', skippable: false },
      { type: 'completion', agents: ['reviewer'], gate: 'review-approved', skippable: false },
    ],
    agentTeam: [
      { role: 'lead', type: 'architect', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
    ],
    estimatedDuration: 15,
    estimatedCost: 0.02,
    ...overrides,
  };
}

function makePhase(overrides: Partial<PlannedPhase> = {}): PlannedPhase {
  return {
    type: 'refinement',
    agents: ['coder', 'tester'],
    gate: 'tests-pass',
    skippable: false,
    ...overrides,
  };
}

function makeAgents(count: number): SpawnedAgentRef[] {
  return Array.from({ length: count }, (_, i) => ({
    agentId: `agent-${i + 1}`,
    role: i === 0 ? 'coder' : 'tester',
  }));
}

/** No-op logger for tests. */
const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return silentLogger; },
};

// ---------------------------------------------------------------------------
// Mock McpClient builder
// ---------------------------------------------------------------------------

interface MockCallLog {
  taskCreate: Array<{ description: string; metadata?: Record<string, unknown> }>;
  taskAssign: Array<{ taskId: string; agentId: string }>;
  taskStatus: Array<{ taskId: string }>;
}

function createMockMcpClient(overrides: {
  taskCreateResults?: Array<{ taskId: string }>;
  taskStatusResults?: Array<TaskStatusResult>;
  taskCreateError?: Error;
} = {}): { client: McpClient; calls: MockCallLog } {
  let createIndex = 0;
  let statusIndex = 0;

  const calls: MockCallLog = {
    taskCreate: [],
    taskAssign: [],
    taskStatus: [],
  };

  const client: McpClient = {
    async swarmInit() { return { swarmId: 'swarm-1' }; },
    async swarmShutdown() {},
    async agentSpawn() { return { agentId: 'a-1' }; },
    async agentStatus() { return { agentId: 'a-1', status: 'completed' }; },
    async agentTerminate() {},
    async taskCreate(opts) {
      calls.taskCreate.push({ description: opts.description, metadata: opts.metadata });
      if (overrides.taskCreateError) throw overrides.taskCreateError;
      const results = overrides.taskCreateResults ?? [{ taskId: `task-${createIndex + 1}` }];
      const result = results[createIndex] ?? { taskId: `task-${createIndex + 1}` };
      createIndex++;
      return result;
    },
    async taskAssign(taskId, agentId) {
      calls.taskAssign.push({ taskId, agentId });
    },
    async taskStatus(taskId) {
      calls.taskStatus.push({ taskId });
      const results = overrides.taskStatusResults ?? [];
      const result = results[statusIndex] ?? { taskId, status: 'completed' as const, output: '' };
      statusIndex++;
      return result;
    },
    async taskComplete() {},
    async memoryStore() {},
    async memorySearch() { return []; },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskDelegator', () => {
  let plan: WorkflowPlan;
  let phase: PlannedPhase;
  let agents: SpawnedAgentRef[];

  beforeEach(() => {
    plan = makePlan();
    phase = makePhase();
    agents = makeAgents(2);
  });

  describe('createAndAssign', () => {
    it('creates a task per spawned agent', async () => {
      const { client, calls } = createMockMcpClient();
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      await delegator.createAndAssign(plan, phase, agents);

      assert.equal(calls.taskCreate.length, 2, 'should create one task per agent');
    });

    it('calls taskAssign for each created task', async () => {
      const { client, calls } = createMockMcpClient({
        taskCreateResults: [{ taskId: 'task-A' }, { taskId: 'task-B' }],
      });
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      await delegator.createAndAssign(plan, phase, agents);

      assert.equal(calls.taskAssign.length, 2, 'should assign each task');
      assert.deepEqual(calls.taskAssign[0], { taskId: 'task-A', agentId: 'agent-1' });
      assert.deepEqual(calls.taskAssign[1], { taskId: 'task-B', agentId: 'agent-2' });
    });

    it('task description includes phase type, gate criteria, and work item context', async () => {
      const { client, calls } = createMockMcpClient();
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      await delegator.createAndAssign(plan, phase, agents);

      const desc = calls.taskCreate[0].description;
      assert.ok(desc.includes('refinement'), 'description should include phase type');
      assert.ok(desc.includes('tests-pass'), 'description should include gate criteria');
      assert.ok(desc.includes('work-item-42'), 'description should include work item ID');
      assert.ok(desc.includes('sparc-full'), 'description should include methodology');
    });

    it('returns DelegatedTask[] with correct fields', async () => {
      const { client } = createMockMcpClient({
        taskCreateResults: [{ taskId: 'task-X' }, { taskId: 'task-Y' }],
      });
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      const result = await delegator.createAndAssign(plan, phase, agents);

      assert.equal(result.length, 2);
      assert.equal(result[0].taskId, 'task-X');
      assert.equal(result[0].phaseType, 'refinement');
      assert.equal(result[0].assignedAgentId, 'agent-1');
      assert.equal(result[0].status, 'assigned');
      assert.ok(result[0].description.length > 0);

      assert.equal(result[1].taskId, 'task-Y');
      assert.equal(result[1].assignedAgentId, 'agent-2');
    });

    it('error during task creation propagates cleanly', async () => {
      const { client } = createMockMcpClient({
        taskCreateError: new Error('MCP tool task_create failed: timeout'),
      });
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      await assert.rejects(
        () => delegator.createAndAssign(plan, phase, agents),
        (err: Error) => {
          assert.ok(err.message.includes('timeout'), 'should propagate original error');
          return true;
        },
      );
    });
  });

  describe('collectResults', () => {
    it('calls taskStatus for each delegated task', async () => {
      const { client, calls } = createMockMcpClient({
        taskStatusResults: [
          { taskId: 'task-1', status: 'completed', output: '{"artifacts":[]}' },
          { taskId: 'task-2', status: 'completed', output: '{"artifacts":[]}' },
        ],
      });
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      const tasks: DelegatedTask[] = [
        { taskId: 'task-1', phaseType: 'refinement', assignedAgentId: 'agent-1', description: 'desc', status: 'assigned' },
        { taskId: 'task-2', phaseType: 'refinement', assignedAgentId: 'agent-2', description: 'desc', status: 'assigned' },
      ];

      await delegator.collectResults(tasks);

      assert.equal(calls.taskStatus.length, 2);
      assert.equal(calls.taskStatus[0].taskId, 'task-1');
      assert.equal(calls.taskStatus[1].taskId, 'task-2');
    });

    it('parses output into TaskResult with artifacts', async () => {
      const artifact: Artifact = {
        id: 'art-1',
        phaseId: 'phase-1',
        type: 'code',
        url: '/src/foo.ts',
        metadata: { lines: 42 },
      };
      const { client } = createMockMcpClient({
        taskStatusResults: [
          {
            taskId: 'task-1',
            status: 'completed',
            output: JSON.stringify({ artifacts: [artifact] }),
          },
        ],
      });
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      const tasks: DelegatedTask[] = [
        { taskId: 'task-1', phaseType: 'refinement', assignedAgentId: 'agent-1', description: 'desc', status: 'assigned' },
      ];

      const results = await delegator.collectResults(tasks);

      assert.equal(results.length, 1);
      assert.equal(results[0].taskId, 'task-1');
      assert.equal(results[0].agentId, 'agent-1');
      assert.equal(results[0].status, 'completed');
      assert.equal(results[0].artifacts.length, 1);
      assert.equal(results[0].artifacts[0].id, 'art-1');
      assert.equal(results[0].artifacts[0].type, 'code');
    });

    it('handles failed tasks gracefully', async () => {
      const { client } = createMockMcpClient({
        taskStatusResults: [
          { taskId: 'task-1', status: 'failed', output: 'Agent crashed' },
        ],
      });
      const delegator = createTaskDelegator({ logger: silentLogger, mcpClient: client });

      const tasks: DelegatedTask[] = [
        { taskId: 'task-1', phaseType: 'refinement', assignedAgentId: 'agent-1', description: 'desc', status: 'assigned' },
      ];

      const results = await delegator.collectResults(tasks);

      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'failed');
      assert.equal(results[0].output, 'Agent crashed');
      assert.deepEqual(results[0].artifacts, []);
    });
  });
});
