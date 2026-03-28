# ADR-051: Tech Lead Ambiguity Detection and Clarification System

## Status
Accepted

## Context
The Tech Lead Orchestrator routes user requests to agent team templates by classifying tasks across five dimensions: domain, complexity, risk, scope, and urgency. The classification engine in `tech-lead-router.cjs` uses regex pattern matching against known domain signals and complexity indicators.

When a user submits an ambiguous or vague request such as "make it better", "fix the thing", or "update the auth", the router exhibits degraded behavior:

1. **Domain misclassification** -- Zero or one domain signals match, causing the classifier to fall through to the `backend` default rather than identifying the correct domain.
2. **Artificially low complexity** -- Vague requests trigger few complexity signals, producing scores in the 5-15% range. This forces selection of the `quick-fix` template with 1-2 agents, which may severely underestimate the actual work.
3. **No user feedback loop** -- The system has no mechanism to detect that it lacks sufficient information and no protocol for requesting clarification before committing to a team configuration.
4. **Wasted resources** -- Deploying the wrong team template wastes agent compute time and forces manual correction, which is more expensive than asking a clarifying question upfront.

The existing SKILL.md contains a single anti-drift rule ("If the user's request is ambiguous, ask ONE clarifying question before deploying") but provides no concrete criteria for detecting ambiguity or structure for the clarification interaction.

## Decision
Add an ambiguity detection and clarification subsystem to the Tech Lead router with the following components:

### 1. Ambiguity Scoring Function (`detectAmbiguity`)
A new function that evaluates a task description and returns a numeric ambiguity score (0-100) along with a list of targeted clarifying questions. The score is computed from four signals:

| Signal | Weight | Trigger |
|--------|--------|---------|
| Domain signal count | 30 | 0 matched domains = +30, 1 matched domain = +15 |
| Complexity confidence | 25 | Score < 20% = +25, score < 30% = +15 |
| Vague language presence | 25 | Each vague pronoun/placeholder = +8, capped at 25 |
| Task brevity | 20 | < 3 words = +20, < 5 words = +15, < 8 words = +10 |

Ambiguity thresholds:
- **score >= 50**: High ambiguity -- clarification required before deployment
- **score 30-49**: Moderate ambiguity -- clarification recommended, proceed with defaults if user declines
- **score < 30**: Low ambiguity -- proceed normally

### 2. Question Generation
The function generates targeted, multiple-choice clarifying questions (not open-ended) based on which signals triggered. Each question includes a sensible default the user can accept.

- Maximum 3 questions per clarification round
- Questions are ordered by the signal weight that triggered them
- Each question narrows one classification dimension

### 3. Integration into `makeDecision`
The `makeDecision` function gains a new `ambiguity` field in its return value containing the score, level, questions, and whether clarification is needed. The existing classification and template selection remain unchanged so that callers who ignore the ambiguity field see no behavior change.

### 4. SKILL.md Behavioral Instructions
The skill instructions are updated with a concrete Clarification Protocol section that tells Claude exactly when and how to present clarifying questions to the user.

## Consequences

### Positive
- Prevents misrouting of vague requests to undersized teams
- Reduces wasted agent compute from deploying wrong templates
- Provides structured, predictable clarification UX (targeted questions, not open-ended)
- Backward compatible -- existing callers that ignore the `ambiguity` field are unaffected
- Defaults are always provided so the user can accept them to move fast

### Negative
- Adds one extra interaction round-trip for ambiguous requests (latency cost)
- The vague-word list requires periodic maintenance as usage patterns evolve
- Threshold tuning (30/50) may need adjustment based on real-world usage data

### Neutral
- The ambiguity score is informational -- it does not block execution, only recommends clarification
- The SKILL.md changes are behavioral guidance; enforcement depends on the LLM following instructions

## Options Considered

### Option 1: Heuristic Ambiguity Scoring (Selected)
- **Pros**: Deterministic, fast (<1ms), no external dependencies, easy to tune thresholds, runs in the same CJS module
- **Cons**: Cannot detect semantic ambiguity beyond lexical signals, requires manual maintenance of vague-word lists

### Option 2: LLM-Based Ambiguity Classification
- **Pros**: Better semantic understanding, can detect subtle ambiguity
- **Cons**: Adds latency (500ms-2s), costs per call, creates circular dependency (LLM calling LLM to decide if LLM needs clarification), non-deterministic

### Option 3: Always Ask Clarifying Questions
- **Pros**: Simplest implementation, eliminates all ambiguity
- **Cons**: Annoys users with clear requests, adds unnecessary latency to the majority of well-specified tasks

### Option 4: Confidence Threshold on Existing Classification
- **Pros**: No new code needed, just threshold checks on complexity score
- **Cons**: Complexity score alone is insufficient -- a task can be clearly low-complexity but ambiguous in domain, or vice versa

## Implementation

### Files Modified
- `.claude/helpers/tech-lead-router.cjs` -- Add `detectAmbiguity()` function, update `makeDecision()` output, update exports
- `.claude/skills/tech-lead/SKILL.md` -- Add Clarification Protocol section with detection criteria and question format

### Key Design Decisions
- Ambiguity detection runs before template selection but does not gate it -- the decision is always computed
- Questions are generated dynamically based on which signals triggered, not from a static list
- The `needsClarification` boolean uses the 50-point threshold; the `recommended` flag uses 30-point

## Related Decisions
- ADR-007: CLI Command Structure (commands referenced in clarification flow)
- ADR-005: Swarm Coordination Patterns (team templates that ambiguity detection protects)

## References
- Tech Lead Router: `.claude/helpers/tech-lead-router.cjs`
- Tech Lead Skill: `.claude/skills/tech-lead/SKILL.md`
- MADR 3.0 Format: https://adr.github.io/madr/
