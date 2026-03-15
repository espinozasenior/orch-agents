# SPARC Plan: Unified Agent Registry

**Date**: 2026-03-13
**Status**: Draft
**Scope**: Eliminate dual agent registry, make `.claude/agents/**/*.md` the single source of truth

---

## Executive Summary

The project maintains two independent agent registries with zero cross-references:

- **Registry A** (`agents/*.yaml`): 6 thin files, used by setup wizard and config toggles
- **Registry B** (`.claude/agents/**/*.md`): 90+ rich Markdown files with YAML frontmatter, used by Claude Code runtime

Additionally, `tech-lead-router.cjs` references ~22 agent types, 5 of which (`sparc-coder`, `perf-analyzer`, `cicd-engineer`, `system-architect`, `analyst`) exist ONLY in `.claude/agents/**/*.md` frontmatter names and are invisible to the TypeScript planning pipeline.

This plan unifies all consumers onto a single `AgentRegistry` module that reads `.claude/agents/**/*.md` as the canonical source.

---

## Phase 1: Specification

### 1.1 Functional Requirements

| ID | Requirement | Testable Criteria |
|----|-------------|-------------------|
| FR-01 | `AgentRegistry` scans `.claude/agents/**/*.md` recursively and parses YAML frontmatter | Returns 90+ agent definitions from disk |
| FR-02 | Each parsed agent exposes: `name`, `type`, `description`, `capabilities[]`, `color`, `category` (derived from subdirectory), `filePath` | All fields populated for `coder.md` |
| FR-03 | `discoverAgentTypes()` returns agent names from the unified registry instead of `agents/*.yaml` | Returns 90+ names, sorted, includes `sparc-coder` |
| FR-04 | Setup wizard displays all discovered agents with descriptions from frontmatter | `agentDescription()` returns frontmatter description |
| FR-05 | `config/setup.json` `activeAgents[].type` values map to `.claude/agents/` name fields | Existing `setup.json` values resolve to agent definitions |
| FR-06 | `tech-lead-router.cjs` agent type strings resolve to actual `.claude/agents/` definitions | All 22 router types resolve; no orphans |
| FR-07 | `config/workflow-templates.json` agent type references resolve to registry entries | All template agent types exist in registry |
| FR-08 | `agents/*.yaml` directory is deleted | Directory does not exist after migration |
| FR-09 | Registry supports categorized listing (core, sparc, github, v3, etc.) | Can filter by category matching subdirectory name |
| FR-10 | Registry is cached after first scan to avoid re-reading 90+ files per call | Second call returns same instance without disk IO |

### 1.2 Non-Functional Requirements

| ID | Requirement | Criteria |
|----|-------------|---------|
| NF-01 | Registry scan completes in under 200ms for 100 files | Benchmark test proves <200ms |
| NF-02 | Graceful degradation when `.claude/agents/` is missing | Returns empty array, no crash |
| NF-03 | Graceful handling of malformed frontmatter | Logs warning, skips file, continues scan |
| NF-04 | No breaking change to `SetupConfig` schema (version stays 1) | Existing `setup.json` files load without error |
| NF-05 | All existing tests continue to pass | Zero test regressions |

### 1.3 Constraints

- Files must stay under 500 lines (CLAUDE.md rule)
- Must use typed interfaces for all public APIs
- Must follow DDD bounded contexts
- Input validation at system boundaries (malformed frontmatter)
- No new root-level files
- Tests go in `/tests`, source in `/src`

### 1.4 Edge Cases

| Edge Case | Expected Behavior |
|-----------|-------------------|
| Agent MD file has no frontmatter (no `---` block) | Skip file, log warning |
| Agent MD file has frontmatter but no `name` field | Use filename (minus `.md`) as name |
| `name` field does not match filename | Use the `name` field as canonical identity |
| Duplicate `name` across different subdirectories | First-found wins (depth-first), log warning |
| `.claude/agents/` directory does not exist | Return `FALLBACK_AGENT_TYPES` (current 6) |
| `setup.json` references agent type not in registry | Validation warning, agent toggle still stored but flagged |
| MD file has empty frontmatter (`---\n---`) | Skip file |
| Very large MD files (>100KB) | Only read first 2KB for frontmatter extraction |

### 1.5 Agent Name Audit

Current orphan analysis from `tech-lead-router.cjs` TEAM_TEMPLATES:

| Router Type | `.claude/agents/` Location | Status |
|-------------|---------------------------|--------|
| `coder` | `core/coder.md` (name: `coder`) | EXISTS |
| `tester` | `core/tester.md` (name: `tester`) | EXISTS |
| `reviewer` | `core/reviewer.md` (name: `reviewer`) | EXISTS |
| `architect` | Not found by name; closest: `arch-system-design.md` (name: `system-architect`) | MISMATCH - router uses `architect` but MD uses `system-architect` |
| `researcher` | `core/researcher.md` (name: `researcher`) | EXISTS |
| `security-architect` | `v3/security-architect.md` (name: `security-architect`) | EXISTS |
| `security-auditor` | `v3/security-auditor.md` (name: `security-auditor`) | EXISTS |
| `sparc-coord` | `templates/sparc-coordinator.md` (name: `sparc-coord`) | EXISTS |
| `specification` | `sparc/specification.md` (name: `specification`) | EXISTS |
| `pseudocode` | `sparc/pseudocode.md` (name: `pseudocode`) | EXISTS |
| `architecture` | `sparc/architecture.md` (name: `architecture`) | EXISTS |
| `sparc-coder` | `templates/implementer-sparc-coder.md` (name: `sparc-coder`) | EXISTS |
| `performance-engineer` | `v3/performance-engineer.md` (name: `performance-engineer`) | EXISTS |
| `perf-analyzer` | `templates/performance-analyzer.md` (name: `perf-analyzer`) | EXISTS |
| `release-manager` | `github/release-manager.md` (name: `release-manager`) | EXISTS |
| `pr-manager` | `github/pr-manager.md` (name: `pr-manager`) | EXISTS |
| `code-review-swarm` | `github/code-review-swarm.md` (name: `code-review-swarm`) | EXISTS |
| `cicd-engineer` | `devops/ops-cicd-github.md` (name: `cicd-engineer`) | EXISTS |
| `hierarchical-coordinator` | `swarm/hierarchical-coordinator.md` (name: `hierarchical-coordinator`) | EXISTS |
| `system-architect` | `architecture/arch-system-design.md` (name: `system-architect`) | EXISTS |
| `backend-dev` | `development/dev-backend-api.md` (name: `backend-dev`) | EXISTS |
| `analyst` | `analysis/code-analyzer.md` (name: `analyst`) | EXISTS |

**Resolution**: All 5 previously-thought orphan types (`sparc-coder`, `perf-analyzer`, `cicd-engineer`, `system-architect`, `analyst`) DO exist in `.claude/agents/**/*.md` -- they were simply invisible to the TypeScript pipeline because it only scans `agents/*.yaml`.

**One real gap**: The router uses `architect` but no `.claude/agents/` file has `name: architect`. The closest is `name: "system-architect"` in `architecture/arch-system-design.md`. We need either:
- (a) An alias map: `architect` -> `system-architect`, OR
- (b) A new `core/architect.md` file, OR
- (c) Rename the router reference to `system-architect`

**Decision**: Option (a) -- maintain an alias map in the registry for backward compatibility. The setup wizard and `agents/architect.yaml` currently use `architect`; `setup.json` may already contain it.

---

## Phase 2: Pseudocode

### 2.1 Frontmatter Parser

```
FUNCTION parseFrontmatter(fileContent: string) -> AgentFrontmatter | null:
  IF fileContent does not start with "---\n":
    RETURN null

  endIndex = fileContent.indexOf("---", 4)  // find closing ---
  IF endIndex == -1:
    RETURN null

  yamlBlock = fileContent.substring(4, endIndex)
  IF yamlBlock.trim() == "":
    RETURN null

  parsed = yaml.parse(yamlBlock)   // use a lightweight YAML parser
  IF parsed is null OR parsed is not object:
    RETURN null

  RETURN {
    name:         parsed.name ?? null,
    type:         parsed.type ?? null,
    description:  parsed.description ?? null,
    color:        parsed.color ?? null,
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    hooks:        parsed.hooks ?? null,
    version:      parsed.version ?? null,
  }
```

**Complexity**: O(1) per file (frontmatter is bounded to first ~2KB)

**YAML parser choice**: Use the built-in `yaml` npm package (already a dependency via many toolchains) or a minimal frontmatter regex extractor to avoid adding dependencies. Given the project already uses Node.js, we can use a simple regex-based approach for just the frontmatter block, then JSON-parse a simplified form, or use `yaml` from npm.

### 2.2 Directory Scanner

```
FUNCTION scanAgentDirectory(baseDir: string) -> AgentDefinition[]:
  IF not exists(baseDir):
    RETURN []

  results = []
  seen = new Set<string>()   // track duplicate names

  FOR EACH file in recursiveGlob(baseDir, "**/*.md"):
    content = readFirst2KB(file)
    frontmatter = parseFrontmatter(content)

    IF frontmatter is null:
      logger.warn("Skipping file with no frontmatter", { file })
      CONTINUE

    // Derive category from subdirectory
    relativePath = path.relative(baseDir, file)
    category = path.dirname(relativePath).split(path.sep)[0]
    IF category == ".":
      category = "uncategorized"

    // Resolve canonical name
    name = frontmatter.name ?? path.basename(file, ".md")

    IF seen.has(name):
      logger.warn("Duplicate agent name, skipping", { name, file })
      CONTINUE
    seen.add(name)

    results.push({
      name,
      type:         frontmatter.type ?? "generic",
      description:  frontmatter.description ?? "",
      capabilities: frontmatter.capabilities,
      color:        frontmatter.color ?? "#888888",
      category,
      filePath:     file,
      hooks:        frontmatter.hooks,
    })

  SORT results by name
  RETURN results
```

**Complexity**: O(N) where N = number of MD files. Each file reads only first 2KB.

### 2.3 AgentRegistry Interface

```typescript
interface AgentDefinition {
  name: string;            // canonical identifier (e.g., "coder", "sparc-coder")
  type: string;            // frontmatter type field (e.g., "developer", "analyst")
  description: string;     // human-readable description
  capabilities: string[];  // list of capability tags
  color: string;           // UI color hint
  category: string;        // derived from subdirectory (core, sparc, github, v3, etc.)
  filePath: string;        // absolute path to the .md file
  hooks?: {                // optional pre/post hooks from frontmatter
    pre?: string;
    post?: string;
  };
}

interface AgentRegistry {
  /** Get all registered agent definitions */
  getAll(): AgentDefinition[];

  /** Get agent names only (sorted), replaces old discoverAgentTypes() */
  getNames(): string[];

  /** Look up a single agent by name */
  getByName(name: string): AgentDefinition | undefined;

  /** Filter agents by category */
  getByCategory(category: string): AgentDefinition[];

  /** Check if a name resolves (including aliases) */
  has(name: string): boolean;

  /** Resolve an alias to canonical name */
  resolve(nameOrAlias: string): string;

  /** Force re-scan from disk (invalidate cache) */
  refresh(): void;
}
```

### 2.4 Alias Map

```
CONST AGENT_ALIASES: Record<string, string> = {
  "architect": "system-architect",    // setup wizard backward compat
  // Add more aliases as discovered during migration
}

FUNCTION resolve(nameOrAlias: string) -> string:
  RETURN AGENT_ALIASES[nameOrAlias] ?? nameOrAlias
```

### 2.5 Integration Points -- Pseudocode for Refactored Functions

**`discoverAgentTypes()` replacement**:
```
FUNCTION discoverAgentTypes(registry?: AgentRegistry) -> string[]:
  reg = registry ?? getDefaultRegistry()
  names = reg.getNames()
  IF names.length == 0:
    RETURN [...FALLBACK_AGENT_TYPES]
  RETURN names
```

**`agentDescription()` replacement in wizard.ts**:
```
FUNCTION agentDescription(type: string, registry?: AgentRegistry) -> string:
  reg = registry ?? getDefaultRegistry()
  def = reg.getByName(reg.resolve(type))
  RETURN def?.description ?? ""
```

**`tech-lead-router.cjs` validation**:
```
FUNCTION validateRouterAgentTypes(registry: AgentRegistry):
  FOR EACH template IN TEAM_TEMPLATES:
    FOR EACH agent IN template.agents:
      IF NOT registry.has(agent.type):
        WARN("Router references unknown agent type", agent.type)
```

---

## Phase 3: Architecture

### 3.1 Module Placement

The `AgentRegistry` belongs in a new bounded context: **Agent Registry**.

```
src/
  agent-registry/
    agent-registry.ts       // AgentRegistry interface + factory
    frontmatter-parser.ts   // parseFrontmatter() pure function
    directory-scanner.ts    // scanAgentDirectory() with fs access
    aliases.ts              // AGENT_ALIASES constant map
    index.ts                // public API barrel export
```

This follows DDD by isolating the registry concern. Each file stays well under 500 lines.

### 3.2 Dependency Graph Changes

```
BEFORE:
  src/setup/presets.ts ----reads----> agents/*.yaml (fs)
  src/setup/wizard.ts ----calls----> presets.getAgentTypes()
  .claude/helpers/tech-lead-router.cjs (standalone, no TS integration)
  .claude/helpers/router.js (standalone, not imported by TS)

AFTER:
  src/agent-registry/         ----reads----> .claude/agents/**/*.md (fs)
  src/setup/presets.ts         ----imports--> agent-registry
  src/setup/wizard.ts          ----imports--> agent-registry (for descriptions)
  src/planning/sparc-decomposer.ts ----imports--> agent-registry (for validation)
  src/execution/agent-orchestrator.ts ----imports--> agent-registry (for type lookup)
  src/router-bridge.ts        ----imports--> agent-registry (for validation)
  config/workflow-templates.json   (unchanged, validated at startup)
```

### 3.3 What Gets Deleted vs Refactored

| Item | Action |
|------|--------|
| `agents/*.yaml` (6 files) | DELETE after migration |
| `agents/` directory | DELETE (empty after removal) |
| `src/setup/presets.ts` `discoverAgentTypes()` | REFACTOR to delegate to `AgentRegistry` |
| `src/setup/presets.ts` `FALLBACK_AGENT_TYPES` | KEEP as ultimate fallback |
| `src/setup/presets.ts` `DEFAULT_AGENTS_DIR` | REPLACE with `.claude/agents` path |
| `src/setup/presets.ts` `getAgentTypes()` cache | REPLACE with `AgentRegistry` cache |
| `src/setup/wizard.ts` `agentDescription()` | REFACTOR to use registry description |
| `src/setup/types.ts` `AgentToggle` | KEEP as-is (no schema change) |
| `src/setup/config-writer.ts` | NO CHANGE (operates on `AgentToggle[]` abstractly) |
| `src/planning/sparc-decomposer.ts` | NO CHANGE (uses `PlannedAgent.type` strings) |
| `src/execution/agent-orchestrator.ts` | NO CHANGE (spawns by type string) |
| `src/execution/prompt-builder.ts` | OPTIONAL: enrich prompts with registry description |
| `.claude/helpers/tech-lead-router.cjs` | NO CHANGE (CJS stays as-is; validation happens in TS) |
| `.claude/helpers/router.js` | NO CHANGE (standalone, not imported by TS) |
| `config/workflow-templates.json` | NO CHANGE (validated by startup check) |
| `config/setup.json` | NO SCHEMA CHANGE; values now resolve through registry |

### 3.4 Startup Validation

Add a validation step that runs once at module load:

```typescript
function validateAgentReferences(registry: AgentRegistry): void {
  // 1. Validate workflow-templates.json agent types
  const templates = loadWorkflowTemplates();
  for (const template of templates) {
    for (const phase of template.phases) {
      for (const agentType of phase.agents) {
        if (!registry.has(agentType)) {
          logger.warn('workflow-templates.json references unknown agent', { template: template.key, agentType });
        }
      }
    }
  }

  // 2. Validate setup.json activeAgents (if exists)
  const setup = loadSetup();
  if (setup) {
    for (const toggle of setup.activeAgents) {
      if (!registry.has(toggle.type)) {
        logger.warn('setup.json references unknown agent', { type: toggle.type });
      }
    }
  }
}
```

### 3.5 Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                   .claude/agents/**/*.md             │
│  (90+ Markdown files with YAML frontmatter)         │
│  SINGLE SOURCE OF TRUTH                             │
└────────────────────────┬────────────────────────────┘
                         │ reads (cached)
                         ▼
┌─────────────────────────────────────────────────────┐
│              src/agent-registry/                     │
│                                                     │
│  ┌──────────────────┐  ┌────────────────────────┐   │
│  │ frontmatter-     │  │ directory-scanner.ts    │   │
│  │ parser.ts        │  │ - recursiveGlob        │   │
│  │ - parseFrontmatter│  │ - scanAgentDirectory   │   │
│  └────────┬─────────┘  └───────────┬────────────┘   │
│           │                        │                 │
│           ▼                        ▼                 │
│  ┌─────────────────────────────────────────────┐     │
│  │ agent-registry.ts                           │     │
│  │ - AgentDefinition interface                 │     │
│  │ - AgentRegistry interface                   │     │
│  │ - createAgentRegistry() factory             │     │
│  │ - getDefaultRegistry() singleton            │     │
│  └──────────────────────┬──────────────────────┘     │
│                         │                            │
│  ┌──────────────────┐   │                            │
│  │ aliases.ts       │───┘                            │
│  │ AGENT_ALIASES    │                                │
│  └──────────────────┘                                │
└───────────────┬──────────────────────────────────────┘
                │ imported by
    ┌───────────┼───────────────────┐
    ▼           ▼                   ▼
┌────────┐ ┌──────────┐  ┌──────────────────┐
│ setup/ │ │ planning/│  │ execution/       │
│presets │ │ decomp.  │  │ agent-orch.      │
│wizard  │ │ decision │  │ prompt-builder   │
└────────┘ └──────────┘  └──────────────────┘
```

---

## Phase 4: Refinement

### 4.1 Migration Strategy (Backward-Compatible Steps)

The migration proceeds in 5 incremental PRs, each independently shippable:

**Step 1: Create `src/agent-registry/` module (additive only)**
- New files: `frontmatter-parser.ts`, `directory-scanner.ts`, `aliases.ts`, `agent-registry.ts`, `index.ts`
- New tests: `tests/agent-registry/frontmatter-parser.test.ts`, `tests/agent-registry/directory-scanner.test.ts`, `tests/agent-registry/agent-registry.test.ts`
- No existing files modified. Both registries co-exist.

**Step 2: Wire `presets.ts` to use `AgentRegistry` as primary, `agents/*.yaml` as fallback**
- Modify `discoverAgentTypes()` to call `AgentRegistry.getNames()` first, fall back to YAML scan
- Modify `getAgentTypes()` cache to use registry
- Modify `agentDescription()` in `wizard.ts` to use registry descriptions
- Update `tests/setup/setup.test.ts`

**Step 3: Add startup validation**
- Add `validateAgentReferences()` call in server/app startup
- Log warnings for mismatches (non-blocking)

**Step 4: Delete `agents/*.yaml` and remove YAML fallback**
- Remove `agents/` directory
- Remove YAML scanning code from `presets.ts`
- Update tests that reference `agents/*.yaml`
- `FALLBACK_AGENT_TYPES` stays as ultimate emergency fallback

**Step 5: Optional enrichments**
- Enhance `prompt-builder.ts` to include agent description from registry
- Add registry info to `router-bridge.ts` for type validation logging

### 4.2 Test Plan

#### New Tests (TDD -- write first)

| Test File | Test Cases |
|-----------|------------|
| `tests/agent-registry/frontmatter-parser.test.ts` | Parse valid frontmatter; handle missing frontmatter; handle empty frontmatter; handle no name field; handle malformed YAML; handle binary content gracefully |
| `tests/agent-registry/directory-scanner.test.ts` | Scan real `.claude/agents/` directory; return empty for missing directory; skip non-MD files; derive category from subdirectory; handle duplicate names; sort by name |
| `tests/agent-registry/agent-registry.test.ts` | `getAll()` returns all agents; `getNames()` returns sorted names; `getByName()` finds by canonical name; `has()` resolves aliases; `resolve()` maps aliases; `getByCategory()` filters; `refresh()` re-scans; caching works (second call same instance) |
| `tests/agent-registry/integration.test.ts` | All tech-lead-router agent types resolve; all workflow-template agent types resolve; existing setup.json agent types resolve |

#### Existing Tests to Update

| Test File | Changes Needed |
|-----------|---------------|
| `tests/setup/setup.test.ts` | `discoverAgentTypes()` now returns 90+ types instead of 6; update assertions for count and specific names; update fallback test |
| `tests/decision-engine.test.ts` | No change (uses mock router) |
| `tests/sparc-decomposer.test.ts` | No change (uses `PlannedAgent` strings) |
| `tests/execution/agent-orchestrator.test.ts` | No change (uses mock cli-client) |

### 4.3 Handling the 5 "Orphan" Agent Types

Based on the audit in Section 1.5, all 5 types DO exist in `.claude/agents/**/*.md`:

| Type | File | Resolution |
|------|------|------------|
| `sparc-coder` | `templates/implementer-sparc-coder.md` | Automatically discovered by new scanner |
| `perf-analyzer` | `templates/performance-analyzer.md` | Automatically discovered |
| `cicd-engineer` | `devops/ops-cicd-github.md` | Automatically discovered |
| `system-architect` | `architecture/arch-system-design.md` | Automatically discovered |
| `analyst` | `analysis/code-analyzer.md` | Automatically discovered |

The one real gap is `architect` (used in presets, workflow-templates, and setup.json) which maps to `system-architect` in `.claude/agents/`. This is handled by the alias map:

```typescript
const AGENT_ALIASES: Record<string, string> = {
  'architect': 'architecture',  // sparc/architecture.md has name: architecture
};
```

Actually, on closer inspection there are TWO `architect` concepts:
- The SPARC phase agent `architecture` in `sparc/architecture.md` (name: `architecture`)
- The system design agent `system-architect` in `architecture/arch-system-design.md`

The router's `feature-build` template uses `architect` as a role with type `architect`. The existing `agents/architect.yaml` served this purpose. The best resolution is to create a new `.claude/agents/core/architect.md` with appropriate frontmatter, since "architect" is a core agent type used pervasively. This avoids ambiguity with the SPARC `architecture` phase agent.

**Action**: Create `.claude/agents/core/architect.md` with:
```yaml
---
name: architect
type: architect
description: Designs system architecture, evaluates trade-offs, and ensures scalable design
capabilities:
  - system_design
  - architecture_review
  - trade_off_analysis
  - scalability_planning
color: "#9B59B6"
---
```

### 4.4 Performance Considerations

| Concern | Mitigation |
|---------|-----------|
| Scanning 90+ files at startup | Read only first 2KB of each file for frontmatter; total IO ~180KB |
| YAML parsing overhead | Frontmatter blocks are typically <500 bytes; parsing is negligible |
| Cache invalidation | Cache is process-lifetime; `refresh()` available for testing |
| Memory footprint | ~90 `AgentDefinition` objects at ~200 bytes each = ~18KB |
| File system latency | Single recursive readdir + 90 small reads; expect <50ms on SSD |

### 4.5 YAML Parsing Strategy

To avoid adding a new dependency, we have two options:

**Option A**: Use the `yaml` npm package (check if already in dependencies).
**Option B**: Simple regex-based frontmatter extraction -- split on `---`, then parse simple `key: value` and `key:\n  - item` patterns.

**Decision**: Use a simple hand-written parser for the frontmatter fields we need (`name`, `type`, `description`, `capabilities`, `color`). This avoids dependency risk and keeps the module self-contained. A full YAML parser is overkill for flat key-value + single-level arrays.

---

## Phase 5: Completion

### 5.1 File-by-File Change List

#### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/agent-registry/frontmatter-parser.ts` | Pure function to extract YAML frontmatter from MD content | ~80 |
| `src/agent-registry/directory-scanner.ts` | Recursive scan of `.claude/agents/**/*.md` | ~90 |
| `src/agent-registry/aliases.ts` | `AGENT_ALIASES` constant and `resolve()` function | ~30 |
| `src/agent-registry/agent-registry.ts` | `AgentRegistry` interface, factory, singleton | ~120 |
| `src/agent-registry/index.ts` | Barrel exports | ~15 |
| `tests/agent-registry/frontmatter-parser.test.ts` | Parser unit tests | ~120 |
| `tests/agent-registry/directory-scanner.test.ts` | Scanner unit tests | ~100 |
| `tests/agent-registry/agent-registry.test.ts` | Registry integration tests | ~150 |
| `.claude/agents/core/architect.md` | New architect agent definition (fills the gap) | ~40 |

#### Modified Files

| File | Changes |
|------|---------|
| `src/setup/presets.ts` | Replace `discoverAgentTypes()` body to use `AgentRegistry`; keep `FALLBACK_AGENT_TYPES` as emergency fallback; remove `DEFAULT_AGENTS_DIR` pointing to `agents/`; update `getAgentTypes()` to delegate |
| `src/setup/wizard.ts` | Replace hardcoded `agentDescription()` map with registry lookup |
| `tests/setup/setup.test.ts` | Update `discoverAgentTypes()` assertions (90+ agents, not 6); update fallback assertions |

#### Deleted Files

| File | Reason |
|------|--------|
| `agents/architect.yaml` | Replaced by `.claude/agents/core/architect.md` |
| `agents/coder.yaml` | Replaced by `.claude/agents/core/coder.md` |
| `agents/researcher.yaml` | Replaced by `.claude/agents/core/researcher.md` |
| `agents/reviewer.yaml` | Replaced by `.claude/agents/core/reviewer.md` |
| `agents/security-architect.yaml` | Replaced by `.claude/agents/v3/security-architect.md` |
| `agents/tester.yaml` | Replaced by `.claude/agents/core/tester.md` |

#### Unchanged Files (Validated)

| File | Why No Change |
|------|--------------|
| `src/setup/config-writer.ts` | Operates on `AgentToggle[]` abstractly; no agent type resolution |
| `src/setup/types.ts` | `AgentToggle` interface is type-agnostic |
| `src/planning/sparc-decomposer.ts` | Uses string-based agent types from `PlannedAgent` |
| `src/planning/decision-engine.ts` | Receives agents from router bridge, passes through |
| `src/planning/planning-engine.ts` | Orchestrates but does not resolve agent types |
| `src/execution/agent-orchestrator.ts` | Spawns by type string; no registry lookup needed |
| `src/execution/prompt-builder.ts` | Could be enriched later (Step 5) but not required |
| `src/router-bridge.ts` | CJS bridge stays; validation is additive |
| `.claude/helpers/tech-lead-router.cjs` | Standalone CJS; no TS imports needed |
| `.claude/helpers/router.js` | Standalone; not imported by TS pipeline |
| `config/workflow-templates.json` | Agent type strings already match `.claude/agents/` names |
| `config/setup.json` | Schema unchanged; values validated through registry |

### 5.2 Verification Criteria

| Check | How to Verify |
|-------|---------------|
| All tests pass | `npm test` exits 0 |
| Build succeeds | `npm run build` exits 0 |
| Setup wizard shows 90+ agents | Run `npx ts-node src/setup/wizard.ts` in test mode |
| `discoverAgentTypes()` returns 90+ names | Unit test assertion |
| All router agent types resolve | Integration test: iterate TEAM_TEMPLATES, assert `registry.has(type)` |
| All workflow-template agent types resolve | Integration test: load JSON, assert each agent string resolves |
| `config/setup.json` loads without error | Existing test in `setup.test.ts` |
| No `agents/*.yaml` files remain | `ls agents/` returns error (directory deleted) |
| Lint passes | `npm run lint` exits 0 |
| Frontmatter parsing handles edge cases | Unit tests for malformed, missing, empty frontmatter |

### 5.3 Rollback Plan

Each step is independently reversible:

1. **Step 1 rollback**: Delete `src/agent-registry/` and `tests/agent-registry/`. No other files were changed.
2. **Step 2 rollback**: Revert `presets.ts` and `wizard.ts` to use YAML scanning. The `agent-registry/` module can stay (unused).
3. **Step 3 rollback**: Remove validation call from startup.
4. **Step 4 rollback**: Restore `agents/*.yaml` from git history (`git checkout HEAD~1 -- agents/`). Re-add YAML scanning code.
5. **Step 5 rollback**: Revert optional enrichments.

### 5.4 Estimated Effort

| Step | Effort | Risk |
|------|--------|------|
| Step 1: New module | 2-3 hours | Low (additive) |
| Step 2: Wire presets | 1-2 hours | Medium (behavior change) |
| Step 3: Validation | 30 min | Low (logging only) |
| Step 4: Delete YAML | 30 min | Medium (irreversible without git) |
| Step 5: Enrichments | 1 hour | Low (optional) |
| **Total** | **5-7 hours** | |

### 5.5 Open Questions

1. **Duplicate files**: Several `.claude/agents/` entries appear duplicated across subdirectories (e.g., `development/dev-backend-api.md` AND `development/backend/dev-backend-api.md`). Should we deduplicate these as part of this work, or defer?
   - **Recommendation**: Defer. The scanner handles duplicates by first-found-wins. Clean up in a follow-up PR.

2. **Setup wizard UX with 90+ agents**: The current wizard shows a multi-select list. With 90+ agents, this becomes unwieldy. Should we group by category?
   - **Recommendation**: Yes, but defer the UX improvement. For now, show all agents sorted. The `category` field enables future grouping.

3. **Preset agent lists**: The `minimal` preset hardcodes `['coder', 'tester']` and `standard` hardcodes `['coder', 'tester', 'reviewer', 'architect']`. These should continue to work via the alias system (`architect` -> resolves through registry).
   - **Recommendation**: No change to preset definitions. They reference names that exist in the registry (either directly or via alias).

---

## Appendix A: Unique Agent Names from `.claude/agents/**/*.md`

Extracted from frontmatter `name:` fields (deduplicated):

```
adaptive-coordinator, adr-architect, agentic-payments, aidefence-guardian,
analyst, api-docs, architecture, backend-dev, base-template-generator,
benchmark-suite, browser-agent, byzantine-coordinator, cicd-engineer,
claims-authorizer, code-analyzer, code-review-swarm, codex-coordinator,
codex-worker, coder, collective-intelligence-coordinator, consensus-coordinator,
crdt-synchronizer, ddd-domain-expert, dual-orchestrator, flow-nexus-app-store,
flow-nexus-auth, flow-nexus-challenges, flow-nexus-neural, flow-nexus-payments,
flow-nexus-sandbox, flow-nexus-swarm, flow-nexus-user-tools, flow-nexus-workflow,
github-modes, goal-planner, gossip-coordinator, hierarchical-coordinator,
injection-analyst, issue-tracker, load-balancing-coordinator, matrix-optimizer,
memory-coordinator, memory-specialist, mesh-coordinator, ml-developer,
mobile-dev, multi-repo-swarm, pagerank-analyzer, perf-analyzer,
performance-benchmarker, performance-engineer, performance-monitor,
performance-optimizer, pii-detector, planner, pr-manager,
production-validator, project-board-sync, pseudocode, queen-coordinator,
raft-manager, reasoningbank-learner, refinement, release-manager,
release-swarm, repo-architect, researcher, resource-allocator,
reviewer, scout-explorer, security-architect, security-architect-aidefence,
security-auditor, security-manager, smart-agent, sona-learning-optimizer,
sparc-coder, sparc-coord, sparc-orchestrator, spec-mobile-react-native,
specification, sublinear-goal-planner, swarm-init, swarm-issue,
swarm-memory-manager, swarm-pr, sync-coordinator, system-architect,
task-orchestrator, tdd-london-swarm, test-long-runner, tester,
topology-optimizer, trading-predictor, v3-integration-architect,
worker-specialist, workflow-automation
```

Total unique names: ~95

## Appendix B: Category Distribution

| Category | Count | Examples |
|----------|-------|---------|
| core | 5 | coder, planner, researcher, reviewer, tester |
| v3 | 13 | security-architect, performance-engineer, memory-specialist, ... |
| github | 13 | pr-manager, release-manager, code-review-swarm, ... |
| templates | 8 | sparc-coder, sparc-coord, perf-analyzer, ... |
| consensus | 7 | raft-manager, byzantine-coordinator, ... |
| flow-nexus | 9 | flow-nexus-auth, flow-nexus-swarm, ... |
| sparc | 4 | specification, pseudocode, architecture, refinement |
| optimization | 5 | load-balancer, topology-optimizer, ... |
| swarm | 3 | hierarchical-coordinator, mesh-coordinator, adaptive-coordinator |
| sublinear | 5 | matrix-optimizer, trading-predictor, ... |
| hive-mind | 4 | queen-coordinator, worker-specialist, ... |
| Other | ~19 | analysis, architecture, development, devops, testing, ... |
