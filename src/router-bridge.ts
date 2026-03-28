/**
 * TypeScript bridge for the existing tech-lead-router CJS module.
 *
 * Provides typed wrappers around the CJS functions so that TypeScript
 * bounded contexts can call the router without importing raw CJS.
 *
 * Migration path: This bridge is used during Phases 0-2. At Phase 7
 * the router will be migrated to native TypeScript.
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// CJS module types (match the exported API of tech-lead-router.cjs)
// ---------------------------------------------------------------------------

interface ComplexityResult {
  level: 'low' | 'medium' | 'high';
  percentage: number;
}

interface ClassificationResult {
  domain: string;
  complexity: ComplexityResult;
  scope: string;
  risk: string;
}

interface AmbiguityResult {
  level: string;
  score: number;
  needsClarification: boolean;
}

interface RouterDecision {
  template: string;
  classification: ClassificationResult;
  ambiguity: AmbiguityResult;
  agents: Array<{ role: string; type: string; tier: number }>;
  topology: string;
  strategy: string;
}

interface TechLeadRouter {
  makeDecision: (task: string) => RouterDecision;
  classifyDomain: (task: string) => string;
  classifyComplexity: (task: string) => ComplexityResult;
  selectTemplate: (classification: ClassificationResult) => string;
  detectAmbiguity: (task: string) => AmbiguityResult;
  TEAM_TEMPLATES: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Load CJS module once
// ---------------------------------------------------------------------------

const ROUTER_PATH = path.resolve(
  __dirname,
  '..',
  '.claude',
  'helpers',
  'tech-lead-router.cjs',
);

let _router: TechLeadRouter | undefined;

function getRouter(): TechLeadRouter {
  if (!_router) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _router = require(ROUTER_PATH) as TechLeadRouter;
  }
  return _router;
}

// ---------------------------------------------------------------------------
// Public typed API
// ---------------------------------------------------------------------------

/**
 * Run the full decision pipeline on a task description.
 */
export function makeDecision(task: string): RouterDecision {
  return getRouter().makeDecision(task);
}

/**
 * Classify the domain of a task description.
 */
export function classifyDomain(task: string): string {
  return getRouter().classifyDomain(task);
}

/**
 * Classify the complexity of a task description.
 */
export function classifyComplexity(task: string): ComplexityResult {
  return getRouter().classifyComplexity(task);
}

/**
 * Select a team template based on classification results.
 */
export function selectTemplate(classification: ClassificationResult): string {
  return getRouter().selectTemplate(classification);
}

/**
 * Detect ambiguity in a task description.
 */
export function detectAmbiguity(task: string): AmbiguityResult {
  return getRouter().detectAmbiguity(task);
}

/**
 * Access the team templates dictionary.
 */
export function getTeamTemplates(): Record<string, unknown> {
  return getRouter().TEAM_TEMPLATES;
}
