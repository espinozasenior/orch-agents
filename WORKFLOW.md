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
repos:
  somnio-projects/marketplace-monorepo:
    url: git@github.com:somnio-projects/marketplace-monorepo.git
    default_branch: main
    teams:
      - AUT
    labels:
      - marketplace-monorepo
      - backend
      - infra
    github:
      events:
        # PR lifecycle — full Open-Inspect coverage
        pull_request.opened: .claude/skills/github-ops/SKILL.md
        pull_request.ready_for_review: .claude/skills/github-ops/SKILL.md
        pull_request.synchronize: .claude/skills/github-ops/SKILL.md
        # Review response — auto-address changes requested
        pull_request_review.changes_requested: .claude/skills/github-ops/SKILL.md
        # CI failure triage — diagnose and fix
        workflow_run.failure: .claude/skills/ci-status/SKILL.md
        # Issue management
        issues.opened: .claude/skills/github-deep-research/SKILL.md
        issues.labeled.bug: .claude/skills/github-ops/SKILL.md
        issues.labeled.enhancement: .claude/skills/github-ops/SKILL.md
        # Comment interaction — respond to @mentions
        issue_comment.created: .claude/skills/github-ops/SKILL.md
    tracker:
      team: AUT
  espinozasenior/orch-agents:
    url: git@github.com:espinozasenior/orch-agents.git
    default_branch: main
    labels:
      - agent
      - orchestrator
      - bot
    github:
      events:
        pull_request.opened: .claude/skills/github-ops/SKILL.md
        pull_request.ready_for_review: .claude/skills/github-ops/SKILL.md
        issues.opened: .claude/skills/github-deep-research/SKILL.md
        workflow_run.completed: .claude/skills/ci-status/SKILL.md
  espinozasenior/automata-somnio-tl:
    url: git@github.com:espinozasenior/automata-somnio-tl.git
    default_branch: main
    github:
      events:
        pull_request.opened: .claude/skills/github-ops/SKILL.md
        issues.opened: .claude/skills/github-ops/SKILL.md
        # pull_request.ready_for_review: .claude/skills/github-ops/SKILL.md
        # pull_request.synchronize: .claude/skills/github-ops/SKILL.md
        # pull_request.closed: .claude/skills/github-ops/SKILL.md
        # issue_comment.created: .claude/skills/github-ops/SKILL.md
        # push.default_branch: .claude/skills/github-ops/SKILL.md
        # pull_request_review.submitted: .claude/skills/github-ops/SKILL.md
        # workflow_run.completed: .claude/skills/github-ops/SKILL.md
        # release.published: .claude/skills/github-ops/SKILL.md
---



You are an autonomous development agent working on {{ issue.identifier }}.

{{ issue.description }}
