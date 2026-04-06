# Claude Code Configuration - Orch-Agents

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- Single-word approvals ("yes", "do it", "push") trigger immediate execution — no repetition or commentary
- NEVER use stubs
- NEVER leave a new feature unwired nor called nor orphan

## Pre-Work Discipline

- Dead code accelerates context compaction. Before ANY structural refactor on a file >500 LOC, first remove dead props, unused exports, unused imports, and debug logs
- Study existing code thoroughly before building — match patterns exactly rather than following English descriptions
- Work directly from error logs and console output rather than guessing. Request actual data when missing
- Non-trivial features require plan mode with user interviews about implementation, UX, and tradeoffs before code

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/data` for runtime data (SQLite, tokens — gitignored)

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines — suggest splitting when reasoning becomes difficult
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

## Build & Test

```bash
# Build
npm run build

# Test
npm test

# Lint
npm run lint

# Type check
npx tsc --noEmit
```

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing
- Report tasks complete ONLY after: running build, running tests, and checking for errors
- Never claim "should work" or "I'm confident" — run it and show output

## Verification Gate (Iron Law)

**NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

- "Should work now" → RUN IT
- "I'm confident" → Confidence is not evidence
- "I already tested earlier" → Code changed since then. Test again
- "It's a trivial change" → Trivial changes break production
- If code changed after the last test run, re-run before claiming done
- ALWAYS review the related task's spec fullfilment before mark task as done

## Edit Safety

- Re-read files before AND after every edit — the Edit tool fails silently when old_string doesn't match stale context
- After 10+ messages in a conversation, re-read any file before editing — auto-compaction may have destroyed context
- When renaming functions/types/variables, search for: direct calls, type references, string literals, dynamic imports, re-exports, barrel files, test files and mocks
- Never fix display problems by duplicating state — all non-source elements must read from one canonical source
- Never delete files without verifying no references exist

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
- OAuth tokens stored in SQLite (`data/oauth-tokens.db`) — never log token values
- Webhook signatures verified via HMAC-SHA256 — never skip verification

## Context Management

- Tasks touching >5 independent files should launch parallel sub-agents (5-8 files per agent)
- Files over 500 LOC must use offset and limit parameters for sequential chunking
- Use the file system actively: write intermediate results to disk for multi-pass problem-solving
- Store summaries, decisions, and pending work in persistent markdown files
- Save debugging artifacts for reproducible verification

## Self-Improvement

- After user corrections, log patterns to memory — convert mistakes into strict rules
- Explain why bugs occurred and identify preventive measures — understand root causes
- After two failed attempts at the same approach, stop and re-read relevant sections
- If told to step back, drop everything and propose a fundamentally different approach

## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- All operations MUST be concurrent/parallel in a single message
- Use Claude Code's Task tool for spawning agents, not just MCP
- ALWAYS batch ALL todos in ONE TodoWrite call (5-10+ minimum)
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message

## Swarm Orchestration

- MUST initialize the swarm using CLI tools when starting complex tasks
- MUST spawn concurrent agents using Claude Code's Task tool
- Never use CLI tools alone for execution — Task tool agents do the actual work
- MUST call CLI tools AND Task tool in ONE message for complex work

### 3-Tier Model Routing (ADR-026)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster (WASM) | <1ms | $0 | Simple transforms (var→const, add types) — Skip LLM |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, low complexity (<30%) |
| **3** | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture, security (>30%) |

- Always check for `[AGENT_BOOSTER_AVAILABLE]` or `[TASK_MODEL_RECOMMENDATION]` before spawning agents
- Use Edit tool directly when `[AGENT_BOOSTER_AVAILABLE]`

## Swarm Execution Rules

- ALWAYS use `run_in_background: true` for all agent Task calls
- ALWAYS put ALL agent Task calls in ONE message for parallel execution
- After spawning, STOP — do NOT add more tool calls or check status
- Never poll TaskOutput or check swarm status — trust agents to return
- When agent results arrive, review ALL results before proceeding

## Linear Agent Integration

- OAuth `actor=app` tokens stored in SQLite — persist across restarts
- ALWAYS use AgentSessionEvent approach, the legacy webhook is for github and issues status hooks only
- AgentSessionEvent webhooks: emit thought activity within 10 seconds (SLA)
- Move issue to first "started" state before orchestrator dispatch
- Agent Activities (thought/action/elicitation/response/error) emitted alongside workpad comments
- Stop signal: immediately halt worker, emit final response
- Plan steps: update full array on each lifecycle phase transition
- `workspace.repos` in WORKFLOW.md is required — no env var fallback

## Testing

- TDD London School: write failing tests FIRST, then implement minimum code
- 100% coverage is the goal for new code paths
- Each SPARC phase agent self-reviews against its spec before reporting done
- Node test runner: `node --import tsx --test tests/**/*.test.ts`
- Test conventions: `node:test` + `node:assert/strict`, mock-first, typed fixtures

## Claude Code vs CLI Tools

- Claude Code's Task tool handles ALL execution: agents, file ops, code generation, git
- CLI tools handle coordination via Bash: swarm init, memory, hooks, routing
- NEVER use CLI tools as a substitute for Task tool agents

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
