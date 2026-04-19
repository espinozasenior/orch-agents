/**
 * P20: Context fetchers.
 *
 * Composes pre-dispatch context loading for skill-routed webhooks. Each
 * fetcher pulls a specific piece of GitHub state via the gh CLI; multiple
 * fetchers run in parallel and individual failures are isolated (logged +
 * empty string) so a single broken call never blocks dispatch.
 *
 * Wired into execution-engine.ts on the IntakeCompleted handler.
 */

import type { GitHubClient } from '../integration/github-client';
import type { Logger } from '../shared/logger';
import type { ParsedGitHubEvent } from '../webhook-gateway/event-parser';
import type { ResolvedSkill } from './skill-resolver';

export type ContextFetcher = (
  parsed: ParsedGitHubEvent,
  gh: GitHubClient,
) => Promise<string>;

/**
 * Built-in context fetchers, keyed by the kebab-case names skill files
 * declare in their `context-fetchers:` frontmatter array.
 */
export const CONTEXT_FETCHERS: Record<string, ContextFetcher> = {
  'gh-pr-view': async (parsed, gh) => {
    if (parsed.prNumber == null) return '';
    return gh.prView(parsed.repoFullName, parsed.prNumber);
  },
  'gh-pr-diff': async (parsed, gh) => {
    if (parsed.prNumber == null) return '';
    return gh.prDiff(parsed.repoFullName, parsed.prNumber);
  },
  'gh-issue-view': async (parsed, gh) => {
    if (parsed.issueNumber == null) return '';
    return gh.issueView(parsed.repoFullName, parsed.issueNumber);
  },
  'gh-pr-checks': async (parsed, gh) => {
    if (parsed.prNumber == null) return '';
    return gh.prChecks(parsed.repoFullName, parsed.prNumber);
  },
};

const SECTION_SEPARATOR = '\n\n---\n\n';

/**
 * Run every fetcher declared by `skill.frontmatter.contextFetchers` in
 * parallel, isolate errors, and join non-empty results with a separator.
 */
export async function fetchContextForSkill(
  skill: ResolvedSkill,
  parsed: ParsedGitHubEvent,
  gh: GitHubClient,
  logger: Logger,
  registry: Record<string, ContextFetcher> = CONTEXT_FETCHERS,
): Promise<string> {
  const names = skill.frontmatter.contextFetchers ?? [];
  if (names.length === 0) return '';

  const results = await Promise.all(
    names.map(async (name) => {
      const fetcher = registry[name];
      if (!fetcher) {
        logger.warn('Unknown context-fetcher declared by skill — skipping', {
          name,
          skillPath: skill.path,
        });
        return '';
      }
      try {
        const result = await fetcher(parsed, gh);
        return typeof result === 'string' ? result : '';
      } catch (err) {
        logger.warn('context-fetcher failed', {
          name,
          skillPath: skill.path,
          error: err instanceof Error ? err.message : String(err),
        });
        return '';
      }
    }),
  );

  return results.filter((s) => s.length > 0).join(SECTION_SEPARATOR);
}
