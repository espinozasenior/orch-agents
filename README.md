# orch-agents

Autonomous AI agents for GitHub repos and Linear boards.

orch-agents watches your GitHub webhooks and Linear board, then dispatches Claude-powered agents to review PRs, fix bugs, build features, and run scheduled automations. Everything is configured in one file: `WORKFLOW.md`.

## What It Does

- **PR review on open** -- a webhook fires, an agent reads the diff, posts inline findings on the PR as `automata-ai-bot[bot]`
- **Linear card moves to "In Progress"** -- a coordinator agent picks it up, spawns sub-agents, pushes a branch, and posts results on the issue workpad
- **Cron fires at 6 AM** -- an automation agent runs your health check, reports failures to Slack
- **@mention the bot in a PR comment** -- the agent reads context and responds in-thread

Every agent runs in an **isolated git worktree**. Every change passes through a **ReviewGate** (AI diff review + test runner + security scanner) before being committed.

## Quick Start

```bash
git clone https://github.com/espinozasenior/orch-agents.git
cd orch-agents
npm install
npm run build

# Set environment
cp .env.example .env   # edit with your keys

# Start
npm start
```

The server starts on port 3000. To expose it publicly for webhooks:

```bash
# Built-in tunnel (set ENABLE_TUNNEL=true in .env)
npm start

# Or manual
npx cloudflared tunnel --url http://localhost:3000
```

## Web Frontend (Optional)

orch-agents ships a Next.js operational dashboard at `packages/web` that
talks to the API over a bearer-protected `/v1/*` surface. Three Fastify
servers run side-by-side:

| Surface | Port (default) | Bound to | Purpose |
|---------|----------------|----------|---------|
| `public` | 3000 | tunneled / `BIND_HOST` | webhooks (HMAC-protected) + OAuth callbacks |
| `admin`  | 3001 | `127.0.0.1` only | `/status`, `/secrets`, `/automations`, `/admin/web-tokens`, `/children` |
| `web`    | 3002 | `WEB_BIND_HOST` (default 127.0.0.1) | bearer-auth `/v1/*` for the BFF + SSE event stream |

### Bring up the web UI

```bash
npm run dev:setup    # one-time: mint token, write .env files (idempotent — safe to re-run)
npm run dev          # both API and web in one terminal (Ctrl+C kills both)
```

That's it. `npm run dev` boots:
- API (with TypeScript hot-reload via `tsx --watch`) on the three Fastify ports above
- Next.js dev server on port **3200** (open http://localhost:3200 in your browser)

Output is tagged `[api]` / `[web]` so you can tell who's logging.

If you only want one side running:

```bash
npm run dev:api    # API only
npm run dev:web    # Next.js only
```

**Port 3000 already in use?** orch-agents' public surface defaults to 3000. If something else owns it on your machine, override via `.env`:

```bash
PORT=3010   # or any free port
```

`ADMIN_PORT` (3001) and `WEB_PORT` (3002) can be moved the same way. The Next dev server stays on 3200 and is unaffected.

Open http://localhost:3000 and you'll see the runs list, automations,
secrets editor, and token-management tabs. Trigger a webhook and the run
will appear within a couple of seconds; click in to watch live thoughts and
actions stream in via SSE.

The `/v1/*` API is a bearer-protected REST surface — see
`src/web-api/v1-router.ts` for the full route catalog. Per-route guards
enforce one of: `runs:read`, `automations:write`, `secrets:read`,
`secrets:write`, `workflow:read`.

### Authentication note

The web BFF holds the bearer token server-side; the browser never sees
it. There's no NextAuth login flow in v1 — deploy the web app behind
your existing SSO/VPN. Multi-domain `NEXTAUTH_ALLOWED_EMAILS` will trigger
a startup warning since orch-agents has no per-tenant isolation (see
ADR-004 if you need a multi-tenant story).

## WORKFLOW.md Configuration

`WORKFLOW.md` is the single source of truth. It uses YAML frontmatter to define repos, events, automations, and tracker config. The server watches the file and hot-reloads on save.

```yaml
---
defaults:
  agents:
    max_concurrent: 8
    max_concurrent_per_org: 4
  stall:
    timeout_ms: 300000
  polling:
    interval_ms: 30000
    enabled: false

repos:
  owner/repo:
    url: git@github.com:owner/repo.git
    default_branch: main
    teams:
      - ENGINEERING
    labels:
      - backend
    github:
      events:
        pull_request.opened: .claude/skills/github-ops/SKILL.md
        pull_request.synchronize: .claude/skills/github-ops/SKILL.md
        pull_request.ready_for_review: .claude/skills/github-ops/SKILL.md
        pull_request.review_requested: .claude/skills/github-ops/SKILL.md
        pull_request_review.changes_requested: .claude/skills/github-ops/SKILL.md
        workflow_run.failure: .claude/skills/ci-status/SKILL.md
        issues.opened: .claude/skills/github-deep-research/SKILL.md
        issues.labeled.bug: .claude/skills/github-ops/SKILL.md
        issue_comment.created: .claude/skills/github-ops/SKILL.md
    automations:
      health-check:
        schedule: "0 */6 * * *"
        instruction: "Run npm test and report failures"
      deploy-check:
        trigger: webhook
        instruction: "Verify deployment health"
      sentry-triage:
        trigger: sentry
        events: ["error"]
        instruction: "Diagnose and suggest fix for this Sentry error"
    lifecycle:
      setup: "npm install"
      start: "docker compose up -d"
    tracker:
      team: ENGINEERING

tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: $LINEAR_TEAM_ID
  active_types:
    - unstarted
    - started
  terminal_types:
    - completed
    - canceled
---
```

### GitHub Events

Each event maps to a skill file (a markdown file with agent instructions):

```yaml
github:
  events:
    pull_request.opened: .claude/skills/github-ops/SKILL.md
    issues.labeled.bug: .claude/skills/github-ops/SKILL.md
    workflow_run.failure: .claude/skills/ci-status/SKILL.md
    issue_comment.created: .claude/skills/github-ops/SKILL.md
```

Format: `event.action[.condition]: path/to/SKILL.md`

### Automations

Three trigger types: `schedule` (cron), `webhook` (inbound HTTP), and `sentry`.

```yaml
automations:
  nightly-tests:
    schedule: "0 2 * * *"
    instruction: "Run full test suite, open issues for failures"
  deploy-hook:
    trigger: webhook
    instruction: "Verify deployment succeeded"
  error-triage:
    trigger: sentry
    events: ["error"]
    instruction: "Diagnose root cause"
```

Automations auto-pause after 3 consecutive failures (circuit breaker). Resume via API.

### Lifecycle Scripts

Control how a repo's workspace is provisioned and started:

```yaml
lifecycle:
  setup: "npm install"        # runs once when worktree is created
  start: "docker compose up -d"  # runs before agent execution
```

Two-layer resolution: WORKFLOW.md `lifecycle:` wins, then `.orch-agents/setup.sh` and `.orch-agents/start.sh` discovered in the repo, then skip.

### Tracker (Linear)

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY    # $VAR reads from environment
  team: $LINEAR_TEAM_ID
  active_types: [unstarted, started]
  terminal_types: [completed, canceled]
```

Supports polling, webhooks, and Linear AgentSessionEvent for bidirectional communication. Agent activities (thought, action, response, error) are emitted on the Linear workpad.

## GitHub App Setup

A GitHub App gives agents a bot identity. Pushes and comments show as `automata-ai-bot[bot]`, preventing feedback loops.

### 1. Create the App

Go to [github.com/settings/apps/new](https://github.com/settings/apps/new).

| Field | Value |
|-------|-------|
| App name | Your preferred name |
| Homepage URL | Your repo URL |
| Webhook URL | `https://your-server/webhooks/github` |
| Webhook secret | `openssl rand -hex 32` |

**Permissions** (Repository):

| Permission | Access | Why |
|------------|--------|-----|
| Contents | Read & Write | Push commits |
| Pull requests | Read & Write | Post reviews and comments |
| Issues | Read & Write | Post comments |
| Metadata | Read | Required |

**Subscribe to events**: Pull request, Issues, Issue comment, Workflow run

### 2. Get Credentials

1. Note the **App ID** from the app settings page
2. Generate a **private key** (.pem file) under Private keys
3. Install the app on your repo and note the **Installation ID** from the URL

### 3. Configure

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./github-app.pem
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

The bot username is auto-resolved from the GitHub App slug at startup.

### Fallback: Personal Access Token

```bash
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
BOT_USERNAME=your-github-username
```

Works for dev/testing. Agents' actions appear as you instead of a bot.

## Automations Guide

### List all automations

```bash
curl http://localhost:3000/automations
```

### Trigger manually

```bash
curl -X POST http://localhost:3000/automations/health-check/trigger
```

### Resume a paused automation (after 3 failures)

```bash
curl -X POST http://localhost:3000/automations/health-check/resume
```

### Inbound webhook trigger

```bash
curl -X POST http://localhost:3000/webhooks/automation/deploy-hook \
  -H "Content-Type: application/json" \
  -d '{"status": "success"}'
```

Webhook automations support JSONPath filters to match specific payloads. Run history is persisted in SQLite.

## Slack Bot Setup

The Slack bot receives @mentions and starts agent sessions in-thread.

1. Create a Slack app with Event Subscriptions enabled
2. Subscribe to `app_mention` events
3. Set the request URL to `https://your-server/webhooks/slack`
4. Configure environment:

```bash
SLACK_ENABLED=true
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_BOT_TOKEN=xoxb-...
```

The bot classifies the mentioned repo from the message text, dispatches an agent, and replies in the same thread with results.

## Secrets Management

Encrypted secrets (AES-256-GCM) injected into agent environments per-execution.

### Store a global secret

```bash
curl -X PUT http://localhost:3000/secrets/NPM_TOKEN \
  -H "Content-Type: application/json" \
  -d '{"value": "npm_...", "scope": "global"}'
```

### Store a repo-scoped secret

```bash
curl -X PUT http://localhost:3000/secrets/DATABASE_URL \
  -H "Content-Type: application/json" \
  -d '{"value": "postgres://...", "scope": "repo", "repo": "owner/repo"}'
```

### List secrets (keys only, values never returned)

```bash
curl http://localhost:3000/secrets
curl "http://localhost:3000/secrets?scope=repo&repo=owner/repo"
```

### Delete a secret

```bash
curl -X DELETE http://localhost:3000/secrets/NPM_TOKEN
```

Requires `SECRETS_MASTER_KEY` in the environment. Secrets are persisted in SQLite with WAL mode.

## Sub-Agent Spawning

The coordinator agent can spawn child agents. Two modes controlled by `AGENT_SPAWN_MODE`:

**SDK mode** (default): The Claude Agent SDK handles `AgentTool` calls natively. Sub-agents inherit the coordinator's context.

**Direct mode** (`AGENT_SPAWN_MODE=direct`): A SwarmDaemon dispatches child agents with full programmatic control -- worktree isolation per child, status queries, cancellation, and capacity enforcement.

```bash
# Check child agent status (direct mode only)
curl http://localhost:3000/children

# Get specific child
curl http://localhost:3000/children/child-abc123

# Reset pause after 3 consecutive failures
curl -X POST http://localhost:3000/children/reset-pause
```

Depth limiting enforces a max of 3 levels. `Agent`/`AgentTool` is removed from workers at max depth.

### Model Override

Add a `model:opus` label to a Linear issue to force that agent session to use a specific model.

## Setup CLI

Interactive CLI for configuring integrations:

```bash
npx orch-setup github          # GitHub App or PAT
npx orch-setup repo add owner/repo   # Add repo + generate WORKFLOW.md entry
npx orch-setup repo list       # List configured repos
npx orch-setup repo edit owner/repo  # Edit repo config
npx orch-setup repo remove owner/repo
npx orch-setup slack           # Slack webhook config
npx orch-setup linear          # Linear API key or OAuth
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (status, version, uptime) |
| POST | `/webhooks/github` | GitHub webhook ingestion (HMAC verified) |
| POST | `/webhooks/linear` | Linear webhook ingestion |
| POST | `/webhooks/slack` | Slack event ingestion (signature verified) |
| GET | `/automations` | List all automations with state |
| POST | `/automations/:id/trigger` | Manually trigger an automation |
| POST | `/automations/:id/resume` | Resume a paused automation |
| POST | `/webhooks/automation/:id` | Inbound webhook trigger |
| GET | `/children` | List child agents (direct mode) |
| GET | `/children/:id` | Get child agent status (direct mode) |
| POST | `/children/reset-pause` | Reset spawn pause (direct mode) |
| GET | `/secrets` | List secret keys (values never returned) |
| PUT | `/secrets/:key` | Create or update a secret |
| DELETE | `/secrets/:key` | Delete a secret |
| GET | `/oauth/authorize` | Start Linear OAuth flow |
| GET | `/oauth/callback` | Linear OAuth callback |
| GET | `/status` | Orchestrator status snapshot |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Claude API key |
| `GITHUB_WEBHOOK_SECRET` | Yes | -- | GitHub webhook HMAC secret |
| `GITHUB_TOKEN` | Fallback | -- | GitHub PAT (if no GitHub App) |
| `GITHUB_APP_ID` | Recommended | -- | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Recommended | -- | Path to `.pem` private key |
| `GITHUB_APP_INSTALLATION_ID` | Recommended | -- | GitHub App installation ID |
| `BOT_USERNAME` | No | Auto-resolved | Bot identity for loop prevention |
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `LINEAR_ENABLED` | No | `false` | Enable Linear integration |
| `LINEAR_API_KEY` | No | -- | Linear API key |
| `LINEAR_WEBHOOK_SECRET` | No | -- | Linear webhook signing secret |
| `LINEAR_TEAM_ID` | No | -- | Linear team UUID |
| `LINEAR_AUTH_MODE` | No | `apiKey` | `apiKey` or `oauth` |
| `LINEAR_CLIENT_ID` | No | -- | Linear OAuth client ID |
| `LINEAR_CLIENT_SECRET` | No | -- | Linear OAuth client secret |
| `ENABLE_TUNNEL` | No | `false` | Start Cloudflare tunnel on boot |
| `AGENT_SPAWN_MODE` | No | `sdk` | `sdk` or `direct` |
| `SECRETS_MASTER_KEY` | No | -- | AES-256 master key for secrets store |
| `SLACK_ENABLED` | No | `false` | Enable Slack bot |
| `SLACK_SIGNING_SECRET` | No | -- | Slack request signing secret |
| `SLACK_BOT_TOKEN` | No | -- | Slack bot token (`xoxb-`) |
| `SLACK_WEBHOOK_URL` | No | -- | Slack incoming webhook URL |
| `WORKTREE_BASE_PATH` | No | `/tmp/orch-agents` | Base path for git worktrees |

## Architecture

```
WORKFLOW.md                    # Single config file (hot-reloaded)

src/
  config/                      # WorkflowConfig store + hot-reload watcher
  webhook-gateway/             # HTTP ingestion, HMAC verification, dedup
  intake/                      # Event normalization (GitHub + Linear + Slack -> IntakeEvent)
  triage/                      # Priority scoring (P0-P3)
  execution/
    coordinator-dispatcher.ts  # Single-agent coordinator with sub-agent spawning
    runtime/                   # SDK executor, direct spawn, agent sandbox
    workspace/                 # Git worktree isolation, artifact applier
    orchestrator/              # Symphony orchestrator (event wiring)
  review/                      # ReviewGate: diff review + test runner + security scanner
  scheduling/                  # Cron scheduler, automation state machine, run persistence
  security/                    # Encrypted secrets store (AES-256-GCM)
  integration/
    github-client.ts           # GitHub API (reviews, comments, PRs)
    github-app-auth.ts         # GitHub App JWT + installation tokens
    linear/                    # Linear client, polling, workpad, AgentSessionEvent
    slack/                     # Slack webhook handler, normalizer, responder
  coordinator/                 # Coordinator prompt builder
  kernel/                      # Event bus, branded types, agent identity, errors
  shared/                      # Logger, config, input sanitizer, SQLite helper
  tunnel/                      # Cloudflare tunnel + webhook URL updater
  setup/                       # Interactive CLI (Commander.js)

tests/                         # London School TDD (node:test + node:assert)
```

## Build and Test

```bash
npm run build        # TypeScript compile
npm test             # Run all tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run setup        # Interactive setup CLI
```

## Requirements

- Node.js 22+
- Claude CLI (`npm i -g @anthropic-ai/claude-code`)
- git (for worktree isolation)
- gh CLI (`brew install gh`)

## License

MIT
