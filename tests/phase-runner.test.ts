/**
 * TDD: Tests for PhaseRunner — the pluggable SPARC phase executor.
 *
 * RED phase: These tests define the contract for running individual
 * SPARC phases with agent coordination and quality gates.
 *
 * Covers both stub mode (no real deps) and real mode (with Layer 2 components).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlannedPhase, PhaseResult, WorkflowPlan, Artifact } from '../src/types';
import {
  type PhaseRunner,
  type PhaseRunnerDeps,
  createPhaseRunner,
  type GateChecker,
} from '../src/execution/phase-runner';
import type { SwarmManager, SwarmHandle } from '../src/execution/swarm-manager';
import type { AgentOrchestrator, SpawnedAgent, AgentOutcome } from '../src/execution/agent-orchestrator';
import type { TaskDelegator, DelegatedTask, TaskResult, SpawnedAgentRef } from '../src/execution/task-delegator';
import type { ArtifactCollector, TaskResultRef } from '../src/execution/artifact-collector';
import type { Logger } from '../src/shared/logger';
import { AgentTimeoutError } from '../src/shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-001',
    workItemId: 'work-001',
    methodology: 'sparc-partial',
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
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    ],
    estimatedDuration: 15,
    estimatedCost: 0.02,
    ...overrides,
  };
}

/** Mock gate checker that always passes. */
const passingGate: GateChecker = async () => ({ passed: true });

/** Mock gate checker that always fails. */
const failingGate: GateChecker = async () => ({
  passed: false,
  reason: 'Gate check failed',
});

/** Silent logger for tests. */
function makeLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// Mock factories for Layer 2 components
// ---------------------------------------------------------------------------

function mockSwarmManager(overrides: Partial<SwarmManager> = {}): SwarmManager & { calls: { init: WorkflowPlan[]; shutdown: string[] } } {
  const calls = { init: [] as WorkflowPlan[], shutdown: [] as string[] };
  return {
    calls,
    async initSwarm(plan: WorkflowPlan): Promise<SwarmHandle> {
      calls.init.push(plan);
      return { swarmId: 'swarm-001', topology: plan.topology, maxAgents: plan.maxAgents, status: 'active' };
    },
    async shutdownSwarm(swarmId: string): Promise<void> {
      calls.shutdown.push(swarmId);
    },
    ...overrides,
  };
}

function mockAgentOrchestrator(overrides: Partial<AgentOrchestrator> = {}): AgentOrchestrator & { calls: { spawn: unknown[]; wait: unknown[]; terminate: unknown[] } } {
  const calls = { spawn: [] as unknown[], wait: [] as unknown[], terminate: [] as unknown[] };
  return {
    calls,
    async spawnAgents(swarmId, phase, team): Promise<SpawnedAgent[]> {
      calls.spawn.push({ swarmId, phase, team });
      return phase.agents.map((role, i) => ({
        agentId: `agent-${i}`,
        role,
        type: role,
        tier: 2,
        status: 'spawned' as const,
      }));
    },
    async waitForAgents(agents, timeoutMs): Promise<AgentOutcome[]> {
      calls.wait.push({ agents, timeoutMs });
      return agents.map((a) => ({
        agentId: a.agentId,
        role: a.role,
        status: 'completed' as const,
        artifacts: [],
        duration: 100,
      }));
    },
    async terminateAgents(agents): Promise<void> {
      calls.terminate.push(agents);
    },
    ...overrides,
  };
}

function mockTaskDelegator(overrides: Partial<TaskDelegator> = {}): TaskDelegator & { calls: { createAndAssign: unknown[]; collectResults: unknown[] } } {
  const calls = { createAndAssign: [] as unknown[], collectResults: [] as unknown[] };
  return {
    calls,
    async createAndAssign(plan, phase, agents): Promise<DelegatedTask[]> {
      calls.createAndAssign.push({ plan, phase, agents });
      return agents.map((a, i) => ({
        taskId: `task-${i}`,
        phaseType: phase.type,
        assignedAgentId: a.agentId,
        description: `Task for ${a.role}`,
        status: 'assigned' as const,
      }));
    },
    async collectResults(tasks): Promise<TaskResult[]> {
      calls.collectResults.push(tasks);
      return tasks.map((t) => ({
        taskId: t.taskId,
        agentId: t.assignedAgentId,
        status: 'completed' as const,
        output: JSON.stringify({ artifacts: [] }),
        artifacts: [],
      }));
    },
    ...overrides,
  };
}

function mockArtifactCollector(overrides: Partial<ArtifactCollector> = {}): ArtifactCollector & { calls: { collect: unknown[]; storeCheckpoint: unknown[] } } {
  const calls = { collect: [] as unknown[], storeCheckpoint: [] as unknown[] };
  return {
    calls,
    collect(phaseId, phase, taskResults): Artifact[] {
      calls.collect.push({ phaseId, phase, taskResults });
      return taskResults.map((tr, i) => ({
        id: `artifact-${i}`,
        phaseId,
        type: phase.type,
        url: `memory://${phaseId}/${tr.taskId}`,
        metadata: { agentId: tr.agentId, taskId: tr.taskId, status: tr.status, output: tr.output },
      }));
    },
    async storeCheckpoint(planId, phaseId, artifacts): Promise<void> {
      calls.storeCheckpoint.push({ planId, phaseId, artifacts });
    },
    ...overrides,
  };
}

/** Build full real deps for PhaseRunner. */
function makeRealDeps(overrides: Partial<PhaseRunnerDeps> = {}): PhaseRunnerDeps & {
  mockSwarm: ReturnType<typeof mockSwarmManager>;
  mockOrch: ReturnType<typeof mockAgentOrchestrator>;
  mockTask: ReturnType<typeof mockTaskDelegator>;
  mockArtifact: ReturnType<typeof mockArtifactCollector>;
} {
  const mockSwarm = mockSwarmManager();
  const mockOrch = mockAgentOrchestrator();
  const mockTask = mockTaskDelegator();
  const mockArtifact = mockArtifactCollector();
  return {
    gateChecker: passingGate,
    swarmManager: mockSwarm,
    agentOrchestrator: mockOrch,
    taskDelegator: mockTask,
    artifactCollector: mockArtifact,
    logger: makeLogger(),
    mockSwarm,
    mockOrch,
    mockTask,
    mockArtifact,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — Stub mode (original behavior)
// ---------------------------------------------------------------------------

describe('PhaseRunner', () => {
  describe('createPhaseRunner()', () => {
    it('returns a PhaseRunner object', () => {
      const runner = createPhaseRunner({
        gateChecker: passingGate,
      });
      assert.ok(runner);
      assert.equal(typeof runner.runPhase, 'function');
    });
  });

  describe('runPhase() — stub mode', () => {
    it('returns a PhaseResult with completed status on success', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();
      const phase = plan.phases[1]; // refinement

      const result = await runner.runPhase(plan, phase);

      assert.equal(result.planId, 'plan-001');
      assert.equal(result.phaseType, 'refinement');
      assert.equal(result.status, 'completed');
      assert.ok(result.phaseId, 'Should have a phaseId');
      assert.ok(result.metrics.duration >= 0, 'Should have duration metric');
    });

    it('includes artifacts array (empty by default)', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.ok(Array.isArray(result.artifacts));
    });

    it('returns failed status when gate check fails', async () => {
      const runner = createPhaseRunner({ gateChecker: failingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]); // non-skippable

      assert.equal(result.status, 'failed');
    });

    it('returns skipped status for skippable phase with failing gate', async () => {
      const runner = createPhaseRunner({ gateChecker: failingGate });
      const plan = makePlan();
      const skippablePhase = plan.phases[0]; // specification (skippable)

      const result = await runner.runPhase(plan, skippablePhase);

      assert.equal(result.status, 'skipped');
    });

    it('tracks agent utilization in metrics', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.ok(result.metrics.agentUtilization >= 0);
      assert.ok(result.metrics.agentUtilization <= 1);
    });

    it('estimates model cost based on agent tiers', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.ok(result.metrics.modelCost >= 0);
    });

    it('assigns unique phaseId for each run', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const r1 = await runner.runPhase(plan, plan.phases[1]);
      const r2 = await runner.runPhase(plan, plan.phases[1]);

      assert.notEqual(r1.phaseId, r2.phaseId);
    });

    it('fallback to stub when no real deps provided (existing behavior preserved)', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();
      const result = await runner.runPhase(plan, plan.phases[1]);

      // Stub returns empty artifacts
      assert.deepEqual(result.artifacts, []);
      assert.equal(result.status, 'completed');
    });
  });

  describe('Custom gate checkers', () => {
    it('gate checker receives phase context', async () => {
      let receivedPhase: PlannedPhase | undefined;
      let receivedPlanId: string | undefined;

      const spyGate: GateChecker = async (planId, phase) => {
        receivedPhase = phase;
        receivedPlanId = planId;
        return { passed: true };
      };

      const runner = createPhaseRunner({ gateChecker: spyGate });
      const plan = makePlan();
      await runner.runPhase(plan, plan.phases[1]);

      assert.ok(receivedPhase);
      assert.equal(receivedPhase!.type, 'refinement');
      assert.equal(receivedPlanId, 'plan-001');
    });

    it('conditional gate: passes for specification, fails for others', async () => {
      const conditionalGate: GateChecker = async (_planId, phase) => {
        if (phase.type === 'specification') return { passed: true };
        return { passed: false, reason: 'Not specification' };
      };

      const runner = createPhaseRunner({ gateChecker: conditionalGate });
      const plan = makePlan();

      const specResult = await runner.runPhase(plan, plan.phases[0]);
      assert.equal(specResult.status, 'completed');

      const refResult = await runner.runPhase(plan, plan.phases[1]);
      assert.equal(refResult.status, 'failed');
    });
  });

  // -------------------------------------------------------------------------
  // Real execution mode tests
  // -------------------------------------------------------------------------

  describe('runPhase() — real mode', () => {
    it('calls spawnAgents -> createAndAssign -> waitForAgents -> collectResults -> collect -> storeCheckpoint -> gateChecker', async () => {
      let gateCalled = false;
      const deps = makeRealDeps({
        gateChecker: async () => {
          gateCalled = true;
          return { passed: true };
        },
      });
      const runner = createPhaseRunner(deps);
      const plan = makePlan();
      const phase = plan.phases[1]; // refinement: ['coder', 'tester']

      const result = await runner.runPhase(plan, phase);

      // Verify call order
      assert.equal(deps.mockSwarm.calls.init.length, 1, 'Should init swarm once');
      assert.equal(deps.mockOrch.calls.spawn.length, 1, 'Should spawn agents');
      assert.equal(deps.mockTask.calls.createAndAssign.length, 1, 'Should create tasks');
      assert.equal(deps.mockOrch.calls.wait.length, 1, 'Should wait for agents');
      assert.equal(deps.mockTask.calls.collectResults.length, 1, 'Should collect results');
      assert.equal(deps.mockArtifact.calls.collect.length, 1, 'Should collect artifacts');
      assert.equal(deps.mockArtifact.calls.storeCheckpoint.length, 1, 'Should store checkpoint');
      assert.ok(gateCalled, 'Should run gate checker');

      assert.equal(result.status, 'completed');
      assert.equal(result.planId, 'plan-001');
      assert.equal(result.phaseType, 'refinement');
    });

    it('lazy swarm init — first call inits swarm, second call reuses it', async () => {
      const deps = makeRealDeps();
      const runner = createPhaseRunner(deps);
      const plan = makePlan();

      await runner.runPhase(plan, plan.phases[0]);
      await runner.runPhase(plan, plan.phases[1]);

      assert.equal(deps.mockSwarm.calls.init.length, 1, 'Should only init swarm once');
      assert.equal(deps.mockOrch.calls.spawn.length, 2, 'Should spawn agents twice');
    });

    it('returns real artifacts in PhaseResult', async () => {
      const deps = makeRealDeps();
      const runner = createPhaseRunner(deps);
      const plan = makePlan();
      const phase = plan.phases[1]; // refinement: ['coder', 'tester']

      const result = await runner.runPhase(plan, phase);

      assert.ok(result.artifacts.length > 0, 'Should have artifacts');
      assert.equal(result.artifacts.length, 2, 'One artifact per agent');
      for (const artifact of result.artifacts) {
        assert.ok(artifact.id, 'Artifact should have id');
        assert.ok(artifact.phaseId, 'Artifact should have phaseId');
        assert.equal(artifact.type, 'refinement');
        assert.ok(artifact.url.startsWith('memory://'));
      }
    });

    it('AgentTimeoutError during waitForAgents results in failed PhaseResult', async () => {
      const deps = makeRealDeps({
        agentOrchestrator: mockAgentOrchestrator({
          async waitForAgents(): Promise<AgentOutcome[]> {
            throw new AgentTimeoutError('agent-0', 5000);
          },
        }),
      });
      const runner = createPhaseRunner(deps);
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.equal(result.status, 'failed');
      assert.deepEqual(result.artifacts, []);
    });
  });

  // -------------------------------------------------------------------------
  // dispose() tests
  // -------------------------------------------------------------------------

  describe('dispose()', () => {
    it('shuts down the swarm when one was initialized', async () => {
      const deps = makeRealDeps();
      const runner = createPhaseRunner(deps);
      const plan = makePlan();

      // Run a phase to initialize the swarm
      await runner.runPhase(plan, plan.phases[0]);
      assert.equal(deps.mockSwarm.calls.init.length, 1);

      // Dispose should shut down the swarm
      await runner.dispose!();
      assert.equal(deps.mockSwarm.calls.shutdown.length, 1);
      assert.equal(deps.mockSwarm.calls.shutdown[0], 'swarm-001');
    });

    it('is no-op when no swarm was initialized', async () => {
      const deps = makeRealDeps();
      const runner = createPhaseRunner(deps);

      // Dispose without ever running a phase
      await runner.dispose!();
      assert.equal(deps.mockSwarm.calls.shutdown.length, 0);
    });

    it('is no-op for stub mode (no swarmManager)', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });

      // Should not throw
      await runner.dispose!();
    });
  });
});
