# Phase 7A: OAuth actor=app Authentication

## Goal
Replace the static API key authentication with Linear's OAuth `actor=app` flow so the agent appears as a distinct workspace member with its own identity, satisfying AIG's "agent should always disclose that it's an agent" principle.

## Specification

### Problem Statement
The current `LinearClient` uses a personal/workspace API key via `tracker.api_key` in WORKFLOW.md. Linear's Agent API requires OAuth `actor=app` authentication for the agent to appear as a distinct workspace member. The API key flow cannot access agent-specific mutations (`agentActivityCreate`, `agentSessionUpdate`) when using the new Agent Session webhooks.

### Functional Requirements
- FR-7A.01: Support two auth modes — `apiKey` (backward compat) and `oauth` (agent identity)
- FR-7A.02: Implement OAuth token exchange via `POST https://api.linear.app/oauth/token`
- FR-7A.03: Auto-refresh access tokens before expiry (5-minute buffer)
- FR-7A.04: Retry on 401 with automatic token refresh
- FR-7A.05: Pass OAuth credentials to worker threads via `workerData` for independent refresh
- FR-7A.06: Support OAuth scopes: `read,write,app:assignable,app:mentionable`
- FR-7A.07: Handle OAuth app revocation gracefully
- FR-7A.08: Add `/oauth/authorize` and `/oauth/callback` Fastify routes for the OAuth setup flow
- FR-7A.09: Store tokens per-workspace using `linear_oauth_token_{workspaceId}` key pattern
- FR-7A.10: Query `viewer.organization.id` after token exchange to determine workspace ID

### Non-Functional Requirements
- Token refresh must not block active GraphQL requests (async refresh with short mutex)
- OAuth credentials (client secret, refresh token) must never appear in logs
- Auth mode selection must be deterministic from env vars at startup

### Acceptance Criteria
- Existing API key mode works unchanged when `LINEAR_AUTH_MODE=apiKey` or unset
- OAuth mode exchanges code, stores tokens, and refreshes automatically
- Worker threads independently refresh tokens without main thread relay
- 401 responses trigger one refresh + retry before surfacing error
- Revoked OAuth app emits error activity and halts gracefully

## Pseudocode

```text
TYPE LinearAuthStrategy =
  | { mode: 'apiKey'; apiKey: string }
  | { mode: 'oauth'; clientId: string; clientSecret: string; accessToken: string; refreshToken: string; expiresAt: number }

INTERFACE OAuthTokenStore:
  getAccessToken(): string
  refreshIfNeeded(): Promise<void>
  exchangeCode(code: string): Promise<{ accessToken, refreshToken, expiresAt }>
  revokeToken(): Promise<void>

FUNCTION createLinearClient(strategy: LinearAuthStrategy):
  IF strategy.mode == 'apiKey':
    getAuthHeader = () => strategy.apiKey
  ELSE:
    tokenStore = createOAuthTokenStore(strategy)
    getAuthHeader = async () =>
      await tokenStore.refreshIfNeeded()
      RETURN "Bearer " + tokenStore.getAccessToken()

  FUNCTION graphql(query, variables):
    header = await getAuthHeader()
    response = await fetch(LINEAR_API_URL, { Authorization: header, ... })

    IF response.status == 401 AND strategy.mode == 'oauth':
      await tokenStore.refreshIfNeeded(force=true)
      header = await getAuthHeader()
      response = await fetch(LINEAR_API_URL, { Authorization: header, ... })

    RETURN response.data

FUNCTION createOAuthTokenStore(config):
  state = { accessToken, refreshToken, expiresAt }

  refreshIfNeeded(force=false):
    IF force OR (expiresAt - Date.now() < 300_000):
      response = POST https://api.linear.app/oauth/token {
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: state.refreshToken,
      }
      state.accessToken = response.access_token
      state.refreshToken = response.refresh_token
      state.expiresAt = Date.now() + response.expires_in * 1000
```

## Architecture

### Primary Components
- `src/integration/linear/linear-client.ts` — Auth strategy injection, `getAuthHeader()` method
- `src/integration/linear/oauth-token-store.ts` (NEW) — Token lifecycle management
- `src/shared/config.ts` — New env vars: `LINEAR_AUTH_MODE`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URI`
- `src/index.ts` — Wire auth strategy from config at startup
- `src/server.ts` — Register `/oauth/authorize` and `/oauth/callback` routes
- `src/execution/orchestrator/issue-worker.ts` — Receive OAuth credentials via `workerData`

### Data Flow
```
Startup → loadConfig() → LinearAuthStrategy → createLinearClient(strategy)
  │
  ├── apiKey mode: Authorization: <raw key>
  └── oauth mode: Authorization: Bearer <access_token>
                      │
                      ├── refreshIfNeeded() on each request
                      └── 401 → force refresh → retry once

Worker thread:
  workerData.oauthCredentials → createOAuthTokenStore() → createLinearClient()
```

### Design Decisions
- Auth strategy as a discriminated union type — explicit, type-safe, no runtime guessing
- Token store is a separate module — testable in isolation, injectable via DI
- Worker threads get credentials (not tokens) — they refresh independently, matching the existing `createWorkerGitHubClient()` pattern
- Refresh happens with a 5-minute buffer before expiry — avoids mid-request token expiration

## Refinement

### Implementation Notes
- The `LinearClientDeps` interface gains an optional `authStrategy` field alongside the existing `apiKey` for backward compat
- `graphql()` becomes async for the auth header (currently sync because API key is static)
- Worker threads reconstruct the token store from `clientId`, `clientSecret`, and the stored `refreshToken` — the access token is ephemeral
- OAuth redirect URI only matters during initial code exchange (setup flow), not runtime

### File Targets
- `src/integration/linear/linear-client.ts`
- `src/integration/linear/oauth-token-store.ts` (NEW)
- `src/shared/config.ts`
- `src/index.ts`
- `src/execution/orchestrator/issue-worker.ts`

### Exact Tests
- `tests/integration/linear/linear-client.test.ts`
  - API key mode returns the raw key as Authorization header
  - OAuth mode returns `Bearer <token>` as Authorization header
  - 401 triggers token refresh and retries the request once
  - Expired token triggers proactive refresh before the request
  - Revoked refresh token throws `LinearAuthError`
- `tests/integration/linear/oauth-token-store.test.ts` (NEW)
  - `exchangeCode` calls the token endpoint and stores tokens
  - `refreshIfNeeded` refreshes when within 5 minutes of expiry
  - `refreshIfNeeded(force=true)` always refreshes
  - Concurrent refresh calls coalesce into one network request

### Risks
- OAuth code exchange is a one-time setup step — need a setup route or CLI flow
- Refresh token rotation: Linear may issue a new refresh token on each refresh (must store the new one)
- Worker threads with stale refresh tokens can fail — need graceful error propagation back to orchestrator
