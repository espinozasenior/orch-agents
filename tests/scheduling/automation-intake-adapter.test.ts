import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutomationIntakeEvent } from '../../src/scheduling/automation-intake-adapter';
import type { AutomationConfig } from '../../src/config/workflow-config';
import type { AutomationSourceMetadata } from '../../src/types';

describe('automation-intake-adapter', () => {
  const baseConfig: AutomationConfig = {
    instruction: 'Run npm test and report failures',
    schedule: '0 */6 * * *',
  };

  it('produces a valid IntakeEvent with source automation', () => {
    const event = buildAutomationIntakeEvent('acme/app::health', 'acme/app', baseConfig, 'cron');

    assert.ok(event.id);
    assert.ok(event.timestamp);
    assert.equal(event.source, 'automation');
    assert.equal(event.rawText, 'Run npm test and report failures');
  });

  it('sets entities.repo to the repo name', () => {
    const event = buildAutomationIntakeEvent('acme/app::health', 'acme/app', baseConfig, 'cron');
    assert.equal(event.entities.repo, 'acme/app');
  });

  it('sets sourceMetadata with automationId and trigger', () => {
    const event = buildAutomationIntakeEvent('acme/app::health', 'acme/app', baseConfig, 'manual');
    const meta = event.sourceMetadata as AutomationSourceMetadata;

    assert.equal(meta.source, 'automation');
    assert.equal(meta.automationId, 'acme/app::health');
    assert.equal(meta.trigger, 'manual');
  });

  it('includes skillPath when config.skill is set', () => {
    const config: AutomationConfig = {
      ...baseConfig,
      skill: '.claude/skills/ci/SKILL.md',
    };
    const event = buildAutomationIntakeEvent('acme/app::ci', 'acme/app', config, 'cron');
    const meta = event.sourceMetadata as AutomationSourceMetadata;

    assert.equal(meta.skillPath, '.claude/skills/ci/SKILL.md');
  });

  it('omits skillPath when config.skill is not set', () => {
    const event = buildAutomationIntakeEvent('acme/app::health', 'acme/app', baseConfig, 'cron');
    const meta = event.sourceMetadata as AutomationSourceMetadata;

    assert.equal(meta.skillPath, undefined);
  });

  it('uses webhook trigger type', () => {
    const config: AutomationConfig = {
      instruction: 'Verify deploy',
      trigger: 'webhook',
    };
    const event = buildAutomationIntakeEvent('acme/app::deploy', 'acme/app', config, 'webhook');
    const meta = event.sourceMetadata as AutomationSourceMetadata;

    assert.equal(meta.trigger, 'webhook');
  });
});
