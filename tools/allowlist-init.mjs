#!/usr/bin/env node
// allowlist-init.mjs — discover the Claude Code project directories on THIS
// machine and scaffold cspace.allowlist.json.
//
//   npm run allowlist
//
// Safe by default: discovered slugs are written to a "discovered" list, NOT to
// "allow". You move the ones you want exposed into "allow" yourself — the
// allowlist is a curation control, so nothing is exposed by accident (a machine
// may hold client or otherwise sensitive sessions). Re-running never overwrites
// an existing config; it reports what is allowed, what is available, and what
// is configured but missing.
//
// EVERY WRITE GOES THROUGH tools/allowlist-store.mjs — the same bounded,
// atomic, comment-preserving writer the in-app setup panel uses. This file owns
// discovery and console output; it owns no file-writing logic of its own. Two
// consequences, both deliberate:
//   · the config path is the RESOLVED one (CSPACE_ALLOWLIST when set, exactly as
//     the server resolves it), so `npm run allowlist` can no longer curate a
//     file the server is not reading;
//   · your comments, key order and hand edits survive a --allow run.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { readAllowlist, applyAllowlistOps, resolveAllowlistPath } from './allowlist-store.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');
const CONFIG = resolveAllowlistPath();

// Home-collapse for display only — the absolute path leaks the OS username, and
// this line gets pasted into issues.
const shown = (p) => {
  const abs = resolve(p);
  const home = resolve(homedir());
  return abs.startsWith(home) ? '~' + abs.slice(home.length) : abs;
};
const REDIRECTED = !!process.env.CSPACE_ALLOWLIST?.trim();

// Flags so nobody has to hand-edit JSON:
//   --allow <slug> [<slug>…]   allow exactly these (repeatable, also comma-separated)
//   --allow-all                allow every discovered project (prints what it did)
//   --allow-match <substr>      allow discovered slugs containing substr
// All of them MERGE into an existing config rather than replacing it.
const argv = process.argv.slice(2);
const ALLOW_ALL = argv.includes('--allow-all');
const flagValues = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) {
      out.push(...argv[j].split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
};
const ALLOW_EXPLICIT = flagValues('--allow');
const ALLOW_MATCH = flagValues('--allow-match');

if (!existsSync(PROJECTS)) {
  console.error(`[allowlist] no Claude Code project store at ${PROJECTS}\n` +
    '            Run Claude Code at least once, then re-run this command.');
  process.exit(1);
}

// A project dir is interesting if it holds at least one session transcript.
// Worktree dirs are folded into their parent project (the allowlist covers
// "<slug>--claude-worktrees..." automatically).
const discovered = [];
for (const name of readdirSync(PROJECTS)) {
  if (name.includes('--claude-worktrees')) continue;
  const dir = join(PROJECTS, name);
  try {
    if (!statSync(dir).isDirectory()) continue;
    const sessions = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (sessions.length) discovered.push({ slug: name, sessions: sessions.length });
  } catch { /* unreadable — skip */ }
}
discovered.sort((a, b) => b.sessions - a.sessions);

if (!discovered.length) {
  console.error('[allowlist] no project directories with session transcripts found.');
  process.exit(1);
}

const slugs = discovered.map((d) => d.slug);

if (REDIRECTED) console.log(`[allowlist] CSPACE_ALLOWLIST is set — using ${shown(CONFIG)}\n`);

// A config that exists but does not parse is never overwritten — that would
// destroy a curation nobody can read back. Say so and stop, on every path.
const current = readAllowlist();
if (current.exists && !current.valid) {
  console.error(`[allowlist] existing ${shown(CONFIG)} is not valid JSON: ${current.parseError}`);
  process.exit(1);
}

// ---- flag-driven writes (merge into any existing config) --------------------
if (ALLOW_ALL || ALLOW_EXPLICIT.length || ALLOW_MATCH.length) {
  let add = [];
  if (ALLOW_ALL) add = slugs.slice();
  for (const s of ALLOW_EXPLICIT) {
    if (slugs.includes(s)) add.push(s);
    else console.warn(`[allowlist] --allow "${s}" is not a project on this machine — skipped`);
  }
  for (const m of ALLOW_MATCH) {
    const hits = slugs.filter((s) => s.toLowerCase().includes(m.toLowerCase()));
    if (hits.length) add.push(...hits);
    else console.warn(`[allowlist] --allow-match "${m}" matched nothing — skipped`);
  }

  try {
    await applyAllowlistOps(
      [...new Set(add)].map((project) => ({ verb: 'allow', source: 'claude', project })),
      { discovered: slugs },
    );
  } catch (e) {
    console.error(`[allowlist] could not write ${shown(CONFIG)}: ${e.code ?? ''} ${e.message}`.trim());
    process.exit(1);
  }

  const allow = readAllowlist().entries.allow;
  console.log(`[allowlist] allow now has ${allow.length} project(s):`);
  for (const a of allow) {
    const d = discovered.find((x) => x.slug === a);
    console.log(`    ✓ ${a}${d ? `  (${d.sessions} sessions)` : '  (not on this machine)'}`);
  }
  const left = slugs.filter((s) => !allow.includes(s));
  if (left.length) console.log(`\n  Still NOT exposed (${left.length}): ` + left.slice(0, 8).join(', ') +
    (left.length > 8 ? ', …' : ''));
  console.log('\n  Next:  npm run build && npm run start' +
    '\n  (stats in the library panel additionally need: npm run build-library)');
  process.exit(0);
}

if (current.exists) {
  const allow = current.entries.allow;
  console.log(`[allowlist] cspace.allowlist.json exists — not overwriting.\n`);
  console.log('  ALLOWED (visible in C-Space):');
  const active = allow.filter((a) => slugs.includes(a));
  const stale = allow.filter((a) => !slugs.includes(a));
  if (active.length) for (const a of active) console.log(`    ✓ ${a}  (${discovered.find((d) => d.slug === a).sessions} sessions)`);
  else console.log('    (none of your allow entries match this machine — C-Space will show nothing)');
  if (stale.length) console.log('\n  CONFIGURED BUT NOT ON THIS MACHINE (wrong OS slug? different username?):' +
    stale.map((s) => `\n    · ${s}`).join(''));
  const unlisted = discovered.filter((d) => !allow.includes(d.slug));
  if (unlisted.length) console.log('\n  AVAILABLE, NOT ALLOWED (add any you want visible):' +
    unlisted.map((d) => `\n    · ${d.slug}  (${d.sessions} sessions)`).join(''));
  console.log('\n  Edit cspace.allowlist.json, then: npm run build-library && npm run build');
  process.exit(0);
}

// ---- no config yet: scaffold a DEFAULT-DENY one -----------------------------
// Nothing is allowed. The store creates the commented template and records what
// this machine has under "discovered"; moving a slug into "allow" is a
// deliberate, separate act.
try {
  await applyAllowlistOps([], { discovered: slugs });
} catch (e) {
  console.error(`[allowlist] could not write ${shown(CONFIG)}: ${e.code ?? ''} ${e.message}`.trim());
  process.exit(1);
}

console.log(`[allowlist] wrote cspace.allowlist.json with ${slugs.length} discovered projects:\n`);
for (const d of discovered) console.log(`    ${d.slug}  (${d.sessions} sessions)`);
console.log('\n  NOTHING is exposed yet — "allow" is empty on purpose.\n' +
  '  Move the slugs you want into "allow", then run:\n' +
  '    npm run build-library && npm run build && npm run start');
