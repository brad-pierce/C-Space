// paths.js — the one rule for collapsing a HOME DIRECTORY out of any string
// C-Space is about to paint.
//
// Sibling of src/lib/labels.js, and here for the same reason. labels.js owns
// how a PROJECT reads (a slug or a cwd, compressed to a name); this module owns
// how any OTHER transcript-derived string reads — event-ticker lines, the
// chronogram's hover/pick card, subagent/drone labels — all of which are built
// from raw tool arguments (file_path, command, pattern, query, url) and
// therefore carry absolute paths verbatim. An absolute path under the home
// directory spells out the OS username.
//
// This lived inside src/modules/hud.js and was applied at exactly ONE call
// site, so every sibling surface that paints the same raw fields was
// unprotected — the chronogram card was observed on screen printing a full
// 'C:\Users\<name>\…' path. One implementation, imported by every surface that
// renders a transcript string. Pure, no DOM, no state beyond the learned
// account name, node-safe.
//
// WHAT THIS IS FOR. C-Space is a wall display and a screen-share tool; there is
// a demo video of it in the README. This is the most screenshotted text in the
// product, so the username comes off before render — the same intent as
// labels.js's compressProject() on the two project panels and
// setup-server.mjs's collapseHome() on the two paths the setup panel prints.
//
// dehome() makes TWO passes over a line, learned-first:
//
//   (1) LEARNED HOME — exact, and the pass that carries the weight. There is no
//       homedir() in the browser, but the SESSION says where it ran: meta.cwd
//       is an absolute path ('C:\Users\you\myapp') and playing.project is
//       Claude's munged key for the same place ('C--Users-you-myapp').
//       learnHome() lifts the account segment out of whichever is present at
//       session-swap time (hud.js's _renderIdentity, so before any line is
//       built) and compiles ONE matcher for that literal name. Knowing the name
//       is what makes the ambiguous shapes safe to collapse — a bare
//       '/home/<name>' or '/Users/<name>' (matching '/home/' on shape alone
//       would eat the '/home/' out of any URL path) and the WSL
//       '/mnt/c/Users/<name>', which is the actual home of an operator running
//       under WSL. It also takes an account name containing a hyphen
//       ('pat-lee') in one piece.
//       It runs FIRST for that last reason: the munged grammar in pass 2 stops
//       a segment at '-', so shape-first would collapse 'C--Users-pat-lee'
//       to '~-lee' and leave half the name on screen.
//
//   (2) SHAPE — the fallback for everything the session did not name: a session
//       recorded on another machine, a path quoted inside a grep pattern, a
//       boot where meta.cwd is absent. It matches '<root>Users<sep><segment>',
//       where <root> is one of an ENUMERATED set of tokens that can only
//       introduce a filesystem root:
//         C:\…  C:/…              native Windows / already forward-slashed
//         /c/…                     MSYS / Git-Bash, how paths read inside Bash
//         /mnt/c/…  /cygdrive/c/…  WSL, Cygwin
//         file:///C:/…  file:///…  a url tool argument (WebFetch, browser MCP)
//         \\server\…               UNC
//         \\?\C:\…  \\.\C:\…  \\?\UNC\server\…   extended-length / device
//       plus the one shape that is not a path at all: Claude's MUNGED project
//       key, 'C--Users-<name>' / '-Users-<name>' (no colon, no separator),
//       which is how the session store spells a home directory and which turns
//       up inside temp paths. The roots are enumerated rather than wildcarded
//       on purpose: a greedy 'any path-ish run' prefix would also swallow the
//       host of 'https://site/users/<name>', and a ticker line must keep saying
//       WHAT was touched.
//
// Only the prefix through the account segment is rewritten to '~'; everything
// after it — separators, casing, the whole tail — is kept exactly as it was.
// Callers collapse BEFORE truncating, so the characters it frees buy back path
// tail inside the same width budget instead of shortening the line, and a line
// can never come out empty (the shortest possible result is '~').
//
// Deliberate consequence, unchanged from the first cut: matching the shape
// collapses ANY user's home of that shape, not only the local one. A stranger's
// home can therefore read on screen as if it were the viewer's — a display
// inaccuracy in the privacy-preserving direction, where the opposite failure
// (leaving a username on screen because it happens to belong to someone else)
// is the one that matters here. It stays conservative in the other direction: a
// bare '/home/<name>' or '/Users/<name>' is matched only when the name is the
// LEARNED one, the host of 'https://example.com/users/<name>' is deliberately
// NOT matched (a URL host must survive — that tradeoff is pinned in
// tests/dehome.test.mjs), and a profile directory whose name contains a space
// collapses only up to the space (the segment stops at whitespace), which is
// the safe direction — no over-eating of the rest of a command line.
//
// Cost: two precompiled regexes (the learned one recompiled only when the
// account name actually changes, i.e. never on a same-machine session swap),
// at most two .replace() calls per rendered line at the moment that line is
// built (per fired event or per hover, never per frame), behind a length guard
// that cannot skip a real match (the shortest matchable subject is '/home/x',
// 7 chars). A non-matching subject is returned unchanged and engines hand back
// the same string rather than building a copy, so the common case is a scan and
// no allocation; the HUD's update() stays allocation-free.
//
// NOT A REDACTION GUARANTEE, and must not be leaned on as one — it reads the
// SHAPE of a path plus one learned name. tools/pii-scan.mjs is the belt to
// these suspenders: it knows the real local home and can say the word out loud.

// tokens that can only introduce a filesystem root, each ending at the
// separator before 'Users'. Ordered most-specific-first so '\\?\C:\' is not
// mis-read as the UNC '\\<host>\'.
const H_ROOTS =
  'file:\\/{2,3}[A-Za-z]:[\\\\/]+' +                 // file:///C:/…
  '|file:\\/{2,3}' +                                 // file:///Users/…
  '|\\\\{2}\\?\\\\+UNC\\\\+[^\\\\/\\s"\'`]+\\\\+' +  // \\?\UNC\server\…
  '|\\\\{2}[?.]\\\\+[A-Za-z]:[\\\\/]+' +             // \\?\C:\…  \\.\C:\…
  '|\\\\{2}[^\\\\/\\s"\'`]+[\\\\/]+' +               // \\server\…
  '|[A-Za-z]:[\\\\/]+' +                             // C:\…  C:/…
  '|\\/mnt\\/[A-Za-z]\\/' +                          // /mnt/c/…
  '|\\/cygdrive\\/[A-Za-z]\\/' +                     // /cygdrive/c/…
  '|\\/[A-Za-z]\\/';                                 // /c/…
const H_SEG = '[^\\\\/\\s"\'`]+';        // path segment: stops at a separator, space or quote
const H_MSEG = '[^-\\\\/\\s"\'`]+';      // munged segment: also stops at the '-' separator
const H_MUNGE = '(?:[A-Za-z]--|-)';      // 'C--Users-…' / '-Users-…'
// left edge. A capture rather than a lookbehind (kept from the first cut: no
// engine-feature floor for a screen-shared tool), so the boundary character is
// handed back by the '$1' in the replacement. Path separators and '-' ARE
// admissible boundaries — the munged key turns up mid-path — and no longer risk
// mangling a longer path into '/mnt~/…' now that every root is spelled out.
const H_EDGE = '(^|[^A-Za-z0-9_.~])';
const HOME_SHAPE_RE = new RegExp(
  H_EDGE + '(?:(?:' + H_ROOTS + ')users[\\\\/]+' + H_SEG + '|' + H_MUNGE + 'users-' + H_MSEG + ')',
  'gi',
);

// account-name extraction from what the session reports. The path form wins so
// a hyphenated name survives whole; the munged key is the fallback.
const H_FROM_PATH = /[\\/](?:users|home)[\\/]+([^\\/\s"'`]+)/i;
const H_FROM_KEY = /(?:^|[-\\/])(?:users|home)-([^-\s"'`]+)/i;
const H_RX_ESC = /[.*+?^${}()|[\]\\]/g;
let homeName = null;                     // learned account segment, or null
let homeRe = null;                       // its compiled matcher, or null

/**
 * Learn the local account name from the playing session's own report. Sources
 * are tried in order and the first that yields a name wins; passing nothing (or
 * only sources with no home shape in them) clears the learned pass, leaving the
 * shape pass to do the work alone. Returns the name for callers/tests.
 *
 * Called once per session swap, from the surface that renders identity; every
 * other surface just calls dehome() and inherits the learned name.
 *
 * @param {...unknown} sources candidate strings (cwd, munged project key, …)
 * @returns {string|null} the learned account segment, or null
 */
export function learnHome(...sources) {
  let name = null;
  for (const src of sources) {
    if (typeof src !== 'string' || !src) continue;
    const m = H_FROM_PATH.exec(src) ?? H_FROM_KEY.exec(src);
    if (m && m[1]) { name = m[1]; break; }
  }
  if (name === homeName) return homeName;          // same machine: no recompile
  homeName = name;
  const lit = name ? name.replace(H_RX_ESC, '\\$&') : '';
  // Two branches with DIFFERENT trailing guards. The slash branch forbids a
  // following '-' so a learned 'pat' cannot half-match 'C:\Users\pat-lee'
  // (pass 2 then collapses it whole); the munged branch must allow '-', since
  // that is the separator that ends the segment in 'C--Users-you-myapp'.
  homeRe = name
    ? new RegExp(
        H_EDGE + '(?:(?:' + H_ROOTS + '|\\/)(?:users|home)[\\\\/]+' + lit + '(?![A-Za-z0-9_-])' +
        '|' + H_MUNGE + '(?:users|home)-' + lit + '(?![A-Za-z0-9_]))',
        'gi',
      )
    : null;
  return homeName;
}

/**
 * Collapse a home-directory prefix to '~' in any string about to be rendered.
 * Non-strings and anything too short to match are returned untouched, so this
 * is safe to wrap around an optional label without a guard at the call site.
 *
 * @param {unknown} s the raw transcript-derived string
 * @returns {unknown} the same value, with any home prefix rewritten to '~'
 */
export const dehome = (s) => {
  if (typeof s !== 'string' || s.length < 7) return s;
  const learned = homeRe ? s.replace(homeRe, '$1~') : s;
  return learned.replace(HOME_SHAPE_RE, '$1~');
};

export default { dehome, learnHome };
