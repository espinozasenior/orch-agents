/**
 * GraphQL query and mutation constants for the Linear API.
 *
 * Extracted from linear-client.ts to keep files under 500 lines.
 */

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { id name type }
  labels { nodes { id name } }
  assignee { id name }
  delegate { id name }
  creator { id name }
  team { id key name }
  project { id name }
`;

// ---------------------------------------------------------------------------
// Issue queries
// ---------------------------------------------------------------------------

export const FETCH_ISSUE_QUERY = `
  query FetchIssue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }
`;

export const FETCH_ACTIVE_ISSUES_QUERY = `
  query FetchActiveIssues($teamId: String!) {
    team(id: $teamId) {
      issues(filter: { state: { type: { nin: ["completed", "canceled"] } } }, first: 100) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

export const FETCH_TEAM_STATES_QUERY = `
  query FetchTeamStates($teamId: String!) {
    team(id: $teamId) {
      states {
        nodes {
          id
          name
          type
          position
        }
      }
    }
  }
`;

export const FETCH_ISSUES_BY_STATES_QUERY = `
  query FetchIssuesByStates($teamId: String!, $stateNames: [String!]!) {
    team(id: $teamId) {
      issues(
        filter: { state: { name: { in: $stateNames } } },
        first: 100
      ) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

export const FETCH_ISSUE_STATES_BY_IDS_QUERY = `
  query FetchIssueStatesByIds($issueIds: [ID!]!) {
    issues(filter: { id: { in: $issueIds } }) {
      nodes {
        id
        state { name }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Comment mutations/queries
// ---------------------------------------------------------------------------

export const FETCH_COMMENTS_QUERY = `
  query FetchComments($issueId: String!) {
    issue(id: $issueId) {
      comments { nodes { id body createdAt updatedAt user { id name } } }
    }
  }
`;

export const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

export const REPLY_TO_COMMENT_MUTATION = `
  mutation ReplyToComment($issueId: String!, $body: String!, $parentId: String!) {
    commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) {
      success
      comment { id }
    }
  }
`;

export const UPDATE_COMMENT_MUTATION = `
  mutation UpdateComment($commentId: String!, $body: String!) {
    commentUpdate(id: $commentId, input: { body: $body }) {
      success
    }
  }
`;

export const UPDATE_ISSUE_STATE_MUTATION = `
  mutation UpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`;

// ---------------------------------------------------------------------------
// Agent Activity API mutations/queries (Phase 7B)
// ---------------------------------------------------------------------------

export const AGENT_ACTIVITY_CREATE_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) { success agentActivity { id } }
  }
`;

export const AGENT_SESSION_UPDATE_MUTATION = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) { success }
  }
`;

export const AGENT_SESSION_CREATE_ON_ISSUE_MUTATION = `
  mutation AgentSessionCreateOnIssue($issueId: String!) {
    agentSessionCreateOnIssue(issueId: $issueId) { success agentSession { id } }
  }
`;

export const AGENT_SESSION_CREATE_ON_COMMENT_MUTATION = `
  mutation AgentSessionCreateOnComment($commentId: String!) {
    agentSessionCreateOnComment(commentId: $commentId) { success agentSession { id } }
  }
`;

export const FETCH_SESSION_ACTIVITIES_QUERY = `
  query FetchSessionActivities($sessionId: String!, $after: String) {
    agentSession(id: $sessionId) {
      activities(after: $after) {
        nodes {
          content {
            ... on AgentActivityThoughtContent { body }
            ... on AgentActivityActionContent { action parameter result }
            ... on AgentActivityResponseContent { body }
            ... on AgentActivityErrorContent { body }
            ... on AgentActivityPromptContent { body }
            ... on AgentActivityElicitationContent { body }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const ISSUE_REPOSITORY_SUGGESTIONS_QUERY = `
  query IssueRepositorySuggestions($issueId: String!, $agentSessionId: String!, $candidates: [RepositoryCandidateInput!]!) {
    issueRepositorySuggestions(issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidates) {
      suggestions { repositoryFullName hostname confidence }
    }
  }
`;

// ---------------------------------------------------------------------------
// Issue Update mutation (Phase 7H — delegate + state management)
// ---------------------------------------------------------------------------

export const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

// ---------------------------------------------------------------------------
// Viewer query (Phase 7H — fetch agent's app user ID)
// ---------------------------------------------------------------------------

export const FETCH_VIEWER_QUERY = `
  query FetchViewer {
    viewer { id organization { id name } }
  }
`;
