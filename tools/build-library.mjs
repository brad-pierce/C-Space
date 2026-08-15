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
//
// TWO OUTPUT MODES.
//   default  — the human CLI, unchanged: progress lines on stdout, one per
//              session, ending with a summary. This is what `npm run
//              build-library` has always printed and it stays byte-for-byte.
//   --json   — the MACHINE channel used by the in-app setup panel (see
//              docs/setup-contract.md §5.4). stdout carries NDJSON and NOTHING
//              ELSE: one JSON object per line, no human lines at all, including
//              the source-coverage lines and the NOTHING TO PARSE block. Those
//              lines print project names, and in --json mode stdout is read by a
//              server that forwards it to a browser (F6: counts only, never
//              names). Exit codes in this mode: 0 ok, 2 nothing allowed, 1 other.
//              The human mode keeps its historical exit 1 for "nothing allowed".

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
const JSON_MODE = process.argv.includes('--json');

// --- the two output channels -----------------------------------------------
// `emit` writes NDJSON and only exists in --json mode; `say`/`warn`/`fail` are
// the human lines and only exist outside it. Nothing is ever written to both, so
// a machine reader never has to filter and an operator never sees JSON.
const emit = JSON_MODE ? (o) => process.stdout.write(JSON.stringify(o) + '\n') : () => {};
const say = JSON_MODE ? () => {} : (...a) => console.log(...a);
const warn = JSON_MODE ? () => {} : (...a) => console.warn(...a);
const fail = JSON_MODE ? () => {} : (...a) => console.error(...a);

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

// Returns the process exit code. Wrapped in a function purely so the
// nothing-to-parse path can return instead of process.exit()-ing: an abrupt
// exit can truncate a pipe write, and in --json mode the last thing written is
// the error line the parent needs.
async function main() {
  ensureDataDir();

  // Suppressed in --json mode: this prints one line per non-Claude store and it
  // is a human hint, not machine state (F6 — the parent must forward counts only).
  if (!JSON_MODE) await reportSourceCoverage();

  const sessions = await listAllowedSessions();
  if (!sessions.length) {
    // Almost always a missing/mismatched allowlist (it is gitignored, so a fresh
    // clone has none). Fail loudly rather than writing an empty index that makes
    // the app look broken at boot.
    emit({ ev: 'error', code: 'nothing-allowed' });
    fail(
      '\n[build-library] NOTHING TO PARSE — no allowlisted sessions.\n' +
      '  The allowlist is per-machine and gitignored, so a fresh clone has none.\n' +
      '  Run:  npm run allowlist    then edit cspace.allowlist.json and re-run this.\n' +
      '  Sessions from other harnesses (codex/hermes/openclaw) additionally need a\n' +
      '  "sources" entry — see cspace.allowlist.example.json.\n');
    return JSON_MODE ? 2 : 1;
  }

  const bySource = sessions.reduce((m, s) => (m[s.source] = (m[s.source] ?? 0) + 1, m), {});
  emit({ ev: 'start', total: sessions.length, force: FORCE });
  say(`[build-library] ${sessions.length} allowlisted sessions found ` +
    `(${Object.entries(bySource).map(([k, n]) => `${k}:${n}`).join(' ')})`);

  const rows = [];
  let parsed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const libId = s.libraryId ?? libraryId(s.source, s.id);
    const out = join(LIB, libId + '.json');
    const fresh = existsSync(out) && !FORCE && statSync(out).mtimeMs >= sourceMtime(s);

    // One NDJSON line per session, whatever happens to it. `libraryId` is the
    // opaque store key the app already fetches as /data/library/<id>.json — no
    // project label and no filesystem path ever goes on this channel.
    const item = (status) => emit({
      ev: 'item', i: i + 1, total: sessions.length, status, libraryId: libId, source: s.source,
    });

    if (!fresh) {
      // Pass the whole discover() row through: adapters locate a session by
      // `path`, `ref`, `dbPath`/`agentId` or plain `id` depending on the store.
      const entryB64 = Buffer.from(JSON.stringify(s), 'utf8').toString('base64');
      const res = spawnSync(process.execPath, [SELF, '--parse-one', s.source, out, entryB64],
        { stdio: ['ignore', 'ignore', 'inherit'] });
      if (res.status !== 0 || !existsSync(out)) {
        warn(`  ✗ ${libId.slice(0, 16)} parse failed`);
        failed++;
        item('failed');
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
      say(`  ${fresh ? '·' : '✓'} ${i + 1}/${sessions.length} [${s.source}] ${String(s.id).slice(0, 8)} ${s.project ?? '—'}` +
        (fresh ? ' (cached)' : ` — ${rows[rows.length - 1].toolCalls ?? '?'} calls`));
      item(fresh ? 'cached' : 'parsed');
    } catch (e) {
      warn(`  ✗ ${libId.slice(0, 16)} stats read failed: ${e.message}`);
      // The per-item verdict is "failed" — the session does not reach the index.
      // The summary counters are left exactly as they have always been (a parse
      // that succeeded a moment ago still counts as parsed), so the human
      // summary line is unchanged; consumers clamp rather than assume the three
      // counters partition `total`.
      failed++;
      item('failed');
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
    say(`[build-library] flagship → ${FLAGSHIP_FILE} ` +
      `(${flagship.source}:${flagship.label}, ${flagship.toolCalls ?? '?'} calls)`);
  }

  emit({
    ev: 'done', parsed, cached: skipped, failed,
    flagship: flagship
      ? { id: flagship.id, source: flagship.source, toolCalls: flagship.toolCalls ?? null }
      : null,
  });
  say(`[build-library] done — ${parsed} parsed, ${skipped} cached, ${failed} failed; ` +
    `index.json has ${rows.length} sessions.\n` +
    `  Rebuild the app to serve them via the runner:  npm run build`);
  return 0;
}

// process.exitCode rather than process.exit(): the last NDJSON line must reach
// the parent's pipe, and an abrupt exit can drop a queued write.
process.exitCode = await main();
