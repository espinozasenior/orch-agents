# Orch-Agents

An automated pipeline that listens for GitHub webhooks (push, PR, issues, etc.) and dispatches AI agents to handle the work — code review, bug fixes, testing, deployments, and more.

## How It Works (The Big Picture)

```
GitHub Webhook (e.g. "PR opened")
    |
    v
1. INTAKE    -- What happened? Parse the webhook payload
    |
    v
2. TRIAGE    -- How urgent is it? Score priority (P0-P3)
    |
    v
3. PLANNING  -- What agents do we need? Pick a workflow template
    |
    v
4. EXECUTION -- Run the agents! Each gets a prompt with full context
    |
    v
5. REVIEW    -- Did it work? Check quality gates
```

Each step is configured by a JSON file you can edit. No code changes needed.

## Quick Start

```bash
npm install
npm run build
npm start          # Starts the server on port 3000
```

Send a test webhook:
```bash
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"ref": "refs/heads/main", "repository": {"full_name": "my/repo"}}'
```

## Configuration (The 3 Files You Can Edit)

The pipeline is controlled by 3 JSON files in the `config/` folder. Together they form a **decision matrix** — you decide what happens for each GitHub event.

### File 1: `config/github-routing.json` — "When X happens, do Y"

Maps GitHub events to a workflow. Think of it as "if this, then that" rules.

```
GitHub Event  +  Action  +  Condition  -->  Intent  +  Template
─────────────────────────────────────────────────────────────────
push             —          main branch     validate-main    cicd-pipeline
push             —          other branch    validate-branch  quick-fix
pull_request     opened     —               review-pr        github-ops
issues           labeled    bug             fix-bug          tdd-workflow
issues           labeled    enhancement     build-feature    feature-build
release          published  —               deploy-release   release-pipeline
```

**To change:** Edit the JSON array. Each entry has `event`, `action`, `condition`, `intent`, and `template`.

### File 2: `config/workflow-templates.json` — "Who works on it and how"

Defines the agent team for each template. This is where you control cost, speed, and quality.

Each template has:

```json
{
  "key": "github-ops",
  "name": "GitHub Operations",
  "phases": [
    {
      "type": "specification",
      "agents": ["architect"],
      "gate": "spec-approved",
      "skippable": true
    },
    {
      "type": "refinement",
      "agents": ["reviewer", "coder"],
      "gate": "review-approved",
      "skippable": false
    }
  ],
  "defaultAgents": [
    { "role": "lead",        "type": "architect", "tier": 3, "required": false },
    { "role": "reviewer",    "type": "reviewer",  "tier": 2, "required": true },
    { "role": "implementer", "type": "coder",     "tier": 2, "required": true }
  ],
  "topology": "hierarchical",
  "maxAgents": 5
}
```

#### What Each Field Means

**`phases`** — The steps agents go through, in order. Like a checklist.

| Phase | What happens |
|-------|-------------|
| `specification` | Agent reads the task and writes a plan |
| `pseudocode` | Agent designs the algorithm |
| `architecture` | Agent designs the system structure |
| `refinement` | Agent writes/fixes the actual code |
| `completion` | Agent runs final checks, deploys |

More phases = more thorough but slower. A quick bug fix might only need `refinement`. A new feature might need all 5.

Each phase has:
- **`agents`** — Which agent types work on this phase (they run in parallel)
- **`gate`** — A quality check that must pass before moving on (e.g., "tests-pass")
- **`skippable`** — If `true`, a failed gate skips the phase instead of stopping everything

**`defaultAgents`** — The team of AI agents assigned to this workflow.

Each agent has:

| Field | What it means | Example |
|-------|--------------|---------|
| `role` | The job title (for logging/identification) | `"lead"`, `"implementer"`, `"validator"` |
| `type` | The agent specialization | `"coder"`, `"tester"`, `"architect"`, `"reviewer"` |
| `tier` | The AI model power level (see below) | `1`, `2`, or `3` |
| `required` | Must this agent spawn? `true` = plan fails without it | `true` or `false` |

**`tier`** — This is the biggest cost/quality knob:

| Tier | Model | Speed | Cost per call | Best for |
|------|-------|-------|---------------|----------|
| 1 | WASM (local) | <1ms | Free | Simple transforms (rename vars, add types) |
| 2 | Haiku | ~500ms | ~$0.0002 | Routine tasks (tests, simple fixes) |
| 3 | Sonnet/Opus | 2-5s | ~$0.003-0.015 | Complex reasoning (architecture, security) |

**`topology`** — How agents coordinate:

| Topology | How it works | When to use |
|----------|-------------|-------------|
| `star` | One leader, agents work independently | Simple tasks, 2-3 agents |
| `hierarchical` | Leader delegates to sub-leads | Medium tasks, 4-6 agents |
| `hierarchical-mesh` | Full coordination between all agents | Complex tasks, 6+ agents |

**`consensus`** — How agents agree on results:

| Consensus | How it works | When to use |
|-----------|-------------|-------------|
| `none` | No coordination overhead | Quick fixes, independent work |
| `raft` | Leader-based agreement | Most workflows |
| `pbft` | Byzantine fault tolerant | Critical/security work |

**`maxAgents`** — Hard limit on how many agents can run at once. Controls your cost ceiling.

### File 3: `config/urgency-rules.json` — "How urgent is it?"

Controls the priority scoring. Adjusts how labels, file types, and PR size affect urgency.

## Common Recipes

### "Make PR reviews cheaper"

Edit `config/workflow-templates.json`, find `github-ops`, change the architect from tier 3 to tier 2:

```json
{ "role": "lead", "type": "architect", "tier": 2, "required": false }
```

### "Add security scanning to bug fixes"

Edit `config/workflow-templates.json`, find `tdd-workflow`, add to `defaultAgents`:

```json
{ "role": "security", "type": "security-architect", "tier": 3, "required": false }
```

### "Skip the specification phase for quick fixes"

Edit `config/workflow-templates.json`, find `quick-fix`, and the `phases` array only has `refinement` — it already skips specification. To add it optionally:

```json
{ "type": "specification", "agents": ["architect"], "gate": "spec-approved", "skippable": true }
```

The `"skippable": true` means it won't block the pipeline if the gate fails.

### "Prevent the bot from responding to its own comments"

Set the `BOT_USERNAME` environment variable to your bot's GitHub username:

```bash
BOT_USERNAME=my-bot-account npm start
```

This does two things:
1. Drops any webhook where the sender matches the bot username (prevents infinite loops)
2. Makes `mentions_bot` routing rules only match comments that contain `@my-bot-account`

Without this, every `issue_comment` event will match — including the bot's own replies.

### "Ignore issue comments entirely"

Edit `config/github-routing.json`, remove the entry with `"event": "issue_comment"`.

## Environment Variables

| Variable | Default | What it does |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Log verbosity: `trace`, `debug`, `info`, `warn`, `error` |
| `ENABLE_TASK_AGENTS` | `false` | Enable real AI agent execution (otherwise runs in stub mode) |
| `ENABLE_AGENTS` | `false` | Enable CLI lifecycle agents (legacy mode) |
| `BOT_USERNAME` | *(none)* | GitHub username of the bot. Prevents the bot from processing its own comments (infinite loop prevention). Also makes `mentions_bot` routing rules require an actual `@<username>` mention instead of matching all comments. |
| `NODE_ENV` | `development` | Set to `production` for production logging |

## Build and Test

```bash
npm run build    # TypeScript compile
npm test         # Run all tests
npm run lint     # Run linter
npm start        # Start server (loads .env automatically)
```

## Project Structure

```
config/                  # Editable JSON configuration
  github-routing.json    # Event -> intent -> template mapping
  workflow-templates.json # Template -> agent teams, phases
  urgency-rules.json     # Priority scoring rules

src/
  intake/                # Webhook parsing + normalization
  triage/                # Priority scoring
  planning/              # Workflow template selection + plan creation
  execution/             # Agent spawning + phase execution
  review/                # Quality gate checking
  shared/                # Logger, event bus, error types
  pipeline.ts            # Wires everything together
  index.ts               # HTTP server entry point

tests/                   # All test files (TDD London School)
docs/sparc/              # SPARC methodology plans
```
