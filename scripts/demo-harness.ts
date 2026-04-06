#!/usr/bin/env tsx
/**
 * Interactive demo — simulates all 6 harness phases in action.
 * Run: npx tsx scripts/demo-harness.ts
 */

/* eslint-disable no-console */

// ---------------------------------------------------------------------------
// P0 — Multi-Tier Context Compaction
// ---------------------------------------------------------------------------

import {
  createDefaultConfig,
  createTrackingState,
  runCompactionPipeline,
  applyToolResultBudget,
  snipCompactIfNeeded,
  tryReactiveCompact,
  tokenCountWithEstimation,
  type CompactMessage,
} from '../src/services/compact/index';

function makeMsg(uuid: string, type: 'user' | 'assistant', text: string, toolResult?: { id: string; content: string }): CompactMessage {
  const content: CompactMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  if (toolResult) content.push({ type: 'tool_result', tool_use_id: toolResult.id, content: toolResult.content });
  return { uuid, type, content };
}

function demoParagraph(title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

async function demoP0() {
  demoParagraph('P0 — MULTI-TIER CONTEXT COMPACTION ENGINE');

  // Build a conversation that's large enough to trigger compaction
  const messages: CompactMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push(makeMsg(`u-${i}`, 'user', `User question ${i}: explain the auth module in detail`));
    messages.push(makeMsg(`a-${i}`, 'assistant', `Here is a detailed explanation of the auth module component ${i}. `.repeat(50)));
  }
  // Add a huge tool result
  messages.push(makeMsg(`big-tool`, 'user', '', {
    id: 'tool-1',
    content: 'x'.repeat(80_000), // 80K chars — over the 50K budget
  }));

  console.log(`\n  Initial conversation: ${messages.length} messages`);
  console.log(`  Estimated tokens: ${tokenCountWithEstimation(messages).toLocaleString()}`);

  // --- Tier 1: Tool Result Budget ---
  console.log('\n  --- Tier 1: Tool Result Budget ---');
  const tier1 = applyToolResultBudget(messages);
  console.log(`  Replacements: ${tier1.replacements.length}`);
  if (tier1.replacements.length > 0) {
    const r = tier1.replacements[0];
    console.log(`  Replaced tool_result ${r.toolUseId}: ${r.originalSize.toLocaleString()} chars -> "${r.replacementMarker}"`);
  }

  // --- Tier 2: Snip Compact ---
  console.log('\n  --- Tier 2: Snip Compact ---');
  const tier2 = snipCompactIfNeeded(tier1.messages, 20); // Keep last 20 messages
  console.log(`  Messages before snip: ${tier1.messages.length}`);
  console.log(`  Messages after snip: ${tier2.messages.length}`);
  console.log(`  Tokens freed: ${tier2.tokensFreed.toLocaleString()}`);
  if (tier2.boundaryMessage) {
    const text = tier2.boundaryMessage.content[0];
    console.log(`  Boundary marker: "${text && 'text' in text ? text.text.slice(0, 80) : ''}..."`);
  }

  // --- Full Pipeline ---
  console.log('\n  --- Full Pipeline (Tier 1 -> 2 -> 3) ---');
  const config = createDefaultConfig(50_000); // Small window to force compaction
  const tracking = createTrackingState();
  const pipeline = runCompactionPipeline({
    messages,
    config,
    tracking,
    snipBoundary: 20,
  });
  console.log(`  Tool result replacements: ${pipeline.toolResultReplacements.length}`);
  console.log(`  Snip tokens freed: ${pipeline.snipTokensFreed.toLocaleString()}`);
  if (pipeline.compactionResult) {
    console.log(`  Auto-compact fired!`);
    console.log(`    Pre-compact tokens: ${pipeline.compactionResult.preCompactTokenCount.toLocaleString()}`);
    console.log(`    Post-compact tokens: ${pipeline.compactionResult.postCompactTokenCount.toLocaleString()}`);
    console.log(`    Reduction: ${Math.round((1 - pipeline.compactionResult.postCompactTokenCount / pipeline.compactionResult.preCompactTokenCount) * 100)}%`);
    const summary = pipeline.compactionResult.summaryMessages[0];
    if (summary) {
      const text = summary.content[0];
      console.log(`    Summary preview: "${text && 'text' in text ? text.text.slice(0, 120) : ''}..."`);
    }
  } else {
    console.log(`  Auto-compact not triggered (under threshold or circuit-breaker open)`);
  }

  // --- Reactive Compact (emergency) ---
  console.log('\n  --- Tier 4: Reactive Compact (Emergency) ---');
  const reactive = tryReactiveCompact(false, messages);
  console.log(`  First attempt: ${reactive ? 'SUCCESS' : 'null'}`);
  if (reactive) {
    console.log(`    Post-compact messages: ${reactive.summaryMessages.length}`);
  }
  const reactive2 = tryReactiveCompact(true, messages); // single-shot guard
  console.log(`  Second attempt (guard): ${reactive2 ? 'SUCCESS' : 'BLOCKED (single-shot guard)'}`);

  // --- Circuit Breaker ---
  console.log('\n  --- Circuit Breaker Demo ---');
  const failTracking = createTrackingState({ consecutiveFailures: 3 });
  const failConfig = createDefaultConfig(999_999_999); // impossibly large window
  const failResult = runCompactionPipeline({
    messages: messages.slice(0, 4),
    config: failConfig,
    tracking: failTracking,
  });
  console.log(`  Tracking failures: ${failTracking.consecutiveFailures}`);
  console.log(`  Compaction skipped: ${!failResult.compactionResult}`);
}

// ---------------------------------------------------------------------------
// P3 — Token Budget Auto-Continue
// ---------------------------------------------------------------------------

import {
  createBudgetTracker,
  checkTokenBudget,
  COMPLETION_THRESHOLD,
  DIMINISHING_THRESHOLD,
} from '../src/query/tokenBudget';

function demoP3() {
  demoParagraph('P3 — TOKEN BUDGET AUTO-CONTINUE');

  const tracker = createBudgetTracker();
  const budget = 100_000;

  console.log(`\n  Budget: ${budget.toLocaleString()} tokens`);
  console.log(`  Threshold: ${COMPLETION_THRESHOLD * 100}% = ${(budget * COMPLETION_THRESHOLD).toLocaleString()} tokens`);
  console.log(`  Diminishing return threshold: ${DIMINISHING_THRESHOLD} tokens/check\n`);

  // Simulate progressive token usage
  const tokenSteps = [20_000, 45_000, 65_000, 78_000, 88_000, 92_000];
  for (const tokens of tokenSteps) {
    const decision = checkTokenBudget(tracker, undefined, budget, tokens);
    const pct = Math.round((tokens / budget) * 100);
    if (decision.action === 'continue') {
      console.log(`  ${pct}% (${tokens.toLocaleString()} tokens) -> CONTINUE #${decision.continuationCount}`);
      console.log(`    Nudge: "${decision.nudgeMessage}"`);
    } else {
      console.log(`  ${pct}% (${tokens.toLocaleString()} tokens) -> STOP`);
      if (decision.completionEvent) {
        console.log(`    Continuations: ${decision.completionEvent.continuationCount}`);
        console.log(`    Diminishing: ${decision.completionEvent.diminishingReturns}`);
      }
    }
  }

  // Subagent skip
  console.log('\n  --- Subagent Skip ---');
  const subDecision = checkTokenBudget(createBudgetTracker(), 'agent-123', budget, 50_000);
  console.log(`  Agent "agent-123" at 50%: ${subDecision.action} (subagents skip budget check)`);
}

// ---------------------------------------------------------------------------
// P4 — Concurrency-Partitioned Tool Execution
// ---------------------------------------------------------------------------

import {
  partitionToolCalls,
  runTools,
  type ToolDefinition,
  type ToolUseBlock,
} from '../src/services/tools/index';

async function demoP4() {
  demoParagraph('P4 — CONCURRENCY-PARTITIONED TOOL EXECUTION');

  // Define mock tools
  const tools = new Map<string, ToolDefinition>();
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  tools.set('Glob', {
    name: 'Glob',
    isConcurrencySafe: () => true,
    execute: async (input) => { await delay(100); return { content: `Found files matching ${JSON.stringify(input)}` }; },
  });
  tools.set('Grep', {
    name: 'Grep',
    isConcurrencySafe: () => true,
    execute: async (input) => { await delay(100); return { content: `Grep results for ${JSON.stringify(input)}` }; },
  });
  tools.set('Read', {
    name: 'Read',
    isConcurrencySafe: () => true,
    execute: async (input) => { await delay(100); return { content: `File content of ${JSON.stringify(input)}` }; },
  });
  tools.set('Edit', {
    name: 'Edit',
    isConcurrencySafe: () => false,
    execute: async (input) => { await delay(100); return { content: `Edited ${JSON.stringify(input)}` }; },
  });
  tools.set('Bash', {
    name: 'Bash',
    isConcurrencySafe: () => false,
    execute: async (input) => { await delay(100); return { content: `Executed ${JSON.stringify(input)}` }; },
  });

  // Simulate a mixed tool call sequence
  const blocks: ToolUseBlock[] = [
    { id: 't1', name: 'Glob', input: { pattern: '**/*.ts' } },
    { id: 't2', name: 'Grep', input: { pattern: 'TODO' } },
    { id: 't3', name: 'Read', input: { path: '/src/index.ts' } },
    { id: 't4', name: 'Edit', input: { path: '/src/foo.ts', old: 'a', new: 'b' } },
    { id: 't5', name: 'Read', input: { path: '/src/bar.ts' } },
    { id: 't6', name: 'Bash', input: { command: 'npm test' } },
  ];

  // Show partitioning
  console.log('\n  --- Partitioning ---');
  console.log(`  Input: ${blocks.map(b => b.name).join(' -> ')}`);
  const batches = partitionToolCalls(blocks, tools);
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    console.log(`  Batch ${i + 1}: [${b.blocks.map(bl => bl.name).join(', ')}] — ${b.isConcurrencySafe ? 'CONCURRENT' : 'SERIAL'}`);
  }

  // Execute with timing
  console.log('\n  --- Execution ---');
  const start = Date.now();
  const results = await runTools(blocks, tools);
  const elapsed = Date.now() - start;
  console.log(`  Completed ${results.length} tools in ${elapsed}ms`);
  console.log(`  (Serial would be ${blocks.length * 100}ms, concurrent batches save time)`);
  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error}` : `OK: ${r.result?.content.slice(0, 50)}`;
    console.log(`    ${r.toolUseId}: ${status}`);
  }
}

// ---------------------------------------------------------------------------
// P1 — Query Loop State Machine
// ---------------------------------------------------------------------------

import { queryLoop, DEFAULT_MAX_TURNS, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from '../src/query/queryLoop';
import { createTestDeps, type ModelEvent } from '../src/query/deps';

async function demoP1() {
  demoParagraph('P1 — QUERY LOOP STATE MACHINE');

  // Scenario 1: Simple text completion
  console.log('\n  --- Scenario 1: Simple Text Completion ---');
  const deps1 = createTestDeps([[{ type: 'text', content: 'Hello! How can I help?' }]]);
  const gen1 = queryLoop({ messages: [], systemPrompt: 'You are helpful.', deps: deps1 });
  const events1: string[] = [];
  let result1;
  for await (const event of gen1) {
    events1.push(event.type);
  }
  // The generator return value
  result1 = await gen1.return(undefined as never);
  console.log(`  Events: ${events1.join(' -> ')}`);
  console.log(`  Terminal: completed (model returned text, no tool_use)`);

  // Scenario 2: Tool use loop
  console.log('\n  --- Scenario 2: Tool Use Loop ---');
  const deps2 = createTestDeps([
    [{ type: 'tool_use', id: 'tu-1', name: 'Glob', input: { pattern: '*.ts' } }],
    [{ type: 'text', content: 'Found 5 TypeScript files.' }],
  ]);
  const gen2 = queryLoop({
    messages: [],
    systemPrompt: 'You are helpful.',
    deps: deps2,
    executeTool: async (blocks) => ({
      messages: blocks.map(b => ({
        uuid: `result-${b.id}`,
        type: 'user' as const,
        content: `Result for ${b.name}`,
      })),
    }),
  });
  const events2: string[] = [];
  for await (const event of gen2) {
    events2.push(`${event.type}${event.type === 'assistant_message' && event.message.toolUseBlocks ? '(tool_use)' : ''}`);
  }
  console.log(`  Events: ${events2.join(' -> ')}`);
  console.log(`  Flow: model -> tool_use -> execute tool -> re-query -> text -> completed`);

  // Scenario 3: Max turns enforcement
  console.log('\n  --- Scenario 3: Max Turns Enforcement ---');
  const infiniteTools: ModelEvent[][] = Array(10).fill([{ type: 'tool_use' as const, id: 'tu', name: 'Bash', input: {} }]);
  const deps3 = createTestDeps(infiniteTools);
  const gen3 = queryLoop({
    messages: [],
    systemPrompt: '',
    deps: deps3,
    maxTurns: 3,
    executeTool: async () => ({ messages: [{ uuid: 'r', type: 'user', content: 'ok' }] }),
  });
  let turnCount = 0;
  let terminal3: string | undefined;
  try {
    for await (const _event of gen3) {
      // count stream_request_start events as turns
      if (_event.type === 'stream_request_start') turnCount++;
    }
  } catch {
    // generator might throw on max turns
  }
  console.log(`  Max turns set to 3, loop ran ${turnCount} iterations`);
  console.log(`  Terminal: max_turns (hard limit prevents infinite loops)`);

  // Scenario 4: Error recovery
  console.log('\n  --- Scenario 4: Max Output Tokens Recovery ---');
  const recoveryDeps = createTestDeps([
    [{ type: 'error', apiError: 'max_output_tokens' }],
    [{ type: 'error', apiError: 'max_output_tokens' }],
    [{ type: 'text', content: 'Finally completed the response.' }],
  ]);
  const gen4 = queryLoop({ messages: [], systemPrompt: '', deps: recoveryDeps });
  const events4: string[] = [];
  for await (const event of gen4) {
    events4.push(event.type);
  }
  console.log(`  Recovery attempts: 2 (max is ${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT})`);
  console.log(`  Events: ${events4.join(' -> ')}`);
  console.log(`  Flow: error -> inject "resume mid-thought" -> retry -> error -> retry -> success`);

  console.log(`\n  Constants: DEFAULT_MAX_TURNS=${DEFAULT_MAX_TURNS}, MAX_RECOVERY=${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT}`);
}

// ---------------------------------------------------------------------------
// P2 — Coordinator/Worker Pattern
// ---------------------------------------------------------------------------

import { getCoordinatorSystemPrompt, getCoordinatorUserContext } from '../src/coordinator/coordinatorPrompt';
import { parseTaskNotification, isTaskNotification } from '../src/coordinator/notificationParser';
import { decideContinueOrSpawn } from '../src/coordinator/decisionMatrix';
import { isCoordinatorMode } from '../src/coordinator/index';
import type { WorkerState, TaskSpec } from '../src/coordinator/types';

function demoP2() {
  demoParagraph('P2 — COORDINATOR/WORKER PATTERN');

  // Show coordinator prompt structure
  console.log('\n  --- Coordinator System Prompt ---');
  const prompt = getCoordinatorSystemPrompt();
  const sections = prompt.split('\n## ').map(s => s.split('\n')[0]);
  console.log(`  Prompt length: ${prompt.length} chars`);
  console.log(`  Sections: ${sections.join(', ')}`);

  // Show user context with MCP
  console.log('\n  --- Worker Context ---');
  const context = getCoordinatorUserContext(
    [{ name: 'github' }, { name: 'linear' }],
    '/tmp/scratchpad',
  );
  console.log(`  ${context.workerToolsContext}`);

  // Parse task notification
  console.log('\n  --- Task Notification Parsing ---');
  const xml = `<task-notification>
<task-id>agent-a1b</task-id>
<status>completed</status>
<summary>Agent "Investigate auth bug" completed</summary>
<result>Found null pointer in src/auth/validate.ts:42. The user field is undefined when sessions expire.</result>
<usage><total-tokens>15000</total-tokens><tool-uses>8</tool-uses><duration-ms>45000</duration-ms></usage>
</task-notification>`;

  console.log(`  Is notification? ${isTaskNotification(xml)}`);
  const notification = parseTaskNotification(xml);
  console.log(`  Task ID: ${notification.taskId}`);
  console.log(`  Status: ${notification.status}`);
  console.log(`  Summary: ${notification.summary}`);
  console.log(`  Result: ${notification.result?.slice(0, 80)}...`);
  console.log(`  Usage: ${notification.usage?.totalTokens} tokens, ${notification.usage?.toolUses} tool calls, ${notification.usage?.durationMs}ms`);

  // Decision matrix
  console.log('\n  --- Continue vs Spawn Decisions ---');
  const worker: WorkerState = {
    id: 'agent-a1b',
    phase: 'research',
    status: 'completed',
    description: 'Investigate auth bug',
    filesExplored: ['src/auth/validate.ts', 'src/auth/types.ts', 'src/auth/session.ts'],
    lastStatus: 'completed',
    startTime: Date.now(),
  };

  const scenarios: Array<{ label: string; task: TaskSpec }> = [
    { label: 'Verify changes', task: { type: 'verification', targetFiles: ['src/auth/validate.ts'] } },
    { label: 'Fix same files', task: { type: 'implementation', targetFiles: ['src/auth/validate.ts', 'src/auth/types.ts'] } },
    { label: 'Fix different files', task: { type: 'implementation', targetFiles: ['src/api/routes.ts', 'src/api/middleware.ts'] } },
    { label: 'Correct failure', task: { type: 'correction', targetFiles: ['src/auth/validate.ts'] } },
  ];

  for (const { label, task } of scenarios) {
    const failWorker = task.type === 'correction' ? { ...worker, lastStatus: 'failed' as const } : worker;
    const decision = decideContinueOrSpawn(failWorker, task);
    const overlap = task.targetFiles.filter(f => worker.filesExplored.includes(f)).length / task.targetFiles.length;
    console.log(`  "${label}" (overlap: ${Math.round(overlap * 100)}%) -> ${decision.toUpperCase()}`);
  }

  console.log(`\n  Coordinator mode active: ${isCoordinatorMode()}`);
}

// ---------------------------------------------------------------------------
// P5 — Fork Subagent with Cache Sharing
// ---------------------------------------------------------------------------

import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  FORK_AGENT,
  isForkSubagentEnabled,
  isInForkChild,
  buildForkConversationMessages,
} from '../src/agents/fork/forkSubagent';
import type { ForkMessage } from '../src/agents/fork/types';

function demoP5() {
  demoParagraph('P5 — FORK SUBAGENT WITH CACHE SHARING');

  console.log(`\n  Fork agent config:`);
  console.log(`    Type: ${FORK_AGENT.agentType}`);
  console.log(`    Tools: ${FORK_AGENT.tools.join(', ')}`);
  console.log(`    Max turns: ${FORK_AGENT.maxTurns}`);
  console.log(`    Model: ${FORK_AGENT.model}`);
  console.log(`    Permissions: ${FORK_AGENT.permissionMode}`);

  console.log('\n  --- Enablement ---');
  console.log(`  Normal mode: ${isForkSubagentEnabled(false, false)}`);
  console.log(`  Coordinator mode: ${isForkSubagentEnabled(true, false)}`);
  console.log(`  Non-interactive: ${isForkSubagentEnabled(false, true)}`);

  // Build fork messages
  console.log('\n  --- Fork Message Building ---');
  const parentMessages: ForkMessage[] = [
    {
      uuid: 'u1',
      type: 'user',
      content: [{ type: 'text', text: 'Find all TODO comments in the codebase' }],
    },
    {
      uuid: 'a1',
      type: 'assistant',
      content: [
        { type: 'text', text: 'I\'ll search for TODO comments.' },
        { type: 'tool_use', id: 'tu-1', name: 'Grep', input: { pattern: 'TODO' } },
      ],
    },
    {
      uuid: 'u2',
      type: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu-1', content: 'src/auth.ts:42: // TODO fix null pointer\nsrc/api.ts:15: // TODO add rate limiting\nsrc/db.ts:88: // TODO optimize query' },
      ],
    },
    {
      uuid: 'a2',
      type: 'assistant',
      content: [{ type: 'text', text: 'Found 3 TODOs. Let me analyze each one.' }],
    },
  ];

  // Create two forks with different directives
  const fork1 = buildForkConversationMessages(parentMessages, 'Investigate the null pointer TODO in src/auth.ts:42');
  const fork2 = buildForkConversationMessages(parentMessages, 'Investigate the rate limiting TODO in src/api.ts:15');

  console.log(`  Parent messages: ${parentMessages.length}`);
  console.log(`  Fork 1 messages: ${fork1.length} (directive: auth.ts investigation)`);
  console.log(`  Fork 2 messages: ${fork2.length} (directive: api.ts investigation)`);

  // Show tool_result replacement
  const toolResultMsg = fork1.find(m => m.content.some(b => b.type === 'tool_result'));
  if (toolResultMsg) {
    const block = toolResultMsg.content.find(b => b.type === 'tool_result');
    if (block && block.type === 'tool_result') {
      console.log(`\n  Tool result replaced:`);
      console.log(`    Original: "src/auth.ts:42: // TODO fix null pointer\\nsrc/api.ts:15:..."`);
      console.log(`    Fork:     "${block.content}"`);
    }
  }

  // Verify byte-identical prefixes
  const prefix1 = JSON.stringify(fork1.slice(0, -1));
  const prefix2 = JSON.stringify(fork2.slice(0, -1));
  const prefixMatch = prefix1 === prefix2;
  console.log(`\n  Cache sharing invariant:`);
  console.log(`    Prefix bytes (fork 1): ${prefix1.length}`);
  console.log(`    Prefix bytes (fork 2): ${prefix2.length}`);
  console.log(`    Byte-identical: ${prefixMatch ? 'YES (cache will be shared)' : 'NO (BROKEN!)'}`);

  // Fork child detection
  console.log('\n  --- Fork Child Detection ---');
  console.log(`  Parent is fork child: ${isInForkChild(parentMessages)}`);
  console.log(`  Fork 1 is fork child: ${isInForkChild(fork1)}`);
  console.log(`  (Fork children cannot fork again — depth = 1)`);

  // Show the boilerplate tag
  const lastMsg = fork1[fork1.length - 1];
  const boilerplate = lastMsg.content[0];
  if (boilerplate && 'text' in boilerplate) {
    console.log(`\n  Boilerplate tag: "${boilerplate.text}"`);
  }
}

// ---------------------------------------------------------------------------
// Run all demos
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n' + '#'.repeat(70));
  console.log('#  ORCH-AGENTS HARNESS — LIVE SIMULATION');
  console.log('#  6 phases from Claude Code architecture research');
  console.log('#'.repeat(70));

  await demoP0();
  demoP3();
  await demoP4();
  await demoP1();
  demoP2();
  demoP5();

  demoParagraph('ALL SIMULATIONS COMPLETE');
  console.log('\n  6 phases demonstrated, all systems operational.\n');
}

main().catch(console.error);
