#!/usr/bin/env node
/**
 * Claude Flow Hook Handler (Cross-Platform)
 * Dispatches hook events to the appropriate helper modules.
 *
 * Usage: node hook-handler.cjs <command> [args...]
 *
 * Commands:
 *   route          - Route a task to optimal agent (reads PROMPT from env/stdin)
 *   pre-bash       - Validate command safety before execution
 *   pre-edit       - Validate edit target before code modifications
 *   post-edit      - Record edit outcome for learning
 *   session-restore - Restore previous session state
 *   session-end    - End session and persist state
 */

const path = require('path');
const fs = require('fs');

const helpersDir = __dirname;

// Safe require with stdout suppression - the helper modules have CLI
// sections that run unconditionally on require(), so we mute console
// during the require to prevent noisy output.
function safeRequire(modulePath) {
  try {
    if (fs.existsSync(modulePath)) {
      const origLog = console.log;
      const origError = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        const mod = require(modulePath);
        return mod;
      } finally {
        console.log = origLog;
        console.error = origError;
      }
    }
  } catch (e) {
    // silently fail
  }
  return null;
}

const router = safeRequire(path.join(helpersDir, 'router.js'));
const techLead = safeRequire(path.join(helpersDir, 'tech-lead-router.cjs'));
const session = safeRequire(path.join(helpersDir, 'session.js'));
const memory = safeRequire(path.join(helpersDir, 'memory.js'));
const intelligence = safeRequire(path.join(helpersDir, 'intelligence.cjs'));

const WORKFLOW_MAP = {
  'quick-fix': 'development',
  'research-sprint': 'research',
  'feature-build': 'development',
  'sparc-full-cycle': 'sparc',
  'security-audit': 'security-audit',
  'performance-sprint': 'development',
  'release-pipeline': 'custom',
  'fullstack-swarm': 'development',
  'testing-sprint': 'testing',
};

// Get the command from argv
const [,, command, ...args] = process.argv;

// Read stdin with timeout — Claude Code sends hook data as JSON via stdin.
// Timeout prevents hanging when stdin is not properly closed (common on Windows).
async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    }, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

async function main() {
  let stdinData = '';
  try { stdinData = await readStdin(); } catch (e) { /* ignore stdin errors */ }

  let hookInput = {};
  if (stdinData.trim()) {
    try { hookInput = JSON.parse(stdinData); } catch (e) { /* ignore parse errors */ }
  }

  // Merge stdin data into prompt resolution: prefer stdin fields, then env, then argv
  const prompt = hookInput.prompt || hookInput.command || hookInput.toolInput
    || process.env.PROMPT || process.env.TOOL_INPUT_command || args.join(' ') || '';

const handlers = {
  'route': () => {
    const startMs = Date.now();

    // Primary: tech-lead-router (4-dimension classifier with team templates)
    if (techLead && techLead.makeDecision && prompt) {
      const decision = techLead.makeDecision(prompt);
      const latencyMs = Date.now() - startMs;
      const cls = decision.classification;
      const workflowTemplate = WORKFLOW_MAP[decision.template] || 'development';

      const output = [
        `[INFO] Routing task: ${prompt.substring(0, 80) || '(no prompt)'}`,
        '',
        'Routing Method',
        `  - Method: tech-lead-router (4-dimension heuristic)`,
        `  - Backend: regex + heuristic classification`,
        `  - Latency: ${latencyMs}ms`,
        '',
        'Classification',
        `  - Domain: ${cls.domain}`,
        `  - Complexity: ${cls.complexity.level} (${cls.complexity.percentage}%)`,
        `  - Scope: ${cls.scope}`,
        `  - Risk: ${cls.risk}`,
        '',
        `+------------------- Tech Lead Decision ------------------------+`,
        `| Template: ${decision.templateName.padEnd(50)}|`,
        `| Workflow: ${workflowTemplate.padEnd(50)}|`,
        `| Topology: ${decision.swarm.topology.padEnd(50)}|`,
        `| Consensus: ${decision.swarm.consensus.padEnd(49)}|`,
        `+--------------------------------------------------------------+`,
        '',
        'Agent Team',
        '+--------------------+--------------------+------+----------+',
        '| Role               | Agent Type         | Tier | Required |',
        '+--------------------+--------------------+------+----------+',
      ];

      for (const a of decision.agents) {
        output.push(
          `| ${a.role.padEnd(18)} | ${a.type.padEnd(18)} | ${String(a.tier).padEnd(4)} | ${(a.required ? 'yes' : 'no').padEnd(8)} |`
        );
      }
      output.push('+--------------------+--------------------+------+----------+');

      if (decision.ambiguity.needsClarification) {
        output.push('');
        output.push(`[WARN] Ambiguity: ${decision.ambiguity.score}/100 (${decision.ambiguity.level})`);
        for (const q of decision.ambiguity.questions) {
          output.push(`  [${q.dimension}] ${q.question}`);
        }
      } else if (decision.ambiguity.score >= 30) {
        output.push('');
        output.push(`[NOTE] Ambiguity: ${decision.ambiguity.score}/100 (${decision.ambiguity.level}) - clarification optional`);
      }

      output.push('');
      output.push(`Suggested: ruflo workflow run -t ${workflowTemplate} --task "..."`);

      console.log(output.join('\n'));
      return;
    }

    // Fallback: simple keyword router
    if (router && router.routeTask) {
      const result = router.routeTask(prompt);
      const latencyMs = Date.now() - startMs;
      const output = [
        `[INFO] Routing task: ${prompt.substring(0, 80) || '(no prompt)'}`,
        '',
        'Routing Method',
        `  - Method: keyword (fallback - tech-lead-router unavailable)`,
        `  - Latency: ${latencyMs}ms`,
        '',
        '+------------------- Fallback Routing --------------------------+',
        `| Agent: ${result.agent.padEnd(53)}|`,
        `| Confidence: ${(result.confidence * 100).toFixed(1)}%${' '.repeat(44)}|`,
        `| Reason: ${result.reason.substring(0, 53).padEnd(53)}|`,
        '+--------------------------------------------------------------+',
      ];
      console.log(output.join('\n'));
    } else {
      console.log('[INFO] No router available, using default routing');
    }
  },

  'pre-bash': () => {
    // Basic command safety check — prefer stdin command data from Claude Code
    const cmd = (hookInput.command || prompt).toLowerCase();
    const dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:'];
    for (const d of dangerous) {
      if (cmd.includes(d)) {
        console.error(`[BLOCKED] Dangerous command detected: ${d}`);
        process.exit(1);
      }
    }
    console.log('[OK] Command validated');
  },

  'pre-edit': () => {
    // Validate file path is not in protected locations
    const filePath = hookInput.file_path || (hookInput.toolInput && hookInput.toolInput.file_path)
      || process.env.TOOL_INPUT_file_path || args[0] || '';
    const protected_paths = ['.env', 'credentials', 'secrets', '.claude/settings.json'];
    for (const p of protected_paths) {
      if (filePath.includes(p)) {
        console.error(`[BLOCKED] Edit to protected file: ${p}`);
        process.exit(1);
      }
    }
    console.log('[OK] Edit validated');
  },

  'post-edit': () => {
    // Record edit for session metrics
    if (session && session.metric) {
      try { session.metric('edits'); } catch (e) { /* no active session */ }
    }
    // Record edit for intelligence consolidation — prefer stdin data from Claude Code
    if (intelligence && intelligence.recordEdit) {
      try {
        const file = hookInput.file_path || (hookInput.toolInput && hookInput.toolInput.file_path)
          || process.env.TOOL_INPUT_file_path || args[0] || '';
        intelligence.recordEdit(file);
      } catch (e) { /* non-fatal */ }
    }
    console.log('[OK] Edit recorded');
  },

  'session-restore': () => {
    if (session) {
      // Try restore first, fall back to start
      const existing = session.restore && session.restore();
      if (!existing) {
        session.start && session.start();
      }
    } else {
      // Minimal session restore output
      const sessionId = `session-${Date.now()}`;
      console.log(`[INFO] Restoring session: %SESSION_ID%`);
      console.log('');
      console.log(`[OK] Session restored from %SESSION_ID%`);
      console.log(`New session ID: ${sessionId}`);
      console.log('');
      console.log('Restored State');
      console.log('+----------------+-------+');
      console.log('| Item           | Count |');
      console.log('+----------------+-------+');
      console.log('| Tasks          |     0 |');
      console.log('| Agents         |     0 |');
      console.log('| Memory Entries |     0 |');
      console.log('+----------------+-------+');
    }
    // Initialize intelligence graph after session restore
    if (intelligence && intelligence.init) {
      try {
        const result = intelligence.init();
        if (result && result.nodes > 0) {
          console.log(`[INTELLIGENCE] Loaded ${result.nodes} patterns, ${result.edges} edges`);
        }
      } catch (e) { /* non-fatal */ }
    }
  },

  'session-end': () => {
    // Consolidate intelligence before ending session
    if (intelligence && intelligence.consolidate) {
      try {
        const result = intelligence.consolidate();
        if (result && result.entries > 0) {
          console.log(`[INTELLIGENCE] Consolidated: ${result.entries} entries, ${result.edges} edges${result.newEntries > 0 ? `, ${result.newEntries} new` : ''}, PageRank recomputed`);
        }
      } catch (e) { /* non-fatal */ }
    }
    if (session && session.end) {
      session.end();
    } else {
      console.log('[OK] Session ended');
    }
  },

  'pre-task': () => {
    if (session && session.metric) {
      try { session.metric('tasks'); } catch (e) { /* no active session */ }
    }
    if (techLead && techLead.makeDecision && prompt) {
      const decision = techLead.makeDecision(prompt);
      const cls = decision.classification;
      console.log(`[INFO] Task routed: ${decision.templateName} | ${cls.domain}/${cls.complexity.level} | agents: ${decision.agents.map(a => a.type).join(', ')}`);
    } else if (router && router.routeTask && prompt) {
      const result = router.routeTask(prompt);
      console.log(`[INFO] Task routed to: ${result.agent} (confidence: ${result.confidence})`);
    } else {
      console.log('[OK] Task started');
    }
  },

  'post-task': () => {
    // Implicit success feedback for intelligence
    if (intelligence && intelligence.feedback) {
      try {
        intelligence.feedback(true);
      } catch (e) { /* non-fatal */ }
    }
    console.log('[OK] Task completed');
  },

  'stats': () => {
    if (intelligence && intelligence.stats) {
      intelligence.stats(args.includes('--json'));
    } else {
      console.log('[WARN] Intelligence module not available. Run session-restore first.');
    }
  },
};

  // Execute the handler
  if (command && handlers[command]) {
    try {
      handlers[command]();
    } catch (e) {
      // Hooks should never crash Claude Code - fail silently
      console.log(`[WARN] Hook ${command} encountered an error: ${e.message}`);
    }
  } else if (command) {
    // Unknown command - pass through without error
    console.log(`[OK] Hook: ${command}`);
  } else {
    console.log('Usage: hook-handler.cjs <route|pre-bash|pre-edit|post-edit|session-restore|session-end|pre-task|post-task|stats>');
  }
}

// Hooks must ALWAYS exit 0 — Claude Code treats non-zero as "hook error"
// and skips all subsequent hooks for the event.
process.exitCode = 0;
main().catch((e) => {
  try { console.log(`[WARN] Hook handler error: ${e.message}`); } catch (_) {}
  process.exitCode = 0;
});
