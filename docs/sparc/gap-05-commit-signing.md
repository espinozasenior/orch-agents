# SPARC Gap 5: Commit Signing

## Enterprise Commit Signing for Compliance

## Priority: P1
## Estimated Effort: 2-3 days
## Status: Planning

---

## Problem Statement

Commits created by orch-agents in worktrees are unsigned. Enterprise environments with branch protection rules requiring signed commits will reject pushes from orch-agents. The current `ArtifactApplier` creates commits via `git commit -m` and the `WorktreeManager` commits via `git -C {path} commit -m`, neither of which signs commits. Two signing methods are needed: GitHub API signing (where GitHub applies its own signature to commits created via the REST API) and SSH key signing (where the agent uses a local SSH key configured via `gpg.format=ssh`).

---

## S -- Specification

### Requirements

1. **R1 -- Add commit signing configuration to AppConfig.** Add `commitSigningMethod?: 'none' | 'github-api' | 'ssh'` and `sshSigningKey?: string` fields to the `AppConfig` interface. Default is `'none'` for backward compatibility.

2. **R2 -- Implement GitHub API signing method.** When `commitSigningMethod` is `'github-api'`, replace `git commit` with `gh api repos/{repo}/git/commits` to create commits via the GitHub REST API. Commits created this way are automatically signed by GitHub's internal GPG key with a "Verified" badge.

3. **R3 -- Implement SSH key signing method.** When `commitSigningMethod` is `'ssh'`, configure the worktree's local git config with `commit.gpgsign=true`, `gpg.format=ssh`, and `user.signingkey={path}` before creating commits. The existing `git commit` command then signs automatically.

4. **R4 -- Modify ArtifactApplier to use the selected signing method.** The `apply()` method must accept signing configuration and use the appropriate commit creation strategy.

5. **R5 -- Modify WorktreeManager to configure signing in worktree setup.** When SSH signing is selected, the `create()` method configures git signing settings in the worktree immediately after creation. This ensures any commit made in the worktree is automatically signed.

6. **R6 -- Validate SSH key at startup.** When `commitSigningMethod` is `'ssh'`, validate that `sshSigningKey` is provided, the file exists, and is readable. Fail fast with a clear error message rather than failing on first commit.

7. **R7 -- Default to 'none' for backward compatibility.** When no signing configuration is provided, behavior is identical to today: unsigned commits via `git commit -m`.

### Acceptance Criteria

- AC1: With `commitSigningMethod: 'none'`, commits are created identically to current behavior.
- AC2: With `commitSigningMethod: 'github-api'`, commits are created via `gh api repos/{repo}/git/commits` and the resulting commit SHA is returned.
- AC3: With `commitSigningMethod: 'ssh'`, `git log --show-signature` on the worktree commit shows a valid SSH signature.
- AC4: With `commitSigningMethod: 'ssh'` and a nonexistent key path, startup fails with `Error: SSH signing key not found: {path}`.
- AC5: With `commitSigningMethod: 'github-api'`, the commit tree, parent, and message are correctly passed to the API.
- AC6: ArtifactApplier.apply() returns the correct commitSha regardless of signing method.
- AC7: WorktreeManager.create() configures signing settings when SSH method is selected.

### Constraints

- Must not require GPG to be installed. SSH signing uses only `ssh-keygen` (already present on macOS/Linux).
- Must not store or log the SSH key contents. Only the file path is stored in config.
- Must not change the ArtifactApplier or WorktreeManager interfaces -- signing config is injected via constructor deps.
- GitHub API signing requires the repo context (owner/name) which must flow from IntakeEvent through to the commit creation point.
- Must work with both worktree-based commits (ArtifactApplier) and direct commits (WorktreeManager.commit).

### Edge Cases

- SSH key file exists but has wrong permissions (not readable) -- fail with descriptive error at startup.
- GitHub API commit creation fails (network, auth) -- fall back to unsigned commit with warning log? No: fail the commit and let retry handler deal with it.
- Repo context unavailable (no IntakeEvent) -- GitHub API signing cannot work; fall back to 'none' with warning.
- Multiple worktrees for same plan -- each worktree gets its own git config, no shared state.
- SSH key is an ed25519 key vs RSA -- both work with `gpg.format=ssh`; no format restriction needed.
- `gh` CLI not authenticated -- GitHub API signing fails; clear error message.

---

## P -- Pseudocode

### P1 -- Config Extension

```
interface AppConfig:
  // ... existing fields ...
  commitSigningMethod?: 'none' | 'github-api' | 'ssh'
  sshSigningKey?: string  // absolute path to SSH private key

function loadConfig(env) -> AppConfig:
  // ... existing loading ...
  commitSigningMethod = env.COMMIT_SIGNING_METHOD ?? 'none'
  if commitSigningMethod not in ['none', 'github-api', 'ssh']:
    throw Error('Invalid COMMIT_SIGNING_METHOD')

  sshSigningKey = env.SSH_SIGNING_KEY ?? undefined
  if commitSigningMethod == 'ssh' and !sshSigningKey:
    throw Error('SSH_SIGNING_KEY required when COMMIT_SIGNING_METHOD=ssh')

  return { ...config, commitSigningMethod, sshSigningKey }
```

### P2 -- SSH Key Validation

```
function validateSshSigningKey(keyPath: string): void:
  try:
    stat = fs.statSync(keyPath)
    if !stat.isFile():
      throw Error(`SSH signing key is not a file: ${keyPath}`)
    // Check readable
    fs.accessSync(keyPath, fs.constants.R_OK)
  catch err:
    if err.code == 'ENOENT':
      throw Error(`SSH signing key not found: ${keyPath}`)
    throw Error(`SSH signing key not accessible: ${keyPath}: ${err.message}`)
```

### P3 -- CommitSigner Interface

```
interface CommitSigner:
  /** Create a signed commit and return the SHA. */
  createCommit(opts: CommitOpts): Promise<string>

interface CommitOpts:
  worktreePath: string
  message: string
  repo?: string  // Required for github-api method

class NoOpSigner implements CommitSigner:
  createCommit(opts) -> Promise<string>:
    // Stage + commit as today
    await exec('git', ['-C', opts.worktreePath, 'add', '-A'])
    result = await exec('git', ['-C', opts.worktreePath, 'commit', '-m', opts.message])
    return extractSha(result.stdout)

class SshSigner implements CommitSigner:
  // No special commit logic needed; git config handles signing
  createCommit(opts) -> Promise<string>:
    await exec('git', ['-C', opts.worktreePath, 'add', '-A'])
    result = await exec('git', ['-C', opts.worktreePath, 'commit', '-m', opts.message])
    return extractSha(result.stdout)

class GitHubApiSigner implements CommitSigner:
  constructor(exec, token)

  createCommit(opts) -> Promise<string>:
    if !opts.repo: throw Error('repo required for github-api signing')

    // 1. Stage all changes
    await exec('git', ['-C', opts.worktreePath, 'add', '-A'])

    // 2. Create tree from index
    treeResult = await exec('git', ['-C', opts.worktreePath, 'write-tree'])
    treeSha = treeResult.stdout.trim()

    // 3. Get parent commit
    parentResult = await exec('git', ['-C', opts.worktreePath, 'rev-parse', 'HEAD'])
    parentSha = parentResult.stdout.trim()

    // 4. Create commit via GitHub API (signed by GitHub)
    apiResult = await exec('gh', [
      'api', '-X', 'POST',
      `repos/${opts.repo}/git/commits`,
      '-f', `message=${opts.message}`,
      '-f', `tree=${treeSha}`,
      '-f', `parents[]=${parentSha}`
    ])
    commitSha = JSON.parse(apiResult.stdout).sha

    // 5. Update local branch to point to new commit
    await exec('git', ['-C', opts.worktreePath, 'update-ref', 'HEAD', commitSha])

    return commitSha
```

### P4 -- Worktree SSH Configuration

```
function configureWorktreeSigning(worktreePath, signingKey, exec):
  await exec('git', ['-C', worktreePath, 'config', 'commit.gpgsign', 'true'])
  await exec('git', ['-C', worktreePath, 'config', 'gpg.format', 'ssh'])
  await exec('git', ['-C', worktreePath, 'config', 'user.signingkey', signingKey])
```

### P5 -- Factory

```
function createCommitSigner(config, exec) -> CommitSigner:
  switch config.commitSigningMethod:
    case 'none': return new NoOpSigner(exec)
    case 'ssh': return new SshSigner(exec)
    case 'github-api': return new GitHubApiSigner(exec, config.githubToken)
    default: return new NoOpSigner(exec)
```

### Complexity Analysis

- Config validation: O(1)
- SSH key validation: O(1) (single stat + access check)
- NoOpSigner.createCommit: same as current -- O(1) git commands
- SshSigner.createCommit: same as current -- O(1) git commands (signing is transparent)
- GitHubApiSigner.createCommit: O(1) git commands + 1 API call
- Worktree SSH config: O(1) -- 3 git config commands

---

## A -- Architecture

### New Components

```
src/execution/commit-signer.ts         -- CommitSigner interface + 3 implementations + factory
```

### Modified Components

```
src/shared/config.ts                   -- Add commitSigningMethod, sshSigningKey to AppConfig + loadConfig
src/execution/artifact-applier.ts      -- Accept CommitSigner dep, delegate commit creation
src/execution/worktree-manager.ts      -- Accept signing config, configure worktree on create
src/pipeline.ts                        -- Wire CommitSigner from config into deps
src/index.ts                           -- Validate SSH key at startup
```

### CommitSigner as Strategy

The CommitSigner follows the Strategy pattern. ArtifactApplier and WorktreeManager receive a CommitSigner via dependency injection. This keeps signing logic decoupled from commit validation logic.

```
ArtifactApplierDeps:
  + commitSigner?: CommitSigner  // defaults to NoOpSigner

WorktreeManagerDeps:
  + signingConfig?: { method: 'ssh', keyPath: string }  // for worktree git config
```

### GitHub API Signing Flow

```
Agent writes files in worktree
  -> ArtifactApplier.apply()
    -> git add -A (stage changes)
    -> git write-tree (create tree object)
    -> git rev-parse HEAD (get parent)
    -> gh api repos/{repo}/git/commits (create signed commit via API)
    -> git update-ref HEAD {sha} (update local branch)
  -> ArtifactApplier returns commitSha
```

The key insight is that `git write-tree` creates a tree object from the index (staged changes) without creating a commit. The commit is then created server-side via GitHub API, which signs it. Finally, `git update-ref` points the local branch at the new commit so subsequent operations (push, diff) work correctly.

### SSH Signing Flow

```
WorktreeManager.create()
  -> git worktree add ...
  -> git -C {path} config commit.gpgsign true
  -> git -C {path} config gpg.format ssh
  -> git -C {path} config user.signingkey {keyPath}

Agent writes files in worktree
  -> ArtifactApplier.apply()
    -> git add -A
    -> git commit -m {message}  // automatically signed by git due to config
  -> ArtifactApplier returns commitSha
```

### Repo Context Propagation

GitHub API signing requires the `repo` (e.g., `owner/name`). This already exists in `IntakeEvent.entities.repo`. The repo context must flow through:

```
IntakeEvent.entities.repo
  -> InteractiveStrategy (already has intakeEvent)
  -> ArtifactApplier.apply() (needs new repo parameter or CommitOpts)
```

The CommitOpts struct carries `repo?` as an optional field. When using `github-api` signing without repo context, the signer throws a clear error.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| GitHub API tree/commit mismatch | MEDIUM | Test with real repo; git write-tree is deterministic |
| SSH key permissions on CI | LOW | Validate at startup; document required permissions |
| git update-ref leaves detached HEAD | LOW | Always update via symbolic ref; test branch state after |
| gh CLI auth token scope | MEDIUM | Document required scope: `repo` permission needed |
| Worktree git config persists after dispose | NONE | Worktree removal deletes the directory and all config |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: Config extension + tests (0 dependencies)

Tests:
- Test: loadConfig with no COMMIT_SIGNING_METHOD returns `commitSigningMethod: 'none'`
- Test: loadConfig with `COMMIT_SIGNING_METHOD=ssh` and `SSH_SIGNING_KEY=/path` returns both fields
- Test: loadConfig with `COMMIT_SIGNING_METHOD=ssh` without SSH_SIGNING_KEY throws
- Test: loadConfig with invalid COMMIT_SIGNING_METHOD throws
- Test: loadConfig with `COMMIT_SIGNING_METHOD=github-api` returns correct method (no key needed)

### Step 2: SSH key validation + tests (mock fs)

Tests (London School -- mock fs.statSync, fs.accessSync):
- Test: validateSshSigningKey with existing readable file passes
- Test: validateSshSigningKey with nonexistent file throws with "not found" message
- Test: validateSshSigningKey with directory (not file) throws with "not a file" message
- Test: validateSshSigningKey with unreadable file throws with "not accessible" message

### Step 3: NoOpSigner + tests (mock exec)

Tests (London School -- mock exec):
- Test: createCommit calls `git add -A` then `git commit -m`
- Test: createCommit returns extracted SHA from git output
- Test: createCommit propagates exec errors

### Step 4: SshSigner + tests (mock exec)

Tests (London School -- mock exec):
- Test: createCommit calls same git commands as NoOpSigner (signing is in git config)
- Test: createCommit returns extracted SHA

### Step 5: GitHubApiSigner + tests (mock exec)

Tests (London School -- mock exec):
- Test: createCommit calls git add, write-tree, rev-parse, gh api, update-ref in order
- Test: createCommit passes correct tree and parent to gh api
- Test: createCommit returns SHA from API response
- Test: createCommit without repo throws Error
- Test: createCommit propagates API errors

### Step 6: createCommitSigner factory + tests

Tests:
- Test: factory with 'none' returns NoOpSigner
- Test: factory with 'ssh' returns SshSigner
- Test: factory with 'github-api' returns GitHubApiSigner
- Test: factory with undefined returns NoOpSigner

### Step 7: ArtifactApplier integration + tests (mock CommitSigner)

Tests (London School -- mock CommitSigner):
- Test: apply() delegates commit creation to CommitSigner
- Test: apply() without CommitSigner uses default (NoOp) behavior
- Test: apply() passes worktreePath and message to CommitSigner
- Test: apply() passes repo to CommitSigner when available
- Test: rollback behavior unchanged

### Step 8: WorktreeManager integration + tests (mock exec)

Tests (London School -- mock exec):
- Test: create() with SSH signing config calls 3 git config commands after worktree creation
- Test: create() without signing config skips git config calls
- Test: create() with 'none' signing config skips git config calls

### Step 9: Pipeline wiring + startup validation

Tests:
- Test: startPipeline with SSH config validates key and wires CommitSigner
- Test: startup with invalid SSH key path fails before pipeline starts

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on commit-signer.ts
- `npm run build` succeeds
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] AppConfig includes commitSigningMethod and sshSigningKey fields
- [ ] loadConfig validates signing configuration
- [ ] SSH key validated at startup
- [ ] NoOpSigner produces identical behavior to current code
- [ ] SshSigner produces signed commits (manual verification with `git log --show-signature`)
- [ ] GitHubApiSigner creates commits via API with "Verified" badge
- [ ] ArtifactApplier delegates to CommitSigner
- [ ] WorktreeManager configures SSH signing in worktree
- [ ] Default 'none' is backward compatible

### Deployment Steps

1. `npm run build` -- verify compilation
2. `npm test` -- verify all tests pass
3. Deploy with no new env vars (defaults to `commitSigningMethod: 'none'`)
4. To enable SSH signing: set `COMMIT_SIGNING_METHOD=ssh` and `SSH_SIGNING_KEY=/path/to/key`
5. To enable GitHub API signing: set `COMMIT_SIGNING_METHOD=github-api`
6. Verify: create a test PR, inspect commit signature

### Rollback Plan

1. Remove `COMMIT_SIGNING_METHOD` env var -- system defaults to 'none' (unsigned commits)
2. No code rollback needed; signing is purely additive
3. Commits already signed remain signed (immutable in git)
4. No database or persistent state changes

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/execution/commit-signer.ts` | NEW |
| `src/shared/config.ts` | MODIFIED (add signing fields to AppConfig) |
| `src/execution/artifact-applier.ts` | MODIFIED (accept CommitSigner dep) |
| `src/execution/worktree-manager.ts` | MODIFIED (configure signing on create) |
| `src/pipeline.ts` | MODIFIED (wire CommitSigner) |
| `src/index.ts` | MODIFIED (validate SSH key at startup) |
| `tests/execution/commit-signer.test.ts` | NEW |
| `tests/shared/config.test.ts` | MODIFIED |
| `tests/execution/artifact-applier.test.ts` | MODIFIED |
| `tests/execution/worktree-manager.test.ts` | MODIFIED |
