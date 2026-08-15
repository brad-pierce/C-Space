// palette.js — the single source of visual truth. Every module colors from here.
// Art direction: Gibson-grade cyberspace. Near-black void, cold cyan machine light,
// hot magenta for fresh data, amber for the machine speaking, violet for spawned minds.

export const PALETTE = {
  void: 0x05060a,
  fogColor: 0x070a12,

  gridLine: 0x0e3d4a,
  gridGlow: 0x19c6d1,

  coreShell: 0x0b1520,
  coreEnergy: 0x37e6ff,
  coreHot: 0xbffcff,

  cache: 0x19c6d1,     // cache-read tokens — cold, stable, archival cyan
  fresh: 0xff2d95,     // fresh input tokens — hot magenta
  output: 0xffb52e,    // model output — amber
  error: 0xff3b30,     // failures — signal red
  subagent: 0x9d5cff,  // spawned minds — violet
  hook: 0x3fffa8,      // hook events — mint

  hudText: 0xc8f7ff,
  hudDim: 0x3a5a66,
};

export const CSS = Object.fromEntries(
  Object.entries(PALETTE).map(([k, v]) => [k, '#' + v.toString(16).padStart(6, '0')])
);

// LAYOUT — world-space contract. Modules MUST place themselves with these numbers
// so the camera rig and conduits line up without cross-module imports.
export const LAYOUT = {
  coreY: 7,                 // center of the reactor core
  coreRadius: 3.2,
  towerPos: [-19, 0, -13],  // context stack base
  towerMaxHeight: 26,       // height at 1M tokens
  towerRadius: 3.4,
  totemRingRadius: 17,      // tool monolith ring around origin
  totemBaseY: 0,
  droneOrbitRadius: 27,     // subagent flight shell
  droneOrbitY: 12,
  gridExtent: 400,
};

// CONTEXT_TOKEN_CAP — the documented DEFAULT ceiling for the context tower.
// Kept exported (and unchanged at 1M) so every module that has not yet moved to
// contextCapFor() keeps working. Prefer contextCapFor(session): a Codex session
// on a 258k window read as 11% full against this constant, which made a
// context-heavy session look nearly empty.
export const CONTEXT_TOKEN_CAP = 1_000_000;

// Standard ceilings we are willing to invent when a session tells us nothing
// about its window. Deliberately coarse — the tower is an instrument, not a
// spec sheet, and a made-up precise number would read as authoritative.
const CONTEXT_BANDS = [200_000, 500_000, 1_000_000, 2_000_000];

// Headroom multiplier for the inferred band: the peak must sit comfortably
// below the ceiling, otherwise the tower pins to full and stops being readable.
const CONTEXT_HEADROOM = 1.1;

// ---------------------------------------------------------------------------
// MODEL -> CONTEXT WINDOW. HEURISTIC, NOT AN API.
// Nothing here is queried from a provider; these are hand-maintained tiers
// matched against whatever string the harness happened to record in meta.model
// (Claude Code writes e.g. "claude-opus-5", Codex writes "gpt-5.5"). Wrong or
// stale entries only mis-scale one tower, never break a parse — but an explicit
// per-session cap (below) always wins over this table, so the right fix for a
// bad tier is to teach the adapter to carry the real number.
// First match wins; order matters (specific tiers before family catch-alls).
// Last reviewed 2026-08.
// ---------------------------------------------------------------------------
const MODEL_CONTEXT_WINDOWS = [
  // --- Anthropic ---------------------------------------------------------
  [/\[1m\]|[-_]1m(\b|$)/, 1_000_000],          // explicit 1M-window tag
  [/claude[-_](fable|mythos)/, 1_000_000],
  [/claude[-_]opus[-_](5|4[-_][678])/, 1_000_000],
  [/claude[-_]sonnet[-_](5|4[-_]6)/, 1_000_000],
  [/claude[-_]haiku/, 200_000],                // Haiku 4.5 and earlier: 200k
  [/claude[-_](opus|sonnet)[-_]4[-_][015]/, 200_000],
  [/claude[-_]3/, 200_000],
  [/^claude/, 1_000_000],                      // unknown newer Claude -> current flagship tier
  // --- OpenAI / Codex ----------------------------------------------------
  [/^gpt[-_]?5\.5/, 258_400],                  // observed as model_context_window in real rollouts
  [/^gpt[-_]?5/, 272_000],
  [/^gpt[-_]?4\.1/, 1_000_000],
  [/^gpt[-_]?4/, 128_000],
  [/^o[34](\b|[-_])/, 200_000],
  // --- others ------------------------------------------------------------
  [/gemini[-_]?[12]\.5[-_]pro/, 2_000_000],
  [/gemini/, 1_000_000],
  [/llama|mistral|qwen|deepseek/, 128_000],
];

// Field names an adapter might plausibly use to carry a real, measured window.
// Codex's token_count records `model_context_window`; other harnesses may add
// meta.contextCap / meta.contextWindow. Any of these beats the model table.
const EXPLICIT_CAP_KEYS = [
  'contextCap', 'context_cap',
  'contextWindow', 'context_window',
  'modelContextWindow', 'model_context_window',
  'contextLimit', 'context_limit',
  'maxContextTokens', 'max_context_tokens',
];

// Coerce to a usable positive number, or 0. Guards against null/NaN/'' /
// negative counters so the tower never divides by zero.
function positiveNum(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

// Smallest standard band that clears peak with headroom; above the top band,
// round up to the next whole million so the tower still has somewhere to grow.
function bandFor(peak) {
  const need = peak * CONTEXT_HEADROOM;
  for (const b of CONTEXT_BANDS) if (b >= need) return b;
  return Math.max(CONTEXT_BANDS[CONTEXT_BANDS.length - 1], Math.ceil(need / 1_000_000) * 1_000_000);
}

/**
 * contextCapFor(session) — the context tower's ceiling for ONE session.
 *
 * Resolution order:
 *   1. an explicit cap the session carries (meta.contextCap / meta.contextWindow
 *      / meta.model_context_window ...) — a measured number always wins;
 *   2. the meta.model heuristic table above;
 *   3. the smallest standard band that comfortably exceeds meta.peakContext.
 *
 * Accepts the COMMON VIZ SHAPE ({ meta: {...} }) or a bare meta object.
 * Guarantees a finite result that is > 0 and never below meta.peakContext, so
 * callers can divide by it unconditionally.
 */
export function contextCapFor(session) {
  const meta = (session && typeof session === 'object' && session.meta) || session || {};
  const peak = positiveNum(meta.peakContext);

  let cap = 0;

  for (const k of EXPLICIT_CAP_KEYS) {
    const v = positiveNum(meta[k]);
    if (v) { cap = v; break; }
  }

  if (!cap && typeof meta.model === 'string' && meta.model) {
    const m = meta.model.toLowerCase();
    for (const [re, tokens] of MODEL_CONTEXT_WINDOWS) {
      if (re.test(m)) { cap = tokens; break; }
    }
  }

  // No cap, or a cap the session already blew past (compaction, bad metadata):
  // fall back to a band sized from what actually happened.
  if (!cap || cap < peak) cap = bandFor(peak);

  return Math.max(cap, peak);
}

// Categorical tool families — information design needs distinguishable hues;
// families keep palette discipline. Color by FAMILY, never per raw tool name.
// The families are HARNESS-NEUTRAL: Claude's Bash, Codex's shell_command and
// OpenClaw's run_command all land on `shell`, so one legend reads the same
// whichever harness produced the session.
export const TOOL_COLORS = {
  shell: 0x37e6ff,    // Bash, PowerShell, shell_command, exec_command, local_shell
  search: 0x2affc4,   // Read, Grep, Glob, ToolSearch, read_file, list_dir, view_image
  mutate: 0xff2d95,   // Write, Edit, NotebookEdit, apply_patch, str_replace, write_file
  agents: 0x9d5cff,   // Agent, Task, Workflow, SendMessage, fork_thread, send_message_to_thread
  web: 0x4f8bff,      // WebSearch, WebFetch, web_search, fetch_url
  browser: 0x3fffa8,  // mcp__Claude_Browser__*, mcp__playwright__*, mcp__claude-in-chrome__*, computer_use
  meta: 0xbfd9ff,     // TaskCreate/Update, Skill, AskUserQuestion, plan tools, update_plan, todo_write
  other: 0xffb52e,    // everything else incl. misc MCP
};

// Normalize a raw tool name to lower_snake_case. Harnesses are inconsistent:
// Claude ships PascalCase (Bash, NotebookEdit), Codex snake_case
// (shell_command, apply_patch), and MCP/OpenClaw tools turn up kebab-cased or
// dotted (apply-patch, browser.navigate). One normal form, one table.
function normalizeToolName(name) {
  return String(name ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')   // camelCase -> camel_Case
    .replace(/[\s.\-/:]+/g, '_')              // kebab / dot / slash / space -> _
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// Exact normalized names, harvested from the adapters' real vocabularies
// (tools/adapters/codex.mjs rollouts, hermes.mjs + openclaw.mjs message
// shapes) rather than guessed. Extend this rather than loosening the
// heuristics below — exact wins are cheap, fuzzy matches misfire.
const TOOL_FAMILY_BY_NAME = new Map(Object.entries({
  // shell — the machine executing something
  bash: 'shell', sh: 'shell', zsh: 'shell', shell: 'shell', shell_command: 'shell',
  bash_command: 'shell', run_command: 'shell', run_shell_command: 'shell',
  run_terminal_cmd: 'shell', execute_command: 'shell', execute_bash: 'shell',
  exec: 'shell', exec_command: 'shell', local_shell: 'shell', container_exec: 'shell',
  terminal: 'shell', powershell: 'shell', pwsh: 'shell', cmd: 'shell',
  code_execution: 'shell', run_code: 'shell', run_python: 'shell', python: 'shell',
  // feeds a running process's stdin — shell interaction, not a file write.
  // Needs the exact entry to beat the write_* -> mutate heuristic below.
  write_stdin: 'shell', send_stdin: 'shell', kill_command: 'shell',

  // search — reading the world without changing it
  read: 'search', read_file: 'search', read_files: 'search', read_many_files: 'search',
  view: 'search', view_file: 'search', view_image: 'search', read_image: 'search',
  open_file: 'search', cat: 'search', head: 'search', tail: 'search',
  grep: 'search', ripgrep: 'search', grep_search: 'search', search_files: 'search',
  file_search: 'search', codebase_search: 'search', semantic_search: 'search',
  glob: 'search', glob_file_search: 'search', list_dir: 'search', list_files: 'search',
  list_directory: 'search', ls: 'search', find: 'search', find_file: 'search',
  tool_search: 'search',

  // mutate — writing to disk
  write: 'mutate', write_file: 'mutate', create_file: 'mutate', save_file: 'mutate',
  edit: 'mutate', edit_file: 'mutate', update_file: 'mutate', multi_edit: 'mutate',
  apply_patch: 'mutate', patch: 'mutate', apply_diff: 'mutate',
  str_replace: 'mutate', str_replace_editor: 'mutate',
  str_replace_based_edit_tool: 'mutate', text_editor: 'mutate',
  insert: 'mutate', delete_file: 'mutate', remove_file: 'mutate',
  rename_file: 'mutate', move_file: 'mutate', mkdir: 'mutate',
  notebook_edit: 'mutate',

  // agents — spawning or talking to other minds
  agent: 'agents', task: 'agents', run_agent: 'agents', spawn_agent: 'agents',
  dispatch_agent: 'agents', subagent: 'agents', delegate: 'agents',
  workflow: 'agents', send_message: 'agents', send_message_to_thread: 'agents',
  create_thread: 'agents', fork_thread: 'agents', handoff_thread: 'agents',
  new_task: 'agents', consult: 'agents', oracle: 'agents',

  // web — the open internet
  web_search: 'web', web_fetch: 'web', websearch: 'web', webfetch: 'web',
  search_web: 'web', fetch: 'web', fetch_url: 'web', url_fetch: 'web',
  http_request: 'web',

  // browser — a driven, stateful surface
  browser: 'browser', browser_action: 'browser', browse: 'browser',
  computer: 'browser', computer_use: 'browser', playwright: 'browser',
  puppeteer: 'browser', navigate: 'browser', screenshot: 'browser',

  // meta — the session talking about itself
  update_plan: 'meta', plan: 'meta', set_plan: 'meta',
  todo_write: 'meta', todo_read: 'meta', task_create: 'meta', task_update: 'meta',
  task_get: 'meta', task_list: 'meta', skill: 'meta', invoke_skill: 'meta',
  ask_user_question: 'meta', ask_followup_question: 'meta',
  attempt_completion: 'meta', enter_plan_mode: 'meta', exit_plan_mode: 'meta',
  list_threads: 'meta', read_thread: 'meta', read_thread_terminal: 'meta',
  set_thread_title: 'meta', set_thread_pinned: 'meta', set_thread_archived: 'meta',
  automation_update: 'meta', load_workspace_dependencies: 'meta',
}));

// Last-resort token heuristics for names no adapter has taught us yet. Ordered
// most-specific-first, because a name like `web_search` must not be caught by
// the generic search rule. Anything that still misses stays `other` — an
// honest unknown beats a confident miscolor.
const TOOL_FAMILY_PATTERNS = [
  [/(^|_)(browser|playwright|puppeteer|computer_use|screenshot|navigate|click|scroll)(_|$)/, 'browser'],
  [/(^|_)(web|http|https|url|fetch|crawl|scrape)(_|$)/, 'web'],
  [/(^|_)(agent|subagent|spawn|delegate|handoff|workflow)(_|$)/, 'agents'],
  [/(^|_)(plan|todo|skill|memory|thread|session|question|prompt)(_|$)/, 'meta'],
  [/(^|_)(patch|diff|edit|write|create|delete|remove|rename|move|insert|replace|apply|save|mkdir)(_|$)/, 'mutate'],
  [/(^|_)(bash|shell|exec|execute|terminal|command|cmd|process|run)(_|$)/, 'shell'],
  [/(^|_)(read|view|open|cat|grep|glob|list|ls|find|search|lookup|inspect|show)(_|$)/, 'search'],
];

export function toolFamily(name) {
  // --- Claude Code's vocabulary, byte-identical to the original mapping. ---
  if (/^(Bash|PowerShell)$/.test(name)) return 'shell';
  if (/^(Read|Grep|Glob|ToolSearch)$/.test(name)) return 'search';
  if (/^(Write|Edit|NotebookEdit)$/.test(name)) return 'mutate';
  if (/^(Agent|Task|Workflow|SendMessage)$/.test(name)) return 'agents';
  if (/^(WebSearch|WebFetch)$/.test(name)) return 'web';
  if (/^mcp__(Claude_Browser|playwright|claude-in-chrome)__/.test(name)) return 'browser';
  if (/^(TaskCreate|TaskUpdate|TaskGet|TaskList|Skill|AskUserQuestion|EnterPlanMode|ExitPlanMode)$/.test(name)) return 'meta';

  // --- MCP tools keep their existing treatment: the three browser-driving
  // servers are 'browser' (now case-tolerantly), every other mcp__* stays
  // 'other'. Server-tool names are arbitrary vendor strings; guessing a family
  // from them would color the ring with noise.
  const raw = String(name ?? '');
  if (/^mcp__/i.test(raw)) {
    return /^mcp__(claude_browser|playwright|claude-in-chrome)__/i.test(raw) ? 'browser' : 'other';
  }

  // --- Every other harness: normalize, then exact table, then heuristics. ---
  const key = normalizeToolName(raw);
  if (!key) return 'other';
  const exact = TOOL_FAMILY_BY_NAME.get(key);
  if (exact) return exact;
  for (const [re, family] of TOOL_FAMILY_PATTERNS) if (re.test(key)) return family;
  return 'other';
}

// THE CHRONOGRAM — radial session infographic on the floor annulus.
export const CHRONO = {
  rInner: 6.5,
  rOuter: 15.0,
  y: 0.06,               // just above the grid plane
  startAngle: Math.PI,   // vt=0 at 12 o'clock (world -Z from cam0), clockwise
  lanes: {               // [r0, r1] per lane, inside rInner..rOuter
    tools: [12.2, 15.0],
    dialogue: [10.2, 12.0],
    subagents: [8.0, 10.0],
    hooks: [6.9, 7.8],
  },
};
