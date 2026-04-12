# Orch-Agents: Building an AI-Native Startup from Day One

> A practical walkthrough mapping the five AI-native principles to the orch-agents system.
> Companion to Episode #3 of the AI-Native Startup series.

---

## What This Walkthrough Covers

Orch-agents is an **Autonomous Development Agency** — a system that watches GitHub repos and Linear boards, dispatches AI agent swarms, and delivers reviewed code changes with quality gates. It is, by design, an AI-native product built for AI-native companies.

This guide walks through how to launch orch-agents as a safe and successful startup by applying five foundational principles. Each principle maps directly to architecture decisions already embedded in the codebase, plus concrete steps for operators and founders.

---

## Principle 1: Make the Company Machine-Legible

**The idea**: If context lives only in people's heads, it does not belong to the company yet. Turn relevant work into artifacts — notes, decisions, specs, plans — that machines can read.

### How orch-agents implements this

**WORKFLOW.md as the single source of truth.** Every routing rule, agent template, event trigger, and team configuration lives in one markdown file that both humans and machines parse:

```yaml
# WORKFLOW.md (excerpt)
templates:
  tdd-workflow: [coder, tester]
  feature-build: [architect, coder, reviewer]
github:
  events:
    pull_request.opened: github-ops
    issues.labeled.bug: tdd-workflow
```

No hidden config. No tribal knowledge about "which webhook does what." The machine reads the same document the team reads.

**Agent definitions are markdown files.** Each agent's system prompt, tools, and constraints are stored as `.md` files in `.claude/agents/`. New team members (human or AI) read the same specs.

**Event traces everywhere.** The event bus (`IntakeCompleted`, `TriageScored`, `ExecutionStarted`) produces a legible audit trail. Every decision the system makes is traceable.

### Startup checklist for Principle 1

- [ ] **Create your WORKFLOW.md** — Define event routes, agent templates, and workspace repos. This is your company's operating playbook in machine-readable form.
- [ ] **Document decisions as ADRs** — The `docs/adr/` directory captures architectural choices. Each ADR has status, context, decision, and consequences. Machines can parse these; new team members can onboard from them.
- [ ] **Transcribe and store meetings** — If a decision happened in a call, it should land in a searchable artifact. Tools like Granola (already integrated via MCP) capture meeting transcripts automatically.
- [ ] **Use plain text defaults** — Markdown for docs, YAML for config, TypeScript for code. Avoid proprietary formats that lock context into tools only humans can navigate.

### What to avoid

- Stuffing configuration into environment variables that nobody documents
- "Hallway decisions" that never reach WORKFLOW.md or an ADR
- Over-structuring too early — legibility matters more than schema perfection at this stage

---

## Principle 2: Choose Tools by Visibility and Portability

**The idea**: Pick tools that expose their state through standard interfaces. If a tool cannot be read by your agents, its knowledge is trapped.

### How orch-agents implements this

**MCP (Model Context Protocol) as the integration layer.** The `.mcp.json` file declares available servers — GitHub, Linear, Chrome, Excalidraw, Gmail, Calendar. Every tool speaks the same protocol, and agents discover capabilities through `ToolSearch`.

**Deferred tool loading (P12).** Tools are not hardcoded. The registry loads them on demand via `ToolSearch`, keeping the system open to new integrations without code changes:

```
Built-in: Read, Edit, Write, Bash, Grep, Glob, Agent
Extended: Any MCP server declared in .mcp.json
```

**GitHub and Linear as first-class citizens.** Not because they are the only options, but because they expose rich APIs (REST, GraphQL, webhooks) that agents can read and write. The system uses `gh` CLI for GitHub and GraphQL for Linear — both portable, both scriptable.

### Startup checklist for Principle 2

- [ ] **Audit your tool stack for API access** — Every tool your team uses should have an API or MCP adapter. If it does not, the knowledge it holds is invisible to your agents.
- [ ] **Configure `.mcp.json`** — Declare every MCP server your agents need. Start with GitHub and your issue tracker (Linear, Jira, etc.).
- [ ] **Prefer open protocols** — OAuth over proprietary auth. Webhooks over polling where possible. Standard formats (JSON, YAML, Markdown) over binary blobs.
- [ ] **Set up GitHub App authentication** — Personal access tokens work for development, but a GitHub App gives you proper identity, scoped permissions, and installation-level access:

```bash
# Required environment variables for GitHub App
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_PRIVATE_KEY_PATH=<path-to-pem>
GITHUB_APP_INSTALLATION_ID=<installation-id>
```

- [ ] **Connect Linear with OAuth** — Use the interactive setup wizard to establish OAuth tokens stored in SQLite (`data/oauth-tokens.db`), surviving restarts without manual re-auth.

### What to avoid

- Tools with no API (your agents cannot participate)
- Vendor lock-in on data formats (PDF-only reports, proprietary databases)
- Manual integration glue that breaks when someone leaves the team

---

## Principle 3: Build Expert Loops Before Administrative Layers

**The idea**: Deploy AI where domain expertise creates value — not where bureaucracy creates friction. Expert loops beat admin layers.

### How orch-agents implements this

**Agents are domain experts, not bureaucrats.** The agent roster includes `coder`, `tester`, `reviewer`, `architect`, `security-architect`, and `ddd-domain-expert`. Each has deep, specialized prompts — not generic "do the task" instructions.

**The coordinator pattern replaces management overhead.** Instead of a chain of approvals (developer → tech lead → reviewer → merger), the `CoordinatorDispatcher` orchestrates a single intelligent agent that plans, executes, and self-reviews:

```
Webhook → Intake → Coordinator → [Plan → Execute → Review] → Ship
```

No middle-management agents relaying information between layers.

**Quality gates run in parallel, not sequentially:**
- `DiffReviewer` — Claude-powered code review
- `TestRunner` — Automated test execution in worktree
- `SecurityScanner` — Pattern-based secret detection

All three run simultaneously. Failures do not block each other. This is an expert loop: each gate applies specialized judgment, not administrative approval.

### Startup checklist for Principle 3

- [ ] **Define your expert agents in WORKFLOW.md templates** — Group agents by the expertise needed, not by org-chart hierarchy:

```yaml
templates:
  bug-fix: [coder, tester]           # Expert loop: fix + verify
  feature-build: [architect, coder, reviewer]  # Expert loop: design + build + review
  security-audit: [security-architect]         # Expert loop: specialized scan
```

- [ ] **Wire quality gates to every output** — Never ship agent work without `review-pipeline.ts` running DiffReview + TestRunner + SecurityScanner. This is your expert review loop.
- [ ] **Start with coordinator mode** — Do not over-architect with multi-agent swarms on day one. The coordinator dispatches a single capable agent per task. Add swarm complexity only when evidence shows a single agent is insufficient.
- [ ] **Use priority scoring for focus, not for blocking** — The triage engine scores P0-P3 for observability. It does not gate execution. Let expert agents work immediately; use scores for human attention management.

### What to avoid

- Building approval chains that slow agent work without adding judgment
- Creating "manager agents" that just relay tasks between worker agents
- Running quality gates sequentially when they are independent

---

## Principle 4: Organize Around Outcomes, Not Handoffs

**The idea**: Structure work so that a single agent (or tight team) owns the full outcome — from trigger to delivered result — instead of passing fragments between departments.

### How orch-agents implements this

**Event-driven pipeline with outcome ownership.** When a GitHub issue gets labeled `bug`, the entire lifecycle is owned end-to-end:

```
Issue labeled "bug"
  → IntakeNormalizer extracts context
  → CoordinatorDispatcher creates a plan
  → Agent clones into isolated worktree
  → Agent writes fix + tests
  → ReviewPipeline validates (diff, tests, security)
  → ArtifactApplier commits changes
  → GitHub client creates PR
```

No handoff. One pipeline. One outcome: a reviewed PR that fixes the bug.

**Git worktree isolation guarantees clean outcomes.** Each agent task gets its own worktree — no interference between parallel tasks. The `WorktreeManager` handles creation, cleanup, and stale worktree pruning on startup.

**Skill-based event routing (P20).** Events route directly to the right skill, not to a queue that someone triages manually. The `SkillResolver` matches events to filesystem-backed skill definitions.

### Startup checklist for Principle 4

- [ ] **Map every GitHub/Linear event to an outcome** — In WORKFLOW.md, each event should route to a template that produces a concrete deliverable (a PR, a review comment, a fix):

```yaml
github:
  events:
    pull_request.opened: code-review      # Outcome: review comments posted
    issues.labeled.bug: tdd-workflow       # Outcome: PR with fix + tests
    issues.labeled.feature: feature-build  # Outcome: PR with implementation
    workflow_run.failure: ci-fix           # Outcome: PR fixing CI
```

- [ ] **Set up worktree isolation** — Ensure `git worktree` is available and the agent has write access. Each task runs in its own filesystem, preventing cross-task contamination.
- [ ] **Define clear "done" signals** — An agent task is done when: (a) code is committed, (b) tests pass, (c) PR is created. Not when "the agent said it's done."
- [ ] **Enable loop prevention** — Configure bot identity checks and SHA-based deduplication to prevent agents from triggering themselves:

```bash
# Environment variables
GITHUB_BOT_LOGIN=<your-bot-username>
```

### What to avoid

- Splitting a single outcome across multiple uncoordinated agents
- Manual handoffs between pipeline stages (intake → "email someone" → execution)
- Agents that produce intermediate artifacts nobody consumes

---

## Principle 5: Install Evaluation, Permissions, and Review from the Start

**The idea**: AI participation requires guardrails from day one — not bolted on later. Evaluation, permissions, and human review are structural, not optional.

### How orch-agents implements this

**Security is structural, not aspirational:**

| Layer | Mechanism | Location |
|-------|-----------|----------|
| **Webhook verification** | HMAC-SHA256 signature check | `webhook-gateway/` |
| **Input sanitization** | Prompt injection defense on all user fields | `shared/input-sanitizer.ts` |
| **Secret scanning** | Pattern-based detection in review pipeline | `review/security-scanner.ts` |
| **Branded types** | `PlanId`, `WorkItemId`, `ExecId` prevent ID confusion at compile time | `shared/branded-types.ts` |
| **OAuth token isolation** | Tokens in SQLite, never logged, never in source | `data/oauth-tokens.db` |
| **Bot loop prevention** | Identity checks + SHA dedup prevent infinite agent loops | `execution/` |

**Quality gates are mandatory, not optional.** The `ReviewPipeline` runs three independent validators before any agent output reaches the repository. There is no "skip review" flag.

**Graceful shutdown preserves state.** Signal handlers (SIGTERM/SIGINT) ensure in-flight tasks complete or checkpoint cleanly — no orphaned worktrees, no half-applied changes.

**Token budgeting prevents runaway costs.** The `TOKEN_BUDGET` environment variable sets a hard ceiling per task. When the budget is exhausted, the agent stops gracefully — no surprise bills.

### Startup checklist for Principle 5

- [ ] **Configure webhook signature verification** — Never accept unverified webhooks. Set your webhook secret:

```bash
GITHUB_WEBHOOK_SECRET=<your-secret>
```

- [ ] **Set token budgets** — Start conservative. You can always increase:

```bash
TOKEN_BUDGET=100000  # tokens per task
```

- [ ] **Enable all three review gates** — DiffReview, TestRunner, and SecurityScanner should all be active. Disable stub mode:

```bash
ENABLE_INTERACTIVE_AGENTS=true
```

- [ ] **Set up OAuth properly** — Use the setup wizard for Linear OAuth. Use GitHub App auth (not personal tokens) for production:

```bash
npm run build && node dist/index.js
# Follow the interactive setup wizard
```

- [ ] **Monitor with structured logging** — The logger outputs structured JSON. Ship logs to your observability stack from day one:

```bash
LOG_LEVEL=info  # Options: debug, info, warn, error
```

- [ ] **Review agent output before merging** — Even with quality gates, keep human review on PRs for the first weeks. Trust the system incrementally.

### What to avoid

- Shipping without webhook verification ("we'll add it later")
- No token budget ("it probably won't run up costs")
- Disabling quality gates to "move faster"
- Giving agents write access to production branches without PR review

---

## Safe Launch Sequence

A step-by-step sequence for getting orch-agents into production safely.

### Phase 0: Local Validation (Day 1)

```bash
# 1. Clone and build
git clone <your-repo>
cd orch-agents
npm install
npm run build

# 2. Run the full test suite
npm test

# 3. Type check
npx tsc --noEmit

# 4. Verify the setup wizard works
node dist/index.js
```

**Gate**: All tests pass. Build succeeds. No type errors.

### Phase 1: Stub Mode (Days 2-3)

Run with `ENABLE_INTERACTIVE_AGENTS=false`. Webhooks are accepted, events are normalized and triaged, but no agents execute. This validates:

- Webhook delivery and signature verification
- Event parsing and routing logic
- WORKFLOW.md configuration
- Linear/GitHub connectivity

**Gate**: Events flow through the pipeline without errors. Triage scores look reasonable.

### Phase 2: Single-Agent Dry Run (Days 4-7)

Enable agents but restrict to one event type:

```yaml
# WORKFLOW.md — start with just PR reviews
github:
  events:
    pull_request.opened: code-review
```

Set a low token budget. Watch the first few PRs carefully. Verify:

- Agent produces sensible review comments
- Quality gates catch obvious issues
- No bot loops or runaway execution
- Token usage stays within budget

**Gate**: 10+ PRs reviewed without intervention. Quality gate pass rate > 90%.

### Phase 3: Expand Event Coverage (Weeks 2-3)

Add more event types one at a time:

1. `issues.labeled.bug` → bug-fix template
2. `issues.labeled.feature` → feature-build template
3. `workflow_run.failure` → CI-fix template

After each addition, monitor for a few days before adding the next.

**Gate**: Each event type produces correct outcomes. No regressions in existing types.

### Phase 4: Production Operations (Week 4+)

- Increase token budgets based on observed usage
- Set up alerting on structured logs
- Establish runbooks for common failure modes
- Begin tracking metrics: tasks completed, quality gate pass rates, time-to-PR, token costs
- Consider multi-repo expansion (P17 workspace resolution)

---

## Key Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `ANTHROPIC_API_KEY` | Claude API access | Yes |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC verification | Yes |
| `GITHUB_TOKEN` or App config | GitHub API access | Yes |
| `LINEAR_API_KEY` | Linear API access | If using Linear |
| `LINEAR_TEAM_ID` | Linear team for issue routing | If using Linear |
| `TOKEN_BUDGET` | Max tokens per agent task | Recommended |
| `ENABLE_INTERACTIVE_AGENTS` | Enable real agent execution | Yes (default: false) |
| `LOG_LEVEL` | Logging verbosity | No (default: info) |
| `PORT` | HTTP server port | No (default: 3000) |

---

## Architecture at a Glance

```
                    ┌─────────────────────┐
                    │   GitHub / Linear    │
                    │   (Event Sources)    │
                    └──────────┬──────────┘
                               │ webhooks
                    ┌──────────▼──────────┐
                    │  Webhook Gateway    │
                    │  (HMAC + dedup)     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Intake Normalizer  │
                    │  (→ IntakeEvent)    │
                    └──────────┬──────────┘
                               │ event bus
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼────┐  ┌───────▼───────┐  ┌─────▼──────┐
    │   Triage     │  │  Coordinator  │  │  Skill     │
    │   (P0-P3)    │  │  Dispatcher   │  │  Resolver  │
    └──────────────┘  └───────┬───────┘  └────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Agent Execution  │
                    │  (git worktree)   │
                    └─────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
    ┌─────────▼────┐ ┌───────▼──────┐ ┌──────▼───────┐
    │ Diff Review  │ │ Test Runner  │ │ Security Scan│
    └──────────────┘ └──────────────┘ └──────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Artifact Apply   │
                    │  (commit + PR)    │
                    └───────────────────┘
```

---

## Summary

| Principle | Orch-Agents Implementation | Your First Action |
|-----------|---------------------------|-------------------|
| **Machine-legible** | WORKFLOW.md, agent .md files, event bus traces | Write your WORKFLOW.md |
| **Visible & portable tools** | MCP protocol, ToolSearch, GitHub/Linear APIs | Configure `.mcp.json` |
| **Expert loops** | Domain-expert agents, parallel quality gates | Define agent templates |
| **Outcome-oriented** | End-to-end pipelines, worktree isolation | Map events to outcomes |
| **Evaluation from day one** | HMAC verification, token budgets, review gates | Set security env vars |

The safest path is incremental: stub mode first, single event type second, full coverage third. Trust the system by verifying it, not by hoping.
