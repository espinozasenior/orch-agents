/**
 * Activity Router — platform-routed response posting.
 *
 * Linear sources with an agentSessionId use createAgentActivity (posts as bot actor).
 * GitHub sources use postPRComment (existing behavior).
 * Linear sources without a session fall back to createComment (state-change triggers).
 *
 * Phase 10A: FR-10A.01, FR-10A.02, FR-10A.05
 */

import type { LinearClient } from './linear-client';
import type { GitHubClient } from '../github-client';
import { getBotMarker } from '../../kernel/agent-identity';
import type { Logger } from '../../shared/logger';
import { redactSecrets } from '../../kernel/errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResponseContext {
  issueId?: string;
  repo?: string;
  prNumber?: number;
}

export type ActivityLinearClient = Pick<
  LinearClient,
  'createAgentActivity' | 'createComment'
>;

export type ActivityGitHubClient = Pick<GitHubClient, 'postPRComment'>;

// ---------------------------------------------------------------------------
// Response posting
// ---------------------------------------------------------------------------

/**
 * Route a response to the correct platform channel.
 *
 * - Linear + agentSessionId  -> createAgentActivity (bot actor, no marker)
 * - GitHub + prNumber        -> postPRComment (marker appended)
 * - Linear + no session      -> createComment fallback (marker appended)
 */
export async function postAgentResponse(
  source: string,
  agentSessionId: string | undefined,
  body: string,
  linearClient: ActivityLinearClient | undefined,
  githubClient: ActivityGitHubClient | undefined,
  context: ResponseContext,
): Promise<void> {
  const safeBody = redactSecrets(body);

  if (source === 'linear' && agentSessionId && linearClient) {
    await linearClient.createAgentActivity(agentSessionId, {
      type: 'response',
      body: safeBody,
    });
    return;
  }

  if (source === 'github' && githubClient && context.repo && context.prNumber) {
    await githubClient.postPRComment(
      context.repo,
      context.prNumber,
      safeBody + '\n' + getBotMarker(),
    );
    return;
  }

  // Fallback: Linear state-change trigger without a session, or unknown source
  if (linearClient && context.issueId) {
    await linearClient.createComment(context.issueId, safeBody + '\n' + getBotMarker());
  }
}

// ---------------------------------------------------------------------------
// Streaming thought activities (FR-10A.02)
// ---------------------------------------------------------------------------

/**
 * Emit a thought activity to Linear. No-op when agentSessionId is absent.
 */
export async function emitThought(
  agentSessionId: string | undefined,
  message: string,
  linearClient: ActivityLinearClient | undefined,
  logger?: Logger,
): Promise<void> {
  if (!agentSessionId || !linearClient) return;
  try {
    await linearClient.createAgentActivity(agentSessionId, {
      type: 'thought',
      body: redactSecrets(message),
    });
  } catch (err) {
    logger?.warn('Failed to emit thought activity', {
      agentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
