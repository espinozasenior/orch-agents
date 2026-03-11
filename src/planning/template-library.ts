/**
 * Template Library.
 *
 * Maps template keys (from github-routing.json) to concrete workflow
 * configurations: SPARC phases, agent teams, topology, and consensus.
 *
 * Templates are the bridge between triage output and the planning engine.
 */

import type { PlannedPhase, PlannedAgent, SPARCPhase } from '../types';

// ---------------------------------------------------------------------------
// Template definition
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  methodology: 'sparc-full' | 'sparc-partial' | 'tdd' | 'adhoc' | 'testing';
  phases: PlannedPhase[];
  defaultAgents: PlannedAgent[];
  topology: 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'ring' | 'star' | 'adaptive';
  consensus: 'raft' | 'pbft' | 'none';
  swarmStrategy: 'specialized' | 'balanced' | 'minimal';
  maxAgents: number;
  estimatedDuration: number; // minutes
}

// ---------------------------------------------------------------------------
// Built-in templates (from Appendix A template keys)
// ---------------------------------------------------------------------------

const TEMPLATES: Map<string, WorkflowTemplate> = new Map([
  ['cicd-pipeline', {
    key: 'cicd-pipeline',
    name: 'CI/CD Pipeline',
    description: 'Validate code on push to default branch',
    methodology: 'sparc-partial',
    phases: [
      { type: 'refinement' as SPARCPhase, agents: ['tester', 'reviewer'], gate: 'tests-pass', skippable: false },
      { type: 'completion' as SPARCPhase, agents: ['coder'], gate: 'build-pass', skippable: false },
    ],
    defaultAgents: [
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
      { role: 'deployer', type: 'coder', tier: 2, required: true },
    ],
    topology: 'hierarchical',
    consensus: 'raft',
    swarmStrategy: 'minimal',
    maxAgents: 4,
    estimatedDuration: 10,
  }],
  ['quick-fix', {
    key: 'quick-fix',
    name: 'Quick Fix',
    description: 'Fast single-phase fix for low-complexity tasks',
    methodology: 'adhoc',
    phases: [
      { type: 'refinement' as SPARCPhase, agents: ['coder'], gate: 'tests-pass', skippable: false },
    ],
    defaultAgents: [
      { role: 'implementer', type: 'coder', tier: 2, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: false },
    ],
    topology: 'star',
    consensus: 'none',
    swarmStrategy: 'minimal',
    maxAgents: 3,
    estimatedDuration: 5,
  }],
  ['github-ops', {
    key: 'github-ops',
    name: 'GitHub Operations',
    description: 'PR review, issue triage, and GitHub-specific workflows',
    methodology: 'sparc-partial',
    phases: [
      { type: 'specification' as SPARCPhase, agents: ['architect'], gate: 'spec-approved', skippable: true },
      { type: 'refinement' as SPARCPhase, agents: ['reviewer', 'coder'], gate: 'review-approved', skippable: false },
    ],
    defaultAgents: [
      { role: 'lead', type: 'architect', tier: 3, required: false },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
      { role: 'implementer', type: 'coder', tier: 2, required: true },
    ],
    topology: 'hierarchical',
    consensus: 'raft',
    swarmStrategy: 'specialized',
    maxAgents: 5,
    estimatedDuration: 15,
  }],
  ['tdd-workflow', {
    key: 'tdd-workflow',
    name: 'TDD Workflow',
    description: 'Test-driven development for bug fixes',
    methodology: 'tdd',
    phases: [
      { type: 'specification' as SPARCPhase, agents: ['tester'], gate: 'test-written', skippable: false },
      { type: 'refinement' as SPARCPhase, agents: ['coder'], gate: 'tests-pass', skippable: false },
      { type: 'completion' as SPARCPhase, agents: ['reviewer'], gate: 'review-approved', skippable: false },
    ],
    defaultAgents: [
      { role: 'test-writer', type: 'tester', tier: 2, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
    ],
    topology: 'hierarchical',
    consensus: 'raft',
    swarmStrategy: 'specialized',
    maxAgents: 5,
    estimatedDuration: 20,
  }],
  ['feature-build', {
    key: 'feature-build',
    name: 'Feature Build',
    description: 'Full SPARC methodology for new features',
    methodology: 'sparc-full',
    phases: [
      { type: 'specification' as SPARCPhase, agents: ['architect', 'researcher'], gate: 'spec-approved', skippable: false },
      { type: 'pseudocode' as SPARCPhase, agents: ['architect'], gate: 'pseudocode-reviewed', skippable: false },
      { type: 'architecture' as SPARCPhase, agents: ['architect', 'security-architect'], gate: 'arch-approved', skippable: false },
      { type: 'refinement' as SPARCPhase, agents: ['coder', 'tester'], gate: 'tests-pass', skippable: false },
      { type: 'completion' as SPARCPhase, agents: ['reviewer', 'coder'], gate: 'review-approved', skippable: false },
    ],
    defaultAgents: [
      { role: 'lead', type: 'architect', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
      { role: 'researcher', type: 'researcher', tier: 2, required: false },
      { role: 'security', type: 'security-architect', tier: 3, required: false },
    ],
    topology: 'hierarchical-mesh',
    consensus: 'raft',
    swarmStrategy: 'specialized',
    maxAgents: 8,
    estimatedDuration: 45,
  }],
  ['release-pipeline', {
    key: 'release-pipeline',
    name: 'Release Pipeline',
    description: 'Post-merge and release deployment workflow',
    methodology: 'sparc-partial',
    phases: [
      { type: 'completion' as SPARCPhase, agents: ['coder', 'tester'], gate: 'deploy-verified', skippable: false },
    ],
    defaultAgents: [
      { role: 'deployer', type: 'coder', tier: 2, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
    ],
    topology: 'hierarchical',
    consensus: 'raft',
    swarmStrategy: 'minimal',
    maxAgents: 4,
    estimatedDuration: 10,
  }],
  ['monitoring-alerting', {
    key: 'monitoring-alerting',
    name: 'Monitoring & Alerting',
    description: 'Incident response for deployment failures',
    methodology: 'adhoc',
    phases: [
      { type: 'refinement' as SPARCPhase, agents: ['coder', 'tester'], gate: 'fix-verified', skippable: false },
      { type: 'completion' as SPARCPhase, agents: ['coder'], gate: 'deploy-verified', skippable: false },
    ],
    defaultAgents: [
      { role: 'incident-lead', type: 'architect', tier: 3, required: true },
      { role: 'fixer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
    ],
    topology: 'star',
    consensus: 'none',
    swarmStrategy: 'minimal',
    maxAgents: 4,
    estimatedDuration: 15,
  }],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a workflow template by key.
 * Returns undefined if not found.
 */
export function getTemplate(key: string): WorkflowTemplate | undefined {
  return TEMPLATES.get(key);
}

/**
 * List all registered template keys.
 */
export function listTemplateKeys(): string[] {
  return [...TEMPLATES.keys()];
}

/**
 * Register a custom template (for extensibility and testing).
 */
export function registerTemplate(template: WorkflowTemplate): void {
  TEMPLATES.set(template.key, template);
}

/**
 * Get the default template for a given methodology.
 */
export function getDefaultTemplate(
  methodology: 'sparc-full' | 'sparc-partial' | 'tdd' | 'adhoc',
): WorkflowTemplate {
  switch (methodology) {
    case 'sparc-full': return TEMPLATES.get('feature-build')!;
    case 'tdd': return TEMPLATES.get('tdd-workflow')!;
    case 'sparc-partial': return TEMPLATES.get('github-ops')!;
    case 'adhoc': return TEMPLATES.get('quick-fix')!;
  }
}
