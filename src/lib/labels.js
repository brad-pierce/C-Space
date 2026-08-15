// labels.js — the one rule for how a PROJECT reads on the glass.
//
// Every surface that names a project — the SETUP panel's tick list, the LIBRARY
// panel's PROJECT column, and all three fleet surfaces (machine nameplates, the
// fleet HUD roster, the fleet hover card) — renders the same field: a harness's
// idea of "which project is this", which for Claude and Codex is the working
// directory, flattened into a slug ("C--Users-you-myapp") or handed over as a
// real path ("C:\Users\you\myapp"). Left alone, both forms spell out the OS
// username.
//
// This module exists because that rule kept getting COPIED — same regex, same
// comment, once per surface — and a gap in it therefore had to be found once per
// surface. It never was. Two copies (setup.js, library.js) were consolidated
// here and fixed; the three fleet copies were left behind and kept leaking on
// every macOS and Linux shape ("-Users-you-app" → "USERS-YOU-APP") because they
// only ever knew about Windows slugs. The lesson is the rule, not the instance:
// FIVE implementations of one privacy rule is the defect. There is now exactly
// one, imported by all five. Pure, no DOM, no state, node-safe.
//
// WHAT THIS IS FOR. C-Space is a wall display and a screen-share tool; there is
// a demo video of it in the README. Every string these panels paint is a string
// somebody else's eyes land on. The OS username is not interesting to a viewer
// and it is not the operator's to hand out, so it comes off before render — the
// same intent as hud.js's dehome() on the event ticker and setup-server.mjs's
// collapseHome() on the two paths the setup panel prints.
//
// WHAT THIS IS NOT. It is not a redaction guarantee and must not be leaned on
// as one. It reads the SHAPE of a path, not the local home directory (this runs
// in a browser, where there is no homedir() to compare against), so it can only
// strip what is shaped like a home prefix. Two known limits, both documented in
// tests/labels.test.mjs so they stay known:
//   * a username containing the separator character ("ford-prefect" → the slug
//     "C--Users-ford-prefect-app") is indistinguishable from a username followed
//     by a project. The first segment comes off, the rest reads as the project.
//   * a project directory that genuinely lives at "<drive>:\home\..." is not a
//     home directory, and is not treated as one (see HOME_PREFIX).
// The scanner in tools/pii-scan.mjs is the belt to this suspenders: it knows the
// real local home and can say the word out loud.

/** What a project whose working directory IS the home directory renders as. */
export const HOME_LABEL = '~';

/** What an absent, empty or fully-consumed label renders as. */
export const UNKNOWN_LABEL = '—';

// Path separators, whichever platform and whichever direction, plus the drive
// colon. Collapsed to the single '-' that a Claude project slug already uses,
// so a raw path and a slug reach the rules below in the same shape.
const SEPARATORS = /[\\/:]+/g;

// "<project>--claude-worktrees-<branch>-<hash>" is a git worktree of <project>,
// which is how Claude names the store directory for a session run inside one.
// Folded to the parent, matching what setup-discovery.mjs already does when it
// enumerates candidates — so the two panels agree about how many projects there
// are, and a PROJECT column keeps naming the repo rather than a throwaway
// branch. Not a username leak in itself; folded because a rule that leaves a
// 40-character tail on screen is a rule people work around.
const WORKTREE_MARK = /--claude-worktrees.*$/i;

// A HOME-DIRECTORY PREFIX, in the four shapes that actually occur:
//
//   C--Users-you-…   / C-Users-you-…    Windows slug, and "C:\Users\you\…"
//   -c-Users-you-…                      MSYS / Git-Bash, "/c/Users/you/…"
//   -mnt-c-Users-you-…                  WSL onto the Windows disk
//   -Users-you-…                        macOS, "/Users/you/…"
//   -home-you-… / -var-home-you-…       Linux, "/home/you/…"
//
// The username is the ONE segment after "Users"/"home"; everything past it is
// the project and is kept verbatim. The trailing "(?:-+|$)" is the whole point
// of this rewrite: the previous rule required a separator AFTER the username,
// so a session whose cwd was the home directory itself — a real, tickable
// project — matched nothing and rendered as "c--users-you". Anchoring on
// end-of-string as well makes that case a match with an empty remainder, which
// callers turn into HOME_LABEL rather than dropping the row.
//
// "users" is accepted with or without a drive letter; "home" only WITHOUT one,
// because "/home/you" is a real home and "C:\home\app" is just a directory
// called home. The mount prefixes are an explicit short list rather than "any
// leading segments": allowing arbitrary leading segments would swallow an
// ordinary "C:\repos\users\guide" and render two unrelated projects as the same
// row, and a rule that makes real projects indistinguishable is not a safer
// rule, it is a broken picker.
const HOME_PREFIX =
  /^-*(?:(?:mnt|cygdrive)-+)?(?:(?:[A-Za-z]-+)?users|(?:var-+)?home)-+[^-]+(?:-+|$)/i;

// A bare drive prefix on a path that is NOT under a home directory
// ("C--work-alpha", "C--Acme-Fieldwork"). Dropped so the project stands on its
// own, the same reduction tools/pii-scan.mjs's slugTails() makes. Tried only
// after HOME_PREFIX, so "C--Users-you" can never reach it and be reduced to the
// username. The captured letter is what a drive ROOT renders as.
//
// A LEADING SINGLE LETTER IS NOT ENOUGH. The old rule was /^-*([A-Za-z])-+/ and
// it ran against every label, including the ones that are not paths at all: a
// Codex "project" is the basename of the working directory, so an operator whose
// cwd was named after the thing they were asking hands this module
// "i-need-a-parser-for" and "i-m-trying-to-figure-out". The old rule ate the
// leading "i" as a drive letter and painted "need-an-icon-logo-for" — a word
// removed from the operator's own sentence, which is both wrong on screen and
// worse than wrong underneath: setup.js's readsAsProse() decides whether to
// caution about a screen-share by looking at the FIRST WORD, and "i" is in its
// PERSONAL_LEAD set while "m" is not. Eating the letter silently switched the
// caution off for exactly the labels that most needed it.
//
// So a drive is only a drive when the input says so, in one of four ways:
//   * DRIVE_RAW    — the raw label still has the colon ("C:\work\alpha",
//                    "C:/work/alpha"). Checked BEFORE separators collapse,
//                    because ":\" flattens to a single "-" and is then
//                    indistinguishable from a word boundary.
//   * DRIVE_SLUG   — a Claude store slug, where ":" + separator flattened to the
//                    doubled dash ("C--work-alpha").
//   * DRIVE_MUNGED — a single dash, but what follows is unmistakably a path: a
//                    "users"/"home" segment ("C-Users"). HOME_PREFIX has already
//                    had its turn, so only the username-less forms reach here.
//   * DRIVE_ROOT   — the label is nothing BUT a letter and separators ("C-",
//                    from the path "C:"). A bare "a" is a one-character project,
//                    not a drive, so at least one separator is required.
// Anything else keeps its first letter. A project called "c-work-alpha" reads as
// "c-work-alpha"; that is the price of not eating words out of sentences, and it
// is a display cost, never a leak — nothing here is a home prefix.
const DRIVE_RAW = /^[\\/]*([A-Za-z]):/;
const DRIVE_SLUG = /^-*([A-Za-z])--/;
const DRIVE_MUNGED = /^-*([A-Za-z])-(?:users|home)(?:-|$)/i;
const DRIVE_ROOT = /^-*([A-Za-z])-+$/;
// What to slice once one of the four has confirmed it.
const DRIVE_HEAD = /^-*[A-Za-z]-+/;

const driveLetter = (raw, s) => {
  const m = DRIVE_RAW.exec(raw) || DRIVE_SLUG.exec(s) || DRIVE_MUNGED.exec(s) ||
    DRIVE_ROOT.exec(s);
  return m ? m[1] : null;
};

const EDGE_DASHES = /^-+|-+$/g;

const clean = (s) => {
  const out = s.replace(EDGE_DASHES, '').toLowerCase();
  return out || UNKNOWN_LABEL;
};

/**
 * The display form of a project label: a slug, an absolute path, or nothing.
 *
 * "C--Users-you-myapp" → "myapp"
 * "C:\Users\you\myapp" → "myapp"
 * "C--Users-you"       → "~"        (the home directory IS the project)
 * "C--work-alpha"      → "work-alpha"
 * "C--"                → "c:"       (the drive root IS the project)
 * null / "" / "-"      → "—"
 *
 * Never returns an empty string: every row this feeds is a row the operator can
 * tick, so a label that compresses to nothing must still render as something.
 *
 * @param {unknown} p raw project label (slug or path)
 * @returns {string} the exact text to paint
 */
export function compressProject(p) {
  if (!p) return UNKNOWN_LABEL;
  const raw = String(p);
  let s = raw.replace(SEPARATORS, '-');

  // Worktree first, so "<home>--claude-worktrees-x" reduces to the home slug and
  // then to HOME_LABEL, instead of the marker eating the boundary the home rule
  // needs. Guarded: a label that is NOTHING but the marker keeps its text rather
  // than compressing to nothing.
  const base = s.replace(WORKTREE_MARK, '');
  if (base.replace(EDGE_DASHES, '')) s = base;

  const home = HOME_PREFIX.exec(s);
  if (home) {
    const rest = s.slice(home[0].length).replace(EDGE_DASHES, '');
    return rest ? clean(rest) : HOME_LABEL;
  }

  const letter = driveLetter(raw, s);
  if (letter) {
    const head = DRIVE_HEAD.exec(s);
    const rest = head ? s.slice(head[0].length).replace(EDGE_DASHES, '') : '';
    return rest ? clean(rest) : `${letter.toLowerCase()}:`;
  }

  return clean(s);
}

/** Default width of a fleet tag — the machine nameplate and the hover card. */
export const TAG_MAX = 18;

/**
 * The same rule, in the fleet's voice: uppercase micro-type, clipped to width.
 *
 * The fleet paints project labels in three places (machine nameplates, the HUD
 * roster, the hover card) and each one had grown its OWN copy of the compression
 * regex — copies that only knew Windows slugs, so "/Users/you/app" rendered as
 * "USERS-YOU-APP" on the operator's laptop. They differ from the panels only in
 * CASE and WIDTH, which is a formatting difference, not a rule difference, so it
 * lives here as an argument rather than as three more implementations.
 *
 * HOME_LABEL ("~") and UNKNOWN_LABEL ("—") pass through unchanged: uppercasing
 * a glyph is a no-op, and the home row stays the home row on every surface.
 *
 * @param {unknown} p raw project label (slug or path)
 * @param {number} [max] width to clip to
 * @returns {string} the exact text to paint
 */
export function projectTag(p, max = TAG_MAX) {
  const out = compressProject(p).toUpperCase();
  return Number.isFinite(max) && max > 0 ? out.slice(0, max) : out;
}

export default { compressProject, projectTag, HOME_LABEL, UNKNOWN_LABEL, TAG_MAX };
