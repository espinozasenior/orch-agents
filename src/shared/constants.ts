/**
 * Shared constants for the Orch-Agents system.
 */

// ---------------------------------------------------------------------------
// Model tier costs (per invocation)
// ---------------------------------------------------------------------------

/** Cost per agent invocation by tier (ADR-026 3-Tier Model Routing). */
export const TIER_COSTS: Record<number, number> = {
  1: 0,       // WASM booster — free
  2: 0.0002,  // Haiku
  3: 0.005,   // Sonnet/Opus
};

/** Default cost for agents with unknown tier. */
export const DEFAULT_AGENT_COST = 0.001;

// ---------------------------------------------------------------------------
// SPARC phase validation
// ---------------------------------------------------------------------------

const VALID_SPARC_PHASES = new Set([
  'specification',
  'pseudocode',
  'architecture',
  'refinement',
  'completion',
]);

/**
 * Validate and filter an array of strings to valid SPARCPhase values.
 * Invalid entries are silently dropped.
 */
export function validateSPARCPhases(phases: string[]): string[] {
  return phases.filter((p) => VALID_SPARC_PHASES.has(p));
}

/**
 * Check if a string is a valid SPARCPhase.
 */
export function isValidSPARCPhase(phase: string): boolean {
  return VALID_SPARC_PHASES.has(phase);
}
