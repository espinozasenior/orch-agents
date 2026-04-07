/**
 * Setup module tests.
 *
 * Tests the pure logic functions: presets, merge overrides, event ID building.
 * The wizard step sequencer and renderer are tested via mock TerminalIO.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import {
  applyPreset,
  buildAgentToggles,
  buildEventToggles,
  getPresetDefs,
} from '../../src/setup/presets';
import {
  applyAgentOverrides,
  applyEventOverrides,
  applyTopologyOverrides,
  buildEventId,
  formatSummary,
} from '../../src/setup/config-writer';
import type { PlannedAgent } from '../../src/types';
import type { SetupConfig, AgentToggle, EventToggle } from '../../src/setup/types';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

describe('Presets', () => {
  it('getPresetDefs returns 4 presets (minimal, standard, full-sparc, custom)', () => {
    const defs = getPresetDefs();
    assert.equal(defs.length, 4);
    assert.deepEqual(defs.map(d => d.key), ['minimal', 'standard', 'full-sparc', 'custom']);
  });

  it('applyPreset("minimal") produces correct config', () => {
    const config = applyPreset('minimal');
    assert.equal(config.version, 1);
    assert.equal(config.preset, 'minimal');
    assert.equal(config.topology, 'star');
    assert.equal(config.consensus, 'none');
    assert.equal(config.maxAgents, 3);
    const enabled = config.activeAgents.filter(a => a.enabled).map(a => a.type).sort();
    assert.deepEqual(enabled, ['coder', 'tester']);
  });

  it('applyPreset("standard") enables 4 agents', () => {
    const config = applyPreset('standard');
    const enabled = config.activeAgents.filter(a => a.enabled).map(a => a.type).sort();
    assert.deepEqual(enabled, ['architect', 'coder', 'reviewer', 'tester']);
    assert.equal(config.topology, 'hierarchical');
    assert.equal(config.consensus, 'raft');
  });

  it('applyPreset("full-sparc") enables all discovered agents and all events', () => {
    const config = applyPreset('full-sparc');
    // All agents should be enabled (count depends on .claude/agents/**/*.md on disk)
    assert.ok(config.activeAgents.every(a => a.enabled), 'all agents should be enabled');
    assert.ok(config.activeAgents.length >= 5, 'should have at least 5 agents');
    assert.equal(config.githubEvents.filter(e => e.enabled).length, 14);
    assert.equal(config.topology, 'hierarchical-mesh');
  });

  it('buildAgentToggles creates correct toggle array', () => {
    const toggles = buildAgentToggles(['coder', 'tester']);
    assert.ok(toggles.length >= 5, 'should include all discovered agents');
    assert.equal(toggles.find(t => t.type === 'coder')?.enabled, true);
    assert.equal(toggles.find(t => t.type === 'reviewer')?.enabled, false);
  });

  it('buildEventToggles creates correct toggle array', () => {
    const toggles = buildEventToggles(['push:default_branch']);
    assert.equal(toggles.length, 14);
    assert.equal(toggles.find(t => t.id === 'push:default_branch')?.enabled, true);
    assert.equal(toggles.find(t => t.id === 'pull_request:opened')?.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// Agent overrides
// ---------------------------------------------------------------------------

describe('applyAgentOverrides', () => {
  const agents: PlannedAgent[] = [
    { role: 'implementer', type: 'coder', tier: 3, required: true },
    { role: 'validator', type: 'tester', tier: 2, required: true },
    { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    { role: 'security', type: 'security-architect', tier: 3, required: false },
  ];

  it('returns all agents when all types enabled', () => {
    const toggles: AgentToggle[] = [
      { type: 'coder', enabled: true },
      { type: 'tester', enabled: true },
      { type: 'reviewer', enabled: true },
      { type: 'security-architect', enabled: true },
    ];
    const result = applyAgentOverrides(agents, toggles);
    assert.equal(result.length, 4);
  });

  it('filters out disabled agents', () => {
    const toggles: AgentToggle[] = [
      { type: 'coder', enabled: true },
      { type: 'tester', enabled: true },
      { type: 'reviewer', enabled: false },
      { type: 'security-architect', enabled: false },
    ];
    const result = applyAgentOverrides(agents, toggles);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(a => a.type), ['coder', 'tester']);
  });

  it('returns empty array when all disabled', () => {
    const toggles: AgentToggle[] = [
      { type: 'coder', enabled: false },
      { type: 'tester', enabled: false },
      { type: 'reviewer', enabled: false },
      { type: 'security-architect', enabled: false },
    ];
    const result = applyAgentOverrides(agents, toggles);
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Event overrides
// ---------------------------------------------------------------------------

describe('buildEventId', () => {
  it('builds id from event only', () => {
    assert.equal(buildEventId({ event: 'push', action: null, condition: null }), 'push');
  });

  it('builds id from event + action', () => {
    assert.equal(
      buildEventId({ event: 'pull_request', action: 'opened', condition: null }),
      'pull_request:opened',
    );
  });

  it('builds id from event + action + condition', () => {
    assert.equal(
      buildEventId({ event: 'pull_request', action: 'closed', condition: 'merged' }),
      'pull_request:closed:merged',
    );
  });

  it('builds id from event + condition (no action)', () => {
    assert.equal(
      buildEventId({ event: 'push', action: null, condition: 'default_branch' }),
      'push:default_branch',
    );
  });
});

describe('applyEventOverrides', () => {
  const rules = [
    { event: 'push', action: null, condition: 'default_branch', intent: 'validate-main' },
    { event: 'pull_request', action: 'opened', condition: null, intent: 'review-pr' },
    { event: 'issues', action: 'opened', condition: null, intent: 'triage-issue' },
  ];

  it('returns all rules when all enabled', () => {
    const toggles: EventToggle[] = [
      { id: 'push:default_branch', label: '', enabled: true },
      { id: 'pull_request:opened', label: '', enabled: true },
      { id: 'issues:opened', label: '', enabled: true },
    ];
    const result = applyEventOverrides(rules, toggles);
    assert.equal(result.length, 3);
  });

  it('filters disabled events', () => {
    const toggles: EventToggle[] = [
      { id: 'push:default_branch', label: '', enabled: true },
      { id: 'pull_request:opened', label: '', enabled: false },
      { id: 'issues:opened', label: '', enabled: false },
    ];
    const result = applyEventOverrides(rules, toggles);
    assert.equal(result.length, 1);
    assert.equal(result[0].intent, 'validate-main');
  });
});

// ---------------------------------------------------------------------------
// Topology overrides
// ---------------------------------------------------------------------------

describe('applyTopologyOverrides', () => {
  it('applies user overrides', () => {
    const selection = {
      topology: 'hierarchical',
      consensus: 'raft',
      maxAgents: 8,
      swarmStrategy: 'specialized',
    };
    const setup = {
      topology: 'star' as const,
      consensus: 'none' as const,
      swarmStrategy: 'minimal' as const,
      maxAgents: 4,
    };
    const result = applyTopologyOverrides(selection, setup);
    assert.equal(result.topology, 'star');
    assert.equal(result.consensus, 'none');
    assert.equal(result.swarmStrategy, 'minimal');
    assert.equal(result.maxAgents, 4); // min(8, 4)
  });

  it('caps maxAgents to lower of selection and setup', () => {
    const selection = { topology: 'mesh', consensus: 'raft', maxAgents: 3, swarmStrategy: 'balanced' };
    const setup = { topology: 'mesh' as const, consensus: 'raft' as const, swarmStrategy: 'balanced' as const, maxAgents: 6 };
    const result = applyTopologyOverrides(selection, setup);
    assert.equal(result.maxAgents, 3); // min(3, 6)
  });
});

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

describe('formatSummary', () => {
  it('produces non-empty string with all sections', () => {
    const config = applyPreset('minimal');
    const summary = formatSummary(config);
    assert.ok(summary.includes('Setup Summary'));
    assert.ok(summary.includes('minimal'));
    assert.ok(summary.includes('Active Agents'));
    assert.ok(summary.includes('GitHub Events'));
    assert.ok(summary.includes('coder'));
    assert.ok(summary.includes('tester'));
  });
});

// ---------------------------------------------------------------------------
// C2: Runtime validation of setup.json
// ---------------------------------------------------------------------------

describe('validateSetupConfig', () => {
  it('returns valid config when all fields are correct', () => {
    const { validateSetupConfig } = require('../../src/setup/config-writer');
    const config = applyPreset('minimal');
    const result = validateSetupConfig(config);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects config with wrong version', () => {
    const { validateSetupConfig } = require('../../src/setup/config-writer');
    const result = validateSetupConfig({ version: 99 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e: string) => e.includes('version')));
  });

  it('rejects config with missing preset', () => {
    const { validateSetupConfig } = require('../../src/setup/config-writer');
    const config = applyPreset('minimal');
    delete (config as Record<string, unknown>).preset;
    const result = validateSetupConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e: string) => e.includes('preset')));
  });

  it('rejects config with invalid maxAgents type', () => {
    const { validateSetupConfig } = require('../../src/setup/config-writer');
    const config = { ...applyPreset('minimal'), maxAgents: 'banana' };
    const result = validateSetupConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e: string) => e.includes('maxAgents')));
  });

  it('rejects config with non-array activeAgents', () => {
    const { validateSetupConfig } = require('../../src/setup/config-writer');
    const config = { ...applyPreset('minimal'), activeAgents: 'not-array' };
    const result = validateSetupConfig(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e: string) => e.includes('activeAgents')));
  });
});

// ---------------------------------------------------------------------------
// H2: multiSelect must NOT mutate caller's items
// ---------------------------------------------------------------------------

describe('multiSelect item isolation', () => {
  it('does not mutate the original items array', async () => {
    const { multiSelect } = await import('../../src/setup/renderer');
    const items = [
      { value: 'a', label: 'A', selected: false },
      { value: 'b', label: 'B', selected: true },
    ];
    // Capture original state
    const originalA = items[0].selected;
    const originalB = items[1].selected;

    let keyIdx = 0;
    const keys = [
      { name: 'space' },  // toggle item 0
      { name: 'return' }, // confirm
    ];
    const mockIO = {
      write(_: string) {},
      async readKey() {
        if (keyIdx >= keys.length) return { name: 'return', ctrl: false, shift: false };
        const k = keys[keyIdx++];
        return { name: k.name, ctrl: false, shift: false };
      },
      clearScreen() {},
      close() {},
    };

    await multiSelect(mockIO, 'test', items);

    // Original items must be unchanged
    assert.equal(items[0].selected, originalA, 'items[0].selected was mutated');
    assert.equal(items[1].selected, originalB, 'items[1].selected was mutated');
  });
});

// C8: getDefaultTemplate test removed — template-library deleted in planning layer cleanup.

// ---------------------------------------------------------------------------
// T1: Happy-path wizard tests
// ---------------------------------------------------------------------------

describe('Wizard with mock IO', () => {
  const setupPath = require('node:path').resolve(__dirname, '..', '..', 'config', 'setup.json');
  // Clean up setup.json before/after each test to avoid cross-test interference
  beforeEach(() => {
    if (existsSync(setupPath)) unlinkSync(setupPath);
  });
  afterEach(() => {
    if (existsSync(setupPath)) unlinkSync(setupPath);
  });

  // Helper to create a mock TerminalIO that feeds keypress sequences
  function createMockIO(keySequence: Array<{ name: string; ctrl?: boolean; shift?: boolean }>) {
    let keyIndex = 0;
    const output: string[] = [];
    return {
      io: {
        write(text: string) { output.push(text); },
        async readKey() {
          if (keyIndex >= keySequence.length) {
            return { name: 'escape', ctrl: false, shift: false };
          }
          const k = keySequence[keyIndex++];
          return { name: k.name, ctrl: k.ctrl ?? false, shift: k.shift ?? false };
        },
        clearScreen() { output.push('[CLEAR]'); },
        close() { output.push('[CLOSE]'); },
      },
      output,
      getKeyIndex: () => keyIndex,
    };
  }

  it('can run to cancellation via escape', async () => {
    const { runWizard } = await import('../../src/setup/wizard');
    const mock = createMockIO([
      { name: 'escape' }, // cancel at preset selection
    ]);
    const result = await runWizard(mock.io);
    assert.equal(result, null);
    assert.ok(mock.output.some(s => s.includes('cancelled')));
  });

  it('happy path: select minimal preset and save', async () => {
    const { runWizard } = await import('../../src/setup/wizard');
    const mock = createMockIO([
      // Step 1: preset select — "Minimal" is first item, move up to select it
      { name: 'up' },     // move to Minimal (cursor starts at Standard=index 1)
      { name: 'return' }, // confirm Minimal
      // Step 2: confirm dialog — "Save and exit" is first, already selected
      { name: 'return' }, // save
    ]);
    const result = await runWizard(mock.io);
    assert.notEqual(result, null);
    assert.equal(result!.preset, 'minimal');
    assert.equal(result!.topology, 'star');
    assert.equal(result!.maxAgents, 3);
    // Verify close was called
    assert.ok(mock.output.some(s => s.includes('[CLOSE]')));
  });

  it('happy path: select standard preset and customize', async () => {
    const { runWizard } = await import('../../src/setup/wizard');
    const mock = createMockIO([
      // Step 1: preset select — Standard is default (index 1)
      { name: 'return' }, // confirm Standard
      // Step 2: confirm dialog — move down to "Customize this preset"
      { name: 'down' },
      { name: 'return' }, // enter custom flow
      // Step 3: agent multi-select — just confirm defaults
      { name: 'return' },
      // Step 4: event multi-select — just confirm defaults
      { name: 'return' },
      // Step 5: topology — confirm default (hierarchical)
      { name: 'return' },
      // Step 6: consensus — confirm default (raft)
      { name: 'return' },
      // Step 7: strategy — confirm default (specialized)
      { name: 'return' },
      // Step 8: max agents — confirm default
      { name: 'return' },
      // Step 9: final confirm — save
      { name: 'return' },
    ]);
    const result = await runWizard(mock.io);
    assert.notEqual(result, null);
    assert.equal(result!.preset, 'custom');
    assert.ok(result!.activeAgents.length > 0);
    assert.ok(result!.githubEvents.length > 0);
  });
});
