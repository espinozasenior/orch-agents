---
# templates: section removed (Option C step 2b).
# Coordinator mode now handles all dispatch dynamically. The coordinator
# decides what work to do based on the issue context and the CC-canonical
# 4-phase workflow (Research → Synthesis → Implementation → Verification).

github:
  # P20: values are relative paths to skill files. Behavior lives in the
  # SKILL.md body; context fetchers live in its frontmatter. Add a new route
  # by editing this map — no TypeScript changes required. Events without an
  # explicit entry here are silently skipped at the normalizer (no IntakeEvent,
  # no worktree, no coordinator cycle). Explicit-only routing — no default
  # catch-all by design.
  events:
    pull_request.opened: .claude/skills/github-ops/SKILL.md
    pull_request.synchronize: .claude/skills/github-ops/SKILL.md
    pull_request.ready_for_review: .claude/skills/github-ops/SKILL.md

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

agents:
  max_concurrent: 8
  # routing: section removed (Option C step 2b). Coordinator mode is now
  # the only dispatch path — label-based template routing is no longer used.

polling:
  interval_ms: 30000
  enabled: false

stall:
  timeout_ms: 300000

workspace:
  root: /tmp/orch-agents
  default_repo: marketplace-monorepo
  repos:
    - name: marketplace-monorepo
      url: git@github.com:somnio-projects/marketplace-monorepo.git
      teams: [AUT]
      labels: [marketplace-monorepo, backend, infra]
      default_branch: main

    - name: orch-agents
      url: git@github.com:espinozasenior/orch-agents.git
      labels: [agent, orchestrator, bot]
      default_branch: main
---

You are an autonomous development agent working on {{ issue.identifier }}.

{{ issue.description }}
