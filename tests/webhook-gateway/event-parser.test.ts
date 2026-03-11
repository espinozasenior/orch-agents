import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubEvent } from '../../src/webhook-gateway/event-parser';

describe('parseGitHubEvent', () => {
  const baseRepo = {
    full_name: 'acme/webapp',
    default_branch: 'main',
  };
  const baseSender = {
    login: 'octocat',
    id: 12345,
    type: 'User',
  };

  describe('push events', () => {
    it('should parse push to default branch', () => {
      const payload = {
        ref: 'refs/heads/main',
        repository: baseRepo,
        sender: baseSender,
        commits: [
          { added: ['new-file.ts'], modified: ['existing.ts'], removed: [] },
        ],
      };

      const result = parseGitHubEvent('push', 'del-001', payload);

      assert.equal(result.eventType, 'push');
      assert.equal(result.action, null);
      assert.equal(result.deliveryId, 'del-001');
      assert.equal(result.repoFullName, 'acme/webapp');
      assert.equal(result.defaultBranch, 'main');
      assert.equal(result.branch, 'main');
      assert.equal(result.sender, 'octocat');
      assert.equal(result.senderId, 12345);
      assert.equal(result.senderIsBot, false);
      assert.deepEqual(result.files, ['new-file.ts', 'existing.ts']);
    });

    it('should parse push to feature branch', () => {
      const payload = {
        ref: 'refs/heads/feature/login',
        repository: baseRepo,
        sender: baseSender,
        commits: [],
      };

      const result = parseGitHubEvent('push', 'del-002', payload);
      assert.equal(result.branch, 'feature/login');
    });

    it('should deduplicate files across commits', () => {
      const payload = {
        ref: 'refs/heads/main',
        repository: baseRepo,
        sender: baseSender,
        commits: [
          { added: ['a.ts'], modified: ['b.ts'], removed: [] },
          { added: [], modified: ['b.ts'], removed: ['c.ts'] },
        ],
      };

      const result = parseGitHubEvent('push', 'del-003', payload);
      assert.deepEqual(result.files, ['a.ts', 'b.ts', 'c.ts']);
    });
  });

  describe('pull_request events', () => {
    it('should parse pull_request opened', () => {
      const payload = {
        action: 'opened',
        repository: baseRepo,
        sender: baseSender,
        pull_request: {
          number: 42,
          merged: false,
          labels: [{ name: 'feature' }, { name: 'needs-review' }],
          head: { ref: 'feature/auth' },
        },
      };

      const result = parseGitHubEvent('pull_request', 'del-010', payload);

      assert.equal(result.eventType, 'pull_request');
      assert.equal(result.action, 'opened');
      assert.equal(result.prNumber, 42);
      assert.equal(result.branch, 'feature/auth');
      assert.equal(result.merged, false);
      assert.deepEqual(result.labels, ['feature', 'needs-review']);
    });

    it('should parse pull_request closed with merge', () => {
      const payload = {
        action: 'closed',
        repository: baseRepo,
        sender: baseSender,
        pull_request: {
          number: 43,
          merged: true,
          labels: [],
          head: { ref: 'hotfix/login' },
        },
      };

      const result = parseGitHubEvent('pull_request', 'del-011', payload);
      assert.equal(result.merged, true);
    });
  });

  describe('issues events', () => {
    it('should parse issues labeled with bug', () => {
      const payload = {
        action: 'labeled',
        repository: baseRepo,
        sender: baseSender,
        issue: {
          number: 99,
          labels: [{ name: 'bug' }, { name: 'P1' }],
        },
      };

      const result = parseGitHubEvent('issues', 'del-020', payload);

      assert.equal(result.eventType, 'issues');
      assert.equal(result.action, 'labeled');
      assert.equal(result.issueNumber, 99);
      assert.deepEqual(result.labels, ['bug', 'P1']);
    });

    it('should parse issues opened', () => {
      const payload = {
        action: 'opened',
        repository: baseRepo,
        sender: baseSender,
        issue: { number: 100, labels: [] },
      };

      const result = parseGitHubEvent('issues', 'del-021', payload);
      assert.equal(result.action, 'opened');
      assert.equal(result.issueNumber, 100);
    });
  });

  describe('issue_comment events', () => {
    it('should parse issue_comment created', () => {
      const payload = {
        action: 'created',
        repository: baseRepo,
        sender: baseSender,
        issue: { number: 50 },
        comment: { body: '@bot please review this' },
      };

      const result = parseGitHubEvent('issue_comment', 'del-030', payload);

      assert.equal(result.eventType, 'issue_comment');
      assert.equal(result.action, 'created');
      assert.equal(result.issueNumber, 50);
      assert.equal(result.commentBody, '@bot please review this');
    });
  });

  describe('pull_request_review events', () => {
    it('should parse review submitted with changes_requested', () => {
      const payload = {
        action: 'submitted',
        repository: baseRepo,
        sender: baseSender,
        pull_request: { number: 55 },
        review: { state: 'changes_requested' },
      };

      const result = parseGitHubEvent('pull_request_review', 'del-040', payload);

      assert.equal(result.eventType, 'pull_request_review');
      assert.equal(result.prNumber, 55);
      assert.equal(result.reviewState, 'changes_requested');
    });
  });

  describe('workflow_run events', () => {
    it('should parse workflow_run completed with failure', () => {
      const payload = {
        action: 'completed',
        repository: baseRepo,
        sender: baseSender,
        workflow_run: {
          conclusion: 'failure',
          head_branch: 'feature/ci-fix',
        },
      };

      const result = parseGitHubEvent('workflow_run', 'del-050', payload);

      assert.equal(result.eventType, 'workflow_run');
      assert.equal(result.conclusion, 'failure');
      assert.equal(result.branch, 'feature/ci-fix');
    });
  });

  describe('release events', () => {
    it('should parse release published', () => {
      const payload = {
        action: 'published',
        repository: baseRepo,
        sender: baseSender,
        release: { tag_name: 'v1.2.0' },
      };

      const result = parseGitHubEvent('release', 'del-060', payload);

      assert.equal(result.eventType, 'release');
      assert.equal(result.action, 'published');
      assert.equal(result.branch, 'v1.2.0');
    });
  });

  describe('deployment_status events', () => {
    it('should parse deployment_status failure', () => {
      const payload = {
        repository: baseRepo,
        sender: baseSender,
        deployment_status: { state: 'failure' },
        deployment: { ref: 'main' },
      };

      const result = parseGitHubEvent('deployment_status', 'del-070', payload);

      assert.equal(result.eventType, 'deployment_status');
      assert.equal(result.conclusion, 'failure');
      assert.equal(result.branch, 'main');
    });
  });

  describe('unknown events', () => {
    it('should handle unknown event type gracefully', () => {
      const payload = {
        action: 'some_action',
        repository: baseRepo,
        sender: baseSender,
      };

      const result = parseGitHubEvent('star', 'del-999', payload);

      assert.equal(result.eventType, 'star');
      assert.equal(result.action, 'some_action');
      assert.equal(result.deliveryId, 'del-999');
      assert.equal(result.repoFullName, 'acme/webapp');
    });
  });

  describe('missing fields', () => {
    it('should use defaults for missing repository info', () => {
      const result = parseGitHubEvent('push', 'del-empty', {});

      assert.equal(result.repoFullName, 'unknown/unknown');
      assert.equal(result.defaultBranch, 'main');
      assert.equal(result.sender, 'unknown');
      assert.equal(result.senderId, 0);
    });
  });

  describe('bot detection', () => {
    it('should detect bot sender', () => {
      const payload = {
        repository: baseRepo,
        sender: { login: 'dependabot[bot]', id: 99999, type: 'Bot' },
      };

      const result = parseGitHubEvent('push', 'del-bot', payload);
      assert.equal(result.senderIsBot, true);
    });
  });
});
