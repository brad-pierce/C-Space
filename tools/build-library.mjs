#!/usr/bin/env node
// build-library.mjs — parse every allowlisted session into the out-of-repo store
// and (re)generate index.json, so the in-app library shows full stats without
// manual per-file parsing. Run once on a new machine, or after new sessions
// accumulate:  npm run build-library
//
// MULTI-SOURCE. Sessions are read through the SOURCE ADAPTERS (tools/adapters/):
// Claude Code, and — only where the allowlist opts them in — Codex, Hermes and
// OpenClaw. Every session goes through its own adapter, so a Codex session lands
// in the library with the same stats a Claude one does, and every index row is
// tagged with the `source` it came from.
//
// Only allowed sessions are touched (live-server's listAllowedSessions applies
// both gates: the Claude project allowlist and the per-source allowlist). A
// source that is not opted in is never even discovered — customer-adjacent
// workspaces and un-curated harnesses are never parsed.
// Reads every session store read-only; writes only into the C-Space data dir
// (outside the repo). Incremental: a session whose output is newer than its
// transcript is skipped.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllowedSessions, reportSourceCoverage } from './live-server.mjs';
import { getAdapter, libraryId } from './adapters/index.mjs';
import { LIBRARY_DIR, FLAGSHIP_FILE, DATA_DIR, ensureDataDir } from './cspace-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIB = LIBRARY_DIR;   // out-of-repo store — see tools/cspace-paths.mjs
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// WORKER MODE:  build-library.mjs --parse-one <source> <out.json> <entry-b64>
//
// One session, one child process — the same crash isolation the old
// spawn(parse-session.mjs) gave, now for every source. A malformed transcript,
// an OOM, or an adapter bug costs one session, not the whole build. The entry
// row travels base64-encoded so no shell/argv quoting rule can mangle a path.
// Must run BEFORE any of the main flow below.
// ---------------------------------------------------------------------------
if (process.argv[2] === '--parse-one') {
  const [, , , source, outPath, entryB64] = process.argv;
  const adapter = getAdapter(source);
  if (!adapter) {
    console.error(`[build-library] no adapter for source "${source}"`);
    process.exit(1);
  }
  let entry;
  try {
    entry = JSON.parse(Buffer.from(entryB64, 'base64').toString('utf8'));
  } catch (e) {
    console.error(`[build-library] bad entry payload: ${e.message}`);
    process.exit(1);
  }
  try {
    writeFileSync(outPath, JSON.stringify(adapter.parse(entry)));
  } catch (e) {
    console.error(`[build-library] ${source} parse failed: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const FORCE = process.argv.includes('--force');

ensureDataDir();

await reportSourceCoverage();   // one count-only line per non-Claude store present

const sessions = await listAllowedSessions();
if (!sessions.length) {
  // Almost always a missing/mismatched allowlist (it is gitignored, so a fresh
  // clone has none). Fail loudly rather than writing an empty index that makes
  // the app look broken at boot.
  console.error(
    '\n[build-library] NOTHING TO PARSE — no allowlisted sessions.\n' +
    '  The allowlist is per-machine and gitignored, so a fresh clone has none.\n' +
    '  Run:  npm run allowlist    then edit cspace.allowlist.json and re-run this.\n' +
    '  Sessions from other harnesses (codex/hermes/openclaw) additionally need a\n' +
    '  "sources" entry — see cspace.allowlist.example.json.\n');
  process.exit(1);
}

const bySource = sessions.reduce((m, s) => (m[s.source] = (m[s.source] ?? 0) + 1, m), {});
console.log(`[build-library] ${sessions.length} allowlisted sessions found ` +
  `(${Object.entries(bySource).map(([k, n]) => `${k}:${n}`).join(' ')})`);

const rows = [];
let parsed = 0, skipped = 0, failed = 0;

// A session's output is fresh when it is newer than the transcript it came from.
// File-backed sources (Claude, Codex, legacy JSONL) stat the transcript itself;
// DB-backed rows (Hermes, OpenClaw) have no single file, so their discover-time
// mtime — the session's last-interaction timestamp — is the comparison.
function sourceMtime(s) {
  if (s.path) {
    try { return statSync(s.path).mtimeMs; } catch { return Infinity; }
  }
  return s.mtime ?? Infinity;
}

for (let i = 0; i < sessions.length; i++) {
  const s = sessions[i];
  const libId = s.libraryId ?? libraryId(s.source, s.id);
  const out = join(LIB, libId + '.json');
  const fresh = existsSync(out) && !FORCE && statSync(out).mtimeMs >= sourceMtime(s);

  if (!fresh) {
    // Pass the whole discover() row through: adapters locate a session by
    // `path`, `ref`, `dbPath`/`agentId` or plain `id` depending on the store.
    const entryB64 = Buffer.from(JSON.stringify(s), 'utf8').toString('base64');
    const res = spawnSync(process.execPath, [SELF, '--parse-one', s.source, out, entryB64],
      { stdio: ['ignore', 'ignore', 'inherit'] });
    if (res.status !== 0 || !existsSync(out)) {
      console.warn(`  ✗ ${libId.slice(0, 16)} parse failed`);
      failed++;
      continue;
    }
    parsed++;
  } else {
    skipped++;
  }

  try {
    const j = JSON.parse(readFileSync(out, 'utf8'));
    const m = j.meta ?? {};
    rows.push({
      // `id` is what the app fetches as /data/library/<id>.json — for Claude it
      // is the session id exactly as before; other sources are namespaced by
      // libraryId() so free-form ids cannot collide across stores.
      id: libId,
      sessionId: String(s.id),
      source: s.source,
      sourceLabel: s.sourceLabel ?? s.source,
      label: String(s.id).slice(0, 8),
      project: s.project ?? null,
      durationMin: m.durationS != null ? Math.round(m.durationS / 60) : null,
      events: j.events?.length ?? null,
      toolCalls: m.toolCalls ?? null,
      subagents: j.subagents?.length ?? null,
      compactions: j.compactions?.length ?? null,
      peakContext: m.peakContext ?? null,
      model: m.model ?? null,
    });
    console.log(`  ${fresh ? '·' : '✓'} ${i + 1}/${sessions.length} [${s.source}] ${String(s.id).slice(0, 8)} ${s.project ?? '—'}` +
      (fresh ? ' (cached)' : ` — ${rows[rows.length - 1].toolCalls ?? '?'} calls`));
  } catch (e) {
    console.warn(`  ✗ ${libId.slice(0, 16)} stats read failed: ${e.message}`);
    failed++;
  }
}

rows.sort((a, b) => (b.toolCalls ?? 0) - (a.toolCalls ?? 0));
// Largest session becomes the flagship (the library's default "no ?session" row).
const flagship = rows[0] ? { ...rows[0], file: `/data/library/${rows[0].id}.json` } : null;
const index = {
  generated: 'build-library',
  sources: rows.reduce((m, r) => (m[r.source] = (m[r.source] ?? 0) + 1, m), {}),
  flagship,
  sessions: rows,
};
writeFileSync(join(LIB, 'index.json'), JSON.stringify(index, null, 2));

// The app's default archive path fetches /data/session.json (the flagship slot)
// when there is no ?session param, so the richest session is ALSO written there.
// Without this, a machine whose only data came from build-library 404s on boot
// and has to fall back to a live tail — which fails outright on a machine with
// no running sessions.
if (flagship) {
  const src = join(LIB, flagship.id + '.json');
  writeFileSync(FLAGSHIP_FILE, readFileSync(src));
  console.log(`[build-library] flagship → ${FLAGSHIP_FILE} ` +
    `(${flagship.source}:${flagship.label}, ${flagship.toolCalls ?? '?'} calls)`);
}

console.log(`[build-library] done — ${parsed} parsed, ${skipped} cached, ${failed} failed; ` +
  `index.json has ${rows.length} sessions.\n` +
  `  Rebuild the app to serve them via the runner:  npm run build`);
