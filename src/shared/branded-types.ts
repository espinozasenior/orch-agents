/**
 * Branded (nominal) types for domain identifiers.
 *
 * Prevents accidental cross-context ID confusion at compile time
 * with zero runtime cost. Each branded type is structurally a string
 * but is not assignable from a plain string without the factory.
 *
 * Usage:
 *   const id = planId('abc-123');   // PlanId
 *   const bad: PlanId = 'abc-123'; // compile error
 */

declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

export type PlanId = Brand<string, 'PlanId'>;
export type WorkItemId = Brand<string, 'WorkItemId'>;
export type ExecId = Brand<string, 'ExecId'>;
export type LinearIssueId = Brand<string, 'LinearIssueId'>;
export type AgentSessionId = Brand<string, 'AgentSessionId'>;
export type PhaseId = Brand<string, 'PhaseId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

// ---------------------------------------------------------------------------
// Factory functions — the only way to create branded values
// ---------------------------------------------------------------------------

export function planId(raw: string): PlanId { return raw as PlanId; }
export function workItemId(raw: string): WorkItemId { return raw as WorkItemId; }
export function execId(raw: string): ExecId { return raw as ExecId; }
export function linearIssueId(raw: string): LinearIssueId { return raw as LinearIssueId; }
export function agentSessionId(raw: string): AgentSessionId { return raw as AgentSessionId; }
export function phaseId(raw: string): PhaseId { return raw as PhaseId; }
export function correlationId(raw: string): CorrelationId { return raw as CorrelationId; }
