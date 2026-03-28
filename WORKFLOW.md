---
templates:
  tdd-workflow:
    - .claude/agents/core/coder.md
    - .claude/agents/core/tester.md
  feature-build:
    - .claude/agents/sparc/architecture.md
    - .claude/agents/core/coder.md
    - .claude/agents/core/reviewer.md
  github-ops:
    - .claude/agents/core/reviewer.md
  quick-fix:
    - .claude/agents/core/coder.md
  security-audit:
    - .claude/agents/v3/security-architect.md
  cicd-pipeline:
    - .claude/agents/core/coder.md
  release-pipeline:
    - .claude/agents/core/coder.md
  sparc-full:
    - .claude/agents/core/architect.md
    - .claude/agents/core/coder.md
    - .claude/agents/core/reviewer.md
    - .claude/agents/core/tester.md

github:
  events:
    pull_request.opened: github-ops
    pull_request.synchronize: github-ops
    pull_request.closed.merged: release-pipeline
    pull_request.ready_for_review: github-ops
    push.default_branch: cicd-pipeline
    issues.opened: github-ops
    issues.labeled.bug: tdd-workflow
    issues.labeled.enhancement: feature-build
    issues.labeled.security: security-audit
    issue_comment.mentions_bot: quick-fix
    workflow_run.failure: quick-fix
    release.published: release-pipeline
    deployment_status.failure: quick-fix

tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  team: $LINEAR_TEAM_ID
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

agents:
  max_concurrent: 8
  routing:
    bug: tdd-workflow
    feature: feature-build
    security: security-audit
    refactor: sparc-full
    review: github-ops
    default: quick-fix

polling:
  interval_ms: 30000
  enabled: false

stall:
  timeout_ms: 300000
---

You are an autonomous development agent working on {{ issue.identifier }}.

{{ issue.description }}
