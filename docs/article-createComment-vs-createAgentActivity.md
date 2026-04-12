# Your AI Agent Is Posting as You, Not Itself

Your Linear bot responded to a user's question. The answer was great. But it showed up as **your** comment, not the bot's. Users thought you typed it. You got pinged. The bot looked invisible. What went wrong?

## What Was Broken

```typescript
// src/execution/simple-executor.ts:316
// WRONG: Uses createComment — posts as the OAuth authorizing user
await deps.linearClient.createComment(
  intakeEvent.sourceMetadata.linearIssueId,
  linearSummary,  // "coordinator completed in 89s..."
);
```

Every response from our agent orchestrator was posting via the standard `commentCreate` GraphQL mutation. Linear attributes these to **whoever authorized the OAuth token** — that's you, the admin who installed the app. Not the bot.

Meanwhile, Linear's own reference implementation — the [weather-bot](https://github.com/linear/weather-bot) — never calls `createComment`. Not once.

## Root Cause

1. **User comments on Linear issue** mentioning `@automata`
2. Linear sends `AgentSessionEvent` webhook with a session ID
3. Our system processes it → spawns a coordinator → Claude Code runs for ~90s
4. Coordinator produces an answer
5. `simple-executor.ts` calls **`createComment(issueId, body)`** ← the bug
6. Linear attributes the comment to the OAuth user (you), not the app

The weather-bot does step 5 differently:

```typescript
// weather-bot/src/lib/agent/agentClient.ts:89
// CORRECT: Uses createAgentActivity — posts as the bot actor
await this.linearClient.createAgentActivity({
  agentSessionId,            // ← ties to the session
  content: {
    type: "response",        // ← appears in activity feed
    body: "The weather in Paris is 15°C and cloudy.",
  },
});
```

This is the Agent Activity API — Linear's dedicated channel for bot communication. It:
- Posts as the **app actor** (the bot identity)
- Appears in the **agent activity sidebar** (not the comment thread)
- Supports streaming updates (`thought`, `action`, `response`, `error`, `elicitation`)
- Maintains **conversation continuity** through session activities

## The Fix

Platform-routed responses. Linear gets `createAgentActivity`. GitHub gets `createComment`:

```typescript
// src/integration/linear/activity-router.ts (new file)
export async function postAgentResponse(
  source: string,
  agentSessionId: string | undefined,
  body: string,
  clients: { linearClient?: LinearClient; githubClient?: GitHubClient },
  context: { issueId?: string; repo?: string; prNumber?: number },
): Promise<void> {
  if (source === 'linear' && agentSessionId && clients.linearClient) {
    // Linear: Agent Activity API — posts as bot actor
    await clients.linearClient.createAgentActivity(agentSessionId, {
      type: 'response',
      body,
    });
  } else if (source === 'github' && context.prNumber && clients.githubClient) {
    // GitHub: PR comment — existing behavior
    await clients.githubClient.postPRComment(
      context.repo!, context.prNumber, body + getBotMarker(),
    );
  } else if (context.issueId && clients.linearClient) {
    // Fallback: Linear comment (no session available)
    await clients.linearClient.createComment(context.issueId, body + getBotMarker());
  }
}
```

| File | Change |
|------|--------|
| `activity-router.ts` | New — platform-routed response posting |
| `simple-executor.ts` | Replace `createComment` with `postAgentResponse` |
| `execution-engine.ts` | Propagate `agentSessionId` through execution chain |

But that's only half the story. The weather-bot also gives users **real-time visibility** while the agent works:

```typescript
// Emit streaming activities during execution
await linearClient.createAgentActivity({
  agentSessionId,
  content: { type: "thought", body: "Researching the codebase..." },
  ephemeral: true,  // disappears after the session ends
});

await linearClient.createAgentActivity({
  agentSessionId,
  content: { type: "action", action: "read_file", parameter: "src/index.ts" },
});

// Final answer
await linearClient.createAgentActivity({
  agentSessionId,
  content: { type: "response", body: "Yes, this feature is implemented. Here's..." },
});
```

Our coordinator ran silently for 89 seconds before dumping everything at once. The weather-bot shows every step.

## The Key Insight

`createComment` is not the agent communication channel — it's for humans and GitHub. Linear's Agent Activity API (`createAgentActivity`) is purpose-built for bots: correct attribution, streaming updates, conversation memory, and a dedicated UI surface.

**Rule**: If the platform has a dedicated agent API, use it. `createComment` is the fallback for platforms that don't.

The full SPARC spec is at `docs/sparc/phase-10a-agent-activity-response-spec.md`.

---

## Tweet Thread Version

**1/** Your AI agent bot is posting Linear comments as YOU, not itself. Every response shows your avatar. Users think you're typing. The bot is invisible. Here's why and the fix 🧵

**2/** The bug: using `createComment` to respond. Linear attributes comments to whoever authorized the OAuth token — that's the admin, not the app. The weather-bot (Linear's official reference) NEVER calls createComment.

**3/** The fix: `createAgentActivity({ agentSessionId, content: { type: "response", body } })` — the Agent Activity API. Posts as the bot actor, appears in the activity sidebar, supports streaming thought/action/response steps.

**4/** But there's more. The weather-bot shows users EVERY step in real-time: "Thinking...", "Looking up coordinates...", "Getting weather...". Our agent ran silently for 89 seconds then dumped a wall of text.

**5/** The weather-bot also fetches previous session activities for conversation context. Follow-up questions work naturally. Our agent started fresh every time — "what's @automata?" on every exchange.

**6/** Platform routing rule: Linear sources → createAgentActivity (bot actor, activity feed). GitHub sources → createComment (PR thread). createComment is the fallback, not the default.

**7/** The conversation continuity fix: before each coordinator run, fetch `agentSession.activities()`, map Prompt→user / Response→assistant, include as conversation prefix. Multi-turn dialogue unlocked.

**8/** Full SPARC spec covering all 5 requirements (platform routing, streaming activities, session history, session ID propagation, GitHub-only createComment) in the repo. The reference implementation gap was just one `createComment` call. 🎯
