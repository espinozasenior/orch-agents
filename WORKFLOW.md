---
# templates: section removed (Option C step 2b).
# Coordinator mode now handles all dispatch dynamically. The coordinator
# decides what work to do based on the issue context and the CC-canonical
# 4-phase workflow (Research → Synthesis → Implementation → Verification).

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
