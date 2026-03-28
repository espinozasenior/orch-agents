/**
 * Agent Identity — consistent comment formatting for AIG compliance.
 *
 * All comments posted by orch-agents include a standardized identity badge
 * and HTML marker for bot-loop detection.
 */

const BOT_NAME = process.env.BOT_USERNAME ?? 'orch-agents';
const BOT_MARKER = `<!-- ${BOT_NAME}-bot -->`;

/**
 * Wrap a comment body with the agent identity badge and bot marker.
 */
export function formatAgentComment(body: string): string {
  return `${body}\n${BOT_MARKER}`;
}

/**
 * Detect whether a comment was posted by this agent (contains bot marker).
 */
export function isAgentComment(body: string): boolean {
  return body.includes(BOT_MARKER);
}

/**
 * Get the configured bot name.
 */
export function getBotName(): string {
  return BOT_NAME;
}

/**
 * Get the bot HTML marker string.
 */
export function getBotMarker(): string {
  return BOT_MARKER;
}
