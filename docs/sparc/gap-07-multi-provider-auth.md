# SPARC Gap 7: Multi-Provider Authentication

## Priority: P2
## Estimated Effort: 7-10 days
## Status: Planning

---

## Problem Statement

Orch-agents only supports direct Anthropic API key authentication. Enterprise customers deploying on AWS Bedrock, Google Vertex AI, or Azure AI Foundry cannot use the system. The config (`shared/config.ts`) defines `githubToken` and `webhookSecret` but has no Claude API auth configuration. The `StreamingExecutor` and `TaskExecutor` both spawn `claude --print -` which inherits environment variables for auth, but `buildSafeEnv()` in `cli-client.ts` explicitly filters out all credential-related env vars (by design for security). There is no structured way to select an auth provider, validate credentials at startup, or inject provider-specific env vars into agent processes.

---

## S -- Specification

### Functional Requirements

- **FR-001**: Create an `AuthProvider` strategy interface that encapsulates provider-specific environment variables and credential validation.
- **FR-002**: Implement `DirectAuthProvider` using `ANTHROPIC_API_KEY`.
- **FR-003**: Implement `BedrockAuthProvider` using `AWS_REGION`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or OIDC (`AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`).
- **FR-004**: Implement `VertexAuthProvider` using `GOOGLE_APPLICATION_CREDENTIALS` or OIDC.
- **FR-005**: Implement `FoundryAuthProvider` using `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and OIDC.
- **FR-006**: Extend `AppConfig` with `authProvider: 'direct' | 'bedrock' | 'vertex' | 'foundry'` and relevant credential fields.
- **FR-007**: Inject auth provider env vars into `buildSafeEnv()` for child process spawning.
- **FR-008**: Validate auth credentials at startup; fail fast with clear, actionable error messages.
- **FR-009**: Support model name overrides per provider (e.g., Bedrock uses `anthropic.claude-3-sonnet-20240229-v1:0` format).
- **FR-010**: Log auth provider type at startup; never log credential values.

### Non-Functional Requirements

- **NFR-001** (security): Credentials must never appear in structured log output, event payloads, or PR comments.
- **NFR-002** (security): Auth provider env vars must only be injected into Claude CLI child processes, not into `claude-flow` CLI or `git` child processes.
- **NFR-003** (compatibility): Default behavior (no `AUTH_PROVIDER` env var) must remain identical to current behavior (inheriting `ANTHROPIC_API_KEY` from environment).
- **NFR-004** (latency): Auth validation at startup must complete within 5 seconds; OIDC token refresh must not block agent execution.

### Acceptance Criteria

- AC1: Setting `AUTH_PROVIDER=bedrock` with valid AWS credentials causes `buildSafeEnv()` to include `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in the returned env object.
- AC2: Setting `AUTH_PROVIDER=bedrock` without `AWS_REGION` causes startup to fail with error message containing "AWS_REGION is required for Bedrock auth provider".
- AC3: Setting `AUTH_PROVIDER=vertex` with `GOOGLE_APPLICATION_CREDENTIALS` pointing to a valid file passes validation.
- AC4: Setting `AUTH_PROVIDER=foundry` without `AZURE_CLIENT_ID` causes startup to fail with a clear error.
- AC5: Setting `CLAUDE_MODEL_OVERRIDE=anthropic.claude-3-sonnet-20240229-v1:0` passes the model name through to the CLI args.
- AC6: With `AUTH_PROVIDER=direct` (or unset), the system behaves identically to current behavior.
- AC7: No credential values appear in any log output at any log level.

### Constraints

- Must not modify the Claude CLI itself; we control only env vars and spawn arguments.
- Must work with the existing `SAFE_ENV_KEYS` whitelist pattern in `cli-client.ts`.
- Must not break the existing `buildSafeEnv()` contract for non-Claude child processes (git, npm, claude-flow CLI).
- OIDC token files are managed by the cloud provider's IAM infrastructure; the auth provider only needs to pass the file path, not refresh tokens.

### Edge Cases

- `ANTHROPIC_API_KEY` set alongside `AUTH_PROVIDER=bedrock` -- Bedrock provider takes precedence; log a warning that direct key is ignored.
- OIDC token file path does not exist at startup -- fail fast with clear error including the expected path.
- AWS credentials use assumed role with session token (`AWS_SESSION_TOKEN`) -- must be supported.
- Model override contains characters invalid for CLI args -- validate and reject at startup.
- Environment has both `AUTH_PROVIDER` and legacy direct key behavior -- explicit provider always wins.

---

## P -- Pseudocode

### P1 -- AuthProvider Interface

```
interface AuthProvider:
  name: string                           // 'direct' | 'bedrock' | 'vertex' | 'foundry'
  getEnvVars(): Record<string, string>   // env vars to inject into claude CLI processes
  validate(): Promise<boolean>           // throws with message on failure
  getModelOverride(): string | undefined // provider-specific model name
```

### P2 -- DirectAuthProvider

```
class DirectAuthProvider implements AuthProvider:
  name = 'direct'
  apiKey: string

  constructor(env):
    this.apiKey = env.ANTHROPIC_API_KEY
    if !this.apiKey: throw 'ANTHROPIC_API_KEY required for direct auth'

  getEnvVars():
    return { ANTHROPIC_API_KEY: this.apiKey }

  validate():
    // Key format validation only (no API call)
    if !this.apiKey.startsWith('sk-ant-'):
      log.warn('ANTHROPIC_API_KEY does not match expected prefix sk-ant-')
    return true

  getModelOverride():
    return env.CLAUDE_MODEL_OVERRIDE ?? undefined
```

### P3 -- BedrockAuthProvider

```
class BedrockAuthProvider implements AuthProvider:
  name = 'bedrock'

  constructor(env):
    this.region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION
    this.useOidc = !!env.AWS_WEB_IDENTITY_TOKEN_FILE
    if this.useOidc:
      this.tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE
      this.roleArn = env.AWS_ROLE_ARN
      if !this.roleArn: throw 'AWS_ROLE_ARN required with OIDC'
    else:
      this.accessKeyId = env.AWS_ACCESS_KEY_ID
      this.secretAccessKey = env.AWS_SECRET_ACCESS_KEY
      this.sessionToken = env.AWS_SESSION_TOKEN  // optional
      if !this.accessKeyId || !this.secretAccessKey:
        throw 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY required'
    if !this.region: throw 'AWS_REGION required for Bedrock'

  getEnvVars():
    vars = { AWS_REGION: this.region }
    if this.useOidc:
      vars.AWS_WEB_IDENTITY_TOKEN_FILE = this.tokenFile
      vars.AWS_ROLE_ARN = this.roleArn
    else:
      vars.AWS_ACCESS_KEY_ID = this.accessKeyId
      vars.AWS_SECRET_ACCESS_KEY = this.secretAccessKey
      if this.sessionToken:
        vars.AWS_SESSION_TOKEN = this.sessionToken
    return vars

  validate():
    if this.useOidc:
      if !fs.existsSync(this.tokenFile):
        throw 'OIDC token file not found: ' + this.tokenFile
    return true

  getModelOverride():
    return env.CLAUDE_MODEL_OVERRIDE ?? 'anthropic.claude-sonnet-4-20250514-v1:0'
```

### P4 -- VertexAuthProvider

```
class VertexAuthProvider implements AuthProvider:
  name = 'vertex'

  constructor(env):
    this.credentialsFile = env.GOOGLE_APPLICATION_CREDENTIALS
    this.project = env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT
    this.region = env.GOOGLE_CLOUD_REGION ?? 'us-central1'
    if !this.credentialsFile && !env.GOOGLE_CLOUD_TOKEN:
      throw 'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_TOKEN required'
    if !this.project:
      throw 'GOOGLE_CLOUD_PROJECT required for Vertex'

  getEnvVars():
    vars = {
      GOOGLE_CLOUD_PROJECT: this.project,
      GOOGLE_CLOUD_REGION: this.region,
    }
    if this.credentialsFile:
      vars.GOOGLE_APPLICATION_CREDENTIALS = this.credentialsFile
    return vars

  validate():
    if this.credentialsFile && !fs.existsSync(this.credentialsFile):
      throw 'Credentials file not found: ' + this.credentialsFile
    return true

  getModelOverride():
    return env.CLAUDE_MODEL_OVERRIDE ?? undefined
```

### P5 -- FoundryAuthProvider

```
class FoundryAuthProvider implements AuthProvider:
  name = 'foundry'

  constructor(env):
    this.clientId = env.AZURE_CLIENT_ID
    this.tenantId = env.AZURE_TENANT_ID
    this.endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT
    if !this.clientId: throw 'AZURE_CLIENT_ID required for Foundry'
    if !this.tenantId: throw 'AZURE_TENANT_ID required for Foundry'

  getEnvVars():
    vars = {
      AZURE_CLIENT_ID: this.clientId,
      AZURE_TENANT_ID: this.tenantId,
    }
    if this.endpoint:
      vars.AZURE_AI_FOUNDRY_ENDPOINT = this.endpoint
    return vars

  validate():
    return true

  getModelOverride():
    return env.CLAUDE_MODEL_OVERRIDE ?? undefined
```

### P6 -- Factory Function

```
function createAuthProvider(env): AuthProvider:
  provider = env.AUTH_PROVIDER ?? 'direct'
  switch provider:
    case 'direct':  return new DirectAuthProvider(env)
    case 'bedrock': return new BedrockAuthProvider(env)
    case 'vertex':  return new VertexAuthProvider(env)
    case 'foundry': return new FoundryAuthProvider(env)
    default: throw 'Unknown AUTH_PROVIDER: ' + provider + '. Valid: direct, bedrock, vertex, foundry'
```

### P7 -- buildSafeEnv Integration

```
// Modified buildSafeEnv signature
function buildSafeEnv(source, authProvider?):
  safe = {}  // existing logic for SAFE_ENV_KEYS
  for key of SAFE_ENV_KEYS:
    if source[key]: safe[key] = source[key]
  safe.FORCE_COLOR = '0'

  // Inject auth provider vars when provided
  if authProvider:
    Object.assign(safe, authProvider.getEnvVars())
    modelOverride = authProvider.getModelOverride()
    if modelOverride:
      safe.CLAUDE_MODEL = modelOverride
  return safe

// New function for non-auth child processes (git, claude-flow CLI)
function buildSafeEnvNoAuth(source):
  return buildSafeEnv(source)  // no auth provider = no credentials injected
```

### Complexity Analysis

- Provider creation: O(1) -- constant-time env var reads.
- Validation: O(1) -- file existence check at most.
- `buildSafeEnv` overhead: O(k) where k = number of auth env vars (max ~6).
- No network calls during validation (OIDC token refresh is handled by the cloud SDK at CLI runtime).

---

## A -- Architecture

### New Components

```
src/shared/auth-provider.ts    -- AuthProvider interface + 4 implementations + factory
```

### Modified Components

```
src/shared/config.ts           -- Add authProvider field to AppConfig, parse AUTH_PROVIDER
src/execution/cli-client.ts    -- Add optional AuthProvider param to buildSafeEnv()
src/execution/streaming-executor.ts -- Pass authProvider to buildSafeEnv()
src/execution/task-executor.ts -- Pass authProvider to buildSafeEnv() (if used directly)
src/index.ts                   -- Create auth provider at startup, validate, inject
```

### Component Diagram

```
                     +---------------------+
                     |     index.ts        |
                     | (startup wiring)    |
                     +----------+----------+
                                |
                     createAuthProvider(env)
                                |
                     +----------v----------+
                     |   auth-provider.ts  |
                     |                     |
                     | AuthProvider iface  |
                     | DirectAuthProvider  |
                     | BedrockAuthProvider |
                     | VertexAuthProvider  |
                     | FoundryAuthProvider |
                     +----------+----------+
                                |
                    authProvider.validate()
                                |
              +-----------------+-----------------+
              |                                   |
    +---------v---------+           +-------------v-----------+
    | streaming-executor|           |    task-executor         |
    | (claude --print -)|           | (claude --print -)      |
    +---------+---------+           +-------------+-----------+
              |                                   |
    buildSafeEnv(env, authProvider)    buildSafeEnv(env, authProvider)
              |                                   |
         child_process.spawn()            child_process.spawn()
```

### Integration Points

1. **`buildSafeEnv()`** is the single injection point. Auth provider env vars are merged into the safe env only when an `AuthProvider` is passed. Non-Claude processes (git, claude-flow CLI) continue calling `buildSafeEnv()` without an auth provider, ensuring no credential leakage.

2. **`loadConfig()`** gains an `authProvider` field but does NOT store credentials. It stores only the provider type string. The actual `AuthProvider` object is created separately in `index.ts` to keep config pure.

3. **Model override** is passed via `CLAUDE_MODEL` env var to the child process. The Claude CLI respects this for provider-specific model selection.

### Key Design Decisions

- **Strategy pattern over union type**: Each provider encapsulates its own validation and env var logic. Adding a new provider requires only a new class and a factory case, no modifications to existing providers.
- **No runtime OIDC refresh**: The auth provider passes token file paths to the child process. The Claude CLI (or underlying SDK) handles token refresh. This keeps orch-agents stateless with respect to cloud auth.
- **Separate `buildSafeEnv` for auth vs non-auth**: Prevents accidental credential injection into git or npm processes.

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude CLI does not respect env vars for Bedrock/Vertex | MEDIUM | Test with actual CLI; document supported CLI versions |
| OIDC token file expires between validation and use | LOW | Claude CLI handles refresh; validation is best-effort |
| Model override format changes per provider | LOW | Override is user-provided; document expected formats |
| Credential leak via error messages | MEDIUM | Never include credential values in Error messages or logs |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: auth-provider.ts -- AuthProvider interface + DirectAuthProvider + tests

Tests (London School -- mock env):
- `createAuthProvider({ AUTH_PROVIDER: 'direct', ANTHROPIC_API_KEY: 'sk-ant-test' })` returns DirectAuthProvider
- `getEnvVars()` returns `{ ANTHROPIC_API_KEY: 'sk-ant-test' }`
- `validate()` resolves to true
- Missing `ANTHROPIC_API_KEY` throws with message containing "ANTHROPIC_API_KEY required"
- `getModelOverride()` returns undefined when `CLAUDE_MODEL_OVERRIDE` is not set
- `getModelOverride()` returns override value when set
- Unknown provider string throws with message listing valid providers

### Step 2: BedrockAuthProvider + tests

Tests:
- Static credentials: `getEnvVars()` returns `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Static credentials with session token: includes `AWS_SESSION_TOKEN`
- OIDC mode: `getEnvVars()` returns `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_REGION`
- Missing `AWS_REGION` throws with "AWS_REGION required"
- OIDC without `AWS_ROLE_ARN` throws with "AWS_ROLE_ARN required"
- Static without `AWS_ACCESS_KEY_ID` throws
- `validate()` with OIDC checks token file existence (mock `fs.existsSync`)
- `getModelOverride()` returns Bedrock default format when no override set

### Step 3: VertexAuthProvider + tests

Tests:
- `getEnvVars()` returns `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION`
- Missing `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_TOKEN` throws
- Missing `GOOGLE_CLOUD_PROJECT` throws
- `validate()` with credentials file checks existence (mock `fs.existsSync`)
- Default region is `us-central1`

### Step 4: FoundryAuthProvider + tests

Tests:
- `getEnvVars()` returns `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`
- Optional `AZURE_AI_FOUNDRY_ENDPOINT` included when set
- Missing `AZURE_CLIENT_ID` throws
- Missing `AZURE_TENANT_ID` throws
- `validate()` always returns true (OIDC validation is external)

### Step 5: buildSafeEnv integration + tests

Tests:
- `buildSafeEnv(env)` without auth provider returns same result as current (backward compatible)
- `buildSafeEnv(env, directProvider)` includes `ANTHROPIC_API_KEY`
- `buildSafeEnv(env, bedrockProvider)` includes AWS vars but NOT `ANTHROPIC_API_KEY`
- `buildSafeEnv(env, vertexProvider)` includes Google vars
- Model override appears as `CLAUDE_MODEL` in returned env
- Existing `SAFE_ENV_KEYS` behavior unchanged

### Step 6: config.ts extension + tests

Tests:
- `loadConfig({ AUTH_PROVIDER: 'bedrock' })` includes `authProvider: 'bedrock'`
- `loadConfig({})` defaults to `authProvider: 'direct'`
- Invalid `AUTH_PROVIDER` value throws

### Step 7: index.ts wiring + integration test

Tests:
- Auth provider created and validated at startup
- Auth provider passed to streaming executor
- Auth provider passed to task executor
- Startup logs auth provider type but not credentials
- Invalid credentials cause startup failure with descriptive error

### Quality Gates

- All existing tests pass (zero regressions)
- 100% branch coverage on `auth-provider.ts`
- `npm run build` succeeds
- `npm test` passes
- No credential values appear in any test log output

---

## C -- Completion

### Verification Checklist

- [ ] All 4 auth providers created and tested
- [ ] `buildSafeEnv` backward compatible (no auth provider = same behavior)
- [ ] `buildSafeEnv` with auth provider injects correct env vars
- [ ] `loadConfig` parses `AUTH_PROVIDER` with validation
- [ ] Startup validates credentials and fails fast
- [ ] Startup logs provider type, never credential values
- [ ] Model override passed through to CLI child processes
- [ ] Existing tests pass with no modifications
- [ ] Manual test with `AUTH_PROVIDER=direct` confirms backward compatibility

### Deployment Steps

1. Merge to main after all tests pass.
2. Update environment variable documentation with new `AUTH_PROVIDER` and per-provider vars.
3. For Bedrock users: set `AUTH_PROVIDER=bedrock`, `AWS_REGION`, and either static keys or OIDC vars.
4. For Vertex users: set `AUTH_PROVIDER=vertex`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`.
5. For Foundry users: set `AUTH_PROVIDER=foundry`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`.
6. No database migration required.

### Rollback Plan

- Revert the merge commit. The default `AUTH_PROVIDER=direct` path is identical to pre-change behavior, so partial rollback is also safe: simply remove `AUTH_PROVIDER` from environment.
- No state migration is involved; rollback is a code-only operation.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `src/shared/auth-provider.ts` | NEW |
| `src/shared/config.ts` | MODIFIED |
| `src/execution/cli-client.ts` | MODIFIED |
| `src/execution/streaming-executor.ts` | MODIFIED |
| `src/execution/task-executor.ts` | MODIFIED |
| `src/index.ts` | MODIFIED |
| `tests/shared/auth-provider.test.ts` | NEW |
| `tests/execution/cli-client.test.ts` | MODIFIED |
| `tests/shared/config.test.ts` | MODIFIED |
