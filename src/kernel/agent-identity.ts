/**
 * Agent Identity — consistent comment formatting for AIG compliance.
 *
 * All comments posted by orch-agents include a standardized identity badge
 * and HTML marker for bot-loop detection.
 */

let _botName = process.env.BOT_USERNAME ?? 'orch-agents';

/**
 * Update the bot name at runtime (e.g., from config.botUsername).
 * Must be called before any comments are posted to ensure the marker
 * stays consistent with webhook loop-prevention checks.
 */
export function setBotName(name: string): void {
  if (name) _botName = name;
}

/**
 * Wrap a comment body with the agent identity badge and bot marker.
 */
export function formatAgentComment(body: string): string {
  return `${body}\n${getBotMarker()}`;
}

/**
 * Detect whether a comment was posted by this agent (contains bot marker).
 */
export function isAgentComment(body: string): boolean {
  return body.includes(getBotMarker());
}

/**
 * Get the configured bot name.
 */
export function getBotName(): string {
  return _botName;
}

/**
 * Get the bot HTML marker string.
 * Strips `[bot]` suffix from the name to avoid `name[bot]-bot` in the marker.
 */
export function getBotMarker(): string {
  const slug = _botName.replace(/\[bot\]$/, '');
  return `<!-- ${slug}-bot -->`;
}
