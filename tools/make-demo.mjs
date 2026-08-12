#!/usr/bin/env node
// make-demo.mjs — generate public/demo/session.json, the BUNDLED SYNTHETIC DEMO.
//
// WHY THIS EXISTS -------------------------------------------------------------
// A fresh clone of C-Space has no data: parsed sessions live in an out-of-repo
// store (tools/cspace-paths.mjs) and the project allowlist is per-machine and
// gitignored. Without something to play, `npm run dev` lands a first-time
// visitor on "BOOT FAILURE // NO SESSIONS". And a real session can never be
// committed (or screenshotted for the README): transcripts carry project names,
// absolute paths with a username, and dialogue.
//
// So the repo ships a session that is entirely INVENTED. Every path, prompt,
// preview, tool label, agent name and number below was written by hand or drawn
// from a fixed table in this file. Nothing is copied, sampled or derived from
// any real transcript, and no real filesystem is read — this script only writes.
// Publishing a screenshot of the demo leaks nothing, because there is nothing
// in it.
//
// SHAPE ----------------------------------------------------------------------
// The output is the COMMON VIZ SHAPE, byte-for-byte compatible with what
// tools/parse-session.mjs and every adapter in tools/adapters/ emit:
//   { meta:{ sessionId, cwd, model, version, startedAt, durationS, userTurns,
//            assistantTurns, thinkingBlocks, hookEvents, toolCalls, peakContext },
//     tools:{ name:{count,errors,chars} }, contextCurve[], subagents[],
//     compactions[], events[] }
// Event kinds are exactly the parser's vocabulary: user, say, thinking,
// tool_call, tool_result, spawn, despawn, hook, compaction, queued.
// The aggregates (tools/meta) are DERIVED from the generated events with the
// same accounting rules the parser uses, so the demo can never disagree with
// itself the way a hand-written fixture would.
//
// DETERMINISTIC --------------------------------------------------------------
// Seeded mulberry32, no Date.now(), no Math.random(), fixed start timestamp.
// Re-running writes an identical file, so the committed artifact has a stable
// diff and regenerating it is never a surprise in review.
//
// A NOTE ON THE DEMO cwd: it is Windows-shaped ("C:\Users\dev\demo-project")
// because hud.js's projectLabel() strips a "<drive>-Users-<user>-" prefix to
// derive the identity block's project name. A posix "/Users/dev/demo-project"
// renders as "USERS-DEV-DEMO-PROJ…"; this one renders "DEMO-PROJECT". The user
// is "dev" and the project is "demo-project" — both obviously placeholders.
//
// Usage:  npm run demo            → public/demo/session.json
//         node tools/make-demo.mjs <out.json>

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = process.argv[2] ?? join(ROOT, 'public', 'demo', 'session.json');

// ---------------------------------------------------------------------------
// seeded PRNG — mulberry32. Fixed seed: the committed file must be reproducible.
// ---------------------------------------------------------------------------
const SEED = 0x0c5face1;
let _s = SEED >>> 0;
function rnd() {
  _s = (_s + 0x6d2b79f5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const R = (a, b) => a + rnd() * (b - a);
const I = (a, b) => Math.floor(R(a, b + 1));
const P = (p) => rnd() < p;
const K = (arr) => arr[Math.floor(rnd() * arr.length)];
// weighted pick over [[value, weight], ...]
const W = (pairs) => {
  let tot = 0;
  for (const p of pairs) tot += p[1];
  let r = rnd() * tot;
  for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
  return pairs[pairs.length - 1][0];
};

// clean() mirrors the parser's preview normalization so previews look native.
const clean = (s, n = 96) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

let _idn = 0;
const newId = () => `toolu_demo${String(++_idn).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// INVENTED CONTENT TABLES — a fictional TypeScript app called "demo-project"
// with an order queue, a checkout page and a dispatch worker. None of this
// exists; that is the point.
// ---------------------------------------------------------------------------
const FILES = [
  'src/app/server.ts', 'src/app/router.ts', 'src/app/handlers/checkout.ts',
  'src/app/handlers/orders.ts', 'src/lib/queue.ts', 'src/lib/retry.ts',
  'src/lib/cache.ts', 'src/lib/telemetry.ts', 'src/workers/dispatch.ts',
  'src/components/Cart.tsx', 'src/components/OrderTotals.tsx',
  'db/migrations/0007_order_totals.sql', 'tests/queue.test.ts',
  'tests/checkout.test.ts', 'tests/dispatch.test.ts', 'docs/architecture.md',
  'docs/runbook.md', 'package.json', 'vite.config.ts', 'tsconfig.json',
];
const WRITE_FILES = [
  'src/lib/retry.ts', 'tests/dispatch.test.ts', 'docs/architecture.md',
  'db/migrations/0007_order_totals.sql', 'src/lib/telemetry.ts', 'docs/runbook.md',
];
const BASH = [
  'npm test -- tests/queue.test.ts', 'npm test', 'npm run build', 'npm run lint',
  'npx tsc --noEmit', 'git status --short', 'git diff --stat', 'git log --oneline -12',
  'node scripts/seed-orders.mjs --count 200', 'npm run test:e2e -- --reporter=line',
  'docker compose up -d postgres', 'wc -l src/workers/dispatch.ts',
  'npm run preview -- --port 4173', 'git add -A && git commit -m "queue: retry budget"',
];
const PWSH = ['Get-Content .\\logs\\dispatch.log -Tail 40', 'Get-Process node | Select-Object Id,CPU'];
const GREP = [
  'createHandler\\(', 'retry(Budget|Count)', 'TODO\\(queue\\)', 'export function \\w+Worker',
  "from ['\"]\\./cache['\"]", 'await enqueue\\(', 'process\\.env\\.[A-Z_]+',
];
const GLOB = ['src/**/*.ts', 'tests/**/*.test.ts', 'src/components/**/*.tsx', 'db/migrations/*.sql', 'docs/**/*.md'];
const URLS = [
  'https://docs.example.com/api/v2/webhooks', 'https://docs.example.com/queue/backpressure',
  'https://example.com/blog/idempotent-consumers', 'https://registry.example.com/package/queue-lite',
];
const SEARCHES = [
  'node stream backpressure patterns', 'postgres advisory lock retry strategy',
  'idempotency key design for order webhooks', 'vitest fake timers with async queues',
  'exponential backoff jitter formula',
];
const PAGES = ['http://localhost:4173/checkout', 'http://localhost:4173/cart', 'http://localhost:4173/admin/orders'];
const SKILLS = ['code-review', 'test-writer', 'perf-audit', 'migration-check'];
const TASK_TITLES = [
  'Add a retry budget to the dispatch worker', 'Backfill order totals in migration 0007',
  'Trim the checkout bundle below 200KB', 'Document the worker lifecycle',
  'Replace direct queue writes with the helper',
];
const QUERIES = [
  "select count(*) from orders where status = 'pending'",
  'select id, total_cents from orders order by created_at desc limit 20',
  'select status, count(*) from jobs group by status',
];
const DOC_SEARCHES = ['queue retry semantics', 'order totals schema', 'dispatch worker lifecycle'];
const TOOL_QUERIES = ['browser automation', 'select:Read,Edit,Grep'];

const USER_PROMPTS = [
  'Take a look at how the dispatch worker handles retries — a poisoned job seems to spin forever.',
  'The checkout page hangs whenever the queue backs up. Find out why.',
  'Add a retry budget so a single bad job cannot starve the worker.',
  'Run the tests and fix whatever breaks.',
  'Split the checkout handler up, it is doing far too much in one function.',
  'Write the migration for the new order totals column, with a rollback.',
  'Once the preview build is up, click through the checkout flow in the browser.',
  'Summarize what changed today and update the architecture doc.',
  'Why is the cart rendering before the totals resolve?',
  'Grep for anywhere we still write to the queue directly instead of via the helper.',
  'Make the telemetry fields consistent — some are camelCase, some snake_case.',
  'Can you get the e2e suite green without loosening the assertions?',
  'Spin up a couple of agents to audit the retry paths in parallel.',
  'That last edit broke the type check. Have a look.',
  'Keep going.',
  'Before you commit, read the runbook and make sure the steps still match.',
];
const SAY_PREVIEWS = [
  'Refactored the request handler into two smaller functions.',
  'The hang comes from an unbounded await inside the dispatch loop.',
  'Tests pass — 42 files, 187 assertions, no failures.',
  'Added a retry budget of five attempts with exponential backoff and jitter.',
  'Wrote the migration and a matching rollback for the order totals column.',
  'The browser run shows the cart rendering before totals resolve.',
  'Updated the architecture doc with the new worker lifecycle.',
  'Found three call sites that still bypass the queue helper.',
  'Type check is clean again — the generic on enqueue() needed widening.',
  'The retry path swallowed the error; it now records it before rethrowing.',
  'Reproduced the hang with a 200-job seed and a stalled consumer.',
  'Two of the telemetry fields were camelCase; they are snake_case now.',
  'Committed as "queue: retry budget" — nothing else in the tree changed.',
  'Reading the runbook first so the steps I add match the existing shape.',
  'That failure is a fake-timer issue in the test, not a bug in the worker.',
  'Dispatch now drains in bounded batches, so backpressure reaches the caller.',
  'The migration needs an advisory lock or the backfill races the writer.',
  'Bundle is at 188KB after dropping the eager admin import.',
];
const AGENT_LABELS = [
  'Audit every retry path in the dispatch worker', 'Write tests for the dispatch loop',
  'Review migration 0007 for lock contention', 'Trace the checkout hang end to end',
  'Find direct queue writes outside the helper', 'Summarize the telemetry field names',
  'Check the e2e suite for flaky waits', 'Map the order status state machine',
  'Look for unbounded awaits in src/workers', 'Compare cache TTLs across modules',
  'Read the runbook and list stale steps', 'Inventory every env var the app reads',
];
const AGENT_TYPES = ['general', 'explore', 'code-reviewer', 'test-writer'];
const AGENT_SAYS = [
  'Three retry paths; only one records the attempt count.',
  'The loop awaits per job with no batch bound — that is the stall.',
  'Two direct queue writes remain, both in the admin handler.',
  'The e2e suite waits on a fixed 500ms timeout in four places.',
  'Statuses are pending, claimed, done, dead — nothing sets dead.',
  'Cache TTLs disagree: 30s in cache.ts, 300s in orders.ts.',
];
const HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

// ---------------------------------------------------------------------------
// tool roster — every one of the eight families in src/lib/palette.js is
// represented (shell, search, mutate, agents, web, browser, meta, other).
// Weights shift across five session phases so the arc reads like real work:
// orient → plan → build → verify → wrap.
// ---------------------------------------------------------------------------
const PHASES = [
  ['orient', 0.12, [['Read', 26], ['Grep', 12], ['Glob', 7], ['Bash', 6], ['WebSearch', 3],
    ['ToolSearch', 2], ['Task', 5], ['Skill', 1], ['mcp__demo_docs__search', 3]]],
  ['plan', 0.26, [['Read', 18], ['Grep', 9], ['Task', 9], ['TaskCreate', 5], ['WebFetch', 3],
    ['Bash', 5], ['Edit', 6], ['mcp__demo_docs__search', 2]]],
  ['build', 0.58, [['Edit', 26], ['Read', 16], ['Bash', 14], ['Write', 7], ['Grep', 6],
    ['Task', 6], ['PowerShell', 2], ['NotebookEdit', 1], ['mcp__demo_db__run_query', 3]]],
  ['verify', 0.82, [['Bash', 22], ['Read', 12], ['Edit', 12], ['Grep', 6], ['Task', 6],
    ['mcp__playwright__browser_navigate', 5], ['mcp__playwright__browser_snapshot', 5],
    ['mcp__playwright__browser_click', 3], ['Skill', 2], ['WebFetch', 2]]],
  ['wrap', 2, [['Bash', 16], ['Edit', 8], ['Read', 8], ['Write', 6], ['TaskUpdate', 5],
    ['Skill', 2], ['Grep', 3], ['Task', 3], ['mcp__demo_db__run_query', 2]]],
];
const phaseFor = (p) => PHASES.find((ph) => p < ph[1]) ?? PHASES[PHASES.length - 1];

// the label the parser would have derived from the tool's input. Re-rolls when a
// tool would draw the same label twice in a row — a batch of three identical
// Globs reads as a generator artifact, and this is the ticker's opening line.
const _lastLabel = new Map();
function labelFor(tool) {
  let v = _rawLabel(tool);
  for (let i = 0; v && v === _lastLabel.get(tool) && i < 3; i++) v = _rawLabel(tool);
  _lastLabel.set(tool, v);
  return v;
}
function _rawLabel(tool) {
  switch (tool) {
    case 'Bash': return K(BASH);
    case 'PowerShell': return K(PWSH);
    case 'Read': case 'Edit': return K(FILES);
    case 'Write': case 'NotebookEdit': return K(WRITE_FILES);
    case 'Grep': return K(GREP);
    case 'Glob': return K(GLOB);
    case 'ToolSearch': return K(TOOL_QUERIES);
    case 'WebFetch': return K(URLS);
    case 'WebSearch': return K(SEARCHES);
    case 'Skill': return K(SKILLS);
    case 'TaskCreate': case 'TaskUpdate': return K(TASK_TITLES);
    case 'mcp__demo_db__run_query': return K(QUERIES);
    case 'mcp__demo_docs__search': return K(DOC_SEARCHES);
    default:
      if (tool.startsWith('mcp__playwright__')) return K(PAGES);
      return '';
  }
}

// result size + failure rate per tool, hand-tuned to look like real output
function resultShape(tool) {
  if (tool === 'Read') return [700, 16000, 0.03];
  if (tool === 'Grep') return [120, 6500, 0.02];
  if (tool === 'Glob') return [90, 1400, 0.02];
  if (tool === 'Bash') return [40, 9000, 0.09];
  if (tool === 'PowerShell') return [60, 4000, 0.08];
  if (tool === 'Edit') return [80, 420, 0.06];
  if (tool === 'Write') return [50, 220, 0.02];
  if (tool === 'NotebookEdit') return [80, 300, 0.03];
  if (tool === 'WebFetch') return [1400, 22000, 0.05];
  if (tool === 'WebSearch') return [900, 6500, 0.03];
  if (tool === 'ToolSearch') return [700, 4200, 0.01];
  if (tool === 'Skill') return [400, 6000, 0.01];
  if (tool === 'TaskCreate' || tool === 'TaskUpdate') return [50, 220, 0.01];
  if (tool.startsWith('mcp__playwright__')) return [350, 9000, 0.05];
  if (tool.startsWith('mcp__demo_')) return [180, 4200, 0.03];
  return [200, 3000, 0.03];
}

// how long a call takes, in seconds
function durFor(tool) {
  if (tool === 'Bash') return P(0.3) ? R(8, 95) : R(0.6, 9);
  if (tool === 'PowerShell') return R(0.5, 6);
  if (tool === 'WebFetch') return R(1.5, 14);
  if (tool === 'WebSearch') return R(3, 18);
  if (tool.startsWith('mcp__playwright__')) return R(0.8, 12);
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return R(0.3, 4);
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return R(0.4, 3.5);
  if (tool === 'Skill') return R(1, 9);
  return R(0.4, 6);
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------
const TARGET_EVENTS = 1700;      // total incl. sidechain; the loop stops near this
const AGENT_TARGET = 30;         // spawn/despawn spans
const CTX_CAP = 1_000_000;       // matches CONTEXT_TOKEN_CAP in src/lib/palette.js
// Each compaction fires when the running context crosses the next threshold;
// the curve then collapses to a fresh prefix and climbs again — the sawtooth
// the context stack renders. Peaks rise monotonically and the last one sits just
// over 910k against the 1M window, which is where a long real session lives.
// Growth (see assistantMessage) is tuned so all five are crossed with a short
// final climb left over, instead of the tail running away at the cap.
const CTX_THRESHOLDS = [645_000, 775_000, 850_000, 892_000, 914_000];

const main = [];    // main-thread events
const side = [];    // sidechain (subagent) events
const contextCurve = [];
const subagents = [];
const compactions = [];

let t = 0;
let ctx = 26_400;                // system prompt + tool definitions at t0
let compIdx = 0;
let lastResultChars = 0;
let spawned = 0;
let userTurns = 0, assistantTurns = 0, thinkingBlocks = 0, hookEvents = 0;

const push = (e) => { main.push(e); return e; };
const total = () => main.length + side.length;

const hook = (name, errP = 0.03) => {
  hookEvents++;
  push({ t, kind: 'hook', name, err: P(errP) });
};

// SessionStart hook, exactly where a real log has it
hook('SessionStart', 0);

// One subagent: the Task call on the main thread, the spawn marker, an invented
// sidechain flow, and the tool_result/despawn pair that closes the span.
function spawnAgent() {
  const id = newId();
  const label = clean(K(AGENT_LABELS), 60);
  const type = K(AGENT_TYPES);
  const spawnT = t;
  const span = R(70, 900);
  const endT = spawnT + span;

  main.push({ t: spawnT, kind: 'tool_call', tool: 'Task', id, label, side: false });
  main.push({ t: spawnT, kind: 'spawn', id, label });
  subagents.push({ id, label, type, spawnT, endT });
  spawned++;

  // the agent's own transcript — sidechain, so it never touches contextCurve
  const n = I(5, 26);
  let st = spawnT + R(1, 4);
  const step = Math.max(0.6, (span - 6) / n);
  const openCalls = [];
  for (let i = 0; i < n; i++) {
    st += R(step * 0.4, step * 1.6);
    if (st > endT - 1.5) break;
    if (openCalls.length && P(0.55)) {
      const c = openCalls.shift();
      const [lo, hi, ep] = resultShape(c.tool);
      side.push({ t: st, kind: 'tool_result', tool: c.tool, id: c.id, chars: I(lo, hi),
        err: P(ep), dur: st - c.t, side: true });
      continue;
    }
    const roll = rnd();
    if (roll < 0.22) {
      thinkingBlocks++;
      side.push({ t: st, kind: 'thinking', chars: I(320, 5200), side: true });
    } else if (roll < 0.34) {
      side.push({ t: st, kind: 'say', chars: I(180, 2400), preview: clean(K(AGENT_SAYS)), side: true });
    } else {
      const tool = W(phaseFor(total() / TARGET_EVENTS)[2].filter((p) => p[0] !== 'Task'));
      const cid = newId();
      side.push({ t: st, kind: 'tool_call', tool, id: cid, label: clean(labelFor(tool), 80), side: true });
      openCalls.push({ tool, id: cid, t: st });
    }
  }
  // close anything the agent left open, just before it returns
  for (const c of openCalls) {
    const [lo, hi, ep] = resultShape(c.tool);
    const rt = Math.min(endT - 0.4, c.t + durFor(c.tool));
    side.push({ t: rt, kind: 'tool_result', tool: c.tool, id: c.id, chars: I(lo, hi),
      err: P(ep), dur: Math.max(0.1, rt - c.t), side: true });
  }

  const [lo, hi] = [900, 11_000];
  main.push({ t: endT, kind: 'tool_result', tool: 'Task', id, chars: I(lo, hi),
    err: false, dur: span, side: false });
  main.push({ t: endT, kind: 'despawn', id });
}

// One assistant message: an optional thinking block, an optional text block, and
// zero or more tool calls with their results. Emits the message's context point.
function assistantMessage(phase) {
  // --- context accounting (the sawtooth) ---
  // ~12.7k tokens per assistant message on average, which is what it takes to
  // cross all four thresholds in a session this long — a couple of big Reads and
  // a test run will do that on their own.
  const growth = 5500 + rnd() * 12_500 + Math.min(9000, lastResultChars / 3.2);
  if (compIdx < CTX_THRESHOLDS.length && ctx + growth >= CTX_THRESHOLDS[compIdx]) {
    // COMPACTION: the window collapses to a summary and starts refilling.
    compactions.push({ t });
    push({ t, kind: 'compaction' });
    compIdx++;
    t += R(6, 22);
    ctx = I(68_000, 96_000);
    const cw = Math.round(ctx * R(0.82, 0.92));
    const fr = Math.round((ctx - cw) * R(0.3, 0.6));
    contextCurve.push({ t, ctx, cacheRead: ctx - cw - fr, cacheWrite: cw, fresh: fr, out: I(240, 1800) });
  } else {
    ctx = Math.min(CTX_CAP - 4000, Math.round(ctx + growth));
    const cw = Math.round(growth * R(0.55, 0.8));
    const fr = Math.round(growth * R(0.06, 0.2)) + I(40, 700);
    contextCurve.push({ t, ctx, cacheRead: ctx - cw - fr, cacheWrite: cw, fresh: fr, out: I(180, 2600) });
  }

  if (P(0.34)) {
    thinkingBlocks++;
    push({ t, kind: 'thinking', chars: I(380, 7400), side: false });
    t += R(0.4, 3.5);
  }
  if (P(0.5)) {
    assistantTurns++;
    push({ t, kind: 'say', chars: I(140, 2600), preview: clean(K(SAY_PREVIEWS)), side: false });
    t += R(0.5, 4);
  }

  // tool calls: usually one, sometimes a small parallel batch
  const nCalls = W([[0, 12], [1, 46], [2, 24], [3, 12], [4, 6]]);
  const open = [];
  for (let i = 0; i < nCalls; i++) {
    const tool = W(phase[2]);
    if (tool === 'Task') {
      if (spawned < AGENT_TARGET && total() / TARGET_EVENTS < 0.9) spawnAgent();
      t += R(0.6, 3);
      continue;
    }
    const id = newId();
    const label = clean(labelFor(tool), 80);
    if (P(0.05)) hook('PreToolUse');
    push({ t, kind: 'tool_call', tool, id, label, side: false });
    open.push({ tool, id, t });
    t += R(0.3, 1.6);
  }
  for (const c of open) {
    t = Math.max(t, c.t + durFor(c.tool));
    const [lo, hi, ep] = resultShape(c.tool);
    const chars = I(lo, hi);
    lastResultChars = chars;
    push({ t, kind: 'tool_result', tool: c.tool, id: c.id, chars, err: P(ep),
      dur: t - c.t, side: false });
    if (P(0.05)) hook('PostToolUse');
    t += R(0.4, 2.6);
  }
}

// --- turn loop --------------------------------------------------------------
let turn = 0;
while (total() < TARGET_EVENTS) {
  turn++;
  // the human thinks / reads / walks away
  t += turn === 1 ? R(2, 9) : (P(0.14) ? R(240, 1500) : R(18, 210));
  const prompt = K(USER_PROMPTS);
  userTurns++;
  push({ t, kind: 'user', chars: I(60, 900), preview: clean(prompt) });
  if (P(0.05)) { t += R(1, 6); push({ t, kind: 'queued', preview: clean(K(USER_PROMPTS)) }); }
  if (P(0.35)) hook('UserPromptSubmit');
  t += R(0.6, 3.2);

  const msgs = I(2, 9);
  for (let i = 0; i < msgs && total() < TARGET_EVENTS; i++) {
    assistantMessage(phaseFor(total() / TARGET_EVENTS));
    t += R(0.8, 5);
  }
  if (P(0.3)) hook('Stop');
}

// --- close out --------------------------------------------------------------
// Nothing may live past the last main-thread event: the parser clamps dangling
// subagents to the session duration, so do the same rather than emit a span
// that ends after the timeline does.
let tEnd = 0;
for (const e of main) tEnd = Math.max(tEnd, e.t);
for (const e of side) tEnd = Math.max(tEnd, e.t);
const durS = tEnd;
for (const s of subagents) if (s.endT > durS) s.endT = durS;

const events = [...main, ...side]
  .map((e, i) => ({ e, i }))
  .sort((a, b) => (a.e.t - b.e.t) || (a.i - b.i))
  .map(({ e }) => e);

// --- aggregates, by the parser's own accounting rules -----------------------
const tools = {};
for (const e of events) {
  if (e.kind === 'tool_call') {
    const st = (tools[e.tool] ??= { count: 0, errors: 0, chars: 0 });
    st.count++;
  } else if (e.kind === 'tool_result') {
    const st = tools[e.tool];
    if (st) { st.chars += e.chars; if (e.err) st.errors++; }
  }
}
const toolsSorted = Object.fromEntries(
  Object.entries(tools).sort((a, b) => b[1].count - a[1].count));

const result = {
  meta: {
    sessionId: 'demo0000-11ee-4a5b-9c3d-0f1e2d3c4b5a',
    cwd: 'C:\\Users\\dev\\demo-project',
    model: 'claude-opus-4-5-20251101',
    version: '2.0.28',
    startedAt: '2026-03-04T14:07:19.000Z',   // fixed: determinism
    durationS: Math.round(durS),
    userTurns, assistantTurns, thinkingBlocks, hookEvents,
    toolCalls: Object.values(tools).reduce((a, s) => a + s.count, 0),
    peakContext: contextCurve.reduce((a, c) => Math.max(a, c.ctx), 0),
    synthetic: true,   // this session is fabricated — see the header of this file
  },
  tools: toolsSorted,
  contextCurve,
  subagents,
  compactions,
  events,
};

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(result);
writeFileSync(OUT, json);

const kb = (json.length / 1024).toFixed(0);
console.log(`wrote ${OUT} (${kb} KB) — ${events.length} events, ${result.meta.toolCalls} tool calls, ` +
  `${subagents.length} subagents, ${compactions.length} compactions, ` +
  `${Math.round(durS / 60)} min session, peak ctx ${result.meta.peakContext}`);
console.log('tools:', Object.entries(toolsSorted).map(([n, s]) => `${n}:${s.count}`).join(' '));
