/**
 * Agent Tracker — per-agent execution state tracking.
 *
 * Tracks individual agent executions independently within plans:
 * spawned, running, completed, failed, cancelled, timed-out.
 * Queryable by planId for drill-down observability.
 */

import type { SPARCPhase } from '../../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentExecStatus = 'spawned' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

export interface AgentExecState {
  execId: string;
  planId: string;
  agentRole: string;
  agentType: string;
  phaseType: SPARCPhase;
  status: AgentExecStatus;
  spawnedAt: string;
  lastActivity: string;
  completedAt: string | null;
  bytesReceived: number;
  chunksReceived: number;
  parsedSignals: {
    toolUseCount: number;
    thinkingDetected: boolean;
    jsonDetected: boolean;
  };
  tokenUsage?: { input: number; output: number };
}

export interface AgentTracker {
  spawn(execId: string, planId: string, agentRole: string, agentType: string, phaseType: SPARCPhase): void;
  touch(execId: string, bytesInChunk?: number): void;
  complete(execId: string, tokenUsage?: { input: number; output: number }): void;
  fail(execId: string, error?: string): void;
  cancel(execId: string): void;
  timeout(execId: string): void;
  recordSignal(execId: string, signal: 'toolUse' | 'thinking' | 'json'): void;
  getAgent(execId: string): AgentExecState | undefined;
  getAgentsByPlan(planId: string): AgentExecState[];
  getStalled(stallThresholdMs: number): AgentExecState[];
  cleanup(maxAgeMs: number): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createAgentTracker(): AgentTracker {
  const agents = new Map<string, AgentExecState>();
  const planIndex = new Map<string, Set<string>>();

  function ensureAgent(execId: string): AgentExecState {
    const agent = agents.get(execId);
    if (!agent) {
      throw new Error(`Agent ${execId} not tracked`);
    }
    return agent;
  }

  return {
    spawn(execId: string, planId: string, agentRole: string, agentType: string, phaseType: SPARCPhase): void {
      if (agents.has(execId)) {
        throw new Error(`Agent ${execId} already tracked`);
      }

      const now = new Date().toISOString();
      agents.set(execId, {
        execId,
        planId,
        agentRole,
        agentType,
        phaseType,
        status: 'spawned',
        spawnedAt: now,
        lastActivity: now,
        completedAt: null,
        bytesReceived: 0,
        chunksReceived: 0,
        parsedSignals: {
          toolUseCount: 0,
          thinkingDetected: false,
          jsonDetected: false,
        },
      });

      if (!planIndex.has(planId)) {
        planIndex.set(planId, new Set());
      }
      planIndex.get(planId)!.add(execId);
    },

    touch(execId: string, bytesInChunk = 0): void {
      const agent = ensureAgent(execId);
      agent.status = 'running';
      agent.lastActivity = new Date().toISOString();
      agent.bytesReceived += bytesInChunk;
      agent.chunksReceived += 1;
    },

    complete(execId: string, tokenUsage?: { input: number; output: number }): void {
      const agent = ensureAgent(execId);
      agent.status = 'completed';
      agent.completedAt = new Date().toISOString();
      agent.lastActivity = agent.completedAt;
      if (tokenUsage) {
        agent.tokenUsage = tokenUsage;
      }
    },

    fail(execId: string): void {
      const agent = ensureAgent(execId);
      agent.status = 'failed';
      agent.completedAt = new Date().toISOString();
      agent.lastActivity = agent.completedAt;
    },

    cancel(execId: string): void {
      const agent = ensureAgent(execId);
      agent.status = 'cancelled';
      agent.completedAt = new Date().toISOString();
      agent.lastActivity = agent.completedAt;
    },

    timeout(execId: string): void {
      const agent = ensureAgent(execId);
      agent.status = 'timed-out';
      agent.completedAt = new Date().toISOString();
      agent.lastActivity = agent.completedAt;
    },

    recordSignal(execId: string, signal: 'toolUse' | 'thinking' | 'json'): void {
      const agent = ensureAgent(execId);
      if (signal === 'toolUse') agent.parsedSignals.toolUseCount++;
      else if (signal === 'thinking') agent.parsedSignals.thinkingDetected = true;
      else if (signal === 'json') agent.parsedSignals.jsonDetected = true;
    },

    getAgent(execId: string): AgentExecState | undefined {
      return agents.get(execId);
    },

    getAgentsByPlan(planId: string): AgentExecState[] {
      const execIds = planIndex.get(planId);
      if (!execIds) return [];
      return [...execIds].map((id) => agents.get(id)!).filter(Boolean);
    },

    getStalled(stallThresholdMs: number): AgentExecState[] {
      const now = Date.now();
      const stalled: AgentExecState[] = [];
      for (const agent of agents.values()) {
        if (agent.status === 'running' || agent.status === 'spawned') {
          const lastActivity = new Date(agent.lastActivity).getTime();
          if (now - lastActivity >= stallThresholdMs) {
            stalled.push(agent);
          }
        }
      }
      return stalled;
    },

    cleanup(maxAgeMs: number): void {
      const now = Date.now();
      for (const [execId, agent] of agents) {
        if (agent.completedAt) {
          const completedAt = new Date(agent.completedAt).getTime();
          if (now - completedAt >= maxAgeMs) {
            agents.delete(execId);
            const planExecs = planIndex.get(agent.planId);
            if (planExecs) {
              planExecs.delete(execId);
              if (planExecs.size === 0) planIndex.delete(agent.planId);
            }
          }
        }
      }
    },
  };
}
