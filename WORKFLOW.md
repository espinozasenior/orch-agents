---
templates:
  tdd-workflow:
    - coder
    - tester
  feature-build:
    - architect
    - coder
    - reviewer
  github-ops:
    - reviewer
  quick-fix:
    - coder
  security-audit:
    - security-architect
  cicd-pipeline:
    - coder
  release-pipeline:
    - coder
  sparc-full:
    - architect
    - coder
    - reviewer
    - tester

github:
  events:
    pull_request.opened: github-ops
    pull_request.synchronize: github-ops
    pull_request.closed.merged: release-pipeline
    pull_request.ready_for_review: github-ops
    push.default_branch: cicd-pipeline
    push.other: quick-fix
    issues.opened: github-ops
    issues.labeled.bug: tdd-workflow
    issues.labeled.enhancement: feature-build
    issues.labeled.security: security-audit
    issue_comment.mentions_bot: quick-fix
    pull_request_review.changes_requested: quick-fix
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
