# orch-agents

Autonomous AI agents for your GitHub repos and Linear boards.

orch-agents watches your GitHub repo and Linear board, then dispatches AI agents to do the work — code reviews, bug fixes, feature builds, security audits. You define what agents run for what tasks in one file: `WORKFLOW.md`.

Inspired by [OpenAI Symphony](https://github.com/openai/symphony) and [Linear's Agent Interaction Guidelines](https://linear.app/docs/agent-interaction-guidelines).

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/espinozasenior/orch-agents.git
cd orch-agents
npm install
npm run build

# 2. Set environment variables
export ANTHROPIC_API_KEY="sk-ant-..."
export GITHUB_TOKEN="ghp_..."
export WEBHOOK_SECRET="your-secret"

# 3. Start
npm start
```

Then add a webhook to your GitHub repo:

| Field | Value |
|-------|-------|
| Payload URL | `https://your-server/webhooks/github` |
| Content type | `application/json` |
| Secret | Same as `WEBHOOK_SECRET` |
| Events | Push, Pull requests, Issues, Issue comments, Workflow runs |

## How It Works

```
YOU                                   ORCH-AGENTS
━━━                                   ━━━━━━━━━━━
Open a PR                         →   reviewer agent checks your code
                                      posts findings on the PR

Label an issue "bug"              →   coder + tester agents
                                      fix the bug, write tests, push

Move Linear card to "Todo"        →   agents from the matching template
(with label "feature")                architect designs, coder builds,
                                      reviewer checks

CI fails on main                  →   coder agent reads the error
                                      pushes a fix

Comment "stop" on a PR            →   all agents stop immediately
```

Every agent runs in an **isolated git worktree**. Every change goes through a **review gate** (automated code review + test runner + security scan) before being committed.

## WORKFLOW.md — The Only Config You Need

Create `WORKFLOW.md` in your repo root. This one file controls everything:

```yaml
---
# Define your agent teams
templates:
  tdd-workflow: [coder, tester]
  feature-build: [architect, coder, reviewer]
  github-ops: [reviewer]
  quick-fix: [coder]
  security-audit: [security-architect]

# What GitHub events trigger which template
github:
  events:
    pull_request.opened: github-ops
    pull_request.synchronize: github-ops
    issues.labeled.bug: tdd-workflow
    issues.labeled.feature: feature-build
    issue_comment.mentions_bot: quick-fix
    workflow_run.failure: quick-fix

# Route work by label (works for both GitHub and Linear)
agents:
  max_concurrent: 8
  routing:
    bug: tdd-workflow
    feature: feature-build
    security: security-audit
    default: quick-fix

# Linear board integration (optional)
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: $LINEAR_TEAM_ID
  active_types: [unstarted, started]       # Match by state type, not name
  terminal_types: [completed, canceled]    # Resilient to renaming states

# Timeouts
stall:
  timeout_ms: 300000
---
```

### Templates

A template is just a name and a list of agent types:

```yaml
templates:
  tdd-workflow: [coder, tester]      # Bug fixes: write code + tests
  feature-build: [architect, coder, reviewer]  # Features: design + build + review
  quick-fix: [coder]                 # Simple stuff: one agent
```

Agents run **sequentially**. Each gets its own isolated workspace.

### GitHub Events

Map events to templates with one line each:

```yaml
github:
  events:
    pull_request.opened: github-ops        # PR opened → review
    issues.labeled.bug: tdd-workflow       # Bug labeled → fix it
    push.default_branch: cicd-pipeline     # Push to main → validate
    workflow_run.failure: quick-fix        # CI failed → fix it
```

Format: `event.action.condition: template-name`

Conditions: `default_branch`, `other` (non-default branch), `merged`, `mentions_bot`, `failure`, or any label name.

### Label Routing

The `agents.routing` section routes work by label — works for **both** GitHub issues and Linear cards:

```yaml
agents:
  routing:
    bug: tdd-workflow         # "bug" label → coder + tester
    feature: feature-build    # "feature" label → architect + coder + reviewer
    security: security-audit  # "security" label → security specialist
    default: quick-fix        # No matching label → single coder
```

### Linear Integration

Optional. When enabled, moving a Linear card to an active state triggers agents:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY             # $VAR syntax reads from env
  team: $LINEAR_TEAM_ID
  active_types: [unstarted, started]    # Agents work on these (match by type, not name)
  terminal_types: [completed, canceled] # Agents stop on these
```

Set up the Linear webhook: Settings > API > Webhooks > URL: `https://your-server/webhooks/linear`

## Agent Definitions

Agents are markdown files in `.claude/agents/`. Each teaches the agent what to do:

```markdown
<!-- .claude/agents/coder.md -->
---
name: coder
category: development
tier: 2
description: Code implementation specialist
---

You are a code implementation agent. Your job is to:
1. Read the issue/PR description
2. Write clean, tested code
3. Follow the project's coding conventions
```

orch-agents ships with 18+ built-in agent definitions. Customize or add your own.

## Commands

### Stop an agent

Comment on any GitHub PR or Linear issue:

```
stop
```

or

```
@orch-agents stop
```

All running agents for that work item cancel immediately.

### Mention the bot

```
@orch-agents take a look at this
```

Triggers the `issue_comment.mentions_bot` event.

## GitHub App Setup (Recommended)

Using a GitHub App gives agents their own bot identity. Pushes and comments show as `orch-agents[bot]` instead of your personal account, which prevents feedback loops and looks professional on PRs.

> **Without a GitHub App**, orch-agents falls back to your personal `GITHUB_TOKEN`. This works for dev/testing but agents' pushes appear as you, requiring extra loop-prevention logic.

### 1. Create the App

Go to **[github.com/settings/apps/new](https://github.com/settings/apps/new)** (or your org's settings for org repos).

| Field | Value |
|-------|-------|
| **App name** | `orch-agents` (or your preferred name) |
| **Homepage URL** | Your repo URL |
| **Webhook URL** | `https://your-server/webhooks/github` |
| **Webhook secret** | Generate with `openssl rand -hex 32` |

**Permissions** (Repository):

| Permission | Access | Why |
|------------|--------|-----|
| Contents | Read & Write | Push commits from agent worktrees |
| Pull requests | Read & Write | Post review comments on PRs |
| Issues | Read & Write | Post comments on issues |
| Metadata | Read | Required by GitHub |

**Subscribe to events**: Push, Pull request, Issues, Issue comment

**Leave unchecked**: Callback URL, "Request user authorization during installation", "Enable Device Flow" — these are for OAuth login flows, not needed here.

### 2. Get Your Credentials

After creating the app:

1. Note the **App ID** (shown at the top of the app settings page)
2. Scroll to **Private keys** → click **Generate a private key** → download the `.pem` file
3. Go to **Install App** (left sidebar) → install on your repo
4. Note the **Installation ID** from the URL: `github.com/settings/installations/XXXXXXXX`

### 3. Configure Environment

Add to your `.env`:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./github-app.pem
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_WEBHOOK_SECRET=<the-secret-from-step-1>
BOT_USERNAME=orch-agents[bot]
```

Copy the downloaded `.pem` file to your project root. It's already in `.gitignore`.

### 4. Verify

Start the server and push to a PR branch. You should see:
- Push webhook arrives and is **skipped** (bot sender = `orch-agents[bot]`)
- PR synchronize webhook arrives and is **skipped** (same bot sender)
- No cascading agent executions

Agent comments on PRs will show as posted by your app, with the bot badge.

### Fallback: Personal Access Token

If you don't want a GitHub App, use a personal access token instead:

```bash
GITHUB_TOKEN=ghp_...
WEBHOOK_SECRET=<your-webhook-secret>
BOT_USERNAME=your-github-username
```

This works but agents' actions appear as you, and the system relies on SHA tracking for loop prevention instead of bot identity.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `GITHUB_TOKEN` | Fallback | — | GitHub PAT (if not using GitHub App) |
| `GITHUB_APP_ID` | Recommended | — | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Recommended | — | Path to `.pem` private key |
| `GITHUB_APP_INSTALLATION_ID` | Recommended | — | GitHub App installation ID |
| `WEBHOOK_SECRET` | Yes | — | GitHub webhook HMAC secret |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | `trace` `debug` `info` `warn` `error` |
| `BOT_USERNAME` | No | `orch-agents` | Bot identity for loop prevention |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `LINEAR_ENABLED` | No | `false` | Enable Linear integration |
| `LINEAR_API_KEY` | No | — | Linear API key |
| `LINEAR_WEBHOOK_SECRET` | No | — | Linear webhook signing secret |
| `LINEAR_TEAM_ID` | No | — | Linear team UUID |
| `ENABLE_INTERACTIVE_AGENTS` | No | `false` | Enable agent execution (otherwise stub mode) |
| `WORKFLOW_MD_GITHUB` | No | `false` | Use WORKFLOW.md for GitHub event routing |

## Deployment

### Local development

```bash
npm start                                          # Start on :3000
npx cloudflared tunnel --url http://localhost:3000  # Expose publicly
# Use the tunnel URL as your webhook URL
```

### Production

```bash
# Any Node.js host (Fly.io, Railway, Render, EC2)
# Set env vars in your platform's dashboard
npm run build && npm start
```

### Docker

```bash
docker build -t orch-agents .
docker run -p 3000:3000 --env-file .env orch-agents
```

## Requirements

- Node.js 22+
- Claude CLI (`npm i -g @anthropic-ai/claude-code`)
- git (for worktree isolation)
- gh CLI (`brew install gh` or equivalent)

## How It Works Internally

```
Webhook arrives (GitHub or Linear)
    ↓
Signature verified (HMAC-SHA256)
    ↓
Input sanitized (prompt injection defense)
    ↓
Event normalized → IntakeEvent
    ↓
WORKFLOW.md looked up → template → agent list
    ↓
For each agent (sequentially, isolated worktree):
    1. Create git worktree
    2. Run Claude Code with agent instructions
    3. Review gate:
       - Diff review (Claude-powered)
       - Test runner (npm test)
       - Security scanner (secret detection)
    4. If review fails → fix-it loop (up to 3 attempts)
    5. Commit and push
    ↓
Post results on GitHub PR / Linear issue
    ↓
Clean up worktree
```

## Project Structure

```
WORKFLOW.md              # Your project config (the only file you edit)

src/
  webhook-gateway/       # HTTP endpoints, HMAC verification, dedup
  intake/                # Event normalization (GitHub + Linear → IntakeEvent)
  triage/                # Priority scoring (P0-P3)
  execution/
    simple-executor.ts   # The executor — runs agents sequentially
    orchestrator/        # Event wiring
    runtime/             # Agent tracking, streaming, sandbox
    workspace/           # Git worktree isolation
    fix-it-loop.ts       # Review → fix → re-review cycle
    prompt-builder.ts    # Prompt construction
  review/                # Quality gates (diff review + tests + security)
  integration/
    github-client.ts     # GitHub API (PR comments, reviews)
    linear/              # Linear API, polling, workpad, stall detection
  agent-registry/        # Agent definition discovery
  shared/                # Event bus, logger, errors, sanitizer, identity
  setup/                 # Interactive setup wizard

.claude/agents/          # Agent definitions (markdown files)
tests/                   # 730+ tests (London School TDD)
docs/                    # Research reports, SPARC specs, DDD analysis
```

## Build & Test

```bash
npm run build    # TypeScript compile
npm test         # Run all 730+ tests
npm run lint     # ESLint
npm run setup    # Interactive setup wizard
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Webhook returns 401 | Check `WEBHOOK_SECRET` matches GitHub/Linear settings |
| Agent doesn't start | Check WORKFLOW.md has a matching event/routing rule |
| Agent times out | Increase `stall.timeout_ms` in WORKFLOW.md |
| No PR comments | Check `GITHUB_TOKEN` has `repo` scope |
| Linear not working | Set `LINEAR_ENABLED=true` and verify `LINEAR_API_KEY` |
| "WORKFLOW.md not found" | Create WORKFLOW.md in your project root |
| Bot responding to itself | Set up a GitHub App (recommended) or set `BOT_USERNAME` to match your bot's login |
| Agent pushes trigger more agents | Set up a GitHub App so pushes come from `app[bot]` sender |
| "Private key not found" | Check `GITHUB_APP_PRIVATE_KEY_PATH` points to your `.pem` file |

## License

MIT
