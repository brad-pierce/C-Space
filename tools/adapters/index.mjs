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
// Registry exports: adapters, getAdapter(id), sourceLabel(id), storesPresent(),
// libraryId(source,id), discoverAll({sources,filter}), countsBySource(rows).
//
// IMPORT DIRECTION. adapters/claude.mjs imports tools/live-server.mjs (it reuses
// listSessions), so live-server must NOT import this module statically — that
// would close a cycle whose evaluation order breaks whenever claude.mjs is the
// module reached first (`export default claude` would still be in its TDZ when
// this file's body ran). live-server reaches the registry with a lazy dynamic
// import instead; keep it that way.
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

// Human label for a source id ('codex' -> 'Codex'), or null if not installed.
export function sourceLabel(id) {
  return getAdapter(id)?.label ?? null;
}

// Which installed adapters have their store present on THIS machine.
// Presence is NOT consent — callers still have to consult the allowlist. This
// exists so the server can say "a Codex store is here but nothing is exposed"
// without ever naming a project.
export function storesPresent() {
  const out = [];
  for (const a of adapters) {
    try {
      if (a.storeExists()) out.push({ id: a.id, label: a.label });
    } catch {
      // unreadable store — treat as absent
    }
  }
  return out;
}

// A stable, filesystem-safe key for one session in the parsed library store.
// Claude ids pass through UNCHANGED so /data/library/<id>.json keeps working
// exactly as before; every other source is namespaced so a bare id (Hermes and
// OpenClaw ids are free-form strings, not UUIDs) can never collide with — or
// escape into — another source's file.
export function libraryId(source, id) {
  const raw = String(id ?? '');
  if (!source || source === 'claude') return raw;
  return `${source}-${raw.replace(/[^A-Za-z0-9._-]+/g, '_')}`.slice(0, 120);
}

// Union discovery across INSTALLED adapters. Each row is tagged with its source.
// One adapter throwing (a corrupt store, a permissions error) must not sink the
// whole union, so each is guarded.
//
// PRIVACY-RELEVANT: `sources` restricts which adapters are consulted AT ALL —
// an adapter that is not listed is never asked whether its store exists and is
// never read. Callers that gate on an allowlist must pass it, so a store the
// operator has not opted into is not so much as opened. Omitting `sources`
// keeps the original "every installed adapter" behaviour.
//   sources : iterable of adapter ids to include (default: all installed)
//   filter  : (row, adapter) => boolean, applied to each source-tagged row
export function discoverAll(options = {}) {
  const { sources = null, filter = null } = options ?? {};
  const want = sources == null ? null : new Set(sources);
  const out = [];
  for (const a of adapters) {
    if (want && !want.has(a.id)) continue;   // not opted in — do not touch the store
    try {
      if (!a.storeExists()) continue;
      for (const row of a.discover()) {
        const tagged = { ...row, source: row.source ?? a.id };
        if (filter && !filter(tagged, a)) continue;
        out.push(tagged);
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

export default {
  adapters, getAdapter, sourceLabel, storesPresent, libraryId,
  discoverAll, countsBySource,
};
