/**
 * Parser for Linear's promptContext XML payload from AgentSessionEvent webhooks.
 *
 * Extracts issue metadata, comment threads, and guidance rules into a typed
 * structure. Uses regex-based parsing (no external XML library). Never throws;
 * returns partial data with parseErrors on malformed input.
 *
 * All extracted text is sanitized via the shared input-sanitizer.
 */

import { sanitize } from '../../shared/input-sanitizer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptContextIssue {
  identifier: string;
  title: string;
  description: string;
  team: string;
  labels: string[];
  parentIssue?: { identifier: string; title: string; description: string };
  project?: { name: string; description: string };
}

export interface PrimaryDirective {
  commentId: string;
  author: string;
  body: string;
  createdAt: string;
  mentionedUserId?: string;
}

export interface ThreadComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface OtherThread {
  commentId: string;
  comments: ThreadComment[];
}

export interface GuidanceRule {
  origin: 'workspace' | 'team' | 'parent-team';
  teamName?: string;
  content: string;
}

export interface PromptContext {
  issue: PromptContextIssue;
  primaryDirective: PrimaryDirective | null;
  otherThreads: OtherThread[];
  guidance: GuidanceRule[];
  parseErrors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_THREADS = 20;

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

export function defaultEmptyContext(): PromptContext {
  return {
    issue: {
      identifier: '',
      title: '',
      description: '',
      team: '',
      labels: [],
    },
    primaryDirective: null,
    otherThreads: [],
    guidance: [],
    parseErrors: [],
  };
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

function innerText(xml: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`);
  const match = xml.match(re);
  return match ? match[1].trim() : undefined;
}

function allMatches(xml: string, re: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml)) !== null) {
    results.push(m);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function parseIssueSection(xml: string, ctx: PromptContext): void {
  const issueMatch = xml.match(/<issue\s+[^>]*identifier="([^"]*)"[^>]*>([\s\S]*?)<\/issue>/);
  if (!issueMatch) return;

  const issueTag = issueMatch[0];
  const identifier = issueMatch[1];
  const issueBody = issueMatch[2];

  ctx.issue.identifier = sanitize(identifier);
  ctx.issue.title = sanitize(innerText(issueBody, 'title') ?? '');
  ctx.issue.description = sanitize(innerText(issueBody, 'description') ?? '');

  // Team attribute
  const teamMatch = issueBody.match(/<team\s+name="([^"]*)"/);
  if (teamMatch) {
    ctx.issue.team = sanitize(teamMatch[1]);
  }

  // Labels
  const labelMatches = allMatches(issueBody, /<label>([^<]*)<\/label>/g);
  ctx.issue.labels = labelMatches.map((m) => sanitize(m[1]));

  // Parent issue — must be parsed before we lose nested context
  // Extract parent-issue block first to avoid inner <title>/<description> collision
  const parentMatch = issueBody.match(
    /<parent-issue\s+[^>]*identifier="([^"]*)"[^>]*>([\s\S]*?)<\/parent-issue>/,
  );
  if (parentMatch) {
    const parentBody = parentMatch[2];
    ctx.issue.parentIssue = {
      identifier: sanitize(parentMatch[1]),
      title: sanitize(innerText(parentBody, 'title') ?? ''),
      description: sanitize(innerText(parentBody, 'description') ?? ''),
    };

    // Re-parse title/description from issue body WITHOUT the parent-issue block
    // to avoid picking up the parent's nested <title>/<description>.
    const issueBodyWithoutParent = issueBody.replace(
      /<parent-issue[\s\S]*?<\/parent-issue>/,
      '',
    );
    ctx.issue.title = sanitize(innerText(issueBodyWithoutParent, 'title') ?? '');
    ctx.issue.description = sanitize(innerText(issueBodyWithoutParent, 'description') ?? '');
  }

  // Project
  const projectMatch = issueTag.match(/<project\s+name="([^"]*)"[^>]*>([^<]*)<\/project>/);
  if (projectMatch) {
    ctx.issue.project = {
      name: sanitize(projectMatch[1]),
      description: sanitize(projectMatch[2]),
    };
  }
}

function parsePrimaryDirectiveSection(xml: string, ctx: PromptContext): void {
  const threadMatch = xml.match(
    /<primary-directive-thread\s+comment-id="([^"]*)"[^>]*>([\s\S]*?)<\/primary-directive-thread>/,
  );
  if (!threadMatch) return;

  const commentId = threadMatch[1];
  const threadBody = threadMatch[2];

  const commentMatch = threadBody.match(
    /<comment\s+author="([^"]*)"\s+created-at="([^"]*)"[^>]*>([\s\S]*?)<\/comment>/,
  );
  if (!commentMatch) return;

  const author = commentMatch[1];
  const createdAt = commentMatch[2];
  const commentBody = commentMatch[3];

  // Extract mentioned user if present
  const userMatch = commentBody.match(/<user\s+id="([^"]*)">[^<]*<\/user>/);
  const bodyWithoutUserTag = commentBody.replace(/<user\s+[^>]*>[^<]*<\/user>\s*/, '').trim();

  ctx.primaryDirective = {
    commentId: sanitize(commentId),
    author: sanitize(author),
    body: sanitize(bodyWithoutUserTag),
    createdAt: sanitize(createdAt),
    ...(userMatch ? { mentionedUserId: sanitize(userMatch[1]) } : {}),
  };
}

function parseOtherThreadsSection(xml: string, ctx: PromptContext): void {
  const threadMatches = allMatches(
    xml,
    /<other-thread\s+comment-id="([^"]*)"[^>]*>([\s\S]*?)<\/other-thread>/g,
  );

  const threads: OtherThread[] = [];
  for (const tm of threadMatches.slice(0, MAX_THREADS)) {
    const commentId = tm[1];
    const threadBody = tm[2];

    const commentMatches = allMatches(
      threadBody,
      /<comment\s+author="([^"]*)"\s+created-at="([^"]*)"[^>]*>([\s\S]*?)<\/comment>/g,
    );

    const comments: ThreadComment[] = commentMatches.map((cm) => ({
      author: sanitize(cm[1]),
      body: sanitize(cm[3].trim()),
      createdAt: sanitize(cm[2]),
    }));

    threads.push({
      commentId: sanitize(commentId),
      comments,
    });
  }

  ctx.otherThreads = threads;
}

function parseGuidanceSection(xml: string, ctx: PromptContext): void {
  const guidanceMatch = xml.match(/<guidance>([\s\S]*?)<\/guidance>/);
  if (!guidanceMatch) return;

  const guidanceBody = guidanceMatch[1];
  const ruleMatches = allMatches(
    guidanceBody,
    /<guidance-rule\s+origin="([^"]*)"(?:\s+team-name="([^"]*)")?[^>]*>([^<]*)<\/guidance-rule>/g,
  );

  ctx.guidance = ruleMatches.map((rm) => {
    const origin = rm[1] as GuidanceRule['origin'];
    const teamName = rm[2];
    const content = rm[3];
    return {
      origin,
      ...(teamName ? { teamName: sanitize(teamName) } : {}),
      content: sanitize(content),
    };
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function parsePromptContext(xml: string | null | undefined): PromptContext {
  if (xml == null || xml.trim() === '') {
    return defaultEmptyContext();
  }

  const ctx = defaultEmptyContext();

  try {
    parseIssueSection(xml, ctx);
  } catch (err) {
    ctx.parseErrors.push(`issue: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    parsePrimaryDirectiveSection(xml, ctx);
  } catch (err) {
    ctx.parseErrors.push(`primary-directive: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    parseOtherThreadsSection(xml, ctx);
  } catch (err) {
    ctx.parseErrors.push(`other-threads: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    parseGuidanceSection(xml, ctx);
  } catch (err) {
    ctx.parseErrors.push(`guidance: ${err instanceof Error ? err.message : String(err)}`);
  }

  return ctx;
}
