import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkflowPromptTemplate, validateWorkflowPromptTemplate } from '../../../src/integration/linear/workflow-prompt';
import type { IntakeEvent, PlannedAgent, WorkflowPlan } from '../../../src/types';

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-1',
    workItemId: 'ENG-9',
    template: 'quick-fix',
    promptTemplate: '',
    agentTeam: [],
    ...overrides,
  };
}

function makeIntake(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'issue-1',
    timestamp: new Date().toISOString(),
    source: 'linear',
    sourceMetadata: {
      linearIdentifier: 'ENG-9',
      linearTitle: 'Fix login',
      linearState: 'Todo',
      linearTeamKey: 'ENG',
      ...overrides.sourceMetadata,
    },
    intent: 'custom:linear-issue',
    entities: {
      repo: 'owner/repo',
      branch: 'feature/workflow',
      labels: ['bug', 'urgent'],
      severity: 'high',
      projectId: 'project-1',
      ...overrides.entities,
    },
    rawText: 'Repair the login flow',
    ...overrides,
  };
}

describe('workflow-prompt', () => {
  const agent: PlannedAgent = {
    role: 'coder',
    type: '.claude/agents/core/coder.md',
    tier: 2,
    required: true,
  };

  it('renders supported placeholders from issue, plan, repository, and agent context', () => {
    const prompt = renderWorkflowPromptTemplate(
      [
        'Issue: {{ issue.identifier }}',
        'Title: {{ issue.title }}',
        'Description: {{ issue.description }}',
        'Attempt: {{ attempt.number }}',
        'Tracker: {{ tracker.team }}',
        'Repo: {{ repository.name }}',
        'Branch: {{ repository.branch }}',
        'Agent: {{ agent.role }}',
        'Template: {{ plan.template }}',
      ].join('\n'),
      makeIntake({ sourceMetadata: { linearIdentifier: 'ENG-9', linearTitle: 'Fix login', linearState: 'Todo', linearTeamKey: 'ENG', attempt: 3 } }),
      agent,
      makePlan(),
    );

    assert.match(prompt, /Issue: ENG-9/);
    assert.match(prompt, /Title: Fix login/);
    assert.match(prompt, /Description: Repair the login flow/);
    assert.match(prompt, /Attempt: 3/);
    assert.match(prompt, /Tracker: ENG/);
    assert.match(prompt, /Repo: owner\/repo/);
    assert.match(prompt, /Branch: feature\/workflow/);
    assert.match(prompt, /Agent: coder/);
    assert.match(prompt, /Template: quick-fix/);
  });

  it('reports unsupported placeholders during validation', () => {
    assert.deepEqual(
      validateWorkflowPromptTemplate('Hello {{ issue.assignee }} {{ issue.identifier }}'),
      ['issue.assignee'],
    );
  });

  it('renders missing optional values as empty strings', () => {
    const prompt = renderWorkflowPromptTemplate(
      'Project={{ issue.project }} State={{ issue.state }}',
      makeIntake({
        sourceMetadata: { linearIdentifier: 'ENG-9' },
        entities: { repo: 'owner/repo', branch: 'main' },
      }),
      agent,
      makePlan(),
    );

    assert.equal(prompt, 'Project= State=');
  });

  it('throws when rendering unsupported placeholders directly', () => {
    assert.throws(
      () => renderWorkflowPromptTemplate('Hello {{ issue.assignee }}', makeIntake(), agent, makePlan()),
      /Unsupported WORKFLOW.md placeholder/,
    );
  });
});
