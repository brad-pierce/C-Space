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

export const CONTEXT_TOKEN_CAP = 1_000_000; // this session ran on the 1M window

// Categorical tool families — information design needs distinguishable hues;
// families keep palette discipline. Color by FAMILY, never per raw tool name.
export const TOOL_COLORS = {
  shell: 0x37e6ff,    // Bash, PowerShell
  search: 0x2affc4,   // Read, Grep, Glob, ToolSearch
  mutate: 0xff2d95,   // Write, Edit, NotebookEdit
  agents: 0x9d5cff,   // Agent, Task, Workflow, SendMessage
  web: 0x4f8bff,      // WebSearch, WebFetch
  browser: 0x3fffa8,  // mcp__Claude_Browser__*, mcp__playwright__*, mcp__claude-in-chrome__*
  meta: 0xbfd9ff,     // TaskCreate/Update, Skill, AskUserQuestion, plan tools
  other: 0xffb52e,    // everything else incl. misc MCP
};

export function toolFamily(name) {
  if (/^(Bash|PowerShell)$/.test(name)) return 'shell';
  if (/^(Read|Grep|Glob|ToolSearch)$/.test(name)) return 'search';
  if (/^(Write|Edit|NotebookEdit)$/.test(name)) return 'mutate';
  if (/^(Agent|Task|Workflow|SendMessage)$/.test(name)) return 'agents';
  if (/^(WebSearch|WebFetch)$/.test(name)) return 'web';
  if (/^mcp__(Claude_Browser|playwright|claude-in-chrome)__/.test(name)) return 'browser';
  if (/^(TaskCreate|TaskUpdate|TaskGet|TaskList|Skill|AskUserQuestion|EnterPlanMode|ExitPlanMode)$/.test(name)) return 'meta';
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
