/**
 * Setup module public API.
 *
 * Entry point for the setup CLI commands and workflow editor.
 */

export { createTerminalIO } from './renderer';
export { createWorkflowEditor } from './workflow-editor';
export { readEnvFile, writeEnvFile } from './env-writer';
export { runGitHubSetup } from './commands/github';
export { runRepoAdd } from './commands/repo-add';
export { runRepoList } from './commands/repo-list';
export { runRepoEdit } from './commands/repo-edit';
export { runRepoRemove } from './commands/repo-remove';
export { runLinearSetup } from './commands/linear';
export type { TerminalIO, SelectItem, RepoSetupOptions } from './types';
