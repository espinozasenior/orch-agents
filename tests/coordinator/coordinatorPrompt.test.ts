/**
 * Tests for the coordinator system prompt builder.
 *
 * Validates that the prompt contains the correct role definition,
 * workflow phases, tool restrictions, and context injection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCoordinatorSystemPrompt,
  getCoordinatorUserContext,
} from '../../src/coordinator/coordinatorPrompt';

// ---------------------------------------------------------------------------
// getCoordinatorSystemPrompt
// ---------------------------------------------------------------------------

describe('getCoordinatorSystemPrompt', () => {
  const prompt = getCoordinatorSystemPrompt();

  it('should contain coordinator role definition', () => {
    assert.ok(
      prompt.includes('You are a coordinator'),
      'Missing coordinator role definition',
    );
  });

  it('should contain the 4-phase workflow', () => {
    assert.ok(prompt.includes('Phase 1: Research'), 'Missing Research phase');
    assert.ok(prompt.includes('Phase 2: Synthesis'), 'Missing Synthesis phase');
    assert.ok(prompt.includes('Phase 3: Implementation'), 'Missing Implementation phase');
    assert.ok(prompt.includes('Phase 4: Verification'), 'Missing Verification phase');
  });

  it('should list coordinator-only tools (AgentTool, SendMessage, TaskStop)', () => {
    assert.ok(prompt.includes('AgentTool'), 'Missing AgentTool');
    assert.ok(prompt.includes('SendMessage'), 'Missing SendMessage');
    assert.ok(prompt.includes('TaskStop'), 'Missing TaskStop');
  });

  it('should NOT include direct execution tools', () => {
    // The coordinator prompt must exclude these as coordinator tools.
    // They appear only in the "you do NOT have" clause, not as available tools.
    const toolSection = prompt.split('## Available Tools')[1]?.split('##')[0] ?? '';
    // Bash/Edit/Write should only appear in the exclusion line
    assert.ok(
      !toolSection.includes('**Bash'),
      'Coordinator should not have Bash as a primary tool',
    );
    assert.ok(
      !toolSection.includes('**Edit'),
      'Coordinator should not have Edit as a primary tool',
    );
  });

  it('should contain concurrency rules', () => {
    assert.ok(
      prompt.includes('Parallelism is your superpower'),
      'Missing parallelism rule',
    );
    assert.ok(
      prompt.includes('Read-only tasks run in parallel freely'),
      'Missing read-only parallel rule',
    );
    assert.ok(
      prompt.includes('Write-heavy tasks one at a time per file set'),
      'Missing serial write rule',
    );
  });

  it('should contain prompt-writing rules', () => {
    assert.ok(
      prompt.includes('Never delegate understanding'),
      'Missing prompt-writing rule',
    );
  });

  it('should contain anti-patterns', () => {
    assert.ok(
      prompt.includes('Never fabricate or predict agent results'),
      'Missing anti-pattern: fabrication',
    );
  });

  it('should contain "After launching agents" rule', () => {
    assert.ok(
      prompt.includes('After launching agents, briefly tell the user what you launched and end your response'),
      'Missing post-launch rule',
    );
  });
});

// ---------------------------------------------------------------------------
// getCoordinatorUserContext
// ---------------------------------------------------------------------------

describe('getCoordinatorUserContext', () => {
  it('should list worker tools (including BashTool)', () => {
    const { workerToolsContext } = getCoordinatorUserContext([], undefined);
    assert.ok(
      workerToolsContext.includes('BashTool'),
      'Missing BashTool in worker tools',
    );
    assert.ok(
      workerToolsContext.includes('EditTool'),
      'Missing EditTool in worker tools',
    );
  });

  it('should NOT include internal-only tools', () => {
    const { workerToolsContext } = getCoordinatorUserContext([], undefined);
    assert.ok(
      !workerToolsContext.includes('TeamCreateTool'),
      'Should not expose TeamCreateTool',
    );
    assert.ok(
      !workerToolsContext.includes('SyntheticOutputTool'),
      'Should not expose SyntheticOutputTool',
    );
  });

  it('should include MCP server names when provided', () => {
    const clients = [{ name: 'github' }, { name: 'linear' }];
    const { workerToolsContext } = getCoordinatorUserContext(clients, undefined);
    assert.ok(workerToolsContext.includes('github'), 'Missing MCP server: github');
    assert.ok(workerToolsContext.includes('linear'), 'Missing MCP server: linear');
  });

  it('should NOT include MCP section when no clients provided', () => {
    const { workerToolsContext } = getCoordinatorUserContext([], undefined);
    assert.ok(
      !workerToolsContext.includes('MCP tools from'),
      'Should not mention MCP when no clients',
    );
  });

  it('should include scratchpad path when provided', () => {
    const { workerToolsContext } = getCoordinatorUserContext([], '/tmp/scratch');
    assert.ok(
      workerToolsContext.includes('/tmp/scratch'),
      'Missing scratchpad path',
    );
    assert.ok(
      workerToolsContext.includes('without permission prompts'),
      'Missing scratchpad permission note',
    );
  });

  it('should NOT include scratchpad section when not provided', () => {
    const { workerToolsContext } = getCoordinatorUserContext([], undefined);
    assert.ok(
      !workerToolsContext.includes('Scratchpad directory'),
      'Should not mention scratchpad when not provided',
    );
  });
});
