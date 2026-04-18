/**
 * Shared GitHub API helpers.
 *
 * Common constants and fetch wrappers used by webhook-updater and repo-add.
 */

// All GitHub event types we subscribe to at the webhook level
export const ALL_WEBHOOK_EVENTS = [
  'pull_request',
  'issues',
  'issue_comment',
  'push',
  'pull_request_review',
  'workflow_run',
  'release',
];

export async function githubFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options?.headers,
    },
  });
}
