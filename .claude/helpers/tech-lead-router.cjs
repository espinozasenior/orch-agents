#!/usr/bin/env node
/**
 * Tech Lead Router — Decision engine for agent team composition
 *
 * Analyzes task descriptions and returns optimal agent team configuration
 * including topology, strategy, agent roles, and model tiers.
 *
 * Usage:
 *   node tech-lead-router.cjs "Build a REST API with authentication"
 *   node tech-lead-router.cjs --json "Fix the login bug"
 */

'use strict';

// ── Domain Classifiers ──────────────────────────────────────────────────────

const DOMAIN_PATTERNS = {
  backend:   /\b(api|endpoint|server|backend|database|db|sql|rest|graphql|grpc|auth|jwt|oauth|middleware|migration)\b/i,
  frontend:  /\b(ui|frontend|component|react|vue|angular|css|style|layout|responsive|dom|browser|page)\b/i,
  fullstack: /\b(fullstack|full.?stack|end.?to.?end|e2e)\b/i,
  infra:     /\b(deploy|docker|k8s|kubernetes|ci|cd|pipeline|infrastructure|terraform|aws|gcp|azure|nginx|helm)\b/i,
  security:  /\b(security|vulnerab|cve|audit|penetration|xss|injection|csrf|auth.?z|rbac|encrypt|secret|credential|sql.?inject|exploit|attack|threat|compliance)\b/i,
  data:      /\b(data|etl|pipeline|analytics|ml|model|train|dataset|schema|migration|seed)\b/i,
  research:  /\b(research|explore|understand|investigate|find|search|document|learn|study|analyze|compare)\b/i,
  testing:   /\b(tests?|spec|coverage|unit.?tests?|integration.?tests?|e2e.?tests?|jest|mocha|vitest|playwright)\b/i,
  docs:      /\b(document|readme|changelog|wiki|guide|tutorial|explain|describe|architecture|adr|runbook|diagram)\b|\/docs?\//i,
  performance: /\b(performance|optimize|benchmark|profil|latency|throughput|cache|memory.?leak|slow|bottleneck)\b/i,
  release:   /\b(release|publish|version|deploy|tag|changelog|npm.?publish|ship)\b/i,
};

const COMPLEXITY_SIGNALS = {
  high: [
    /\b(architect\w*|redesign|refactor.*(entire|whole|major)|migrate|rewrite|distributed|microservice)\b/i,
    /\b(specification|design.?doc|rfc|adr|cross.?cutting|breaking.?change)\b/i,
    /\b(complex|sophisticated|advanced|enterprise|production.?ready|scalab)\b/i,
    /\bmulti.?(repo|service|module|package|team)\b/i,
    /\b(coordinat\w*|orchestrat\w*|end.?to.?end.?design)\b/i,
    /\b(sparc(?!-review|-\w+\.md|-\w+\.cjs)|methodology)\b/i,
    /\b(event.?sourc\w*|bounded.?context)\b/i,
    /\b(domain.?driven|ddd|cqrs)\b/i,
    /\b(system.?design|architecture.?doc\w*|decompos\w*|governance|end.?to.?end)\b/i,
  ],
  medium: [
    /\b(feature|implement\w*|create|build|develop|add|integrate|connect|hook|extend)\b/i,
    /\b(refactor\w*|improve|enhance|update|upgrade|convert)\b/i,
    /\b(test|coverage|spec|validation)\b/i,
    /\b(auth|jwt|oauth|rbac|role|permission|session|token)\b/i,
    /\b(crud|rest|graphql|websocket|queue|cache|search)\b/i,
    /\b(upload|download|file|image|avatar|media|storage)\b/i,
    /\b(page|screen|view|form|dashboard|panel|modal|wizard)\b/i,
    /\b(webhook|notification|notify|workflow|swarm|agent|triage|intake)\b/i,
  ],
  low: [
    /\b(fix|bug|patch|typo|rename|move|delete|remove|clean)\b/i,
    /\b(tweak|adjust|config|env|setting|toggle|flag)\b/i,
    /\b(lint|format|style|indent|whitespace)\b/i,
    /\b(comment|revert|bump|hotfix|sort|reorder|label)\b/i,
  ],
};

const SCOPE_SIGNALS = {
  'cross-repo':   /\b(cross.?repo|multi.?repo|monorepo|workspace|organization|different.?repo|repos)\b/i,
  'multi-service': /\b(micro.?service|multi.?service|distributed|cross.?cutting|several.?files|synchronize|across)\b/i,
  'multi-file':   /\b(multiple.?files|several|across|throughout|module|package)\b/i,
  'single-file':  /\b(single.?file|one.?file|this.?file|just|only|simple|quick)\b/i,
};

const RISK_SIGNALS = {
  high: /\b(production|live|customer|payment|auth|secret|credential|database.?migration|breaking|destructive|vulnerab|injection|exploit|xss|csrf|audit|pii|gdpr|hipaa|compliance|hotfix|data.?loss|downtime)\b/i,
  medium: /\b(shared|team|integration|api.?change|schema.?change|dependency|breaking.?change|deprecat|public.?api|third.?party|vendor)\b/i,
  low: /\b(local|test|draft|prototype|experiment|poc|internal|dev)\b/i,
};

// ── Team Templates ──────────────────────────────────────────────────────────

const TEAM_TEMPLATES = {
  'quick-fix': {
    name: 'Quick Fix',
    topology: 'mesh',
    strategy: 'balanced',
    maxAgents: 2,
    consensus: 'gossip',
    agents: [
      { role: 'implementer', type: 'coder', tier: 2, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: false },
    ],
  },
  'research-sprint': {
    name: 'Research Sprint',
    topology: 'mesh',
    strategy: 'balanced',
    maxAgents: 3,
    consensus: 'gossip',
    agents: [
      { role: 'lead-researcher', type: 'researcher', tier: 3, required: true },
      { role: 'analyst', type: 'analyst', tier: 2, required: false },
    ],
  },
  'feature-build': {
    name: 'Feature Build',
    topology: 'hierarchical',
    strategy: 'specialized',
    maxAgents: 5,
    consensus: 'raft',
    agents: [
      { role: 'lead', type: 'architect', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    ],
  },
  'sparc-full-cycle': {
    name: 'SPARC Full Cycle',
    topology: 'hierarchical',
    strategy: 'specialized',
    maxAgents: 8,
    consensus: 'raft',
    agents: [
      { role: 'orchestrator', type: 'sparc-coord', tier: 3, required: true },
      { role: 'spec-writer', type: 'specification', tier: 3, required: true },
      { role: 'pseudocoder', type: 'pseudocode', tier: 3, required: true },
      { role: 'architect', type: 'architecture', tier: 3, required: true },
      { role: 'implementer', type: 'sparc-coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    ],
  },
  'testing-sprint': {
    name: 'Testing Sprint',
    topology: 'hierarchical',
    strategy: 'specialized',
    maxAgents: 4,
    consensus: 'raft',
    agents: [
      { role: 'lead', type: 'tester', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    ],
  },
  'security-audit': {
    name: 'Security Audit',
    topology: 'hierarchical',
    strategy: 'specialized',
    maxAgents: 5,
    consensus: 'raft',
    agents: [
      { role: 'lead', type: 'security-architect', tier: 3, required: true },
      { role: 'auditor', type: 'security-auditor', tier: 3, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: false },
    ],
  },
  'performance-sprint': {
    name: 'Performance Sprint',
    topology: 'hierarchical',
    strategy: 'specialized',
    maxAgents: 4,
    consensus: 'raft',
    agents: [
      { role: 'lead', type: 'performance-engineer', tier: 3, required: true },
      { role: 'analyzer', type: 'perf-analyzer', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: false },
    ],
  },
  'release-pipeline': {
    name: 'Release Pipeline',
    topology: 'hierarchical-mesh',
    strategy: 'specialized',
    maxAgents: 6,
    consensus: 'raft',
    agents: [
      { role: 'lead', type: 'release-manager', tier: 3, required: true },
      { role: 'pr-handler', type: 'pr-manager', tier: 2, required: true },
      { role: 'reviewer', type: 'code-review-swarm', tier: 2, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'deployer', type: 'cicd-engineer', tier: 2, required: false },
    ],
  },
  'fullstack-swarm': {
    name: 'Full Stack Swarm',
    topology: 'hierarchical-mesh',
    strategy: 'specialized',
    maxAgents: 8,
    consensus: 'raft',
    agents: [
      { role: 'lead', type: 'hierarchical-coordinator', tier: 3, required: true },
      { role: 'architect', type: 'system-architect', tier: 3, required: true },
      { role: 'backend', type: 'backend-dev', tier: 3, required: true },
      { role: 'frontend', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: true },
      { role: 'security', type: 'security-auditor', tier: 2, required: false },
    ],
  },
};

// ── Ambiguity Detection ─────────────────────────────────────────────────────

const VAGUE_PATTERNS = [
  /\b(it|this|that|the thing|the stuff|things?|stuff|everything)\b/i,
  /\b(make .* better|improve .* somehow|do something|handle .* properly)\b/i,
  /\b(fix .* up|clean .* up|sort .* out|deal with)\b/i,
  /\b(whatever|idk|not sure|maybe|probably|i guess|kinda|some)\b/i,
];

const CLARIFICATION_GENERATORS = {
  domain: (task) => ({
    dimension: 'domain',
    question: 'Which area of the system does this involve?',
    options: ['Backend/API', 'Frontend/UI', 'Infrastructure/DevOps', 'Security', 'Performance', 'Data/ML'],
    default: 'Backend/API',
  }),
  scope: (task) => ({
    dimension: 'scope',
    question: 'How large is the expected change?',
    options: ['Single file fix', 'Multiple files in one module', 'Multiple services/packages', 'Cross-repository'],
    default: 'Multiple files in one module',
  }),
  complexity: (task) => ({
    dimension: 'complexity',
    question: 'How would you describe the complexity?',
    options: ['Quick fix or tweak', 'Standard feature or enhancement', 'Major refactor or new system'],
    default: 'Standard feature or enhancement',
  }),
  urgency: (task) => ({
    dimension: 'urgency',
    question: 'How urgent is this?',
    options: ['Exploration / no deadline', 'Standard priority', 'Hotfix / production issue'],
    default: 'Standard priority',
  }),
};

function detectAmbiguity(task) {
  let score = 0;
  const triggers = [];

  // Signal 1: Domain match count (weight 30)
  let domainMatchCount = 0;
  for (const pattern of Object.values(DOMAIN_PATTERNS)) {
    if (pattern.test(task)) domainMatchCount++;
  }
  if (domainMatchCount === 0) {
    score += 30;
    triggers.push('domain');
  } else if (domainMatchCount === 1) {
    score += 15;
  }

  // Signal 2: Complexity confidence (weight 25)
  const complexity = classifyComplexity(task);
  if (complexity.percentage < 20) {
    score += 25;
    triggers.push('complexity');
  } else if (complexity.percentage < 30) {
    score += 15;
    triggers.push('complexity');
  }

  // Signal 3: Vague language (weight 25, capped)
  let vagueHits = 0;
  for (const pattern of VAGUE_PATTERNS) {
    const matches = task.match(new RegExp(pattern, 'gi'));
    if (matches) vagueHits += matches.length;
  }
  score += Math.min(25, vagueHits * 8);
  if (vagueHits > 0 && !triggers.includes('domain')) {
    triggers.push('scope');
  }

  // Signal 4: Brevity (weight 20)
  const wordCount = task.trim().split(/\s+/).length;
  if (wordCount < 3) {
    score += 20;
    triggers.push('urgency');
  } else if (wordCount < 5) {
    score += 15;
    triggers.push('urgency');
  } else if (wordCount < 8) {
    score += 10;
  }

  score = Math.min(100, score);

  // Generate questions based on triggers (max 3)
  const questionDimensions = triggers.length > 0 ? triggers : ['domain', 'complexity', 'scope'];
  const questions = questionDimensions
    .filter((dim, i, arr) => arr.indexOf(dim) === i) // deduplicate
    .slice(0, 3)
    .map(dim => CLARIFICATION_GENERATORS[dim](task));

  let level, needsClarification, recommended;
  if (score >= 50) {
    level = 'high';
    needsClarification = true;
    recommended = true;
  } else if (score >= 30) {
    level = 'moderate';
    needsClarification = false;
    recommended = true;
  } else {
    level = 'low';
    needsClarification = false;
    recommended = false;
  }

  return {
    score,
    level,
    needsClarification,
    recommended,
    questions,
    signals: {
      domainMatchCount,
      complexityScore: complexity.percentage,
      vagueHits,
      wordCount,
    },
  };
}

// ── Tier 2 AI Classification (Haiku) ────────────────────────────────────────

/**
 * Generates a structured prompt for Haiku to semantically classify a task
 * when regex scores in the moderate band (30-49). Returns a prompt object
 * that can be sent via hooks_model-route or used by Claude directly.
 *
 * Cost: ~$0.0002 per call (~150 input tokens, ~80 output tokens)
 * Latency: ~500ms
 */
function buildAIClassificationPrompt(task, regexResult) {
  const domains = Object.keys(DOMAIN_PATTERNS).join(', ');
  const scopes = Object.keys(SCOPE_SIGNALS).join(', ');

  return {
    model: 'claude-haiku-4-5-20251001',
    system: 'You are a task classifier for a software engineering agent orchestrator. Respond ONLY with valid JSON, no markdown.',
    prompt: [
      `Classify this software task into structured dimensions.`,
      ``,
      `Task: "${task}"`,
      ``,
      `Regex pre-classification (low confidence):`,
      `  domain: ${regexResult.classification.domain}`,
      `  complexity: ${regexResult.classification.complexity.level} (${regexResult.classification.complexity.percentage}%)`,
      `  scope: ${regexResult.classification.scope}`,
      `  risk: ${regexResult.classification.risk}`,
      ``,
      `Respond with JSON:`,
      `{`,
      `  "domain": one of [${domains}],`,
      `  "complexity": "low" | "medium" | "high",`,
      `  "complexityPct": 5-95,`,
      `  "scope": one of [${scopes}],`,
      `  "risk": "low" | "medium" | "high",`,
      `  "intent": brief 1-sentence summary of what the user likely wants,`,
      `  "confidence": 0.0-1.0,`,
      `  "needsClarification": true if still unclear even with context`,
      `}`,
    ].join('\n'),
    maxTokens: 150,
    temperature: 0,
  };
}

/**
 * Parses Haiku's JSON response and merges it with the regex classification.
 * AI classification overrides regex when AI confidence > 0.6.
 */
function mergeAIClassification(regexDecision, aiResponse) {
  let parsed;
  try {
    // Handle potential markdown wrapping
    const cleaned = aiResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // AI response unparseable — fall back to regex
    return { ...regexDecision, aiUsed: false, aiError: 'parse_failed' };
  }

  if (!parsed.confidence || parsed.confidence < 0.6) {
    // AI not confident enough — keep regex result but attach AI metadata
    return {
      ...regexDecision,
      aiUsed: true,
      aiConfidence: parsed.confidence || 0,
      aiIntent: parsed.intent || null,
      aiAgreed: false,
    };
  }

  // AI confident — override classification
  const overridden = {
    domain: parsed.domain || regexDecision.classification.domain,
    complexity: {
      level: parsed.complexity || regexDecision.classification.complexity.level,
      percentage: parsed.complexityPct || regexDecision.classification.complexity.percentage,
    },
    scope: parsed.scope || regexDecision.classification.scope,
    risk: parsed.risk || regexDecision.classification.risk,
  };

  // Re-run template selection with AI-enhanced classification
  const templateKey = selectTemplate(overridden);
  const template = TEAM_TEMPLATES[templateKey];

  const agents = template.agents.filter(a => {
    if (a.required) return true;
    return overridden.complexity.level !== 'low';
  });

  const adjustedAgents = agents.map(a => ({
    ...a,
    tier: overridden.complexity.level === 'low' ? Math.min(a.tier, 2) : a.tier,
  }));

  // Update ambiguity based on AI judgment
  const updatedAmbiguity = { ...regexDecision.ambiguity };
  if (parsed.needsClarification === false && updatedAmbiguity.level === 'moderate') {
    updatedAmbiguity.level = 'low';
    updatedAmbiguity.needsClarification = false;
    updatedAmbiguity.recommended = false;
  } else if (parsed.needsClarification === true) {
    updatedAmbiguity.level = 'high';
    updatedAmbiguity.needsClarification = true;
    updatedAmbiguity.recommended = true;
  }

  return {
    ambiguity: updatedAmbiguity,
    classification: overridden,
    template: templateKey,
    templateName: template.name,
    swarm: {
      topology: template.topology,
      strategy: template.strategy,
      maxAgents: adjustedAgents.length,
      consensus: template.consensus,
    },
    agents: adjustedAgents,
    commands: {
      init: `npx @claude-flow/cli@latest swarm init --topology ${template.topology} --max-agents ${adjustedAgents.length} --strategy ${template.strategy}`,
      spawn: adjustedAgents.map(a =>
        `npx @claude-flow/cli@latest agent spawn -t ${a.type} --name "${a.role}"`
      ),
    },
    aiUsed: true,
    aiConfidence: parsed.confidence,
    aiIntent: parsed.intent || null,
    aiAgreed: true,
  };
}

// ── Classification Engine ───────────────────────────────────────────────────

function classifyDomain(task) {
  // Priority domains that override general matches
  const PRIORITY_DOMAINS = ['security', 'performance', 'release', 'testing', 'research'];

  const matches = [];
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    const m = task.match(new RegExp(pattern, 'gi'));
    if (m) matches.push({ domain, matchCount: m.length, priority: PRIORITY_DOMAINS.includes(domain) });
  }

  // Priority domains win ties
  matches.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return b.matchCount - a.matchCount;
  });

  return matches.length > 0 ? matches[0].domain : 'backend';
}

function classifyComplexity(task) {
  let score = 0;
  let highHits = 0, medHits = 0, lowHits = 0;
  for (const pattern of COMPLEXITY_SIGNALS.high) {
    if (pattern.test(task)) { score += 30; highHits++; }
  }
  for (const pattern of COMPLEXITY_SIGNALS.medium) {
    if (pattern.test(task)) { score += 15; medHits++; }
  }
  for (const pattern of COMPLEXITY_SIGNALS.low) {
    if (pattern.test(task)) { score -= 10; lowHits++; }
  }

  // A single high signal is a strong indicator — boost toward high threshold
  if (highHits >= 1) score += 30;
  // High + medium co-occurrence compounds (e.g., "implement event sourcing")
  if (highHits >= 1 && medHits >= 1) score += 10;

  // Multiple medium signals compound (e.g., "build API with auth and tests")
  if (medHits >= 2) score += 10 * (medHits - 1);

  // Multiple domain keywords indicate cross-cutting complexity
  let domainCount = 0;
  for (const pattern of Object.values(DOMAIN_PATTERNS)) {
    if (pattern.test(task)) domainCount++;
  }
  if (domainCount >= 2) score += 15;

  // Word count as complexity proxy
  const words = task.split(/\s+/).length;
  if (words > 50) score += 15;
  else if (words > 20) score += 5;

  score = Math.max(5, Math.min(95, score));

  if (score >= 60) return { level: 'high', percentage: score };
  if (score >= 30) return { level: 'medium', percentage: score };
  return { level: 'low', percentage: score };
}

function classifyScope(task) {
  for (const [scope, pattern] of Object.entries(SCOPE_SIGNALS)) {
    if (pattern.test(task)) return scope;
  }
  return 'multi-file';
}

function classifyRisk(task) {
  if (RISK_SIGNALS.high.test(task)) return 'high';
  if (RISK_SIGNALS.medium.test(task)) return 'medium';
  return 'low';
}

// ── Template Selection ──────────────────────────────────────────────────────

function selectTemplate(classification) {
  const { domain, complexity, scope, risk } = classification;

  // Direct domain matches
  if (domain === 'testing') return 'testing-sprint';
  if (domain === 'research' || domain === 'docs') {
    if (complexity.level === 'high' && scope === 'multi-service') return 'sparc-full-cycle';
    if (complexity.level === 'high') return 'research-sprint';
    if (complexity.level === 'low') return 'quick-fix';
    return 'research-sprint';
  }
  if (domain === 'security') return 'security-audit';
  if (domain === 'performance') return 'performance-sprint';
  if (domain === 'release') return 'release-pipeline';

  // Scope overrides — cross-repo always needs full swarm
  if (scope === 'cross-repo') return 'fullstack-swarm';
  if (scope === 'multi-service') return complexity.level === 'low' ? 'feature-build' : 'fullstack-swarm';

  // Complexity-driven selection
  if (complexity.level === 'low') return 'quick-fix';

  if (complexity.level === 'high') {
    if (scope === 'multi-service' || domain === 'fullstack') return 'fullstack-swarm';
    if (complexity.percentage >= 70) return 'sparc-full-cycle';
    return 'feature-build';
  }

  // Medium complexity
  if (risk === 'high') return 'sparc-full-cycle';
  return 'feature-build';
}

// ── Main Decision Function ──────────────────────────────────────────────────

function makeDecision(task) {
  const classification = {
    domain: classifyDomain(task),
    complexity: classifyComplexity(task),
    scope: classifyScope(task),
    risk: classifyRisk(task),
  };

  const ambiguity = detectAmbiguity(task);

  // Escalation: high ambiguity + low complexity = likely misclassification
  // But only if there are no explicit low-complexity keyword hits (fix, typo, etc.)
  const hasExplicitLowSignals = COMPLEXITY_SIGNALS.low.some(p => p.test(task));
  if (ambiguity.level === 'high' && classification.complexity.level === 'low' && !hasExplicitLowSignals) {
    classification.complexity = { level: 'medium', percentage: 35 };
  }

  // Explicit SPARC keyword override — always ensure high at >=65%
  // But only when SPARC is used as a methodology intent, not as part of a file path
  const sparcAsMethodology = /\b(sparc(?!-review|-\w+\.md|-\w+\.cjs))\b/i.test(task);
  if (sparcAsMethodology) {
    if (classification.complexity.level !== 'high' || classification.complexity.percentage < 65) {
      classification.complexity = { level: 'high', percentage: Math.max(65, classification.complexity.percentage) };
    }
  }

  const templateKey = selectTemplate(classification);
  const template = TEAM_TEMPLATES[templateKey];

  // Filter agents: include required + optional based on complexity
  const agents = template.agents.filter(a => {
    if (a.required) return true;
    return classification.complexity.level !== 'low';
  });

  // Adjust tiers based on complexity
  const adjustedAgents = agents.map(a => ({
    ...a,
    tier: classification.complexity.level === 'low' ? Math.min(a.tier, 2) : a.tier,
  }));

  const result = {
    ambiguity,
    classification,
    template: templateKey,
    templateName: template.name,
    swarm: {
      topology: template.topology,
      strategy: template.strategy,
      maxAgents: adjustedAgents.length,
      consensus: template.consensus,
    },
    agents: adjustedAgents,
    commands: {
      init: `npx @claude-flow/cli@latest swarm init --topology ${template.topology} --max-agents ${adjustedAgents.length} --strategy ${template.strategy}`,
      spawn: adjustedAgents.map(a =>
        `npx @claude-flow/cli@latest agent spawn -t ${a.type} --name "${a.role}"`
      ),
    },
  };

  // Attach AI classification prompt for moderate ambiguity (30-49)
  // The caller (Claude/hooks) can optionally send this to Haiku for refinement
  if (ambiguity.level === 'moderate') {
    result.aiClassification = {
      available: true,
      tier: 2,
      estimatedLatency: '~500ms',
      estimatedCost: '$0.0002',
      prompt: buildAIClassificationPrompt(task, result),
    };
  }

  return result;
}

// ── CLI Interface ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const task = args.filter(a => a !== '--json').join(' ');

  if (!task) {
    console.log('Tech Lead Router — Agent team composition engine');
    console.log('');
    console.log('Usage:');
    console.log('  node tech-lead-router.cjs "task description"');
    console.log('  node tech-lead-router.cjs --json "task description"');
    console.log('');
    console.log('Templates:', Object.keys(TEAM_TEMPLATES).join(', '));
    process.exit(0);
  }

  const decision = makeDecision(task);

  if (jsonFlag) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    if (decision.ambiguity.needsClarification) {
      console.log('## CLARIFICATION NEEDED\n');
      console.log(`Ambiguity score: ${decision.ambiguity.score}/100 (${decision.ambiguity.level})`);
      console.log('The request is too vague to route confidently. Suggested questions:\n');
      for (const q of decision.ambiguity.questions) {
        console.log(`  [${q.dimension}] ${q.question}`);
        console.log(`    Options: ${q.options.join(' | ')}`);
        console.log(`    Default: ${q.default}`);
        console.log('');
      }
      console.log('---\n');
      console.log('Proceeding with best-effort classification below:\n');
    } else if (decision.ambiguity.recommended) {
      console.log(`> Note: Ambiguity score ${decision.ambiguity.score}/100 (${decision.ambiguity.level}) — clarification recommended but not required.\n`);
    }

    console.log('## Tech Lead Decision\n');
    console.log('**Classification**');
    console.log(`- Domain: ${decision.classification.domain}`);
    console.log(`- Complexity: ${decision.classification.complexity.level} (${decision.classification.complexity.percentage}%)`);
    console.log(`- Risk: ${decision.classification.risk}`);
    console.log(`- Scope: ${decision.classification.scope}`);
    console.log('');
    console.log(`**Selected Template**: ${decision.templateName}`);
    console.log('');
    console.log('**Agent Team**');
    console.log('| Role | Agent Type | Tier | Required |');
    console.log('|------|-----------|------|----------|');
    for (const a of decision.agents) {
      console.log(`| ${a.role} | ${a.type} | ${a.tier} | ${a.required ? 'yes' : 'no'} |`);
    }
    console.log('');
    console.log('**Swarm Config**');
    console.log(`- Topology: ${decision.swarm.topology}`);
    console.log(`- Strategy: ${decision.swarm.strategy}`);
    console.log(`- Max Agents: ${decision.swarm.maxAgents}`);
    console.log(`- Consensus: ${decision.swarm.consensus}`);
    console.log('');
    console.log('**Commands**');
    console.log(`Init: ${decision.commands.init}`);
    for (const cmd of decision.commands.spawn) {
      console.log(`Spawn: ${cmd}`);
    }
  }
}

module.exports = {
  makeDecision,
  classifyDomain,
  classifyComplexity,
  classifyRisk,
  selectTemplate,
  detectAmbiguity,
  buildAIClassificationPrompt,
  mergeAIClassification,
  TEAM_TEMPLATES,
};
