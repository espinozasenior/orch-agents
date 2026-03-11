/**
 * SPARC Decomposer.
 *
 * Takes a PlanningInput and decomposes the work into concrete SPARC phases
 * with assigned agents and quality gates.
 *
 * Uses the template library for base phase definitions, then adjusts
 * based on triage complexity and agent availability.
 */

import type { PlannedPhase, PlannedAgent, SPARCPhase, PlanningInput } from '../types';
import { getTemplate, type WorkflowTemplate } from './template-library';

// ---------------------------------------------------------------------------
// Decomposition result
// ---------------------------------------------------------------------------

export interface DecompositionResult {
  phases: PlannedPhase[];
  adjustedAgents: PlannedAgent[];
  methodology: 'sparc-full' | 'sparc-partial' | 'tdd' | 'adhoc' | 'testing';
  phasesSkipped: SPARCPhase[];
}

// ---------------------------------------------------------------------------
// Decompose
// ---------------------------------------------------------------------------

/**
 * Decompose a PlanningInput into SPARC phases with agents and gates.
 *
 * Strategy:
 * 1. Look up template for base phase definitions
 * 2. Filter phases by triage-recommended phases
 * 3. Assign agents from PlanningInput.agentTeam
 * 4. Add quality gates based on phase type
 */
export function decompose(input: PlanningInput): DecompositionResult {
  const template = getTemplate(input.templateKey);

  if (!template) {
    // Fallback: build minimal phases from triage recommendations
    return fallbackDecomposition(input);
  }

  return templateBasedDecomposition(input, template);
}

// ---------------------------------------------------------------------------
// Template-based decomposition
// ---------------------------------------------------------------------------

function templateBasedDecomposition(
  input: PlanningInput,
  template: WorkflowTemplate,
): DecompositionResult {
  const recommended = new Set(input.triageResult.recommendedPhases);
  const phases: PlannedPhase[] = [];
  const skipped: SPARCPhase[] = [];

  for (const templatePhase of template.phases) {
    if (recommended.has(templatePhase.type)) {
      // Map template agents to actual agents from the team
      const phaseAgents = resolveAgents(templatePhase.agents, input.agentTeam);
      phases.push({
        type: templatePhase.type,
        agents: phaseAgents,
        gate: templatePhase.gate,
        skippable: templatePhase.skippable,
      });
    } else if (templatePhase.skippable) {
      skipped.push(templatePhase.type);
    } else {
      // Non-skippable phase not in recommended — still include it
      const phaseAgents = resolveAgents(templatePhase.agents, input.agentTeam);
      phases.push({
        type: templatePhase.type,
        agents: phaseAgents,
        gate: templatePhase.gate,
        skippable: false,
      });
    }
  }

  // If triage recommends phases not in template, add them
  for (const phase of input.triageResult.recommendedPhases) {
    if (!phases.some((p) => p.type === phase)) {
      phases.push(buildAdHocPhase(phase, input.agentTeam));
    }
  }

  // Sort phases in SPARC order
  phases.sort((a, b) => SPARC_ORDER.indexOf(a.type) - SPARC_ORDER.indexOf(b.type));

  // Merge agent teams: template defaults + planning input overrides
  const adjustedAgents = mergeAgentTeams(template.defaultAgents, input.agentTeam);

  return {
    phases,
    adjustedAgents,
    methodology: template.methodology,
    phasesSkipped: skipped,
  };
}

// ---------------------------------------------------------------------------
// Fallback decomposition (no template found)
// ---------------------------------------------------------------------------

function fallbackDecomposition(input: PlanningInput): DecompositionResult {
  const phases: PlannedPhase[] = input.triageResult.recommendedPhases.map((phase) =>
    buildAdHocPhase(phase, input.agentTeam),
  );

  phases.sort((a, b) => SPARC_ORDER.indexOf(a.type) - SPARC_ORDER.indexOf(b.type));

  const methodology = phases.length >= 4 ? 'sparc-full' : phases.length >= 2 ? 'sparc-partial' : 'adhoc';

  return {
    phases,
    adjustedAgents: input.agentTeam,
    methodology,
    phasesSkipped: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SPARC_ORDER: SPARCPhase[] = [
  'specification',
  'pseudocode',
  'architecture',
  'refinement',
  'completion',
];

/**
 * Map template agent type names to actual agent roles from the team.
 */
function resolveAgents(templateAgentTypes: string[], team: PlannedAgent[]): string[] {
  const resolved: string[] = [];
  for (const agentType of templateAgentTypes) {
    const match = team.find((a) => a.type === agentType || a.role === agentType);
    if (match) {
      resolved.push(match.role);
    } else {
      // Use the type name as fallback
      resolved.push(agentType);
    }
  }
  return resolved;
}

/**
 * Build an ad-hoc phase when no template phase matches.
 */
function buildAdHocPhase(phaseType: SPARCPhase, team: PlannedAgent[]): PlannedPhase {
  const agents = defaultAgentsForPhase(phaseType, team);
  return {
    type: phaseType,
    agents,
    gate: defaultGateForPhase(phaseType),
    skippable: phaseType === 'pseudocode',
  };
}

function defaultAgentsForPhase(phase: SPARCPhase, team: PlannedAgent[]): string[] {
  switch (phase) {
    case 'specification':
      return pickAgents(team, ['architect', 'researcher'], ['lead']);
    case 'pseudocode':
      return pickAgents(team, ['architect'], ['lead']);
    case 'architecture':
      return pickAgents(team, ['architect', 'security-architect'], ['lead', 'security']);
    case 'refinement':
      return pickAgents(team, ['coder', 'tester'], ['implementer', 'validator']);
    case 'completion':
      return pickAgents(team, ['reviewer', 'coder'], ['reviewer', 'implementer']);
  }
}

function pickAgents(team: PlannedAgent[], types: string[], roles: string[]): string[] {
  const picked: string[] = [];
  for (let i = 0; i < types.length; i++) {
    const match = team.find((a) => a.type === types[i] || a.role === roles[i]);
    if (match) {
      picked.push(match.role);
    } else {
      picked.push(types[i]);
    }
  }
  return picked.length > 0 ? picked : ['coder'];
}

function defaultGateForPhase(phase: SPARCPhase): string {
  switch (phase) {
    case 'specification': return 'spec-approved';
    case 'pseudocode': return 'pseudocode-reviewed';
    case 'architecture': return 'arch-approved';
    case 'refinement': return 'tests-pass';
    case 'completion': return 'review-approved';
  }
}

/**
 * Merge template default agents with planning input agents.
 * Planning input agents take precedence.
 */
function mergeAgentTeams(
  defaults: PlannedAgent[],
  overrides: PlannedAgent[],
): PlannedAgent[] {
  const merged = new Map<string, PlannedAgent>();

  // Add defaults
  for (const agent of defaults) {
    merged.set(agent.role, agent);
  }

  // Override with planning input
  for (const agent of overrides) {
    merged.set(agent.role, agent);
  }

  return [...merged.values()];
}
