# SPARC Specs — Claude Code Harness Adoption

Implementation specs derived from deep research of the Claude Code original source.
Each spec follows the SPARC methodology: **S**pecification, **P**seudocode, **A**rchitecture, **R**efinement.

## Phase Index

| Phase | Name | Priority | Est. Effort | Status |
|-------|------|----------|-------------|--------|
| [P0](P0-multi-tier-compaction-spec.md) | Multi-Tier Context Compaction Engine | Critical | 7 days | Spec Ready |
| [P1](P1-query-loop-transitions-spec.md) | Query Loop with Continue Transitions | High | 5 days | Spec Ready |
| [P2](P2-coordinator-worker-pattern-spec.md) | Coordinator/Worker Phase Pattern | High | 5 days | Spec Ready |
| [P3](P3-token-budget-auto-continue-spec.md) | Token Budget Auto-Continue | Medium | 3 days | Spec Ready |
| [P4](P4-concurrency-partitioned-tools-spec.md) | Concurrency-Partitioned Tool Execution | Medium | 3 days | Spec Ready |
| [P5](P5-fork-subagent-cache-sharing-spec.md) | Fork Subagent with Cache Sharing | Medium | 4 days | Spec Ready |

## Dependency Graph

```
P0 (Compaction) ─────┐
                      ├──► P1 (Query Loop) ──► P2 (Coordinator)
P3 (Token Budget) ───┘                    │
                                          ├──► P5 (Fork Subagent)
P4 (Tool Concurrency) ───────────────────┘
```

## Source Research

- [Claw-Code Analysis](../research_claw_code_20260331.md) — Community rewrite patterns
- [Claude Code Original Analysis](../research_claude_code_original_source_20260401.md) — Production architecture
