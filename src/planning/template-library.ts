/**
 * Template Library.
 *
 * Maps template keys (from github-routing.json) to concrete workflow
 * configurations: SPARC phases, agent teams, topology, and consensus.
 *
 * Templates are loaded from config/workflow-templates.json on first access
 * (lazy singleton). Use setTemplates()/resetTemplates() for test overrides.
 *
 * Templates are the bridge between triage output and the planning engine.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlannedPhase, PlannedAgent } from '../types';
import { isValidSPARCPhase } from '../shared/constants';

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
  estimatedCost?: number;
}

// ---------------------------------------------------------------------------
// Valid enum values for validation
// ---------------------------------------------------------------------------

const VALID_TOPOLOGIES = new Set<string>([
  'mesh', 'hierarchical', 'hierarchical-mesh', 'ring', 'star', 'adaptive',
]);

const VALID_CONSENSUS = new Set<string>(['raft', 'pbft', 'none']);

const VALID_STRATEGIES = new Set<string>(['specialized', 'balanced', 'minimal']);

const VALID_METHODOLOGIES = new Set<string>([
  'sparc-full', 'sparc-partial', 'tdd', 'adhoc', 'testing',
]);

// ---------------------------------------------------------------------------
// Lazy-loaded template store
// ---------------------------------------------------------------------------

let _templates: Map<string, WorkflowTemplate> | undefined;

function loadTemplatesFromDisk(): Map<string, WorkflowTemplate> {
  const filePath = resolve(__dirname, '..', '..', 'config', 'workflow-templates.json');
  const raw = readFileSync(filePath, 'utf-8');
  const entries = JSON.parse(raw) as WorkflowTemplate[];
  const map = new Map<string, WorkflowTemplate>();
  for (const entry of entries) {
    map.set(entry.key, entry);
  }
  return map;
}

function getTemplatesMap(): Map<string, WorkflowTemplate> {
  if (!_templates) {
    _templates = loadTemplatesFromDisk();
  }
  return _templates;
}

// ---------------------------------------------------------------------------
// Test override helpers (same pattern as github-normalizer / triage-engine)
// ---------------------------------------------------------------------------

/**
 * Override the templates map (for testing).
 */
export function setTemplates(templates: WorkflowTemplate[]): void {
  _templates = new Map(templates.map((t) => [t.key, t]));
}

/**
 * Reset templates to force reload from disk on next access.
 */
export function resetTemplates(): void {
  _templates = undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate all currently loaded templates.
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validateTemplates(): string[] {
  const errors: string[] = [];
  const map = getTemplatesMap();

  for (const [key, t] of map) {
    // Required string fields
    if (!t.name) errors.push(`${key}: missing or empty name`);
    if (!t.description) errors.push(`${key}: missing or empty description`);

    // Methodology
    if (!VALID_METHODOLOGIES.has(t.methodology)) {
      errors.push(`${key}: invalid methodology "${t.methodology}"`);
    }

    // Phases
    if (!t.phases || t.phases.length === 0) {
      errors.push(`${key}: phases array is empty or missing`);
    } else {
      for (const phase of t.phases) {
        if (!isValidSPARCPhase(phase.type)) {
          errors.push(`${key}: invalid phase type "${phase.type}"`);
        }
      }
    }

    // Agents
    if (!t.defaultAgents || t.defaultAgents.length === 0) {
      errors.push(`${key}: defaultAgents array is empty or missing`);
    } else {
      for (const agent of t.defaultAgents) {
        if (![1, 2, 3].includes(agent.tier)) {
          errors.push(`${key}/${agent.role}: invalid tier ${agent.tier} (must be 1, 2, or 3)`);
        }
      }
    }

    // Topology
    if (!VALID_TOPOLOGIES.has(t.topology)) {
      errors.push(`${key}: invalid topology "${t.topology}"`);
    }

    // Consensus
    if (!VALID_CONSENSUS.has(t.consensus)) {
      errors.push(`${key}: invalid consensus "${t.consensus}"`);
    }

    // Strategy
    if (!VALID_STRATEGIES.has(t.swarmStrategy)) {
      errors.push(`${key}: invalid swarmStrategy "${t.swarmStrategy}"`);
    }

    // Max agents
    if (!t.maxAgents || t.maxAgents <= 0) {
      errors.push(`${key}: maxAgents must be > 0`);
    }
  }

  return errors;
}

/**
 * Cross-reference validation: check every `template` value in
 * config/github-routing.json has a matching entry in the templates map.
 *
 * Returns an array of error strings (empty = all refs are valid).
 */
export function validateRoutingTemplateRefs(): string[] {
  const errors: string[] = [];
  const map = getTemplatesMap();

  const routingPath = resolve(__dirname, '..', '..', 'config', 'github-routing.json');
  const raw = readFileSync(routingPath, 'utf-8');
  const rules = JSON.parse(raw) as Array<{ template: string; event: string; action: string | null }>;

  for (const rule of rules) {
    if (!map.has(rule.template)) {
      errors.push(
        `Routing rule (event=${rule.event}, action=${rule.action}) references ` +
        `template "${rule.template}" which does not exist in workflow-templates.json`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a workflow template by key.
 * Returns undefined if not found.
 */
export function getTemplate(key: string): WorkflowTemplate | undefined {
  return getTemplatesMap().get(key);
}

/**
 * List all registered template keys.
 */
export function listTemplateKeys(): string[] {
  return [...getTemplatesMap().keys()];
}

/**
 * Register a custom template (for extensibility and testing).
 */
export function registerTemplate(template: WorkflowTemplate): void {
  getTemplatesMap().set(template.key, template);
}

/**
 * Unregister a custom template (for test cleanup).
 */
export function unregisterTemplate(key: string): void {
  getTemplatesMap().delete(key);
}

/**
 * Get the default template for a given methodology.
 */
export function getDefaultTemplate(
  methodology: 'sparc-full' | 'sparc-partial' | 'tdd' | 'adhoc',
): WorkflowTemplate | undefined {
  const map = getTemplatesMap();
  switch (methodology) {
    case 'sparc-full': return map.get('feature-build');
    case 'tdd': return map.get('tdd-workflow');
    case 'sparc-partial': return map.get('github-ops');
    case 'adhoc': return map.get('quick-fix');
  }
}
