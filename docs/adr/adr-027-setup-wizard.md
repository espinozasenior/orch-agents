# ADR-027: Interactive CLI Setup Wizard

**Status:** Proposed
**Date:** 2026-03-13
**Context:** The orch-agents system requires manual JSON editing for configuration. Users must understand the internal structure of `workflow-templates.json`, `github-routing.json`, and `urgency-rules.json` before they can start. No interactive onboarding path exists.

---

## Decision

Introduce an interactive CLI setup wizard invoked via `npx orch-agents setup`. The wizard produces a single `config/setup.json` file containing user overrides that merge on top of the default JSON configs at load time.

---

## Architecture

### 1. File Structure

```
src/setup/
  wizard.ts            -- Orchestrator: step sequencing, state accumulation
  prompts.ts           -- Pure functions: build prompt data for each step
  renderer.ts          -- ANSI terminal rendering: multi-select, single-select, numeric input
  config-writer.ts     -- Serialize WizardState to config/setup.json, merge logic
  types.ts             -- All wizard-specific interfaces
  presets.ts           -- Preset definitions (Minimal, Standard, Full SPARC, Custom)
```

Each file stays under 500 lines. Responsibilities are cleanly separated:

| File | Responsibility | Testability |
|------|---------------|-------------|
| `types.ts` | Type definitions only | N/A (no logic) |
| `presets.ts` | Pure data: preset configurations | Trivially testable, no IO |
| `prompts.ts` | Pure functions: given current state, return prompt config | Pure, no IO |
| `renderer.ts` | Thin IO layer: readline + ANSI escape codes | Integration-tested or mocked |
| `wizard.ts` | Step sequencer: calls prompts, passes to renderer, accumulates state | Testable with renderer mock |
| `config-writer.ts` | Merge logic + fs.writeFileSync | Merge logic is pure; IO layer is thin |

### 2. Key Interfaces

```typescript
// src/setup/types.ts

/** The complete output of the wizard, persisted as config/setup.json */
export interface SetupConfig {
  version: 1;
  createdAt: string;
  activeAgents: AgentToggle[];
  githubEvents: EventToggle[];
  preset: PresetKey;
  topology: TopologyChoice;
  maxAgents: number;
  consensus: ConsensusChoice;
  swarmStrategy: StrategyChoice;
}

export interface AgentToggle {
  type: string;       // e.g. "coder", "tester", "security-architect"
  enabled: boolean;
}

export interface EventToggle {
  event: string;      // e.g. "push", "pull_request"
  action: string | null;
  condition: string | null;
  enabled: boolean;
}

export type PresetKey = 'minimal' | 'standard' | 'full-sparc' | 'custom';
export type TopologyChoice = 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'ring' | 'star' | 'adaptive';
export type ConsensusChoice = 'raft' | 'pbft' | 'none';
export type StrategyChoice = 'specialized' | 'balanced' | 'minimal';

/** Generic prompt descriptor passed from prompts.ts to renderer.ts */
export interface MultiSelectPrompt<T> {
  title: string;
  instructions: string;
  items: SelectItem<T>[];
}

export interface SingleSelectPrompt<T> {
  title: string;
  instructions: string;
  items: SelectItem<T>[];
}

export interface NumericPrompt {
  title: string;
  instructions: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface SelectItem<T> {
  label: string;
  value: T;
  description?: string;
  selected: boolean;
}

/** Abstraction over readline for testability */
export interface TerminalIO {
  write(text: string): void;
  readKey(): Promise<KeyPress>;
  clearScreen(): void;
  close(): void;
}

export interface KeyPress {
  name: string;       // 'up', 'down', 'space', 'return', 'q', etc.
  ctrl: boolean;
}
```

### 3. Interactive UI Component Design (ANSI-based)

The renderer uses only Node.js built-in `readline` and raw ANSI escape codes. No external dependencies.

#### 3.1 Terminal Control

```
ANSI codes used:
  \x1b[?25l        -- hide cursor
  \x1b[?25h        -- show cursor
  \x1b[nA          -- move cursor up n lines
  \x1b[2K          -- clear current line
  \x1b[36m          -- cyan (highlight)
  \x1b[32m          -- green (selected)
  \x1b[90m          -- dim/gray
  \x1b[1m           -- bold
  \x1b[0m           -- reset
```

#### 3.2 Multi-Select Component

Used for agent selection and GitHub event toggles.

```
  Select Active Agents (space=toggle, up/down=move, enter=confirm)

  > [x] coder          Code generation, refactoring, debugging
    [x] tester         Test writing and validation
    [x] reviewer       Code review and quality checks
    [ ] architect      System design and architecture
    [ ] security-architect   Security analysis and threat modeling
    [ ] researcher     Research and information gathering

  3 of 6 selected
```

Rendering algorithm:
1. Hide cursor
2. Print title + instructions
3. For each item: print prefix (cursor indicator `>` or space), checkbox (`[x]` or `[ ]`), label, description
4. Print footer with count
5. On keypress: update in-memory state, move cursor up N lines, redraw all items
6. On enter: show cursor, return selected items

The renderer never uses `console.clear()`. Instead it overwrites in-place by moving the cursor up by the number of rendered lines, then rewriting each line with `\x1b[2K` (clear line) before printing the new content. This avoids flicker.

#### 3.3 Single-Select Component

Used for preset selection, topology, consensus.

```
  Choose Workflow Preset (up/down=move, enter=confirm)

    ( ) Minimal       3 agents, star topology, push events only
  > (*) Standard      5 agents, hierarchical, common GitHub events
    ( ) Full SPARC    8 agents, hierarchical-mesh, all events + security
    ( ) Custom        Configure each setting individually
```

Same rendering approach as multi-select but with radio buttons and mutual exclusion.

#### 3.4 Numeric Input Component

Used for max agents.

```
  Set Maximum Concurrent Agents (type number, enter=confirm)

  > 8     (range: 1-15, default: 8)
```

Captures digit keypresses, validates against min/max on confirm.

#### 3.5 Review/Summary Screen

```
  ── Setup Summary ──────────────────────────────

  Preset:     Standard
  Topology:   hierarchical
  Consensus:  raft
  Strategy:   specialized
  Max Agents: 8

  Active Agents:
    coder, tester, reviewer, architect

  GitHub Events:
    push (default branch)          enabled
    pull_request.opened            enabled
    pull_request.synchronize       enabled
    issues.opened                  enabled
    workflow_run.completed         disabled
    release.published              disabled

  Save to config/setup.json? (y/n)
```

### 4. Wizard Step Sequencing

The wizard orchestrator in `wizard.ts` follows a linear pipeline with an early-exit optimization for presets:

```
Step 1: Welcome screen + detect existing config/setup.json
Step 2: Choose Preset (minimal | standard | full-sparc | custom)
         |
         +-- If not "custom": apply preset defaults, skip to Step 6
         |
Step 3: Select Active Agents (multi-select)
Step 4: Toggle GitHub Events (multi-select)
Step 5: Configure Topology (single-select) + Max Agents (numeric) + Consensus (single-select)
Step 6: Review & Confirm
Step 7: Write config/setup.json
```

The `wizard.ts` function signature:

```typescript
export async function runWizard(io: TerminalIO): Promise<SetupConfig | null>
```

Returns null if the user cancels (Ctrl+C or 'q' at any step). The `TerminalIO` injection makes the entire wizard testable without a real terminal.

### 5. Preset Definitions

Defined in `presets.ts` as plain data objects:

| Preset | Agents | Topology | Max | Events | Consensus |
|--------|--------|----------|-----|--------|-----------|
| Minimal | coder, tester | star | 3 | push (default branch), PR opened | none |
| Standard | coder, tester, reviewer, architect | hierarchical | 6 | push, PR opened/sync/merged, issues opened, workflow failures | raft |
| Full SPARC | all 6 agents | hierarchical-mesh | 8 | all 14 events enabled | raft |
| Custom | (user picks) | (user picks) | (user picks) | (user picks) | (user picks) |

Each preset is a complete `Omit<SetupConfig, 'version' | 'createdAt'>` object. The "Custom" preset just sets sensible defaults that the user then modifies in subsequent steps.

### 6. Config Merge Strategy (setup.json integration)

#### 6.1 The setup.json file

Written to `config/setup.json`. This file is the single source of user overrides. It never replaces the default JSON configs; it layers on top.

#### 6.2 Merge semantics

The merge happens at config load time, not at wizard time. This requires a small change to `template-library.ts` (and similar for routing/urgency).

```
Load order:
  1. config/workflow-templates.json  (defaults, checked into repo)
  2. config/github-routing.json      (defaults, checked into repo)
  3. config/urgency-rules.json       (defaults, checked into repo)
  4. config/setup.json               (user overrides, gitignored)

Merge rules:
  - activeAgents: filter workflow template defaultAgents arrays.
    If an agent type is disabled, it is removed from all template
    defaultAgents lists (and its phases are adjusted if no agents remain).
  - githubEvents: filter github-routing.json entries.
    Disabled events are excluded from the routing table at load time.
  - topology/maxAgents/consensus/swarmStrategy: override the
    TopologySelector defaults. The selector still runs its heuristics
    but the setup.json values become the floor/ceiling constraints.
  - preset: informational only (stored for display, not used in logic).
```

#### 6.3 Integration point

A new function in `config-writer.ts`:

```typescript
/** Load setup.json if it exists, return null if not found. */
export function loadSetupConfig(): SetupConfig | null

/** Apply setup overrides to a routing rules array. */
export function applyEventOverrides(
  rules: RoutingRule[],
  toggles: EventToggle[]
): RoutingRule[]

/** Apply setup overrides to a template's agent list. */
export function applyAgentOverrides(
  agents: PlannedAgent[],
  toggles: AgentToggle[]
): PlannedAgent[]

/** Apply topology constraints from setup to a TopologySelection. */
export function applyTopologyOverrides(
  selection: TopologySelection,
  setup: SetupConfig
): TopologySelection
```

The existing `template-library.ts` gains a single new call at the end of `loadTemplatesFromDisk()`:

```typescript
// After loading templates from disk:
const setup = loadSetupConfig();
if (setup) {
  for (const [key, template] of map) {
    template.defaultAgents = applyAgentOverrides(template.defaultAgents, setup.activeAgents);
  }
}
```

Similarly, the GitHub normalizer / routing loader applies `applyEventOverrides` to filter disabled events.

The topology selector applies `applyTopologyOverrides` as a post-processing step.

This approach means:
- Default configs remain the source of truth for the full system definition
- setup.json is purely subtractive/constraining (never adds new templates or events)
- Deleting setup.json restores full defaults with zero side effects
- The merge functions are pure and independently testable

### 7. Entry Point

The `npx orch-agents setup` command is wired through `package.json` bin field:

```json
{
  "bin": {
    "orch-agents": "./dist/cli.ts"
  }
}
```

A minimal `src/cli.ts` dispatches subcommands:

```typescript
const command = process.argv[2];
if (command === 'setup') {
  const { runWizard } = await import('./setup/wizard.js');
  const io = createTerminalIO();  // real readline-based IO
  const result = await runWizard(io);
  if (result) {
    console.log('Configuration saved to config/setup.json');
  }
  process.exit(0);
}
```

---

## Quality Attributes

| Attribute | How Addressed |
|-----------|--------------|
| Testability | All logic in pure functions (prompts.ts, presets.ts, config-writer.ts merge functions). Renderer is behind TerminalIO interface. |
| Zero dependencies | Uses only Node.js built-in readline and ANSI codes. |
| Maintainability | Each file has a single responsibility, all under 500 lines. |
| Extensibility | New wizard steps = new prompt function + new field in SetupConfig. New agent types = add to agents/*.yaml, wizard discovers them. |
| Reversibility | Delete config/setup.json to restore defaults. |
| Discoverability | Presets provide guided paths; Custom mode exposes all options. |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Terminal compatibility (Windows cmd, non-TTY) | Detect `process.stdout.isTTY`. If false, fall back to simple line-by-line prompts without ANSI codes. |
| Agent list gets out of sync with agents/*.yaml | Wizard reads agents/*.yaml at runtime via glob to build the multi-select list dynamically. |
| setup.json conflicts with template changes | Version field in setup.json. On version mismatch, wizard warns and offers to re-run. |
| ANSI rendering flicker | Overwrite-in-place strategy (cursor up + clear line) instead of full screen clear. |

## Alternatives Considered

1. **Modify JSON configs in-place** -- Rejected. Destructive; loses defaults; merge conflicts with upstream changes.
2. **Environment variables for overrides** -- Rejected. Too many knobs (agents, events, topology) for env vars. Good for secrets (already used), bad for structured config.
3. **YAML config file** -- Rejected. Would add a YAML parser dependency or require the js-yaml package. JSON is sufficient and already used throughout.
4. **Web-based config UI** -- Rejected. Violates zero-UI-dependency constraint. Overkill for initial setup.
