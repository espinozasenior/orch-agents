import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflowMdString } from '../../src/config/workflow-parser';

function wrapYaml(yaml: string): string {
  return `---\n${yaml}\n---\nYou are a helpful agent. {{issue.title}}`;
}

describe('workflow-parser: automations', () => {
  it('parses a cron automation from YAML', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    default_branch: main
    automations:
      health-check:
        schedule: "0 */6 * * *"
        instruction: "Run npm test and report failures"
        skill: .claude/skills/ci-status/SKILL.md
    `));

    const auto = config.repos['acme/app'].automations;
    assert.ok(auto);
    assert.ok(auto['health-check']);
    assert.equal(auto['health-check'].schedule, '0 */6 * * *');
    assert.equal(auto['health-check'].instruction, 'Run npm test and report failures');
    assert.equal(auto['health-check'].skill, '.claude/skills/ci-status/SKILL.md');
    assert.equal(auto['health-check'].trigger, undefined);
  });

  it('parses a webhook automation from YAML', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      deploy-verify:
        trigger: webhook
        instruction: "Verify deployment is healthy"
    `));

    const auto = config.repos['acme/app'].automations!;
    assert.equal(auto['deploy-verify'].trigger, 'webhook');
    assert.equal(auto['deploy-verify'].instruction, 'Verify deployment is healthy');
    assert.equal(auto['deploy-verify'].schedule, undefined);
  });

  it('parses a sentry automation with events', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      error-handler:
        trigger: sentry
        events:
          - error
          - fatal
        instruction: "Investigate the Sentry error"
    `));

    const auto = config.repos['acme/app'].automations!;
    assert.equal(auto['error-handler'].trigger, 'sentry');
    assert.deepEqual(auto['error-handler'].events, ['error', 'fatal']);
  });

  it('throws when instruction is missing', () => {
    assert.throws(
      () => parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      bad-auto:
        schedule: "0 * * * *"
      `)),
      /instruction.*is required/,
    );
  });

  it('throws when neither schedule nor trigger is provided', () => {
    assert.throws(
      () => parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      orphan:
        instruction: "Do something"
      `)),
      /must have either 'schedule' or 'trigger'/,
    );
  });

  it('throws on invalid trigger value', () => {
    assert.throws(
      () => parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      bad:
        trigger: email
        instruction: "Do something"
      `)),
      /trigger must be 'webhook' or 'sentry'/,
    );
  });

  it('applies custom timeout', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      quick:
        schedule: "*/5 * * * *"
        instruction: "Quick check"
        timeout: 60000
    `));

    assert.equal(config.repos['acme/app'].automations!['quick'].timeout, 60000);
  });

  it('parses model override', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      smart:
        schedule: "0 0 * * *"
        instruction: "Deep analysis"
        model: claude-sonnet-4-20250514
    `));

    assert.equal(config.repos['acme/app'].automations!['smart'].model, 'claude-sonnet-4-20250514');
  });

  it('parses multiple repos with different automations', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    automations:
      health:
        schedule: "0 */6 * * *"
        instruction: "Health check"
  acme/lib:
    url: https://github.com/acme/lib
    automations:
      deploy:
        trigger: webhook
        instruction: "Verify deploy"
      nightly:
        schedule: "0 0 * * *"
        instruction: "Nightly build"
    `));

    assert.equal(Object.keys(config.repos['acme/app'].automations!).length, 1);
    assert.equal(Object.keys(config.repos['acme/lib'].automations!).length, 2);
    assert.ok(config.repos['acme/lib'].automations!['deploy']);
    assert.ok(config.repos['acme/lib'].automations!['nightly']);
  });

  it('repos without automations remain unchanged', () => {
    const config = parseWorkflowMdString(wrapYaml(`
repos:
  acme/app:
    url: https://github.com/acme/app
    `));

    assert.equal(config.repos['acme/app'].automations, undefined);
  });
});
