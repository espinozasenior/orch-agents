# SPARC Gap 6: Consensus Protocol Wiring

## Conflict Resolution for Multi-Agent Parallel Execution

## Priority: P1
## Estimated Effort: 10-14 days
## Status: Planning

---

## Problem Statement

The `WorkflowPlan.consensus` field supports `'raft' | 'pbft' | 'none'`, and workflow templates specify consensus per template (e.g., github-ops uses 'raft'). However, no actual consensus logic exists in the execution path. When multiple agents within a phase produce conflicting file changes in their worktrees, the current system has no mechanism to detect or resolve these conflicts. The `SwarmManager` exists but does not implement consensus. The `PhaseRunner` runs phases sequentially and delegates to strategies, but strategies like `InteractiveStrategy` run one agent per phase. When parallel agents in a shared phase modify the same files, the last write wins silently -- there is no merge, vote, or conflict detection.

This gap becomes critical as the system scales to multi-agent parallel execution within phases, which is the intended architecture for `hierarchical-mesh` topologies with `specialized` strategy.

---

## S -- Specification

### Requirements

1. **R1 -- Create a ConsensusProtocol interface.** Define `ConsensusProtocol` with a `propose(changesets: AgentChangeset[]): Promise<MergedChangeset>` method in a new `src/execution/consensus/` bounded context. This interface is the single integration point for all consensus strategies.

2. **R2 -- Implement RaftConsensus (leader-based).** The designated "lead" agent's changes take unconditional priority. Non-leader changes are accepted only if they do not conflict with leader changes (no overlapping file paths with different content). Conflicting non-leader changes are surfaced as PR inline comment suggestions rather than being discarded.

3. **R3 -- Implement PBFTConsensus (Byzantine fault-tolerant).** Require 2f+1 votes for change acceptance, where f = floor((n-1)/3) and n = number of agents. Each agent's changeset is a proposal. Changes to a file are accepted when a supermajority of agents agree on the content. Rejected changes become findings in the ReviewVerdict.

4. **R4 -- Implement NoConsensus passthrough.** First-come-first-served: the first agent's changeset is accepted in full. This preserves current behavior when `consensus: 'none'`.

5. **R5 -- Define AgentChangeset and MergedChangeset types.** `AgentChangeset` captures per-agent output: `{ agentRole, files: Map<path, diff>, confidence: number, reasoning: string }`. `MergedChangeset` captures the consensus result: `{ accepted: Map<path, diff>, rejected: RejectedChange[], conflicts: ConflictRecord[] }`.

6. **R6 -- Wire consensus into PhaseRunner.** After all agents in a phase complete, and before proceeding to the next phase, run the configured consensus protocol on the collected changesets. The merged result is applied to the worktree.

7. **R7 -- Use git three-way merge for conflict detection.** Use `git merge-tree` or `git merge-file` to detect actual file-level conflicts between agent outputs, rather than simple path overlap. Two agents modifying the same file in non-overlapping regions should not be flagged as conflicts.

8. **R8 -- Emit ConsensusReached and ConsensusRejected domain events.** These events carry the merge result for observability and progress tracking.

### Acceptance Criteria

- AC1: With `consensus: 'none'`, behavior is identical to current (zero regression).
- AC2: With `consensus: 'raft'`, the leader agent's changes are always in the final merged result.
- AC3: With `consensus: 'raft'`, a non-leader agent modifying a file not touched by the leader has its changes accepted.
- AC4: With `consensus: 'raft'`, a non-leader agent modifying a file also modified by the leader has its changes surfaced as a suggestion, not applied.
- AC5: With `consensus: 'pbft'` and 3 agents, a change agreed upon by 2+ agents is accepted.
- AC6: With `consensus: 'pbft'` and 3 agents, a change proposed by only 1 agent is rejected.
- AC7: After consensus, a `ConsensusReached` event is emitted with accepted file count and rejected change count.
- AC8: Two agents modifying non-overlapping regions of the same file are not treated as conflicts (three-way merge).
- AC9: `MergedChangeset.rejected` entries appear as findings in ReviewVerdict.

### Constraints

- Must not introduce external dependencies for merge logic -- use git commands available in any git installation.
- Must not modify the `PhaseRunner` interface -- consensus is injected as a dependency, not a parameter change.
- Must work with existing worktree-based execution (agents write to their own worktrees).
- Consensus runs in-process (no external coordination service for Phase 0-2).
- Must handle the case where agents produce no changes (empty changeset).
- Must complete within the phase timeout (default 5 minutes); consensus itself should be sub-second for typical changesets.

### Edge Cases

- Single agent in phase -- consensus is a no-op passthrough regardless of configured protocol.
- All agents produce identical changes -- consensus accepts one copy, no conflicts.
- Agent produces empty changeset (no file changes) -- treated as "no opinion," does not count as a vote in PBFT.
- Agent fails before producing changeset -- excluded from consensus; remaining agents proceed.
- Leader agent fails in Raft -- fall back to NoConsensus for that phase with warning log.
- Binary file changes -- cannot three-way merge; treat as conflict, leader wins in Raft.
- File deleted by one agent, modified by another -- treat as conflict.
- Three-way merge produces conflict markers -- reject the merge, use leader's version (Raft) or reject change (PBFT).
- Consensus runs on a phase with 100 changed files -- must remain performant (git merge-file is per-file, parallelizable).

---

## P -- Pseudocode

### P1 -- Core Types

```
interface AgentChangeset:
  agentRole: string
  agentType: string
  isLeader: boolean
  files: Map<string, FileDiff>
  confidence: number  // 0-1, self-reported by agent
  reasoning: string

interface FileDiff:
  path: string
  status: 'added' | 'modified' | 'deleted'
  content: string  // full file content after changes
  diff: string     // unified diff

interface MergedChangeset:
  accepted: Map<string, FileDiff>
  rejected: RejectedChange[]
  conflicts: ConflictRecord[]

interface RejectedChange:
  agentRole: string
  path: string
  reason: string
  suggestion?: string  // for PR inline comments

interface ConflictRecord:
  path: string
  agents: string[]  // roles of conflicting agents
  resolution: 'leader-wins' | 'majority-wins' | 'rejected'

interface ConsensusProtocol:
  propose(changesets: AgentChangeset[]): Promise<MergedChangeset>
```

### P2 -- NoConsensus

```
class NoConsensus implements ConsensusProtocol:
  propose(changesets) -> Promise<MergedChangeset>:
    if changesets.length == 0:
      return { accepted: new Map(), rejected: [], conflicts: [] }

    // Take first changeset as-is
    first = changesets[0]
    return {
      accepted: first.files,
      rejected: [],
      conflicts: []
    }
```

### P3 -- RaftConsensus

```
class RaftConsensus implements ConsensusProtocol:
  constructor(mergeDriver: MergeDriver, logger: Logger)

  propose(changesets) -> Promise<MergedChangeset>:
    if changesets.length == 0:
      return empty result

    // Find leader
    leader = changesets.find(c => c.isLeader)
    if !leader:
      logger.warn('No leader found in Raft consensus, using first agent')
      leader = changesets[0]

    followers = changesets.filter(c => c != leader)
    accepted = new Map(leader.files)  // Leader changes always accepted
    rejected = []
    conflicts = []

    // For each follower, check for conflicts with leader
    for follower in followers:
      for (path, followerDiff) in follower.files:
        if !accepted.has(path):
          // No conflict with leader -- accept follower change
          accepted.set(path, followerDiff)
        else:
          // Both leader and follower modified same file
          leaderDiff = accepted.get(path)
          mergeResult = await mergeDriver.threeWayMerge(
            getBase(path),
            leaderDiff.content,
            followerDiff.content
          )

          if mergeResult.clean:
            // Non-overlapping changes -- accept merged content
            accepted.set(path, {
              ...leaderDiff,
              content: mergeResult.content,
              diff: mergeResult.diff
            })
          else:
            // Real conflict -- leader wins, follower becomes suggestion
            conflicts.push({
              path,
              agents: [leader.agentRole, follower.agentRole],
              resolution: 'leader-wins'
            })
            rejected.push({
              agentRole: follower.agentRole,
              path,
              reason: `Conflicts with leader (${leader.agentRole}) changes`,
              suggestion: followerDiff.diff
            })

    return { accepted, rejected, conflicts }
```

### P4 -- PBFTConsensus

```
class PBFTConsensus implements ConsensusProtocol:
  constructor(mergeDriver: MergeDriver, logger: Logger)

  propose(changesets) -> Promise<MergedChangeset>:
    if changesets.length == 0:
      return empty result

    n = changesets.length
    f = Math.floor((n - 1) / 3)
    quorum = 2 * f + 1

    // Collect all unique file paths
    allPaths = new Set()
    for cs in changesets:
      for path in cs.files.keys():
        allPaths.add(path)

    accepted = new Map()
    rejected = []
    conflicts = []

    for path in allPaths:
      // Gather all proposals for this file
      proposals = changesets
        .filter(cs => cs.files.has(path))
        .map(cs => ({ agentRole: cs.agentRole, diff: cs.files.get(path) }))

      if proposals.length == 0: continue

      // Group by content hash (agents that agree on the same content)
      groups = groupByContentHash(proposals)

      // Find majority group
      majorityGroup = groups.find(g => g.length >= quorum)

      if majorityGroup:
        // Supermajority agrees -- accept
        accepted.set(path, majorityGroup[0].diff)
      else if proposals.length < quorum:
        // Not enough voters -- reject
        for p in proposals:
          rejected.push({
            agentRole: p.agentRole,
            path,
            reason: `Insufficient votes: ${proposals.length}/${quorum} required`
          })
        conflicts.push({
          path,
          agents: proposals.map(p => p.agentRole),
          resolution: 'rejected'
        })
      else:
        // No single majority -- try three-way merge between largest groups
        sorted = groups.sort((a, b) => b.length - a.length)
        mergeResult = await mergeDriver.threeWayMerge(
          getBase(path),
          sorted[0][0].diff.content,
          sorted[1][0].diff.content
        )

        if mergeResult.clean and (sorted[0].length + sorted[1].length) >= quorum:
          accepted.set(path, { ...sorted[0][0].diff, content: mergeResult.content })
        else:
          // Cannot reach consensus -- reject all
          for p in proposals:
            rejected.push({
              agentRole: p.agentRole,
              path,
              reason: `No supermajority: largest group has ${sorted[0].length}/${quorum} votes`
            })
          conflicts.push({
            path,
            agents: proposals.map(p => p.agentRole),
            resolution: 'rejected'
          })

    return { accepted, rejected, conflicts }

  groupByContentHash(proposals):
    map = new Map<hash, proposal[]>
    for p in proposals:
      hash = sha256(p.diff.content)
      group = map.get(hash) ?? []
      group.push(p)
      map.set(hash, group)
    return Array.from(map.values())
```

### P5 -- MergeDriver (git three-way merge)

```
interface MergeDriver:
  threeWayMerge(base, ours, theirs) -> Promise<MergeResult>

interface MergeResult:
  clean: boolean
  content: string
  diff: string

class GitMergeDriver implements MergeDriver:
  constructor(exec)

  threeWayMerge(baseContent, oursContent, theirsContent) -> Promise<MergeResult>:
    // Write temp files
    baseFile = writeTmp(baseContent)
    oursFile = writeTmp(oursContent)
    theirsFile = writeTmp(theirsContent)

    try:
      result = await exec('git', [
        'merge-file', '-p',
        oursFile, baseFile, theirsFile
      ])
      return { clean: true, content: result.stdout, diff: '' }
    catch err:
      if err.exitCode == 1:
        // Conflict markers in output
        return { clean: false, content: err.stdout, diff: '' }
      throw err
    finally:
      cleanup(baseFile, oursFile, theirsFile)
```

### P6 -- Changeset Extraction from Worktrees

```
function extractChangeset(
  worktreePath: string,
  agentRole: string,
  agentType: string,
  isLeader: boolean,
  exec
) -> Promise<AgentChangeset>:

  // Get list of changed files
  diffResult = await exec('git', ['-C', worktreePath, 'diff', '--name-status', 'HEAD'])
  files = new Map()

  for line in diffResult.stdout.split('\n'):
    [status, path] = parseDiffLine(line)
    if status == 'D':
      files.set(path, { path, status: 'deleted', content: '', diff: line })
    else:
      content = await readFile(join(worktreePath, path))
      diffContent = await exec('git', ['-C', worktreePath, 'diff', 'HEAD', '--', path])
      files.set(path, {
        path,
        status: status == 'A' ? 'added' : 'modified',
        content,
        diff: diffContent.stdout
      })

  return {
    agentRole,
    agentType,
    isLeader,
    files,
    confidence: 1.0,  // default; agent can override via structured output
    reasoning: ''
  }
```

### P7 -- PhaseRunner Integration Point

```
// In phase-runner.ts or a new consensus-runner.ts:

async function runPhaseWithConsensus(
  plan, phase, strategies, consensusProtocol, strategyDeps
) -> PhaseResult:

  // 1. Run all agents (existing strategy logic)
  agentResults = await strategy.run(plan, phase, strategyDeps)

  // 2. If single agent or no consensus, return as-is
  if phase.agents.length <= 1 or consensusProtocol is NoConsensus:
    return agentResults

  // 3. Extract changesets from each agent's worktree
  changesets = await Promise.all(
    agentResults.worktrees.map((wt, i) =>
      extractChangeset(wt.path, phase.agents[i], plan.agentTeam[i].type, i == 0)
    )
  )

  // 4. Run consensus
  merged = await consensusProtocol.propose(changesets)

  // 5. Apply merged changes to primary worktree
  await applyMergedChangeset(primaryWorktree, merged)

  // 6. Emit events
  eventBus.publish(createDomainEvent('ConsensusReached', {
    planId: plan.id,
    phaseType: phase.type,
    acceptedFiles: merged.accepted.size,
    rejectedChanges: merged.rejected.length,
    conflicts: merged.conflicts.length
  }))

  // 7. Surface rejected changes as findings
  for rc in merged.rejected:
    // Post as inline PR comment suggestion if githubClient available
    if githubClient and rc.suggestion:
      await githubClient.postInlineComment(...)

  return phaseResult
```

### Complexity Analysis

- NoConsensus: O(1)
- RaftConsensus: O(f * p) where f = followers, p = file paths per follower
- PBFTConsensus: O(n * p) where n = agents, p = unique file paths
- Git three-way merge: O(s) per file where s = file size (git merge-file)
- Changeset extraction: O(f) per agent where f = changed files
- Total per phase: O(n * p * s) worst case; bounded by agent count (max 15) and file count

---

## A -- Architecture

### New Components

```
src/execution/consensus/
  consensus-protocol.ts    -- ConsensusProtocol interface, AgentChangeset, MergedChangeset types
  no-consensus.ts          -- NoConsensus passthrough implementation
  raft-consensus.ts        -- RaftConsensus leader-based implementation
  pbft-consensus.ts        -- PBFTConsensus Byzantine implementation
  merge-driver.ts          -- GitMergeDriver for three-way file merges
  changeset-extractor.ts   -- extractChangeset() from worktree diffs
  index.ts                 -- Re-exports + createConsensusProtocol factory
```

### New Domain Events (in event-types.ts)

```
ConsensusReachedEvent:
  { planId, phaseType, acceptedFiles, rejectedChanges, conflicts, protocol }

ConsensusRejectedEvent:
  { planId, phaseType, reason, changesets }
```

### Modified Components

```
src/shared/event-types.ts              -- Add ConsensusReached, ConsensusRejected events
src/types.ts                           -- Add AgentChangeset, MergedChangeset, etc.
src/execution/phase-runner.ts          -- Accept ConsensusProtocol dep, run after phase agents
src/pipeline.ts                        -- Wire ConsensusProtocol from plan.consensus
src/execution/strategies/phase-strategy.ts -- Expose worktree handles for changeset extraction
```

### Phase Execution Flow (Modified)

```
BEFORE (current):
  PhaseRunner.runPhase(plan, phase)
    -> strategy.run(plan, phase)  // single agent
    -> PhaseResult

AFTER (with consensus):
  PhaseRunner.runPhase(plan, phase)
    -> strategy.run(plan, phase)  // potentially multiple agents in parallel
    -> [AgentResult, AgentResult, ...]
    -> extractChangesets(agentResults)
    -> consensusProtocol.propose(changesets)
    -> MergedChangeset
    -> applyMergedChangeset(primaryWorktree, merged)
    -> emit ConsensusReached/ConsensusRejected
    -> PhaseResult
```

### Consensus Factory

```
function createConsensusProtocol(
  type: 'raft' | 'pbft' | 'none',
  mergeDriver: MergeDriver,
  logger: Logger
): ConsensusProtocol:
  switch type:
    case 'raft': return new RaftConsensus(mergeDriver, logger)
    case 'pbft': return new PBFTConsensus(mergeDriver, logger)
    default: return new NoConsensus()
```

### Leader Designation

In Raft consensus, the first agent listed in `PlannedPhase.agents[]` is the leader. This is consistent with the planning engine's agent ordering (primary agent first). The `isLeader` flag is set during changeset extraction based on array index.

### Bounded Context

The `consensus/` directory forms a sub-context within `execution`. It has no dependencies on `triage`, `planning`, `review`, or `intake`. Its only integration point is the PhaseRunner (which calls `propose()` after agents complete) and the EventBus (for domain events).

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Three-way merge produces incorrect results | MEDIUM | Use git merge-file (battle-tested); test with known conflict patterns |
| PBFT quorum math error | HIGH | Extensive unit tests with edge cases (1, 2, 3, 4, 7 agents) |
| Consensus adds latency to phase execution | LOW | O(files) per phase; git merge-file is fast; single-agent phases skip consensus |
| Changeset extraction fails on large diffs | LOW | Cap per-file diff at 1MB; skip binary files |
| Leader agent failure in Raft | MEDIUM | Fall back to NoConsensus with warning; documented edge case |
| Parallel worktree access during extraction | LOW | Each agent has its own worktree; extraction is read-only |
| Memory usage for large changesets | MEDIUM | Stream diffs rather than loading all into memory; use temp files |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: Types (consensus-protocol.ts) -- 0 dependencies

No tests -- type definitions only. Define ConsensusProtocol, AgentChangeset, MergedChangeset, FileDiff, RejectedChange, ConflictRecord.

### Step 2: NoConsensus + tests (0 dependencies)

Tests (London School -- pure logic, no mocks):
- Test: propose with empty array returns empty accepted/rejected/conflicts
- Test: propose with single changeset returns all files accepted
- Test: propose with multiple changesets returns first changeset accepted
- Test: propose preserves file status (added/modified/deleted)

### Step 3: MergeDriver + tests (mock exec)

Tests (London School -- mock exec):
- Test: threeWayMerge with non-overlapping changes returns clean: true
- Test: threeWayMerge with conflicting changes returns clean: false
- Test: threeWayMerge creates and cleans up temp files
- Test: threeWayMerge with identical ours/theirs returns clean: true
- Test: threeWayMerge propagates exec errors for non-merge failures
- Test: threeWayMerge with empty base (new file from both) handles correctly

### Step 4: RaftConsensus + tests (mock MergeDriver)

Tests (London School -- mock MergeDriver):
- Test: leader changes always accepted
- Test: follower changes to non-overlapping files accepted
- Test: follower changes to leader-modified file triggers three-way merge
- Test: clean three-way merge accepts merged content
- Test: conflicting three-way merge rejects follower, creates suggestion
- Test: no leader found uses first agent with warning
- Test: single changeset returns it as-is
- Test: leader modifies file A, follower modifies file B -- both accepted
- Test: leader modifies file A, two followers modify file A differently -- both followers rejected
- Test: leader deletes file, follower modifies same file -- conflict, leader wins

### Step 5: PBFTConsensus + tests (mock MergeDriver)

Tests (London School -- mock MergeDriver):
- Test: 3 agents, all agree -- all changes accepted (quorum = 1, f=0 with n=3 means 2f+1=1... actually f=floor((3-1)/3)=0, quorum=1)
  - Correction: n=3, f=floor(2/3)=0, quorum=2*0+1=1. Any single agent's change is accepted.
  - With n=4: f=1, quorum=3. Need 3/4 to agree.
- Test: 4 agents, 3 agree on file A -- accepted
- Test: 4 agents, 2 agree, 2 disagree -- attempt merge, if fail then reject
- Test: 4 agents, 1 unique proposal -- rejected (1 < 3 quorum)
- Test: 7 agents, 5 agree -- accepted (f=2, quorum=5)
- Test: 7 agents, 4 agree, 3 disagree -- rejected (4 < 5 quorum)
- Test: empty changeset does not count as vote
- Test: all agents produce different content for same file -- all rejected
- Test: single agent (n=1) -- accepted (quorum=1)

### Step 6: Changeset extractor + tests (mock exec, mock fs)

Tests (London School -- mock exec and readFile):
- Test: extractChangeset with modified files produces correct FileDiff entries
- Test: extractChangeset with added file sets status to 'added'
- Test: extractChangeset with deleted file sets status to 'deleted' and empty content
- Test: extractChangeset with no changes returns empty files map
- Test: extractChangeset sets isLeader based on parameter

### Step 7: createConsensusProtocol factory + tests

Tests:
- Test: factory with 'none' returns NoConsensus
- Test: factory with 'raft' returns RaftConsensus
- Test: factory with 'pbft' returns PBFTConsensus

### Step 8: Domain events + event-types.ts

Tests:
- Test: ConsensusReached event has correct payload structure
- Test: ConsensusRejected event has correct payload structure

### Step 9: PhaseRunner integration + tests (mock ConsensusProtocol, mock strategy)

Tests (London School -- mock ConsensusProtocol and PhaseStrategy):
- Test: single-agent phase skips consensus
- Test: multi-agent phase with consensus: 'raft' calls RaftConsensus.propose
- Test: multi-agent phase with consensus: 'none' uses NoConsensus
- Test: consensus result applied to primary worktree
- Test: rejected changes surfaced as findings
- Test: ConsensusReached event emitted after successful consensus
- Test: consensus failure does not crash phase runner

### Step 10: Pipeline wiring

Tests:
- Test: startPipeline creates consensus protocol from plan.consensus
- Test: consensus protocol flows through to PhaseRunner

### Step 11: Integration test (full phase with 2 agents + Raft consensus)

Tests:
- Test: two stub agents with non-overlapping changes produce merged result
- Test: two stub agents with conflicting changes produce leader-wins result
- Test: ConsensusReached event observable on EventBus

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on all consensus/ modules
- PBFT quorum math verified for n=1 through n=10
- `npm run build` succeeds
- `npm test` passes

---

## C -- Completion

### Verification Checklist

- [ ] ConsensusProtocol interface defined with clear contract
- [ ] NoConsensus preserves current first-come-first-served behavior
- [ ] RaftConsensus leader-priority logic works for all conflict scenarios
- [ ] PBFTConsensus quorum math correct for n=1 through n=10
- [ ] GitMergeDriver correctly uses git merge-file for three-way merges
- [ ] Changeset extractor handles added/modified/deleted files
- [ ] PhaseRunner integrates consensus after parallel agent completion
- [ ] ConsensusReached and ConsensusRejected events emitted
- [ ] Rejected changes surfaced as findings in ReviewVerdict
- [ ] Single-agent phases skip consensus (no overhead)
- [ ] Binary files handled (treated as conflict, not merged)
- [ ] Domain events registered in DomainEventMap

### Deployment Steps

1. `npm run build` -- verify compilation
2. `npm test` -- verify all tests pass including new consensus tests
3. Deploy -- consensus is determined by workflow template's `consensus` field
4. Templates already specify consensus (github-ops uses 'raft'); no config changes needed
5. Verify: trigger a multi-agent phase, inspect ConsensusReached event
6. Verify: create conflicting agent outputs, confirm leader-wins behavior

### Rollback Plan

1. Set `consensus: 'none'` in workflow templates to disable consensus
2. NoConsensus passthrough produces identical behavior to pre-consensus code
3. No database or persistent state to roll back
4. Consensus events stop emitting but pipeline continues normally
5. If PhaseRunner integration causes issues: remove consensus call from phase-runner.ts (guarded by feature flag or null check on consensusProtocol dep)

---

## Cross-Plan Dependencies

- **Depends on Plan 1** (Dorothy Improvements): AgentTracker provides per-agent worktree handles needed for changeset extraction.
- **Benefits from Gap 3** (Progress Tracking): ConsensusReached events can be reflected in PR progress comments.
- **Benefits from Gap 4** (Structured Output): Rejected changes and conflict records can be included in StructuredOutput.

---

## Execution Timeline

```
Phase 1: Types + NoConsensus + MergeDriver (2 days)
Phase 2: RaftConsensus + PBFTConsensus (4 days)
Phase 3: Changeset extractor + PhaseRunner integration (3 days)
Phase 4: Domain events + Pipeline wiring + Integration tests (3 days)
```

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/execution/consensus/consensus-protocol.ts` | NEW |
| `src/execution/consensus/no-consensus.ts` | NEW |
| `src/execution/consensus/raft-consensus.ts` | NEW |
| `src/execution/consensus/pbft-consensus.ts` | NEW |
| `src/execution/consensus/merge-driver.ts` | NEW |
| `src/execution/consensus/changeset-extractor.ts` | NEW |
| `src/execution/consensus/index.ts` | NEW |
| `src/types.ts` | MODIFIED (add consensus types) |
| `src/shared/event-types.ts` | MODIFIED (add ConsensusReached, ConsensusRejected) |
| `src/execution/phase-runner.ts` | MODIFIED (integrate consensus after agent runs) |
| `src/execution/strategies/phase-strategy.ts` | MODIFIED (expose worktree handles) |
| `src/pipeline.ts` | MODIFIED (wire consensus protocol) |
| `tests/execution/consensus/no-consensus.test.ts` | NEW |
| `tests/execution/consensus/raft-consensus.test.ts` | NEW |
| `tests/execution/consensus/pbft-consensus.test.ts` | NEW |
| `tests/execution/consensus/merge-driver.test.ts` | NEW |
| `tests/execution/consensus/changeset-extractor.test.ts` | NEW |
| `tests/execution/phase-runner.test.ts` | MODIFIED |
| `tests/integration/consensus-e2e.test.ts` | NEW |
