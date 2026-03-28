# Orch-Agents

Autonomous orchestration system that routes GitHub events and user requests through an AI agent swarm using SPARC methodology.

## How It Works

```
GitHub Event / User Request
        |
        v
+---------------------+
|  Tech-Lead Router   |  <-- reads config/team-templates.json (13 templates)
|  (decision matrix)  |      picks template based on event type + complexity
+--------+------------+
         | template key + agent team
         v
+---------------------+
|  Planning Engine    |  <-- loads config/setup.json overrides
|                     |      applies topology/consensus/agent overrides
+--------+------------+
         | WorkflowPlan
         v
+---------------------+
|  Execution Engine   |  <-- spawns agents from .claude/agents/*.md
+---------------------+
```

### 1. Router (Decision Matrix)

The **Tech-Lead Router** (`/.claude/helpers/tech-lead-router.cjs`) classifies incoming work by domain, complexity, scope, and risk. It selects a workflow template from `config/team-templates.json` that defines:

- Which agents to spawn (roles, types, tiers)
- Which SPARC phases to run (specification, pseudocode, architecture, refinement, completion)
- Topology, consensus protocol, and max concurrency

The router's decision matrix acts as the **default preset** -- a hardcoded recommendation for each event type.

### 2. Planning Engine (Override Layer)

The **Planning Engine** (`src/planning/planning-engine.ts`) takes the router's template selection and applies user customizations from `config/setup.json`:

- **Topology override** -- switch from hierarchical to mesh, star, etc.
- **Consensus override** -- raft, pbft, gossip, or none
- **Agent filtering** -- disable agents you don't need
- **Max agents cap** -- limit concurrency

If no `setup.json` exists, the router's defaults are used as-is.

### 3. Execution Engine

The **Execution Engine** (`src/execution/`) spawns the planned agents, runs SPARC phases in sequence, and gates progress on phase-specific criteria (tests pass, review approved, etc.).

## Key Configuration Files

| File | Purpose |
|------|---------|
| `config/team-templates.json` | 13 unified workflow templates (single source of truth) |
| `config/setup.json` | User overrides for topology, agents, events (created by setup wizard) |
| `config/github-routing.json` | Maps GitHub events to template keys |
| `.claude/agents/**/*.md` | 95+ agent definitions with YAML frontmatter |

## Agent Registry

All agents are defined as Markdown files in `.claude/agents/` with YAML frontmatter:

```markdown
---
name: my-agent
type: developer
description: What this agent does
capabilities:
  - code_generation
  - testing
---

# System prompt for the agent...
```

The **Agent Registry** (`src/agent-registry/`) scans these files and serves as the single source of truth for agent discovery. The setup wizard, planning engine, and template validation all use it.

### Agent Categories

Agents are organized by subdirectory:

| Directory | Examples |
|-----------|----------|
| `core/` | coder, tester, reviewer, architect, researcher |
| `sparc/` | sparc-coord, specification, pseudocode, architecture |
| `github/` | pr-manager, code-review-swarm, issue-tracker, release-manager |
| `v3/` | security-architect, memory-specialist, performance-engineer |
| `consensus/` | raft-manager, byzantine-coordinator |

### Creating Custom Agents

Drop a Markdown file in `.claude/agents/<category>/`:

```markdown
---
name: my-custom-agent
type: developer
description: Handles backend API development
capabilities:
  - api_design
  - database_queries
---

You are a backend API specialist...
```

It's automatically discovered by the registry, appears in the setup wizard, and can be referenced in `config/team-templates.json`.

## Setup Wizard

Run the interactive setup wizard to customize your configuration:

```bash
npx tsx src/setup/cli.ts
```

### Presets

| Preset | Agents | Topology | Consensus | Max Agents |
|--------|--------|----------|-----------|------------|
| **Minimal** | coder, tester | star | none | 3 |
| **Standard** | coder, tester, reviewer, architect | hierarchical | raft | 6 |
| **Full SPARC** | all discovered agents | hierarchical-mesh | raft | 8 |
| **Custom** | pick your own | pick your own | pick your own | 2-15 |

The wizard saves to `config/setup.json`. The planning engine reads this file at runtime to override template defaults.

## Workflow Templates

The 13 templates in `config/team-templates.json` cover common workflows:

| Template | Methodology | Use Case |
|----------|-------------|----------|
| `quick-fix` | adhoc | Fast single-phase fixes |
| `feature-build` | sparc-full | New features with full SPARC |
| `sparc-full-cycle` | sparc-full | Dedicated SPARC phase agents |
| `testing-sprint` | tdd | Test-driven bug fixes |
| `security-audit` | sparc-partial | Security review and compliance |
| `performance-sprint` | sparc-partial | Profiling and optimization |
| `release-pipeline` | sparc-partial | Release coordination |
| `fullstack-swarm` | sparc-full | Large cross-cutting work |
| `cicd-pipeline` | sparc-partial | CI validation on push |
| `github-ops` | sparc-partial | PR review, issue triage |
| `tdd-workflow` | tdd | TDD for bug fixes |
| `research-sprint` | adhoc | Deep investigation |
| `monitoring-alerting` | adhoc | Incident response |

## Build & Test

```bash
npm run build    # TypeScript compilation
npm test         # 681 tests
npm run lint     # ESLint
```

## Architecture Overview

```
src/
  intake/           # GitHub webhook normalization
  triage/           # Priority, complexity, intent classification
  planning/         # Decision engine, SPARC decomposer, topology selector
  execution/        # Agent spawning, phase runner, work tracker
  agent-registry/   # Scans .claude/agents/*.md, provides lookup APIs
  setup/            # Wizard, presets, config reader/writer
  shared/           # Event bus, logger, constants, errors

config/
  team-templates.json      # Unified workflow templates
  github-routing.json      # Event-to-template mapping
  setup.json               # User overrides (generated by wizard)

.claude/
  agents/                  # 95+ agent Markdown definitions
  helpers/                 # Tech-lead router, router bridge
```
