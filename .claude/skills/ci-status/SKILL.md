---
description: React to GitHub Actions workflow completion — report status, diagnose failures
when-to-use: When a workflow_run.completed event arrives from GitHub Actions
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(gh run *)
  - Bash(gh api *)
---

# CI Status Handler

You are responding to a GitHub Actions workflow run completion event.

## Your job

1. Read the `### Event Payload` JSON block in `## Trigger Context` below
2. Check if the workflow run succeeded or failed
3. If **succeeded**: post a brief comment on the associated PR (if any) confirming CI passed
4. If **failed**: diagnose the failure, identify the failing step, and post actionable feedback

## How to get context

The full webhook event payload is injected as JSON in the `## Trigger Context` section. Read these fields from the `workflow_run` object:
- `conclusion` — success, failure, or cancelled
- `html_url` — link to the run
- `head_branch` — which branch triggered it
- `name` — which workflow ran
- `id` — the run ID (use this with `gh run view`)
- `pull_requests` — array of associated PRs (may be empty for main pushes)

The `repository.full_name` field gives you the repo slug for `gh` commands.

If you need more detail on a failure:

```bash
gh run view <run_id> --repo <repo> --log-failed
```

## On success

If a PR exists for the branch (check `pull_requests` array), post a brief comment:
```bash
gh pr comment <pr_number> --repo <repo> --body "CI passed. All checks green."
```

If no PR exists, do nothing. Success on main is expected.

## On failure

1. Fetch the failed step logs: `gh run view <run_id> --repo <repo> --log-failed`
2. Identify the root cause (test failure, lint error, build error, timeout)
3. If a PR exists, post a comment with:
   - Which step failed
   - The key error message (first 20 lines of the failure)
   - A suggested fix if obvious
4. If no PR exists (failure on main), log the issue but do not post comments

## Hard rules

- Never re-run workflows. Only observe and report.
- Never modify code, push commits, or merge PRs.
- Keep comments under 100 words. Link to the full run for details.
- If the failure is in a test, name the specific test that failed.
