// adapters/claude.mjs — the Claude Code source, exposed through the common
// adapter interface. This is a THIN wrapper: all JSONL parsing is delegated to
// the shared SessionParser (tools/session-parser.mjs), and discovery/allowlist
// logic is delegated to listSessions (tools/live-server.mjs). Nothing here
// reimplements either — it only tags rows with source:'claude' and assembles
// the SessionParser stream into the same object shape parse-session.mjs emits.
//
// Read-only w.r.t. ~/.claude — never writes to the session store.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { SessionParser } from '../session-parser.mjs';
import { listSessions } from '../live-server.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');

// Assemble the ordered SessionParser item stream (ctx items + events) into the
// COMMON VIZ SHAPE — identical to parse-session.mjs's output object. Kept here
// (not in SessionParser) because the parser is the streaming engine shared with
// the live tail; batch assembly is an adapter concern.
export function assemble(parser, items) {
  const events = [];
  const contextCurve = [];
  for (const it of items) {
    if (it.kind === 'ctx') contextCurve.push(it);
    else events.push(it);
  }

  // close any dangling subagents at session end (mirrors parse-session.mjs)
  const durS = parser.durationS();
  for (const s of parser.subagents) if (s.endT === null) s.endT = durS;

  const compactions = events.filter((e) => e.kind === 'compaction').map((e) => ({ t: e.t }));
  events.sort((a, b) => a.t - b.t);

  const peakContext = contextCurve.reduce((a, c) => Math.max(a, c.ctx), 0);

  return {
    meta: { ...parser.snapshotMeta(), peakContext },
    tools: parser.toolsObject(),
    contextCurve,
    subagents: parser.subagents,
    compactions,
    events,
  };
}

const claude = {
  id: 'claude',
  label: 'Claude Code',

  // Does this harness's store exist on THIS machine?
  storeExists() {
    return existsSync(PROJECTS);
  },

  // List sessions this adapter can read. Reuses live-server's listSessions —
  // which applies the curated, gitignored project allowlist — so no project
  // names or allowlist logic are duplicated here. Rows are tagged source:'claude'.
  discover() {
    if (!this.storeExists()) return [];
    return listSessions().map((s) => ({
      id: s.id,
      source: 'claude',
      project: s.project,
      path: s.path,
      mtime: s.mtime,
      sizeMB: s.sizeMB,
      active: s.active,
    }));
  },

  // Produce the COMMON VIZ SHAPE for one session (a row from discover(), or any
  // object carrying { id, path }). Streams the raw JSONL through SessionParser
  // and assembles — no parsing logic reimplemented.
  parse(entry) {
    const path = entry?.path;
    if (!path) throw new Error('claude.parse: entry.path is required');
    const id = entry.id ?? path;
    const parser = new SessionParser(id);
    const items = [];
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (line) items.push(...parser.feed(line));
    }
    return assemble(parser, items);
  },
};

export default claude;
