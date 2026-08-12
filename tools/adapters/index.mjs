// adapters/index.mjs — the SOURCE ADAPTER registry.
//
// Every adapter implements the same interface so all downstream viz modules
// work unchanged regardless of which harness a session came from:
//
//   {
//     id,                  // stable short key: 'claude' | 'codex' | 'hermes' | 'openclaw'
//     label,               // human name for the UI
//     storeExists(),       // is this harness's store present on THIS machine?
//     discover(),          // -> [{ id, source, project, path|ref, mtime, sizeMB, active }]
//     parse(entry),        // -> COMMON VIZ SHAPE (identical to parse-session.mjs)
//   }
//
// The COMMON VIZ SHAPE (what parse() must return):
//   { meta:{ sessionId, cwd, model, version, startedAt, durationS, userTurns,
//            assistantTurns, thinkingBlocks, hookEvents, toolCalls, peakContext },
//     tools:{ name:{count,errors,chars} }, contextCurve[], subagents[],
//     compactions[], events[] }
//
// Only the Claude adapter is a hard dependency (it re-exposes the existing
// parser). Codex, Hermes and OpenClaw are optional siblings — this registry
// loads whichever of them are present so a machine (or a fresh clone) that has
// only some adapter files still imports clean and runs. Dependency-light: no
// npm deps, only node built-ins transitively.

import claude from './claude.mjs';

// Optional sibling adapters, loaded if their file exists. Missing files are not
// an error — a peer may not have landed codex.mjs / hermes.mjs / openclaw.mjs
// yet, and this module must still import cleanly with just claude.mjs present.
// Top-level await keeps the exported `adapters` a plain, already-resolved array
// for consumers.
const OPTIONAL = ['./codex.mjs', './hermes.mjs', './openclaw.mjs'];

const loaded = [claude];
for (const spec of OPTIONAL) {
  try {
    const mod = await import(spec);
    const a = mod?.default ?? mod?.adapter;
    if (a && typeof a.id === 'string' && typeof a.discover === 'function') {
      if (!loaded.some((x) => x.id === a.id)) loaded.push(a);
    }
  } catch {
    // not installed on this machine / not landed yet — skip silently
  }
}

// The registry: an array of every installed adapter.
export const adapters = loaded;

// Look up one adapter by its id ('claude' | 'codex' | 'hermes' | 'openclaw').
// Returns null if that adapter is not installed on this machine.
export function getAdapter(id) {
  return adapters.find((a) => a.id === id) ?? null;
}

// Union discovery across every INSTALLED adapter whose store exists on this
// machine. Each row is tagged with its source. One adapter throwing (a corrupt
// store, a permissions error) must not sink the whole union, so each is guarded.
export function discoverAll() {
  const out = [];
  for (const a of adapters) {
    try {
      if (!a.storeExists()) continue;
      for (const row of a.discover()) {
        out.push({ ...row, source: row.source ?? a.id });
      }
    } catch {
      // skip this source's rows; the others still list
    }
  }
  out.sort((x, y) => (y.mtime ?? 0) - (x.mtime ?? 0));
  return out;
}

// Per-source counts from a discovery union — handy for diagnostics/tests.
export function countsBySource(rows = discoverAll()) {
  const counts = {};
  for (const r of rows) counts[r.source] = (counts[r.source] ?? 0) + 1;
  return counts;
}

export default { adapters, getAdapter, discoverAll, countsBySource };
