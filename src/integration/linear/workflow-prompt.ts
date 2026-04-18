const SUPPORTED_PLACEHOLDERS = new Set([
  'agent.role',
  'agent.type',
  'attempt.number',
  'issue.branch',
  'issue.description',
  'issue.identifier',
  'issue.labels',
  'issue.priority',
  'issue.project',
  'issue.repo',
  'issue.state',
  'issue.team',
  'issue.title',
  'plan.workItemId',
  'repository.branch',
  'repository.name',
  'tracker.team',
]);

export function validateWorkflowPromptTemplate(template: string): string[] {
  const placeholders = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    placeholders.add(match[1]);
  }

  return Array.from(placeholders).filter((placeholder) => !SUPPORTED_PLACEHOLDERS.has(placeholder));
}
