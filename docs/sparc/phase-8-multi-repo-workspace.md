# Phase 8: Multi-Repository Workspace Resolution

## Goal
Enable the agent to work across multiple GitHub repositories from a single Linear workspace. Each issue is automatically matched to the correct repository using team keys, labels, Linear's `issueRepositorySuggestions` API, and the `select` signal as a user fallback.

## Specification

### Problem Statement
The current system hardcodes a single repository via `GITHUB_REPOSITORY` env var. All issue worktrees are created from this one repo. In practice, Linear workspaces span multiple repos — frontend, backend, docs, infrastructure. The agent must resolve which repo to clone/worktree for each issue.

### Functional Requirements
- FR-8.01: Parse `workspace.repos[]` config from WORKFLOW.md frontmatter
- FR-8.02: Each repo entry has: `name`, `url`, optional `teams[]` (Linear team keys), optional `labels[]` (issue label matching), optional `defaultBranch`
- FR-8.03: Resolve repo per-issue using priority chain: (1) label match, (2) team key match, (3) `issueRepositorySuggestions` API, (4) `select` signal user prompt, (5) fallback to `defaultRepo`
- FR-8.04: Cache cloned repos in `workspace.root` so subsequent issues for the same repo reuse the clone
- FR-8.05: Worktree creation uses the resolved repo's local clone as the git source
- FR-8.06: Pass resolved repo URL and branch to the issue worker via `workerData`
- FR-8.07: Backward compatible — if no `workspace.repos` config, use existing `GITHUB_REPOSITORY` behavior
- FR-8.08: Support `issueRepositorySuggestions` with all configured repos as candidates
- FR-8.09: Auto-select when suggestion confidence > 0.8; emit `select` signal when ambiguous

### Non-Functional Requirements
- Repo cloning must happen once and be reused (not per-issue)
- Clone operations must not block the orchestrator tick loop (async, background)
- Label and team matching must be case-insensitive
- The resolver must be deterministic for the same issue metadata

### Acceptance Criteria
- Issue with label "frontend" routes to the frontend repo when `labels: [frontend]` is configured
- Issue in team "FE" routes to the frontend repo when `teams: [FE]` is configured
- Issue with no matching labels/teams triggers `issueRepositorySuggestions` query
- Low-confidence suggestion triggers `select` elicitation in Linear
- Issue with no config match uses the default repo
- Worktree for issue X is created from the correct repo's local clone
- Second issue for the same repo reuses the existing clone (no re-clone)

## Pseudocode

```text
TYPE RepoConfig = {
  name: string
  url: string
  teams?: string[]
  labels?: string[]
  defaultBranch?: string
}

TYPE WorkspaceConfig = {
  root: string
  repos: RepoConfig[]
  defaultRepo?: string         // fallback — name of default repo
}

FUNCTION resolveRepoForIssue(issue, workspaceConfig, linearClient?, agentSessionId?):
  repos = workspaceConfig.repos
  IF repos is empty:
    RETURN { url: GITHUB_REPOSITORY, branch: GITHUB_BASE_BRANCH }

  // 1. Label match (highest priority — explicit routing)
  FOR EACH repo IN repos:
    IF repo.labels AND issue.labels intersect repo.labels (case-insensitive):
      RETURN repo

  // 2. Team key match
  FOR EACH repo IN repos:
    IF repo.teams AND issue.team.key IN repo.teams (case-insensitive):
      RETURN repo

  // 3. issueRepositorySuggestions (Linear AI ranking)
  IF linearClient AND agentSessionId:
    candidates = repos.map(r => { hostname: "github.com", repositoryFullName: extractFullName(r.url) })
    suggestions = linearClient.issueRepositorySuggestions(issue.id, agentSessionId, candidates)
    bestMatch = suggestions.sort(by: confidence).first

    IF bestMatch.confidence > 0.8:
      RETURN repos.find(r => r includes bestMatch.repositoryFullName)

    // 4. Select signal — ask user
    IF agentSessionId:
      emitSelectElicitation(linearClient, agentSessionId,
        "Which repository should I work in for this issue?",
        suggestions.map(s => ({ label: s.repositoryFullName.split('/').pop(), value: s.repositoryFullName }))
      )
      // Wait for prompted webhook with user's selection
      RETURN PENDING  // orchestrator handles async resolution

  // 5. Fallback to default
  defaultRepo = repos.find(r => r.name == workspaceConfig.defaultRepo) ?? repos[0]
  RETURN defaultRepo

FUNCTION ensureRepoCloned(repo, workspaceRoot):
  clonePath = join(workspaceRoot, 'repos', repo.name)
  IF exists(clonePath):
    // Pull latest
    exec(`git -C ${clonePath} fetch origin`)
    RETURN clonePath

  // Clone fresh
  exec(`git clone ${repo.url} ${clonePath}`)
  RETURN clonePath

FUNCTION createWorktreeFromRepo(clonePath, issueId, baseBranch):
  worktreePath = join(workspaceRoot, 'issues', issueId)
  exec(`git -C ${clonePath} worktree add ${worktreePath} -b issue/${issueId} origin/${baseBranch}`)
  RETURN worktreePath
```

## Architecture

### Primary Components
- `src/integration/linear/workflow-parser.ts` — Parse `workspace.repos[]` from WORKFLOW.md
- `src/execution/orchestrator/repo-resolver.ts` (NEW) — Resolve repo per-issue
- `src/execution/workspace/worktree-manager.ts` — Support creating worktrees from external repo clones
- `src/execution/orchestrator/symphony-orchestrator.ts` — Pass resolved repo to worker
- `src/execution/orchestrator/issue-worker.ts` — Accept resolved repo in workerData
- `src/execution/orchestrator/issue-worker-runner.ts` — Use resolved repo for workspace

### Data Flow
```
Issue arrives (AUT-7, labels: [bug, frontend], team: FE)
  │
  ▼
repo-resolver.ts
  ├─ Check labels: "frontend" matches repos[1].labels → HIT
  │  (skip team/suggestions/select)
  │
  ▼
ensureRepoCloned("frontend-app")
  ├─ /tmp/orch-agents/repos/frontend-app/ exists? → git fetch
  ├─ doesn't exist? → git clone
  │
  ▼
createWorktreeFromRepo()
  ├─ /tmp/orch-agents/issues/{issueId}/ ← worktree from frontend-app clone
  │
  ▼
issue-worker runs Claude in the correct repo context
```

### Directory Structure
```
/tmp/orch-agents/
  ├── repos/                    # Shared clones (one per repo)
  │   ├── orch-agents/          # git clone of espinozasenior/orch-agents
  │   ├── frontend-app/         # git clone of espinozasenior/frontend-app
  │   └── api-docs/             # git clone of espinozasenior/api-docs
  │
  └── issues/                   # Per-issue worktrees
      ├── acdb4d5e-.../         # worktree from orch-agents clone
      └── f7a8b3c2-.../         # worktree from frontend-app clone
```

### Design Decisions
- **Label match > team match > API suggestion > user prompt > default** — explicit routing beats AI inference
- **Shared clone directory** — avoids re-cloning the same repo for every issue
- **Worktrees from clones** — `git worktree add` from the shared clone, not from `process.cwd()`
- **Async repo resolution** — the `select` signal path is inherently async (waits for user response via webhook). The orchestrator must handle a PENDING state.
- **Backward compat** — no `workspace.repos` = existing single-repo behavior unchanged

## Refinement

### WORKFLOW.md Config Example
```yaml
workspace:
  root: /tmp/orch-agents
  default_repo: orch-agents
  repos:
    - name: orch-agents
      url: git@github.com:espinozasenior/orch-agents.git
      teams: [AUT]
      labels: [backend, agent, infra]
      default_branch: main

    - name: frontend-app
      url: git@github.com:espinozasenior/frontend-app.git
      teams: [FE]
      labels: [frontend, ui, design]
      default_branch: main

    - name: api-docs
      url: git@github.com:espinozasenior/api-docs.git
      labels: [docs, documentation]
      default_branch: main
```

### File Targets
- `src/integration/linear/workflow-parser.ts` — Parse `workspace.repos[]`
- `src/execution/orchestrator/repo-resolver.ts` (NEW)
- `src/execution/workspace/worktree-manager.ts` — `createFromClone()` method
- `src/execution/orchestrator/symphony-orchestrator.ts`
- `src/execution/orchestrator/issue-worker.ts`
- `src/execution/orchestrator/issue-worker-runner.ts`

### Exact Tests
- `tests/execution/repo-resolver.test.ts` (NEW)
  - Label match returns correct repo
  - Team key match returns correct repo when no label match
  - Case-insensitive label matching
  - issueRepositorySuggestions called when no label/team match
  - High-confidence suggestion (>0.8) auto-selects
  - Low-confidence triggers select elicitation
  - No repos configured returns default
  - Empty workspace.repos uses GITHUB_REPOSITORY fallback
- `tests/integration/linear/workflow-parser.test.ts`
  - Parse workspace.repos with all fields
  - Parse workspace.repos with minimal fields (name + url only)
  - Missing workspace.repos section returns undefined
- `tests/execution/issue-worker.test.ts`
  - Worker receives resolved repo URL in workerData
  - Worktree created from resolved repo's clone path

### Risks
- `select` signal path is async — the orchestrator must handle the gap between emitting the elicitation and receiving the user's response in a `prompted` webhook. The issue stays in a "pending repo selection" state.
- Git clone over SSH requires SSH keys available to the server process. HTTPS with token may be more reliable for CI/server environments.
- Large repos may take significant time to clone on first use — should show a "Cloning repository..." action activity in Linear.
- Concurrent clone attempts for the same repo need a mutex to avoid corruption.
