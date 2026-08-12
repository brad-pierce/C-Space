#!/usr/bin/env node
// build-library.mjs — parse every allowlisted session into the out-of-repo store
// and (re)generate index.json, so the in-app library shows full stats without
// manual per-file parsing. Run once on a new machine, or after new sessions
// accumulate:  npm run build-library
//
// Only touches allowlisted projects (reuses live-server's listSessions, which
// applies ALLOWED_PROJECTS) — customer-adjacent workspaces are never parsed.
// Reads ~/.claude read-only; writes only into the C-Space data dir (outside the repo).
// Incremental: a session whose output is newer than its transcript is skipped.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './live-server.mjs';
import { LIBRARY_DIR, FLAGSHIP_FILE, DATA_DIR, ensureDataDir } from './cspace-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIB = LIBRARY_DIR;   // out-of-repo store — see tools/cspace-paths.mjs
const PARSER = join(HERE, 'parse-session.mjs');
const FORCE = process.argv.includes('--force');

ensureDataDir();

const sessions = listSessions();
if (!sessions.length) {
  // Almost always a missing/mismatched allowlist (it is gitignored, so a fresh
  // clone has none). Fail loudly rather than writing an empty index that makes
  // the app look broken at boot.
  console.error(
    '\n[build-library] NOTHING TO PARSE — no allowlisted sessions.\n' +
    '  The allowlist is per-machine and gitignored, so a fresh clone has none.\n' +
    '  Run:  npm run allowlist    then edit cspace.allowlist.json and re-run this.\n');
  process.exit(1);
}
console.log(`[build-library] ${sessions.length} allowlisted sessions found`);

const rows = [];
let parsed = 0, skipped = 0, failed = 0;

for (let i = 0; i < sessions.length; i++) {
  const s = sessions[i];
  const out = join(LIB, s.id + '.json');
  const fresh = existsSync(out) && !FORCE &&
    statSync(out).mtimeMs >= (() => { try { return statSync(s.path).mtimeMs; } catch { return Infinity; } })();

  if (!fresh) {
    const res = spawnSync(process.execPath, [PARSER, s.path, out], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (res.status !== 0 || !existsSync(out)) { console.warn(`  ✗ ${s.id.slice(0, 8)} parse failed`); failed++; continue; }
    parsed++;
  } else {
    skipped++;
  }

  try {
    const j = JSON.parse(readFileSync(out, 'utf8'));
    const m = j.meta ?? {};
    rows.push({
      id: s.id,
      label: s.id.slice(0, 8),
      project: s.project,
      durationMin: m.durationS != null ? Math.round(m.durationS / 60) : null,
      events: j.events?.length ?? null,
      toolCalls: m.toolCalls ?? null,
      subagents: j.subagents?.length ?? null,
      compactions: j.compactions?.length ?? null,
      peakContext: m.peakContext ?? null,
    });
    console.log(`  ${fresh ? '·' : '✓'} ${i + 1}/${sessions.length} ${s.id.slice(0, 8)} ${s.project}` +
      (fresh ? ' (cached)' : ` — ${rows[rows.length - 1].toolCalls ?? '?'} calls`));
  } catch (e) {
    console.warn(`  ✗ ${s.id.slice(0, 8)} stats read failed: ${e.message}`);
    failed++;
  }
}

rows.sort((a, b) => (b.toolCalls ?? 0) - (a.toolCalls ?? 0));
// Largest session becomes the flagship (the library's default "no ?session" row).
const flagship = rows[0] ? { ...rows[0], file: `/data/library/${rows[0].id}.json` } : null;
const index = { generated: 'build-library', flagship, sessions: rows };
writeFileSync(join(LIB, 'index.json'), JSON.stringify(index, null, 2));

// The app's default archive path fetches /data/session.json (the flagship slot)
// when there is no ?session param, so the richest session is ALSO written there.
// Without this, a machine whose only data came from build-library 404s on boot
// and has to fall back to a live tail — which fails outright on a machine with
// no running sessions.
if (flagship) {
  const src = join(LIB, flagship.id + '.json');
  writeFileSync(FLAGSHIP_FILE, readFileSync(src));
  console.log(`[build-library] flagship → ${FLAGSHIP_FILE} (${flagship.id.slice(0, 8)}, ${flagship.toolCalls ?? '?'} calls)`);
}

console.log(`[build-library] done — ${parsed} parsed, ${skipped} cached, ${failed} failed; ` +
  `index.json has ${rows.length} sessions.\n` +
  `  Rebuild the app to serve them via the runner:  npm run build`);
