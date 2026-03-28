# SPARC Gap 9: GitHub Action Packaging

## Priority: P2
## Estimated Effort: 5-7 days
## Status: Planning

---

## Problem Statement

Orch-agents requires deploying a Fastify server to receive webhooks, which is a significant adoption barrier. Users must provision infrastructure, configure DNS, manage TLS certificates, and set up webhook delivery. Competing tools like `claude-code-action` run directly as GitHub Actions, requiring only a workflow YAML file. The system should support both deployment modes: self-hosted server (existing) and GitHub Action (new).

The pipeline logic in `src/pipeline.ts` is already decoupled from HTTP transport -- it subscribes to domain events via EventBus. The current entry point (`src/index.ts` -> `src/server.ts`) creates a Fastify server that receives webhooks and publishes `IntakeCompleted` events. A GitHub Action entry point can construct the same `IntakeCompleted` event from the GitHub Actions event context (`GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`) and run the pipeline directly.

---

## S -- Specification

### Functional Requirements

- **FR-001**: Create `action.yml` composite action definition at the repository root.
- **FR-002**: Create `src/entrypoints/github-action.ts` as an alternative entry point that reads GitHub Actions context from environment variables and event payload files.
- **FR-003**: The action entry point must construct a `ParsedGitHubEvent` (same type used by `webhook-router.ts`) from the Actions context, bypassing HTTP entirely.
- **FR-004**: The action entry point must run the same pipeline (`startPipeline()`) as the server, producing identical results.
- **FR-005**: Support both deployment modes without code duplication:
  - **Self-hosted**: `npm start` starts Fastify server (existing, unchanged).
  - **GitHub Action**: `uses: org/orch-agents@v1` runs in GitHub Actions runner.
- **FR-006**: Map action inputs to environment variables: `anthropic_api_key`, `webhook_secret`, `model`, `max_agents`, `template`, `auth_provider`.
- **FR-007**: Define action outputs: `execution_log`, `structured_output`, `branch_name`, `review_verdict`.
- **FR-008**: Package as a container action using Node.js 22 (not Bun, for compatibility).
- **FR-009**: Include a `Dockerfile` for the container action that installs the Claude CLI.
- **FR-010**: The action entry point must post results back via the GitHub token provided by the Actions runner (`GITHUB_TOKEN`).

### Non-Functional Requirements

- **NFR-001** (startup time): Action entry point must begin pipeline execution within 10 seconds of container start (excluding docker pull).
- **NFR-002** (compatibility): Must work on `ubuntu-latest` GitHub-hosted runners and self-hosted runners with Docker support.
- **NFR-003** (size): Container image should be under 500MB to minimize pull time.
- **NFR-004** (security): `GITHUB_TOKEN` and `anthropic_api_key` must be passed via `secrets` context, never hardcoded in workflow files.

### Acceptance Criteria

- AC1: A workflow file using `uses: org/orch-agents@v1` with `anthropic_api_key` secret triggers the pipeline on `pull_request` events.
- AC2: The action reads `GITHUB_EVENT_PATH` and constructs a valid `IntakeEvent` with correct `intent`, `repo`, `prNumber`, and `branch`.
- AC3: Pipeline execution results are posted as a PR comment via the Actions-provided `GITHUB_TOKEN`.
- AC4: Action outputs (`execution_log`, `structured_output`, `review_verdict`) are set and accessible in subsequent workflow steps.
- AC5: `npm start` continues to work identically (self-hosted mode unaffected).
- AC6: The Dockerfile builds successfully and the container starts within 10 seconds.
- AC7: Claude CLI is available inside the container at `/usr/local/bin/claude`.

### Constraints

- Must not modify `src/index.ts` or `src/server.ts` -- the server entry point remains unchanged.
- Must reuse existing pipeline wiring from `src/pipeline.ts` without duplication.
- Must reuse `github-normalizer.ts` for event parsing (same normalization logic).
- Claude CLI must be installable in the container (requires `npm install -g @anthropic-ai/claude-code`).
- The action must handle the case where Claude CLI is already installed on the runner (self-hosted runners with pre-installed tools).
- GitHub Actions file size limit for `GITHUB_OUTPUT` is 1MB per step.

### Edge Cases

- `GITHUB_EVENT_PATH` file does not exist or is not valid JSON -- fail with clear error and set action output `review_verdict=error`.
- `GITHUB_EVENT_NAME` is an unsupported event type (e.g., `schedule`) -- log warning and exit with neutral status.
- Pipeline execution exceeds GitHub Actions job timeout (6 hours default) -- rely on Actions timeout; no custom handling needed.
- `GITHUB_TOKEN` has insufficient permissions -- fail with error message suggesting required permissions (`pull-requests: write`, `contents: write`).
- Action is triggered by a fork PR -- `GITHUB_TOKEN` has read-only access; detect and warn.

---

## P -- Pseudocode

### P1 -- Action Entry Point

```
// src/entrypoints/github-action.ts

async function main():
  // 1. Read GitHub Actions context
  eventName = env.GITHUB_EVENT_NAME
  eventPath = env.GITHUB_EVENT_PATH
  repo = env.GITHUB_REPOSITORY          // 'owner/repo'
  token = env.GITHUB_TOKEN
  runId = env.GITHUB_RUN_ID

  if !eventPath || !eventName:
    setFailed('Not running in GitHub Actions context')
    return

  // 2. Read event payload
  payload = JSON.parse(fs.readFileSync(eventPath, 'utf-8'))

  // 3. Map to IntakeEvent using existing normalizer
  intakeEvent = normalizeGitHubEvent(eventName, payload)
  if !intakeEvent:
    setOutput('review_verdict', 'skipped')
    log('Unsupported event type: ' + eventName)
    return

  // 4. Create infrastructure
  config = loadActionConfig(env)
  logger = createLogger({ level: config.logLevel })
  eventBus = createEventBus(logger)

  // 5. Create executor (same as index.ts logic)
  authProvider = createAuthProvider(env)
  await authProvider.validate()
  taskExecutor = createTaskExecutor(authProvider)

  // 6. Create GitHubClient with Actions token
  githubClient = createGitHubClient({ token, logger })

  // 7. Start pipeline
  pipeline = startPipeline({
    eventBus, logger, taskExecutor, githubClient, ...
  })

  // 8. Collect results via event subscription
  resultPromise = collectResults(eventBus)

  // 9. Publish IntakeCompleted to kick off pipeline
  eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }))

  // 10. Wait for pipeline completion
  result = await resultPromise

  // 11. Set action outputs
  setOutput('execution_log', result.log)
  setOutput('structured_output', JSON.stringify(result.output))
  setOutput('review_verdict', result.verdict)
  if result.branch:
    setOutput('branch_name', result.branch)

  // 12. Post summary comment
  if intakeEvent.entities.prNumber:
    await githubClient.postPRComment(
      repo, intakeEvent.entities.prNumber, formatSummary(result)
    )

  // 13. Shutdown
  pipeline.shutdown()
  eventBus.removeAllListeners()

  // 14. Exit with appropriate code
  if result.verdict === 'fail':
    process.exit(1)
```

### P2 -- Event Normalization for Actions Context

```
function normalizeGitHubEvent(eventName, payload) -> IntakeEvent | null:
  // Reuse github-normalizer.ts parseGitHubWebhook logic
  // but construct from Actions payload instead of webhook body

  switch eventName:
    case 'pull_request':
      return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: 'github',
        sourceMetadata: { eventName, action: payload.action },
        intent: mapPRAction(payload.action),
        entities: {
          repo: payload.repository.full_name,
          branch: payload.pull_request.head.ref,
          prNumber: payload.pull_request.number,
          author: payload.pull_request.user.login,
          files: [],  // loaded lazily via GitHub API
        },
      }

    case 'pull_request_review':
      return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: 'github',
        intent: 'process-review',
        sourceMetadata: { eventName },
        entities: {
          repo: payload.repository.full_name,
          prNumber: payload.pull_request.number,
        },
      }

    case 'issues':
      return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: 'github',
        intent: 'triage-issue',
        sourceMetadata: { eventName },
        entities: {
          repo: payload.repository.full_name,
          issueNumber: payload.issue.number,
          labels: payload.issue.labels.map(l => l.name),
        },
      }

    case 'push':
      return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: 'github',
        intent: payload.ref === 'refs/heads/main' ? 'validate-main' : 'validate-branch',
        sourceMetadata: { eventName },
        entities: {
          repo: payload.repository.full_name,
          branch: payload.ref.replace('refs/heads/', ''),
        },
      }

    default:
      return null

function mapPRAction(action):
  switch action:
    case 'opened', 'reopened', 'synchronize': return 'review-pr'
    case 'closed': return 'post-merge'
    default: return 'review-pr'
```

### P3 -- Result Collection

```
function collectResults(eventBus) -> Promise<PipelineResult>:
  return new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ verdict: 'error', log: 'Timeout' }), 3600000)

    eventBus.subscribe('WorkCompleted', (event) => {
      clearTimeout(timeout)
      resolve({
        verdict: 'pass',
        log: JSON.stringify(event.payload),
        output: event.payload,
        branch: undefined,
      })
    })

    eventBus.subscribe('WorkFailed', (event) => {
      clearTimeout(timeout)
      resolve({
        verdict: 'fail',
        log: event.payload.failureReason,
        output: event.payload,
        branch: undefined,
      })
    })

    eventBus.subscribe('ReviewCompleted', (event) => {
      // Don't resolve yet -- WorkCompleted/WorkFailed will follow
      // But capture review verdict for output
    })
  })
```

### P4 -- Action Output Helpers

```
function setOutput(name, value):
  outputFile = env.GITHUB_OUTPUT
  if outputFile:
    // Multi-line safe output using delimiter
    delimiter = 'EOF_' + randomUUID().slice(0, 8)
    fs.appendFileSync(outputFile, name + '<<' + delimiter + '\n' + value + '\n' + delimiter + '\n')
  else:
    // Fallback for older runners
    console.log('::set-output name=' + name + '::' + value)

function setFailed(message):
  console.error('::error::' + message)
  process.exit(1)
```

### Complexity Analysis

- Event normalization: O(1) -- constant-time payload field extraction.
- Result collection: O(1) -- single event subscription resolution.
- Pipeline execution: Same as server mode (bounded by pipeline complexity).

---

## A -- Architecture

### New Components

```
action.yml                              -- GitHub Action definition
Dockerfile                              -- Container action image
src/entrypoints/github-action.ts        -- Action entry point
src/entrypoints/action-normalizer.ts    -- GitHub event normalization for Actions context
src/entrypoints/action-outputs.ts       -- setOutput, setFailed helpers
```

### Modified Components

```
package.json                            -- Add 'action' build script
tsconfig.json                           -- Include entrypoints directory
```

### Deployment Mode Diagram

```
                     GitHub Event
                         |
          +--------------+--------------+
          |                             |
     [Self-Hosted]              [GitHub Action]
          |                             |
   Webhook HTTP POST          GITHUB_EVENT_PATH
          |                             |
   webhook-router.ts          action-normalizer.ts
          |                             |
   github-normalizer.ts       (same normalization)
          |                             |
     IntakeCompleted              IntakeCompleted
          |                             |
          +-----------+  +--------------+
                      |  |
                  EventBus
                      |
                  pipeline.ts
                      |
              Triage -> Plan -> Execute -> Review
                      |
                  WorkCompleted
                      |
          +-----------+  +--------------+
          |                             |
   [Server response]           [Action outputs]
   (webhook ack)               setOutput()
                               postPRComment()
```

### Key Design Decisions

- **Container action over JavaScript action**: The Claude CLI requires Node.js and npm. A container action provides a consistent environment with pre-installed dependencies. JavaScript actions would require the runner to have Claude CLI pre-installed.

- **Shared pipeline, different entry points**: Both `index.ts` (server) and `github-action.ts` (action) wire the same `startPipeline()` with the same dependencies. The only difference is event source (webhook HTTP vs file) and result delivery (HTTP response vs action outputs).

- **Separate normalizer for Actions context**: While the normalization logic is similar to `github-normalizer.ts`, the Actions payload structure differs slightly from webhook payloads (no `x-github-event` header, different payload wrapping). A dedicated `action-normalizer.ts` handles these differences.

- **Node.js 22 (not Bun)**: GitHub Actions container actions require a standard Node.js runtime. Bun compatibility is not guaranteed on all runner architectures.

### Dockerfile Design

```dockerfile
FROM node:22-slim

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy built application
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/

ENTRYPOINT ["node", "dist/entrypoints/github-action.js"]
```

### action.yml Design

```yaml
name: 'Orch-Agents'
description: 'AI-powered code review and task automation'
inputs:
  anthropic_api_key:
    description: 'Anthropic API key (or use auth_provider for cloud providers)'
    required: false
  auth_provider:
    description: 'Auth provider: direct, bedrock, vertex, foundry'
    required: false
    default: 'direct'
  model:
    description: 'Claude model override'
    required: false
  max_agents:
    description: 'Maximum concurrent agents'
    required: false
    default: '4'
  template:
    description: 'Workflow template'
    required: false
    default: 'review-pr'
  log_level:
    description: 'Log level'
    required: false
    default: 'info'
outputs:
  execution_log:
    description: 'Execution log summary'
  structured_output:
    description: 'JSON structured output from pipeline'
  branch_name:
    description: 'Branch name created (if applicable)'
  review_verdict:
    description: 'Review verdict: pass, fail, conditional, skipped, error'
runs:
  using: 'docker'
  image: 'Dockerfile'
  env:
    ANTHROPIC_API_KEY: ${{ inputs.anthropic_api_key }}
    AUTH_PROVIDER: ${{ inputs.auth_provider }}
    CLAUDE_MODEL_OVERRIDE: ${{ inputs.model }}
    MAX_AGENTS: ${{ inputs.max_agents }}
    TEMPLATE: ${{ inputs.template }}
    LOG_LEVEL: ${{ inputs.log_level }}
```

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude CLI not installable in container | HIGH | Test Dockerfile build in CI; pin CLI version |
| Container image too large (>500MB) | MEDIUM | Use node:22-slim base; multi-stage build |
| GITHUB_TOKEN insufficient permissions | MEDIUM | Document required permissions; detect and warn |
| Action timeout for long-running pipelines | LOW | Document recommended timeout settings |
| Fork PR token restrictions | MEDIUM | Detect fork PRs; skip write operations, post read-only summary |

---

## R -- Refinement (TDD Implementation Order)

### Step 1: action-outputs.ts + tests (0 dependencies)

Tests:
- `setOutput('key', 'value')` appends to `GITHUB_OUTPUT` file with delimiter format
- `setOutput('key', 'multi\nline')` handles multi-line values correctly
- `setFailed('msg')` writes `::error::msg` to stderr
- When `GITHUB_OUTPUT` not set, falls back to legacy format

### Step 2: action-normalizer.ts + tests (depends on types.ts only)

Tests:
- `pull_request` with `action: 'opened'` produces IntakeEvent with `intent: 'review-pr'`
- `pull_request` with `action: 'synchronize'` produces `intent: 'review-pr'`
- `pull_request` with `action: 'closed'` produces `intent: 'post-merge'`
- `pull_request_review` produces `intent: 'process-review'`
- `issues` produces `intent: 'triage-issue'` with labels
- `push` to `refs/heads/main` produces `intent: 'validate-main'`
- `push` to non-main branch produces `intent: 'validate-branch'`
- Unknown event type returns null
- Missing required payload fields throw descriptive error
- Payload with missing `repository.full_name` throws

### Step 3: github-action.ts entry point + integration tests

Tests (mock filesystem, mock EventBus, mock pipeline):
- Reads `GITHUB_EVENT_PATH` and parses JSON payload
- Constructs IntakeEvent from payload via action-normalizer
- Publishes `IntakeCompleted` event to EventBus
- Sets action outputs from pipeline result
- Posts PR comment when prNumber present
- Exits with code 1 when verdict is 'fail'
- Exits with code 0 when verdict is 'pass'
- Handles missing `GITHUB_EVENT_PATH` with clear error
- Handles invalid JSON in event file with clear error

### Step 4: Dockerfile + build verification

Tests:
- `docker build .` succeeds
- Container starts and `claude --version` succeeds
- Container starts and `node dist/entrypoints/github-action.js` with mock env runs
- Image size is under 500MB

### Step 5: action.yml validation

Tests:
- YAML is valid
- All required fields present
- Input defaults are sensible
- `runs.using` is 'docker'

### Step 6: End-to-end integration test (mock GitHub context)

Tests:
- Simulate a `pull_request` event with mock event file
- Pipeline runs through triage, planning, execution (stub mode)
- Action outputs are set correctly
- PR comment would be posted (mock GitHubClient)

### Quality Gates

- All existing tests pass (zero regressions)
- Dockerfile builds successfully in CI
- `npm run build` succeeds
- `npm test` passes
- Container image under 500MB

---

## C -- Completion

### Verification Checklist

- [ ] `action.yml` defines all inputs and outputs
- [ ] `Dockerfile` builds and installs Claude CLI
- [ ] `github-action.ts` reads Actions context correctly
- [ ] `action-normalizer.ts` handles all supported event types
- [ ] Pipeline runs identically in action mode vs server mode
- [ ] Action outputs set correctly (execution_log, structured_output, review_verdict, branch_name)
- [ ] PR comments posted via GITHUB_TOKEN
- [ ] Fork PR detection and graceful handling
- [ ] Self-hosted mode (`npm start`) unaffected
- [ ] Container image under 500MB
- [ ] Example workflow YAML documented

### Deployment Steps

1. Merge to main after all tests pass.
2. Tag a release (`v1`) for the action to be usable as `uses: org/orch-agents@v1`.
3. Publish container image to GitHub Container Registry (GHCR) for faster action startup.
4. Document usage in README with example workflow:
   ```yaml
   - uses: org/orch-agents@v1
     with:
       anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
     env:
       GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```
5. For self-hosted mode, no changes needed -- `npm start` works as before.

### Rollback Plan

- Remove the release tag (`v1`) to prevent new workflow runs from using the action.
- Existing self-hosted deployments are unaffected (different entry point).
- If Dockerfile issues arise, users can switch to self-hosted mode while the container is fixed.
- No database or state migration involved; rollback is tag + code revert.

---

## Files Affected

| File | Change Type |
|------|-------------|
| `action.yml` | NEW |
| `Dockerfile` | NEW |
| `src/entrypoints/github-action.ts` | NEW |
| `src/entrypoints/action-normalizer.ts` | NEW |
| `src/entrypoints/action-outputs.ts` | NEW |
| `package.json` | MODIFIED (add action build script) |
| `tsconfig.json` | MODIFIED (include entrypoints) |
| `tests/entrypoints/github-action.test.ts` | NEW |
| `tests/entrypoints/action-normalizer.test.ts` | NEW |
| `tests/entrypoints/action-outputs.test.ts` | NEW |
