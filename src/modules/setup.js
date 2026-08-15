// setup.js — IN-WORLD SETUP CONSOLE for C-SPACE. Pure DOM/CSS inside #hud, a
// sibling of library.js: same chip idiom (top-center, key S), same scrim, same
// typography, same fast fade/slide panel, ESC to close, its own <style> block,
// no THREE, no canvas, no ctx.pick registration, nothing touched at module
// scope (this file has to stay importable under `node --test`).
//
// WHAT IT IS FOR ------------------------------------------------------------
// First run used to be: hand-edit a JSON allowlist, run `npm run allowlist`,
// run `npm run build-library`, restart. This panel is that sequence, in world:
// tick the projects you want, press INGEST, watch the parse stream in, and the
// wall swaps IN PLACE to your own flagship session while the SomaFM <audio>
// element and the WebGL context keep running (SESSION SWAP CONTRACT, main.js).
// The demo keeps playing behind the panel the whole time — this is an overlay,
// never a modal, and never a gate on first paint.
//
// WHAT IT IS ALLOWED TO DO --------------------------------------------------
// The server is read-only with respect to its own configuration everywhere
// except /setup/*, and that surface is fenced (docs/setup-contract.md). The
// parts of the fence this file is responsible for:
//   F1  every mutation carries the per-run token from window.__CSPACE_SETUP in
//       the X-CSpace-Setup-Token header. It is never logged, never put in a URL
//       or a query string, never stored, never shown, and there is no field
//       anywhere in this panel that accepts one.
//   F2  the only thing sent over the wire is an opaque `p_…` id the server
//       itself enumerated. This file constructs no paths and sends none — grep
//       it for join/resolve and there is nothing to find.
//   F3  if GET /setup/state 404s (non-loopback bind, no runner, a plain static
//       server) the panel is not offered AT ALL: no chip, no key binding. The
//       surface either exists or it does not; we never advertise it.
//   F4  NO SELECT-ALL. No group tick, no "allow all", no shift-range, no
//       keyboard shortcut that ticks more than the row it is on. One click can
//       only ever expose one project — that is the whole point, because a
//       one-click select-all is how a sensitive workspace gets indexed by
//       accident. The allowlist FILE still honours ["*"]; a source that has one
//       renders locked with a line saying to edit the file by hand.
//   F5  the disclosure line is required copy, always visible next to the action
//       button, never behind a triangle: ingesting PARSES TRANSCRIPTS INTO A
//       DERIVED COPY ON DISK. A tick is not "viewing".
//   F6  no console line in this file — error handlers included — ever prints a
//       project label, a session title, or a path. Codes and counts only. That
//       line lands in screen-shares.
//
// READ-ONLY IS A FIRST-CLASS STATE, not an error: a page with no injected token,
// a token the runner has stopped honouring, or a surface the host mounted
// read-only renders the whole panel with every control disabled, plus WHICH of
// those three happened and the CLI equivalent. A dead tick that silently fails
// is worse than no tick at all.
//
// AND THE HOUSE RULE ABOVE ALL OF IT: THIS PANEL NEVER TURNS ITS OWN FAILURE
// INTO A CLAIM ABOUT THE OPERATOR'S MACHINE. "No harness store was found" is a
// finding, and a finding requires that C-Space actually looked. When discovery
// is unavailable the panel says C-Space could not enumerate — naming it as a
// C-Space fault — and says nothing whatsoever about what is or is not on disk.
// See discoveryOk() / renderDiscoveryFault().

// The one shared import in this file, and it is here for F6's sake: the rule
// that decides what a project row PAINTS lives in src/lib/labels.js and is used
// verbatim by library.js's PROJECT column too. It used to be copied into both
// files, which is exactly why a hole in it (a project whose cwd IS the home
// directory rendered as "c--users-<name>", the OS username, in this panel) had
// to be found twice and was found once.
import { compressProject } from '../lib/labels.js';

const STATE_URL = '/setup/state';
const ALLOW_URL = '/setup/allow';
const DENY_URL = '/setup/deny';
const BUILD_URL = '/setup/build';
const TOKEN_HEADER = 'X-CSpace-Setup-Token';

// The token is 43 base64url chars today; accept the documented range and refuse
// anything else rather than putting an unvetted string in a header.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
// Wire shape of a candidate id (contract §3.1). Belt and suspenders: the server
// re-derives and rejects unknown ids anyway, but nothing shaped like anything
// else should ever leave this file.
const ID_RE = /^p_[A-Za-z0-9_-]{22}$/;
const MAX_IDS = 200;          // server rejects >200 per mutation — chunk, never truncate
const FLUSH_MS = 350;         // tick coalescing window (see flushTicks)
const POLL_MS = 1000;         // build recovery poll (contract §5.1)

// The four stores C-Space knows how to read, for the "nothing found" state.
// NAMES ONLY — never their paths (F6 / contract §7 "never render a filesystem
// path other than state.dataDir / state.allowlistPath").
const KNOWN_SOURCES = [
  ['claude', 'CLAUDE CODE'],
  ['codex', 'CODEX'],
  ['hermes', 'HERMES'],
  ['openclaw', 'OPENCLAW'],
];

// ---- pure helpers ----------------------------------------------------------
// compressProject() is imported from src/lib/labels.js above, shared with
// library.js. Contract §7.2 asks this panel to reuse library.js's rule; it now
// reuses the module BOTH read from, which is the only version of "reuse" that
// cannot drift. §7.2's other clause — the raw label on the row's title= — is
// deliberately NOT honoured; see rowTitle() below for the ruling.

// ---------------------------------------------------------------------------
// DOES A LABEL READ AS PROSE? — the screen-share question
// ---------------------------------------------------------------------------
// A harness's "project" label is whatever that harness had to hand. Claude and
// Codex use the working directory; Hermes and OpenClaw use a content-derived
// session title. The server states the second fact statically (labelsAreTitles)
// and says nothing about the first, which is correct about PROVENANCE and wrong
// about EFFECT: a Codex label is the basename of the directory the operator was
// in, and an operator who starts a session in a directory named after the thing
// they were asking gets rows like "how-much-tax-do-i-owe-on" or
// "which-libraries-support-this" — their own questions, verbatim, in a panel
// that lands in screen-shares. Cautioning on the field it came out of misses
// that entirely.
//
// So the caution is driven by the SHAPE OF WHAT CAME BACK. These predicates
// answer "would a stranger read this row as a sentence?", which is the only
// question the operator actually has. They are deliberately conservative: a
// caution that fires on every group is a caution nobody reads, so a tidy slug
// ("harness-viz", "sprite-editor", "acme-api-v2") must measure clean.
//
// Function words: ordinary in a sentence, essentially absent from a directory
// name. Content verbs that are ordinary in repo names — build, make, set, run,
// test, get — are deliberately NOT here; including them would caution half of a
// developer's machine.
const PROSE_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'about', 'into', 'and', 'or', 'but', 'if', 'than', 'then', 'that', 'this',
  'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'my', 'me',
  'i', 'im', 'we', 'our', 'us', 'you', 'your', 'they', 'their', 'there', 'what',
  'how', 'why', 'when', 'where', 'who', 'which', 'whose', 'not', 'no', 'so',
  'as', 'too', 'any', 'some', 'much', 'many', 'more', 'most',
]);

// A label that OPENS with one of these is a question, not a name.
const QUESTION_LEAD = new Set([
  'if', 'what', 'how', 'why', 'when', 'where', 'who', 'whom', 'whose', 'which',
  'whether', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have', 'had',
]);

// A label that OPENS with one of these is somebody talking about themselves.
const PERSONAL_LEAD = new Set([
  'i', 'im', 'my', 'me', 'we', 'our', 'us', 'you', 'your', 'lets', 'please',
  'help', 'need', 'needs', 'looking', 'trying', 'want', 'wants', 'wondering',
  'thinking',
]);

const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Does this string read as a sentence or a question rather than as a name?
 *
 * Exported so it can be exercised directly — this is a heuristic, and a
 * heuristic with no seam is a heuristic that rots. Pure: no DOM, no state.
 */
export const readsAsProse = (label) => {
  const w = wordsOf(label);
  // Two words are a name ("harness-viz"), never a sentence.
  if (w.length < 3) return false;
  // "how-to-...", "how-much-...", "should-we-..." — an interrogative in
  // first position is decisive on its own; three words is enough.
  if (QUESTION_LEAD.has(w[0])) return true;
  if (w.length < 4) return false;
  // "i-m-trying-to-figure-out", "my-notes-about-the-thing".
  if (PERSONAL_LEAD.has(w[0])) return true;
  // Otherwise it takes grammar: two function words in one label is something a
  // slug almost never has and a sentence almost always does.
  let stop = 0;
  for (const t of w) if (PROSE_STOPWORDS.has(t)) stop++;
  return stop >= 2;
};

// ---------------------------------------------------------------------------
// WHAT A ROW PUTS ON ITS title= — AND WHY IT IS NOT THE RAW LABEL
// ---------------------------------------------------------------------------
// Contract §7.2 says "raw label on title= hover". THIS FILE NO LONGER DOES
// THAT, deliberately. docs/setup-contract.md is not this file's to edit, so the
// divergence is declared here and reported upward rather than left to be
// discovered: §7.2's hover clause is superseded and should be amended to
// "compressed label on hover; the raw label is never rendered".
//
// The raw label of a Claude project on Windows is the store's munged directory
// name — "C--Users-<name>-northwind". compressProject() takes the username off
// the text the row PAINTS; a raw title= put it straight back as a native
// browser tooltip, on every row, in the one panel whose whole subject is what
// this machine is about to show other people. On a first run that is ~21 rows
// each holding the OS username, one hover away, in a tool that is screen-shared
// and has a demo video in its README. The bar — the username renders nowhere,
// on any screen — outranks §7.2, so §7.2 loses.
//
// What replaces it keeps the useful half of the hover. The row is ellipsised
// (.setx-pname), so the tooltip still exists to spell out a label too long for
// its column: it carries the DISPLAYED label in full. The second line is only
// added when compression actually removed something, so a hermes/openclaw row —
// whose label is a session title, not a path, and is therefore already shown
// verbatim — never claims something was withheld when nothing was. That second
// line says "path", not "home directory": compression also fires on a bare
// drive prefix ("C--work-alpha") and on a worktree suffix, where no home
// directory is involved, and a privacy panel that overstates one line is a
// privacy panel nobody reads carefully.
//
// Note what is NOT here: a path. "The full path with the home segment
// collapsed" was the other sanctioned option and it was refused on the
// contract's own terms — §7 says this panel never renders a filesystem path
// other than state.dataDir and state.allowlistPath, and dehome() takes the
// USERNAME out of a path, not the path out of the panel. "~\clients\acme-bank\
// migration" carries no account name and is still a directory tree belonging to
// somebody who is not in the room. The compressed label is the one form that
// satisfies both rules at once.
// Second reason, for the record: this file owns no privacy rule of its own. It
// imports compressProject() from src/lib/labels.js and renders what comes back.
// A private "collapse the home segment" written here would have been another
// copy of src/lib/paths.js's dehome() — and a rule with N copies is a rule that
// gets fixed in N-1 of them, which is the whole reason this leak outlived five
// rounds of fixing its instances.
//
// Pure, exported so the rule has a seam that can be exercised without a DOM.
export const rowTitle = (shown, raw) => (
  String(shown) === String(raw)
    ? String(shown)
    : `${shown}\nRAW LABEL WITHHELD — IT IS THIS PROJECT'S PATH ON THIS MACHINE.`
);

const fmtN = (n) => (n == null || !isFinite(n) ? '—' : String(n));

// "1 SESSION" / "0 SESSIONS" / "— SESSIONS". Every count this panel prints goes
// through here rather than through an inline ternary, because the inline form is
// how "LIBRARY // 1 SESSIONS" got shipped: an unknown count still reads as a
// plural, and there is one place to be wrong instead of five.
const plural = (n, word, suffix = 'S') => `${fmtN(n)} ${word}${n === 1 ? '' : suffix}`;

const fmtAge = (ts) => {
  if (ts == null || !isFinite(ts)) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'JUST NOW';
  const m = s / 60;
  if (m < 90) return Math.round(m) + 'M AGO';
  const h = m / 60;
  if (h < 36) return Math.round(h) + 'H AGO';
  const d = h / 24;
  if (d < 60) return Math.round(d) + 'D AGO';
  return Math.round(d / 30) + 'MO AGO';
};

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Error codes are the contract's taxonomy (§4.3 / §5.2). The panel always shows
// the CODE — an operator pasting "wildcard-in-effect" into a search finds the
// answer — with a plain line under it. Never a raw stderr blob.
const ERR_COPY = {
  forbidden: 'THE RUNNER REFUSED THE WRITE — THIS PAGE IS READ-ONLY',
  'unknown-id': 'THE CANDIDATE LIST MOVED — RELOADED IT',
  'bad-request': 'THE RUNNER REJECTED THE REQUEST',
  'too-large': 'THE REQUEST WAS TOO LARGE',
  'unsupported-media-type': 'THE RUNNER REJECTED THE REQUEST',
  'build-in-progress': 'A BUILD IS ALREADY RUNNING',
  'nothing-allowed': 'NOTHING IS TICKED YET',
  'wildcard-in-effect': 'THIS SOURCE IS EXPOSED BY A "*" IN THE ALLOWLIST FILE — EDIT THE FILE BY HAND TO NARROW IT',
  'rate-limited': 'TOO MANY CHANGES TOO FAST — WAIT A MINUTE AND RETRY',
  'allowlist-write-failed': 'THE ALLOWLIST COULD NOT BE WRITTEN',
  'id-collision': 'INTERNAL ID COLLISION — NOTHING WAS WRITTEN',
  internal: 'THE RUNNER HIT AN INTERNAL ERROR',
  'build-failed': 'THE BUILD FAILED',
  'build-timeout': 'THE BUILD RAN PAST ITS TIME LIMIT',
  'no-flagship': 'THE BUILD PRODUCED NO PLAYABLE SESSION',
  'swap-refused': 'THE LIBRARY BUILT, BUT THE WALL COULD NOT SWAP IN PLACE',
  network: 'THE RUNNER STOPPED ANSWERING',
};

// The per-run token, injected into <head> by the runner (prod) or the vite
// plugin (dev). There is no endpoint that hands it out; this is the only place
// it is read. Never logged, never rendered, never persisted, never in a URL.
const readToken = () => {
  const boot = (typeof window !== 'undefined' && window.__CSPACE_SETUP) || null;
  return boot && typeof boot.token === 'string' && TOKEN_RE.test(boot.token) ? boot.token : null;
};

// GET /setup/state, shaped so the caller can tell "this surface does not exist"
// (a clean 404 — do not offer the panel) apart from "the request never landed"
// (status 0 — worth one retry). Never throws.
//
// THE TOKEN GATES DETAIL ON THIS ROUTE, NOT EXISTENCE. A token-less read still
// answers 200 — that is what keeps §2.5's read-only degradation possible — but
// it comes back `authenticated:false, mutable:false` with every `projects`
// array emptied, because project names are exactly what the allowlist exists to
// withhold from an unauthenticated local GET. So pass the token whenever we
// hold one: without it this panel would render its own machine as having no
// projects, which is the same class of lie as the discovery fault above.
const probeState = (tok) =>
  fetch(STATE_URL, {
    headers: tok
      ? { Accept: 'application/json', [TOKEN_HEADER]: tok }
      : { Accept: 'application/json' },
  })
    .then(async (r) => ({ status: r.status, state: r.ok ? await r.json().catch(() => null) : null }))
    .catch(() => ({ status: 0, state: null }));

export default {
  name: 'setup',

  init(ctx) {
    // Shot mode is deterministic by construction: no chip, no panel, no probe,
    // no key binding. ?freeze=1 stills must never catch setup chrome.
    if (ctx.params.get('freeze') === '1') return;

    // main.js fires the probe next to bootTimeline() so the answer is usually
    // already in flight by the time modules init — first paint never waits on
    // it. Falling back to our own probe keeps this module standalone.
    const first = ctx.setupProbe ?? probeState();

    // init() must not await: main.js awaits each module's init in turn, and
    // gating that on a network round-trip would put the setup surface on the
    // critical path to the first frame. Mount when (and if) the answer lands.
    Promise.resolve(first)
      .then(async (r) => {
        let state = r && r.status === 200 ? r.state : null;
        if (!state && r && r.status === 0) {
          // Transient failure, not a 404: the runner may still have been
          // binding. Exactly one retry, then give up silently.
          await new Promise((res) => setTimeout(res, 1500));
          const again = await probeState(readToken());
          if (again.status === 200) state = again.state;
        }
        if (!state || typeof state !== 'object') return;   // 404 ⇒ no surface at all (F3)
        this._panel = mount(ctx, state);
      })
      .catch((err) => {
        // Sandboxed by contract, but a rejection inside this .then would escape
        // main.js's try/catch, so swallow it here. Code only — never a label.
        console.warn('[c-space] setup panel unavailable:', err?.message ?? 'unknown');
      });
  },

  // SESSION SWAP — the panel's own finish calls swapSession, so reset() runs
  // while the panel is open and mid-"done". Nothing here is session-shaped (no
  // GPU resources, no timeline cursor, no ctx.pick entries): all it has to do is
  // re-adopt its chip into the #chips row if a rebuild elsewhere orphaned it,
  // and repaint — the action row reads ctx.playing, which the swap just rebound.
  reset() {
    this._panel?.reset?.();
  },

  // DOM-only module: every bit of motion is CSS.
  update() {},
};

// ---------------------------------------------------------------------------
// mount() — everything below here runs only once the surface is known to exist.
// ---------------------------------------------------------------------------
function mount(ctx, state0) {
  const C = ctx.CSS;

  const token = readToken();

  let state = state0;
  let readOnlyForced = false;   // set if a mutation ever comes back 403
  let lastError = null;         // { code, where } — shown, never thrown away silently
  let staleSinceBuild = false;  // ticks changed after the last successful build
  let forceReparse = false;
  let inFlight = false;         // an allow/deny round-trip is out
  let pollTimer = null;
  let flushTimer = null;
  let closeTimer = null;
  let streaming = false;        // we hold a live SSE body for the running build

  // THE PREVIOUS BUILD'S RECORD, HELD SO IT CAN BE REFUSED.
  // `state.build` is the RUNNER's account of a build and it reaches this page
  // only on a refresh — so between "we asked for a new build" and "the first
  // refresh lands" it still describes the PREVIOUS one. renderProgress prefers
  // it in exactly that window (server counts win while our stream is not the one
  // running), so pressing REBUILD used to paint one frame of the finished
  // build's bar and counts — 96.3%, PARSED 26 OF 27 — under a bar that had just
  // been reset to zero. A progress widget that describes the wrong build for
  // even one frame is lying about which build it is describing, and "it is only
  // one frame" is not a defence: that frame is the one the operator is looking
  // at, because they just clicked. So the record is invalidated the instant a
  // build is initiated, and stays invalid until the runner reports one that is
  // not it.
  let staleServerBuild = null;  // the record no frame may render, or null

  // A mutable state that we have no token for would render live ticks that
  // 403 on click — exactly the "dead tick that silently fails" the contract
  // forbids. Treat it as read-only and say so.
  const canMutate = () => !!(state?.mutable && token && !readOnlyForced);

  // Local tick overlay: a click paints immediately, the server's echo replaces
  // it. Cleared per id as each response lands.
  const desired = new Map();    // id → boolean the operator asked for
  const queued = new Map();     // id → boolean not yet sent
  let lastTouched = null;       // last id the operator toggled (focus restore)
  let refocus = null;           // set per render(); consumed by renderRow

  let build = idleBuild();

  function idleBuild() {
    return {
      status: 'idle', parsed: 0, cached: 0, failed: 0, total: 0,
      warnings: 0, error: null, flagship: null, note: null,
    };
  }

  // ---- style block --------------------------------------------------------
  const st = document.createElement('style');
  st.id = 'setx-style';
  st.textContent = `
.setx{position:absolute;inset:0;pointer-events:none;color:${C.hudText};
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 text-transform:uppercase;line-height:1.35;-webkit-font-smoothing:antialiased;user-select:none;}

/* shared scrim — the same darkness recipe as the library and the HUD blocks */
.setx-chip,.setx-panel{
 background:
  repeating-linear-gradient(0deg,transparent 0 2px,${C.cache}07 2px 3px),
  linear-gradient(168deg,${C.void}d9 0%,${C.void}b3 55%,${C.void}d9 100%);
 -webkit-backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 box-shadow:inset 0 0 0 1px ${C.hudDim}3a,0 0 18px ${C.void}99;}

/* --- affordance chip (mounts into the shared #chips row) --- */
.setx-chip{position:absolute;top:26px;left:50%;transform:translateX(-50%);
 pointer-events:auto;cursor:pointer;padding:8px 18px;
 font-size:9px;letter-spacing:.34em;color:${C.hudText};
 animation:setxIn .7s cubic-bezier(.2,.9,.2,1) .55s both;
 transition:color .15s ease,box-shadow .15s ease,text-shadow .15s ease;}
.setx-chip::before,.setx-chip::after{content:"";position:absolute;width:9px;height:9px;}
.setx-chip::before{top:0;left:0;border-top:1px solid ${C.output};border-left:1px solid ${C.output};}
.setx-chip::after{bottom:0;right:0;border-bottom:1px solid ${C.output};border-right:1px solid ${C.output};}
.setx-chip:hover,.setx-chip.on{color:${C.output};text-shadow:0 0 8px ${C.output}88;
 box-shadow:inset 0 0 0 1px ${C.output}66,0 0 18px ${C.void}99;}
.setx-chip.todo{color:${C.output};box-shadow:inset 0 0 0 1px ${C.output}55,0 0 18px ${C.void}99;}
.setx-key{color:${C.hudDim};margin-left:.7em;letter-spacing:.2em;}
.setx-chip:hover .setx-key,.setx-chip.on .setx-key{color:${C.output};}
@keyframes setxIn{from{opacity:0;transform:translate(-50%,6px);}to{opacity:1;transform:translate(-50%,0);}}

/* --- panel. Same geometry as the library panel, one layer above it: both are
   top-center overlays, and when an operator has opened both the newer intent
   should be the readable one.

   NO z-index HERE, DELIBERATELY. It used to carry z-index:6 to sit above the
   library panel, and that quietly broke a neighbour: this panel occupies the
   whole top-center band (x 720-1480, y 66-349 at 2200px) and the audio module's
   dropdown falls through exactly that band (x 999-1201, y 52-289). Every other
   overlay in #hud stacks at level 0 and orders by DOM position, so z-index:6
   hoisted a PERSISTENT panel over a TRANSIENT dropdown — elementFromPoint in
   the overlap returned .setx-ph / .setx-msg / .setx-foot and the audio mode
   items were unclickable for as long as setup was open (which, on first run, is
   from page load). At level 0 the natural order is right on both counts: .setx
   is appended after .libx (this module mounts inside a promise callback, the
   library mounts synchronously in init), so setup still paints over the
   library; and .audiox-menu is appended after both, so an open dropdown wins
   over a panel the operator is not currently pointing at.

   The root (.setx) is inset:0 but pointer-events:none, and stays that way —
   only the panel shell (when .open) and the chip are hit targets, so the full-
   viewport root never intercepts anything outside actual content. --- */
.setx-panel{position:absolute;top:66px;left:50%;width:min(760px,94vw);
 transform:translate(-50%,-10px);opacity:0;visibility:hidden;pointer-events:none;
 display:flex;flex-direction:column;max-height:min(78vh,760px);
 transition:opacity .16s cubic-bezier(.2,.9,.2,1),transform .16s cubic-bezier(.2,.9,.2,1),
  visibility 0s linear .16s;
 box-shadow:inset 0 0 0 1px ${C.output}33,0 0 30px ${C.void}cc;}
.setx-panel.open{opacity:1;visibility:visible;pointer-events:auto;
 transform:translate(-50%,0);transition-delay:0s;}

.setx-ph{display:flex;justify-content:space-between;align-items:baseline;
 padding:12px 16px 6px;border-bottom:1px solid ${C.output}2e;flex:none;}
.setx-title{font-size:9px;letter-spacing:.32em;color:${C.output};text-shadow:0 0 8px ${C.output}44;}
.setx-close{pointer-events:auto;cursor:pointer;font-size:8px;letter-spacing:.24em;color:${C.hudDim};}
.setx-close:hover{color:${C.hudText};}

.setx-body{overflow-y:auto;overflow-x:hidden;flex:1 1 auto;}
.setx-body::-webkit-scrollbar{width:6px;}
.setx-body::-webkit-scrollbar-thumb{background:${C.hudDim}66;}
.setx-body::-webkit-scrollbar-track{background:transparent;}

.setx-banner{padding:9px 16px;font-size:8.5px;letter-spacing:.16em;color:${C.hudText};
 border-bottom:1px solid ${C.hudDim}22;background:${C.output}0d;
 box-shadow:inset 2px 0 0 ${C.output};}
.setx-banner.err{background:${C.error}12;box-shadow:inset 2px 0 0 ${C.error};color:${C.hudText};}
.setx-banner b{color:${C.output};font-weight:400;}
.setx-banner .setx-code{color:${C.error};}

.setx-msg{padding:13px 16px;font-size:9px;letter-spacing:.2em;color:${C.hudDim};}
.setx-msg.lead{color:${C.hudText};letter-spacing:.16em;}

/* --- source group --- */
.setx-grp{display:flex;align-items:center;gap:10px;padding:9px 16px 8px;
 border-top:1px solid ${C.hudDim}22;font-size:9px;letter-spacing:.24em;
 color:${C.cache};cursor:pointer;transition:color .15s ease,background .15s ease;}
.setx-grp:hover{background:${C.cache}0d;color:${C.coreHot};}
.setx-grp.flat{cursor:default;}
.setx-grp.flat:hover{background:none;color:${C.cache};}
.setx-tw{width:10px;color:${C.hudDim};flex:none;}
.setx-gmeta{margin-left:auto;color:${C.hudDim};font-size:8px;letter-spacing:.18em;
 text-align:right;white-space:nowrap;}
.setx-tag{font-size:7.5px;letter-spacing:.2em;color:${C.hudDim};
 box-shadow:inset 0 0 0 1px ${C.hudDim}55;padding:1px 5px;white-space:nowrap;}
.setx-tag.live{color:${C.fresh};box-shadow:inset 0 0 0 1px ${C.fresh}66;}

.setx-note{padding:2px 16px 7px 40px;font-size:8px;letter-spacing:.14em;
 color:${C.hudDim};}

/* --- CAUTION BLOCK ---------------------------------------------------------
   A CAUTION IN THIS PANEL MAY NOT BE CARRIED BY COLOUR. C.output is the
   panel's GENERAL ACCENT: the title, every ticked [X], the INGEST/REBUILD
   button and the disclosure's emphasis are all this exact amber, so amber text
   reads as "this is the panel" and not as "stop and read this". The old rule
   was .setx-note.warn — accent colour on the smallest type in the panel, no
   glyph, no rule, no ground — which is a colour-only signal wearing the least
   emphatic typography available.
   Three signals here, and NONE of them is the colour:
     · a bracketed [!] in the panel's own glyph idiom ([X] / [ ] / [-] / [ESC]),
     · a ruled box on a hatched ground — the only boxed, hatched element in the
       panel, so it separates from flat accent text in greyscale and for a
       viewer who cannot tell amber from cyan,
     · the largest body type here (9.5px against 9px rows, 8.5px banners, 8px
       notes) instead of the smallest.
   Everything else stays the panel's idiom: same monospace, same tracking, same
   inset-shadow rule as .setx-tag, no foreign iconography, no rounded card. --- */
.setx-warn{display:grid;grid-template-columns:auto 1fr;gap:0 9px;align-items:start;
 margin:6px 16px 9px 24px;padding:8px 11px;
 font-size:9.5px;letter-spacing:.14em;line-height:1.55;color:${C.output};
 background:repeating-linear-gradient(135deg,${C.output}12 0 4px,transparent 4px 10px);
 box-shadow:inset 0 0 0 1px ${C.output}66,inset 4px 0 0 ${C.output};}
.setx-wmark{letter-spacing:.06em;white-space:nowrap;}
.setx-warn b{font-weight:400;text-shadow:0 0 8px ${C.output}55;}

/* --- project rows: one tick per row, and no control anywhere that ticks
   more than the row it sits on (F4). --- */
.setx-row{display:grid;grid-template-columns:16px minmax(110px,1fr) 46px 74px;
 gap:0 10px;align-items:center;padding:5px 16px 5px 24px;
 font-size:9px;letter-spacing:.14em;color:${C.hudDim};cursor:pointer;
 transition:background .12s ease,color .12s ease;}
.setx-row:hover{background:${C.cache}10;color:${C.hudText};}
.setx-row.on{color:${C.hudText};}
.setx-row.on .setx-tick{color:${C.output};text-shadow:0 0 7px ${C.output}66;}
.setx-row.dim{opacity:.5;}
.setx-row.locked,.setx-row.locked:hover{cursor:not-allowed;background:none;}
.setx-row.locked:not(.on):hover{color:${C.hudDim};}
.setx-row.locked .setx-tick{color:${C.hudDim};text-shadow:none;}
.setx-tick{color:${C.hudDim};white-space:nowrap;}
.setx-row:hover .setx-tick{color:${C.hudText};}
.setx-pname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:none;}
.setx-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.setx-age{text-align:right;font-size:8px;letter-spacing:.12em;white-space:nowrap;}
.setx-sub{padding:8px 16px 2px 24px;font-size:8px;letter-spacing:.2em;color:${C.hudDim};opacity:.8;}

/* --- footer: disclosure + action, always visible, never collapsed --- */
.setx-foot{flex:none;border-top:1px solid ${C.output}2e;padding:10px 16px 12px;}
.setx-disc{font-size:8px;letter-spacing:.11em;line-height:1.6;color:${C.hudText};
 opacity:.92;margin-bottom:9px;}
.setx-disc b{color:${C.output};font-weight:400;}
.setx-path{text-transform:none;color:${C.cache};}
.setx-act{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.setx-btn{pointer-events:auto;cursor:pointer;padding:6px 14px;font-size:9px;
 letter-spacing:.26em;color:${C.output};box-shadow:inset 0 0 0 1px ${C.output}66;
 transition:color .15s ease,box-shadow .15s ease,text-shadow .15s ease;white-space:nowrap;}
.setx-btn:hover{color:${C.coreHot};box-shadow:inset 0 0 0 1px ${C.output};
 text-shadow:0 0 8px ${C.output}66;}
.setx-btn.off,.setx-btn.off:hover{color:${C.hudDim};box-shadow:inset 0 0 0 1px ${C.hudDim}44;
 cursor:not-allowed;text-shadow:none;}
.setx-btn.ghost{color:${C.hudDim};box-shadow:inset 0 0 0 1px ${C.hudDim}44;letter-spacing:.2em;
 font-size:8px;padding:5px 10px;}
.setx-btn.ghost:hover{color:${C.hudText};box-shadow:inset 0 0 0 1px ${C.cache}66;text-shadow:none;}
.setx-btn.ghost.on{color:${C.output};box-shadow:inset 0 0 0 1px ${C.output}88;}
.setx-actnote{font-size:8px;letter-spacing:.14em;color:${C.hudDim};}
.setx-actnote.err{color:${C.error};}

.setx-prog{margin-top:10px;}
.setx-bar{height:3px;background:${C.void}cc;box-shadow:inset 0 0 0 1px ${C.hudDim}55;position:relative;}
.setx-fill{position:absolute;left:0;top:0;bottom:0;
 background:linear-gradient(90deg,${C.cache}77,${C.output});box-shadow:0 0 6px ${C.output}66;
 transition:width .2s linear;}
.setx-pnums{margin-top:5px;font-size:8px;letter-spacing:.16em;color:${C.hudDim};
 display:flex;gap:12px;flex-wrap:wrap;}
.setx-pnums .hot{color:${C.output};}
.setx-pnums .bad{color:${C.error};}
.setx-paths{margin-top:10px;font-size:7.5px;letter-spacing:.12em;color:${C.hudDim};opacity:.8;}
.setx-paths span{text-transform:none;}
`;
  document.head.appendChild(st);

  // ---- DOM ----------------------------------------------------------------
  const el = (tag, cls, parent, text) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    parent.appendChild(d);
    return d;
  };
  const div = (cls, parent, text) => el('div', cls, parent, text);

  const hud = document.getElementById('hud');
  const root = div('setx', hud ?? document.body);

  // Chip mounts into the shared #chips flex row (index.html) exactly as
  // library.js's does, so it sits beside LIBRARY and can never overlap it.
  const chipRow = () => document.getElementById('chips');
  const chip = div('setx-chip', chipRow() ?? root, 'SETUP');
  el('span', 'setx-key', chip, '[S]');

  const panel = div('setx-panel', root);
  const ph = div('setx-ph', panel);
  div('setx-title', ph, '// C-SPACE SETUP');
  const closeBtn = div('setx-close', ph, '[ESC] CLOSE');
  const body = div('setx-body', panel);
  const foot = div('setx-foot', panel);

  // Groups start expanded when they have something to show — the default first
  // run is "stores found, nothing allowed", and a collapsed panel would hide
  // the only thing the operator came here to do.
  const collapsed = new Set();

  // ---- derived views over state -------------------------------------------
  const sources = () => (Array.isArray(state?.sources) ? state.sources : []);
  const projectsOf = (s) => (Array.isArray(s?.projects) ? s.projects : []);
  const wildcarded = (sid) => !!state?.wildcards?.[sid];
  // What a row's tick shows: the operator's un-echoed click first, then the
  // server's truth.
  const isOn = (p) => (desired.has(p.id) ? desired.get(p.id) : !!p.allowed);
  const allowedCount = () => {
    let n = 0;
    for (const s of sources()) for (const p of projectsOf(s)) if (isOn(p)) n++;
    return n;
  };
  const anyStore = () => sources().some((s) => s.storePresent);
  const buildRunning = () => build.status === 'running' || state?.build?.status === 'running';

  // ---- which build is state.build talking about? ---------------------------
  // Two records are the same record if the runner says so: `buildId` is minted
  // per build (build-runner.mjs) so it is the reliable key. The timestamp/status
  // triple is the fallback for a runner old enough not to send one — never a
  // count comparison, because two consecutive builds of the same library have
  // identical counts, which is the whole reason this bug was invisible.
  const sameBuildRecord = (a, b) => (
    (a?.buildId != null || b?.buildId != null)
      ? a?.buildId === b?.buildId
      : (a?.startedAt ?? null) === (b?.startedAt ?? null)
        && (a?.finishedAt ?? null) === (b?.finishedAt ?? null)
        && (a?.status ?? null) === (b?.status ?? null)
  );

  /** Called the moment a new build is initiated. Drops `state.build` NOW — before
   *  any render() can read it — and remembers what was dropped so a refresh
   *  already in flight cannot quietly put it back. */
  function invalidateServerBuild() {
    const sb = state?.build;
    staleServerBuild = sb && typeof sb === 'object' ? sb : null;
    if (state && state.build != null) state = { ...state, build: null };
  }

  /** The guard is per-build, never permanent: every terminal outcome releases it,
   *  so a POST that never reached the runner cannot suppress the record for the
   *  rest of the page's life (which would blind us to a build started elsewhere). */
  const releaseServerBuild = () => { staleServerBuild = null; };

  // DID THE SERVER ACTUALLY LOOK? --------------------------------------------
  // setup-server reaches its enumerator through a lazy dynamic import and fails
  // CLOSED: if the module does not load it returns `{ sources: [] }` and every
  // mutation 404s. That is the right server behaviour and the wrong thing to
  // render blind, because an empty `sources` array reaching this panel used to
  // come out as "NO HARNESS STORE WAS FOUND ON THIS MACHINE … AND FOUND NONE" —
  // an assertion about the operator's disk that is flatly untrue when the truth
  // is that C-Space never opened a directory. A tool may report its own
  // failure; it may not launder that failure into a claim about the machine.
  //
  // The server now says so explicitly (state.discovery, contract §4.4). When
  // that field is absent — an older runner, or a state document from before it
  // landed — fall back to the SHAPE of the answer: enumerateCandidates always
  // emits the claude entry, `storePresent:false` when the store is missing
  // (§3.3), so a genuinely bare machine still arrives here as a non-empty
  // array. An EMPTY array is therefore never a fact about the machine; it is
  // the fail-closed signature. Erring this way is safe in the only direction
  // that matters: the worst case is C-Space blaming itself.
  const discoveryOk = () => (
    state?.discovery === 'ok' ? true
      : state?.discovery === 'unavailable' ? false
        : sources().length > 0
  );

  // ---- rendering ----------------------------------------------------------
  function render() {
    // The chip carries one bit of state even while the panel is shut: a runner
    // that could ingest but has nothing built yet.
    chip.classList.toggle('todo', !!(state?.mutable && !state?.library?.exists));
    // Rows are rebuilt wholesale, which drops keyboard focus mid-list. Put it
    // back on the row that was just toggled, but only when focus was inside the
    // panel to begin with — a mouse user should not suddenly grow a focus ring.
    refocus = body.contains(document.activeElement) ? lastTouched : null;
    // Nothing below is visible while the panel is closed, and a build streaming
    // 10 events/second into a hidden subtree is pure waste. setOpen(true)
    // rebuilds from `state` + `build`, so there is nothing to catch up on.
    if (!isOpen) return;
    const keepScroll = body.scrollTop;
    body.textContent = '';
    foot.textContent = '';
    renderBanners();
    if (!discoveryOk()) {
      // Fault first, then whatever partial list did arrive — a broken scan must
      // never HIDE data either, only stop us vouching for it as complete.
      renderDiscoveryFault();
      for (const s of sources()) renderSource(s);
    } else if (!anyStore()) renderNoStores();
    else for (const s of sources()) renderSource(s);
    renderFoot();
    body.scrollTop = keepScroll;
  }

  // 7.6 READ-ONLY — WHY, specifically. The banner used to name one cause: "the
  // setup runner is not attached (a dev server without the runner, or a server
  // not bound to loopback)". That sentence can never be true here. Both hosts
  // derive `mutable` from the SAME loopback predicate that gates registration
  // (cspace.mjs: SETUP_MUTABLE = isLoopbackBind(bound), passed to the factory
  // that returns a decline-everything handler off loopback; vite.config.js:
  // `if (!loopback) return;` before `mutable = true`), so a non-loopback bind
  // does not produce a read-only surface — it produces NO surface, /setup/state
  // 404s, and init() never mounts this panel at all (F3).
  //
  // The BRANCH is still live, for two causes the old copy never named, so it is
  // wired rather than deleted:
  //   no-token  the document arrived without a usable __CSPACE_SETUP bootstrap.
  //             Contract §2.3 explicitly permits the injector to skip an HTML
  //             file with no <head> and no <script>, and §2.5 row 2 specifies
  //             exactly this: token null + a 200 from /setup/state ⇒ read-only
  //             discovery.
  //   refused   a mutation came back 403. Tokens are per process and are not
  //             rotated, so a tab left open across a runner restart is holding
  //             a token the new process never minted. This one is actionable:
  //             reloading fixes it, and only this banner can say so.
  // `surface` (the server reporting mutable:false) is kept as the third arm
  // because setup-server enforces it structurally in mutationBody and takes
  // `mutable` as a public factory argument; if a host ever passes false, the
  // page must not render live ticks that 403 on click.
  function readOnlyReason() {
    if (!token) return 'no-token';
    // We hold a token and the server did not honour it: a 403 on a mutation, or
    // a state document that came back authenticated:false while we were sending
    // one. Same cause, same fix, so say the actionable thing.
    if (readOnlyForced || state?.authenticated === false) return 'refused';
    if (!state?.mutable) return 'surface';
    return null;
  }

  function renderBanners() {
    const why = canMutate() ? null : readOnlyReason();
    if (why) {
      // Everything below still renders — seeing what exists is useful — but
      // every control is inert and says why, with the CLI path.
      const b = div('setx-banner', body);
      const parts = [mk('b', 'READ-ONLY. ')];
      if (why === 'no-token') {
        parts.push(text(
          'THIS DOCUMENT WAS SERVED WITHOUT A SETUP TOKEN. THE RUNNER INJECTS ONE INTO ' +
          'THE HTML IT SERVES AND THIS PAGE DID NOT ARRIVE WITH IT — A PLAIN STATIC ' +
          'SERVER, A PREVIEW BUILD, OR A CACHED COPY. THE COUNTS BELOW ARE REAL, BUT ' +
          'PROJECT NAMES ARE WITHHELD FROM AN UNAUTHENTICATED READ AND THE TICKS ARE ' +
          'INERT. '));
      } else if (why === 'refused') {
        parts.push(text(
          'THE RUNNER REFUSED THIS PAGE\'S TOKEN. TOKENS ARE MINTED ONCE PER RUN AND ARE ' +
          'NEVER ROTATED, SO A TAB LEFT OPEN ACROSS A RESTART IS HOLDING ONE THE CURRENT ' +
          'PROCESS NEVER ISSUED — '),
          mk('b', 'RELOAD THIS PAGE'),
          text(' TO PICK UP THE NEW ONE. NOTHING WAS CHANGED. '));
      } else {
        parts.push(text(
          'THE RUNNER MOUNTED THIS SURFACE READ-ONLY, SO IT WILL NOT ACCEPT A CHANGE ' +
          'FROM THIS PAGE. '));
      }
      parts.push(
        text('CONFIGURE FROM THE CLI: '),
        mk('b', 'npm run allowlist'),
        text(' THEN '),
        mk('b', 'npm run build-library'),
        text('.'),
      );
      b.append(...parts);
    }
    if (lastError) {
      const b = div('setx-banner err', body);
      b.append(
        mk('span', lastError.code, 'setx-code'),
        text(' — ' + (ERR_COPY[lastError.code] ?? 'THE RUNNER REFUSED THAT CHANGE')),
      );
    }
  }

  // DISCOVERY UNAVAILABLE — a C-SPACE fault, stated as one.
  //
  // This is NOT §7.1. §7.1 is a finding about the operator's machine and is
  // only ever allowed to render when C-Space actually enumerated it. Here the
  // enumeration never happened, so every sentence below is about C-Space: it
  // names no store as absent, it does not say "none were found", and it tells
  // the operator in as many words not to read it as a statement about their
  // disk. The owner of this repo hit exactly this on a machine with 35 Claude
  // projects and 21 Codex sessions and was told he had none.
  //
  // No path, no code, no label goes on the console from here (F6); the reason
  // code is already on the RUNNER's console, where it is safe, so point there.
  function renderDiscoveryFault() {
    div('setx-msg lead', body, 'C-SPACE COULD NOT ENUMERATE THE PROJECTS ON THIS MACHINE.');
    div('setx-msg', body,
      'THIS IS A FAULT IN C-SPACE, NOT A FINDING ABOUT YOUR MACHINE. THE COMPONENT THAT ' +
      'LISTS CANDIDATE PROJECTS DID NOT LOAD, SO NOTHING WAS SCANNED AND THERE IS ' +
      'NOTHING FOR THIS PANEL TO OFFER.');
    div('setx-msg', body,
      'THIS PANEL IS NOT SAYING YOU HAVE NO HARNESS STORES — IT IS SAYING IT NEVER GOT ' +
      'A LIST. WHATEVER IS ON DISK IS UNTOUCHED, YOUR ALLOWLIST IS UNCHANGED, AND ' +
      'NOTHING HAS BEEN WRITTEN.');
    div('setx-msg', body,
      'THE RUNNER\'S CONSOLE PRINTED THE REASON CODE WHEN IT GAVE UP ON THE MODULE. ' +
      'THE CLI PATH DOES NOT GO THROUGH THIS SURFACE AND STILL WORKS.');
    const cli = div('setx-msg', body);
    cli.append(
      text('CONFIGURE FROM THE CLI: '),
      mk('b', 'npm run allowlist'),
      text(' THEN '),
      mk('b', 'npm run build-library'),
      text('.'),
    );
  }

  // 7.1 — no harness store on this machine. Reachable ONLY through discoveryOk()
  // above: a scan that happened, and came back empty.
  function renderNoStores() {
    div('setx-msg lead', body, 'NO HARNESS STORE WAS FOUND ON THIS MACHINE.');
    div('setx-msg', body,
      'C-SPACE LOOKED FOR ' + KNOWN_SOURCES.map(([, l]) => l).join(' · ') +
      ' IN THEIR STANDARD HOME-DIRECTORY LOCATIONS AND FOUND NONE.');
    div('setx-msg', body,
      'WHAT IS ON SCREEN RIGHT NOW IS THE BUNDLED SYNTHETIC DEMO — A FABRICATED SESSION ' +
      'SHIPPED WITH THE REPO. NOTHING IN IT CAME FROM A REAL TRANSCRIPT.');
    div('setx-msg', body,
      'RUN ONE OF THOSE HARNESSES ON THIS MACHINE, THEN REOPEN THIS PANEL.');
  }

  function renderSource(s) {
    const sid = String(s.id ?? '');
    const label = String(s.label ?? sid).toUpperCase();
    const projects = projectsOf(s);
    const wild = wildcarded(sid);
    const open = !collapsed.has(sid) && projects.length > 0;

    const g = div('setx-grp' + (projects.length ? '' : ' flat'), body);
    div('setx-tw', g, projects.length ? (open ? '[-]' : '[+]') : '   ');
    el('span', null, g, label);
    if (s.streamable) div('setx-tag live', g, 'LIVE');
    else if (s.storePresent) div('setx-tag', g, 'ARCHIVE');
    const declared = s.projectCount ?? projects.length;
    div('setx-gmeta', g, s.storePresent
      ? `${plural(s.sessionsTotal, 'SESSION')} · ${plural(declared, 'PROJECT')}` +
        (s.allowedCount ? ` · ${fmtN(s.allowedCount)} ALLOWED` : '')
      : 'NOT ON THIS MACHINE');
    if (projects.length) {
      g.addEventListener('click', () => {
        if (collapsed.has(sid)) collapsed.delete(sid); else collapsed.add(sid);
        render();
      });
    }
    // The server counted projects here and then withheld their names, because
    // this page is reading /setup/state without a token. Say which of the two
    // it is: an empty row list under a non-zero count must not be left to read
    // as "this store has nothing in it".
    // ABOVE THE FOLD, DELIBERATELY. This used to sit below `if (!open) return`,
    // so a collapsed group carried no warning at all — and a collapsed group is
    // precisely the state in which the operator is deciding whether to expand,
    // or whether this panel is safe to have open on a shared screen. A caution
    // you have to expand something to read is a caution that arrives after the
    // decision it was meant to inform.
    const caution = labelCaution(s, projects, open);
    if (caution) renderCaution(body, caution);

    if (declared > 0 && projects.length === 0) {
      // A PLAIN NOTE, NOT A CAUTION. This says "the list you are looking at is
      // short because names were withheld, not because the store is empty" — it
      // corrects a misreading of the panel and warns about nothing. It used to
      // render in the caution style, which is a third of the reason the real
      // caution had no force left: a warning treatment spent on non-warnings is
      // a warning treatment that stops meaning anything.
      div('setx-note', body,
        `${plural(declared, 'PROJECT')} FOUND HERE — THEIR NAMES ARE WITHHELD FROM AN ` +
        'UNAUTHENTICATED READ, WHICH IS WHY NO ROWS ARE LISTED. THIS IS NOT AN EMPTY STORE.');
      return;
    }
    if (!open) return;

    if (wild) {
      // This one IS a caution, and the strongest in the panel: every project of
      // this source is already exposed and no tick on screen can narrow it.
      renderCaution(body,
        'THE ALLOWLIST FILE EXPOSES EVERY PROJECT OF THIS SOURCE WITH "*". ' +
        'THIS PANEL WILL NOT REWRITE A WILDCARD — EDIT THE FILE BY HAND TO NARROW IT.');
    }

    const here = projects.filter((p) => p.onThisMachine !== false);
    const gone = projects.filter((p) => p.onThisMachine === false);
    for (const p of here) renderRow(s, p, wild, false);
    if (gone.length) {
      div('setx-sub', body, '// CONFIGURED, NOT ON THIS MACHINE');
      for (const p of gone) renderRow(s, p, wild, true);
    }
  }

  // The exact string a row paints for a project. Shared with labelCaution() on
  // purpose: the caution has to be measured on WHAT IS DISPLAYED, not on the raw
  // field it came from, or it can warn about words the panel never shows (and
  // stay silent about ones it does).
  const displayLabel = (s, p) => (
    s.labelsAreTitles ? String(p.label) : compressProject(p.label)
  );

  /**
   * EVERY caution in this panel is drawn here, and there is no other way to
   * draw one — a second call site is how "a caution" decayed into "some amber
   * text" the first time. The block leads with the word CAUTION rather than
   * with a statistic: "9 OF 17 LABELS HERE READ AS…" opens as a measurement,
   * and a reader skimming a dense panel has to finish the sentence before
   * learning it was a warning at all. The number is still there; it is just not
   * the first thing said.
   */
  function renderCaution(parent, sentence) {
    const w = div('setx-warn', parent);
    el('span', 'setx-wmark', w, '[!]');
    const line = el('span', null, w);
    line.append(mk('b', 'CAUTION — '), text(sentence));
    return w;
  }

  /**
   * The line that says what this group is about to put — or has already put —
   * on the glass. `null` when there is nothing to caution about.
   *
   * BOTH SIGNALS ARE KEPT, BECAUSE THEY ARE DIFFERENT CLAIMS.
   *
   * `labelsAreTitles` is a PROVENANCE fact the server states statically for
   * hermes and openclaw: their "project" is content-derived, so ticking a row
   * exposes the title as well as the sessions beneath it. That is true of a
   * title like "auth" exactly as much as of "why is my token expiring" — shape
   * cannot see it, and it is a fact about what a TICK does, not about what the
   * panel renders. Dropping it in favour of shape alone would lose it.
   *
   * The shape signal is the one that was missing, and it is the one that decides
   * whether this panel is safe on a shared screen. It is measured over
   * displayLabel(), it applies to every source equally — codex is not named
   * anywhere in this file, and a Claude directory phrased as a question is
   * cautioned on exactly the same terms — and it reports the COUNT it measured
   * rather than asserting a blanket property of the harness. A harness whose
   * labels are tidy slugs measures zero and is left alone, which is what keeps
   * this from becoming furniture.
   *
   * Counts only in the copy (F6 applies to the console; this is the local page,
   * but there is no reason to quote a label back at the operator to tell them
   * their labels are quotable).
   */
  function labelCaution(s, projects, open) {
    // A STORE THAT IS NOT ON THIS MACHINE CANNOT EXPOSE ANYTHING.
    // `labelsAreTitles` is declared statically per harness, so hermes and
    // openclaw asserted it even with storePresent:false, 0 sessions, 0 projects
    // and no row to tick — and a true first run therefore opened with three
    // caution blocks of which exactly one described anything real. Warning
    // about what a tick would expose, under a group whose own meta line reads
    // NOT ON THIS MACHINE and which has no tick, is precisely the furniture
    // this file's own comment above says a caution must never become: the two
    // fake ones train the operator to skip the third.
    if (!s.storePresent) return null;
    const shown = projects
      .filter((p) => p.label != null && p.label !== '')
      .map((p) => displayLabel(s, p));
    const prose = shown.reduce((n, t) => n + (readsAsProse(t) ? 1 : 0), 0);
    const titles = !!s.labelsAreTitles;
    if (!prose && !titles) return null;

    const parts = [];
    if (prose) {
      parts.push(
        'THE LABELS IN THIS GROUP CAN BE YOUR OWN WORDING, NOT FOLDER NAMES — THIS ' +
        'HARNESS NAMES A PROJECT AFTER WHATEVER IT HAD TO HAND. ' +
        `${fmtN(prose)} OF ${plural(shown.length, 'LABEL')} HERE READ AS SENTENCES OR ` +
        'QUESTIONS. ' +
        // Say which it is. Telling an operator that expanding will put their own
        // questions on screen, while the rows are already showing them, is the
        // kind of small inaccuracy that teaches people to skim these lines.
        (open ? 'THE ROWS BELOW ARE SHOWING IT VERBATIM RIGHT NOW.'
          : 'EXPANDING THIS GROUP PUTS IT ON SCREEN VERBATIM.'));
    }
    if (titles) {
      parts.push(prose
        ? 'THEY ARE ALSO SESSION TITLES, NOT PROJECT FOLDERS: TICKING ONE EXPOSES THE ' +
          'TITLE AS WELL AS THE SESSION.'
        : 'THESE LABELS ARE SESSION TITLES, NOT PROJECT FOLDERS — TICKING ONE EXPOSES ' +
          'THE TITLE AS WELL AS THE SESSION.');
    }
    return parts.join(' ');
  }

  function renderRow(s, p, wild, absent) {
    const id = typeof p.id === 'string' && ID_RE.test(p.id) ? p.id : null;
    const on = wild ? true : isOn(p);
    // Locked: a wildcard row (never rewritten from the UI), a row whose id the
    // server did not shape as expected, a read-only page, a build in flight, or
    // a project that is not on this machine and not currently allowed — there is
    // nothing to tick on, only something to untick.
    const locked = wild || !id || !canMutate() || buildRunning() || (absent && !on);

    const row = div('setx-row' + (on ? ' on' : '') + (absent ? ' dim' : '') +
      (locked ? ' locked' : ''), body);
    div('setx-tick', row, on ? '[X]' : '[ ]');

    const unlabelled = p.label == null || p.label === '';
    // hermes/openclaw "projects" are session titles: compressing them the way a
    // path-shaped Claude slug is compressed would mangle them. displayLabel()
    // owns that rule so the caution above measures this exact string.
    const shown = unlabelled ? 'UNLABELLED SESSIONS' : displayLabel(s, p);
    const name = div('setx-pname', row, shown);
    // THE HOVER IS NOT THE RAW LABEL — see rowTitle() at the top of this file
    // for the ruling and for why §7.2 diverges here. A title= attribute is a
    // rendered surface like any other: it lands in screen-shares, it is not
    // covered by the row's compression, and it is the last place in this panel
    // that still spelled out the OS username.
    name.title = unlabelled
      ? 'SESSIONS WHOSE PROJECT LABEL COULD NOT BE RECOVERED. THIS ROW IS THE ALLOWLIST\'S "*" MATCH FOR UNLABELLED SESSIONS, NOT A NAMED PROJECT.'
      : rowTitle(shown, p.label);

    div('setx-num', row, fmtN(p.sessions));
    div('setx-age', row, p.sessions ? fmtAge(p.lastActiveAt) : '');

    if (unlabelled) {
      div('setx-note', body,
        'UNLABELLED SESSIONS CORRESPOND TO THE ALLOWLIST\'S "*" MATCH FOR SESSIONS ' +
        'WITH NO RECOVERABLE PROJECT, NOT TO A NAMED PROJECT.');
    }

    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', on ? 'true' : 'false');
    if (locked) {
      row.setAttribute('aria-disabled', 'true');
      return;
    }
    row.tabIndex = 0;
    if (refocus && refocus === id) row.focus();
    // ONE ROW PER CLICK. There is deliberately no modifier, no range, no group
    // tick and no keyboard shortcut here that reaches a second row (F4).
    const hit = () => toggle(id, !on);
    row.addEventListener('click', hit);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        hit();
      }
    });
  }

  function renderFoot() {
    // Nothing enumerated ⇒ nothing to ingest, and the §7.4 disclosure would be
    // describing an action that cannot be taken. Same shape as §7.1's footer.
    if (!discoveryOk() || !anyStore()) {
      const act = div('setx-act', foot);
      const close = div('setx-btn ghost', act, 'CLOSE');
      close.addEventListener('click', () => setOpen(false));
      renderPaths();
      return;
    }

    // 7.4 — REQUIRED COPY. Adjacent to the action, never collapsed, never
    // softened into implying a tick is "just viewing".
    const disc = div('setx-disc', foot);
    disc.append(
      text('INGESTING '),
      mk('b', 'PARSES THE TRANSCRIPTS OF THE TICKED PROJECTS INTO A DERIVED COPY ON DISK'),
      text(' AT '),
      mk('span', state?.dataDir ?? '~/.cspace/data', 'setx-path'),
      text('. THAT COPY IS WHAT C-SPACE PLAYS BACK, AND ANYTHING THAT CAN READ YOUR HOME ' +
        'DIRECTORY CAN READ IT. NOTHING IS UPLOADED, AND NOTHING IS WRITTEN BACK TO THE ' +
        'HARNESS STORES.'),
    );

    const lib = state?.library ?? {};
    const n = allowedCount();
    const running = buildRunning();
    const built = !!lib.exists;

    const act = div('setx-act', foot);
    // 7.4: once a library exists the action is a REBUILD, not an INGEST — a tick
    // change after a build makes what is on the wall stale, and the button has
    // to say which of the two things it is about to do.
    const label = built
      ? 'REBUILD LIBRARY'
      : `INGEST ${plural(n, 'PROJECT')}`;
    const usable = canMutate() && n > 0 && !running && !inFlight;
    const btn = div('setx-btn' + (usable ? '' : ' off'), act,
      build.status === 'failed' ? 'RETRY BUILD' : label);
    if (usable) btn.addEventListener('click', () => startBuild(forceReparse));

    if (built && canMutate()) {
      const f = div('setx-btn ghost' + (forceReparse ? ' on' : ''), act,
        (forceReparse ? '[X]' : '[ ]') + ' FORCE REPARSE');
      f.title = 'RE-PARSE SESSIONS THAT ARE ALREADY CACHED';
      if (!running) f.addEventListener('click', () => { forceReparse = !forceReparse; render(); });
    }

    const note = div('setx-actnote', act);
    if (running) note.textContent = 'BUILDING…';
    else if (!canMutate()) note.textContent = 'READ-ONLY — USE THE CLI';
    else if (n === 0) note.textContent = 'TICK AT LEAST ONE PROJECT';
    else if (staleSinceBuild) note.textContent = 'TICKS CHANGED SINCE THE LAST BUILD — LIBRARY IS STALE';
    else if (inFlight) note.textContent = 'SAVING…';
    else note.textContent = `${plural(n, 'PROJECT')} ALLOWED`;

    if (built) {
      const fl = lib.flagship ?? null;
      div('setx-msg', foot,
        `LIBRARY // ${plural(lib.sessions, 'SESSION')} · BUILT ${fmtAge(lib.builtAt)}` +
        (fl ? ` · FLAGSHIP ${String(fl.id ?? '').slice(0, 8)} (${String(fl.source ?? '—').toUpperCase()})` : ''));
    } else if (n > 0) {
      // 7.3 — allowed, never built.
      div('setx-msg', foot, 'NO LIBRARY HAS BEEN BUILT YET. INGEST TO PARSE AND PLAY THEM HERE.');
    }

    renderProgress();
    renderPaths();
  }

  function renderProgress() {
    const running = buildRunning();
    const failed = build.status === 'failed';
    const done = build.status === 'done';
    if (!running && !failed && !done) return;

    // Server-side counts win while our stream is not the one running (a build
    // started before this page loaded, or a stream we lost). Safe to prefer
    // blind ONLY because state.build is nulled the instant a build is initiated
    // and stays null until the runner reports the new one — see
    // invalidateServerBuild(). An absent record reads as zeros, which is the
    // truth about a build that has not reported anything yet.
    const sb = state?.build ?? {};
    const parsed = running && !streaming ? (sb.parsed ?? 0) : build.parsed;
    const total = running && !streaming ? (sb.total ?? 0) : build.total;
    const cached = build.cached;
    const bad = running && !streaming ? (sb.failed ?? 0) : build.failed;

    const wrap = div('setx-prog', foot);
    if (running) {
      const bar = div('setx-bar', wrap);
      const frac = total > 0 ? Math.min((parsed + cached) / total, 1) : 0;
      div('setx-fill', bar).style.width = (frac * 100).toFixed(1) + '%';
    }
    const nums = div('setx-pnums', wrap);
    if (running || done) {
      el('span', 'hot', nums, `PARSED ${fmtN(parsed)}`);
      el('span', null, nums, `CACHED ${fmtN(cached)}`);
      el('span', bad ? 'bad' : null, nums, `FAILED ${fmtN(bad)}`);
      el('span', null, nums, `OF ${fmtN(total)}`);
    }
    if (build.warnings) {
      el('span', 'bad', nums,
        `${plural(build.warnings, 'SESSION')} COULD NOT BE PARSED`);
    }
    if (done && build.note === 'reload-to-apply') {
      div('setx-msg', wrap,
        'LIBRARY BUILT. THIS PAGE IS STREAMING A LIVE SESSION, SO IT WILL NOT SWAP IN ' +
        'PLACE — RELOAD TO APPLY.');
    } else if (done) {
      div('setx-msg', wrap, 'LIBRARY BUILT — PLAYING YOUR FLAGSHIP SESSION.');
    }
    if (failed) {
      const m = div('setx-msg', wrap);
      m.append(
        text('BUILD FAILED // '),
        mk('span', build.error ?? 'unknown', 'setx-code'),
        text(' — ' + (ERR_COPY[build.error] ?? 'THE BUILD DID NOT COMPLETE') + '. '),
        text('THE TICKS ABOVE ARE UNCHANGED. THE CLI EQUIVALENT IS '),
        mk('b', 'npm run build-library'),
        text('.'),
      );
    }
  }

  function renderPaths() {
    // Display only, and the only two paths this panel is allowed to render.
    // No endpoint accepts either of them back.
    const p = div('setx-paths', foot);
    p.append(text('ALLOWLIST '), mk('span', state?.allowlistPath ?? '—'));
    if (state?.allowlistWritable === false) p.append(text('  (NOT WRITABLE)'));
  }

  // small helpers for mixed-format lines
  function mk(tag, txt, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = txt;
    return n;
  }
  function text(t) { return document.createTextNode(t); }

  // ---- mutations ----------------------------------------------------------
  // A tick paints immediately and is coalesced into one request: ticking eight
  // projects in four seconds must be one allowlist write, not eight (the server
  // rate-limits at 30/min, and a partially-applied tick list is a worse outcome
  // than a batched one). Closing the panel flushes immediately, so a tick is
  // never lost by walking away — that is the "allowed but never built" state
  // the contract expects to find on reopen.
  function toggle(id, on) {
    if (!id || !canMutate()) return;
    // A tick invalidates the previous build report: leaving "LIBRARY BUILT —
    // PLAYING YOUR FLAGSHIP" on screen next to "TICKS CHANGED SINCE THE LAST
    // BUILD" would be two contradictory claims about the same library.
    if (build.status === 'done' || build.status === 'failed') build = idleBuild();
    lastTouched = id;
    desired.set(id, on);
    queued.set(id, on);
    lastError = null;
    render();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTicks(); }, FLUSH_MS);
  }

  async function flushTicks() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!queued.size || !canMutate()) return;
    // A round-trip is already out: come back rather than dropping the queue on
    // the floor — a tick that vanished because it was clicked at the wrong
    // moment is exactly the silent failure this panel must never produce.
    if (inFlight) { flushTimer = setTimeout(() => { flushTicks(); }, FLUSH_MS); return; }
    const batch = [...queued];
    queued.clear();
    const allow = batch.filter(([, v]) => v).map(([id]) => id);
    const deny = batch.filter(([, v]) => !v).map(([id]) => id);

    inFlight = true;
    render();
    try {
      for (const ids of chunk(allow, MAX_IDS)) await mutate(ALLOW_URL, ids);
      for (const ids of chunk(deny, MAX_IDS)) await mutate(DENY_URL, ids);
      // The server's echo is truth now — except for ids the operator re-ticked
      // while this request was out, whose newer intent is still queued.
      for (const [id] of batch) if (!queued.has(id)) desired.delete(id);
    } catch (err) {
      // Rejected: drop the optimistic overlay for this batch and re-read the
      // truth, so a refused tick never looks applied.
      for (const [id] of batch) if (!queued.has(id)) desired.delete(id);
      lastError = { code: err.code ?? 'network' };
      console.warn('[c-space] setup: allowlist change refused —', lastError.code);
      await refresh();
    } finally {
      inFlight = false;
      render();
    }
  }

  // POST a bounded verb. Body carries ONLY server-minted ids — no path, no
  // label, no free text, ever.
  async function mutate(url, ids) {
    const clean = ids.filter((id) => ID_RE.test(id));
    if (!clean.length) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify({ ids: clean }),
    }).catch(() => null);
    if (!res) throw Object.assign(new Error('network'), { code: 'network' });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const code = typeof j?.error === 'string' ? j.error : 'http-' + res.status;
      // 403 means this page is not (or no longer) trusted to write. Never retry,
      // never ask for a token, never offer a field to paste one into: fall back
      // to the read-only presentation for the rest of this page's life.
      if (res.status === 403) readOnlyForced = true;
      throw Object.assign(new Error(code), { code });
    }
    const next = await res.json().catch(() => null);
    if (next && typeof next === 'object') {
      state = next;
      if (next.changed && state.library?.exists) staleSinceBuild = true;
    }
  }

  async function refresh() {
    const r = await probeState(token);
    if (r.status === 200 && r.state && typeof r.state === 'object') {
      state = r.state;
      // A read that was already out when the build was initiated answers with
      // the record we just invalidated. Keep dropping it — the alternative is
      // the previous build's numbers reappearing under the new build's bar one
      // poll after we cleared them.
      if (staleServerBuild) {
        if (sameBuildRecord(state.build, staleServerBuild)) state = { ...state, build: null };
        else staleServerBuild = null;      // the runner is talking about the new build now
      }
    } else if (r.status === 404) { state = { ...state, mutable: false }; }
    return state;
  }

  // ---- build --------------------------------------------------------------
  async function startBuild(force) {
    if (!canMutate() || buildRunning()) return;
    // Reset BOTH accounts of "the build" before the first paint, not just ours.
    // `build` is this page's; `state.build` is the runner's, and it still holds
    // the finished build until a refresh lands.
    invalidateServerBuild();
    build = { ...idleBuild(), status: 'running' };
    lastError = null;
    streaming = false;
    render();

    let res;
    try {
      res = await fetch(BUILD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
        body: JSON.stringify(force ? { force: true } : {}),
      });
    } catch {
      return failBuild('network');
    }
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const code = typeof j?.error === 'string' ? j.error : 'http-' + res.status;
      if (res.status === 403) readOnlyForced = true;
      failBuild(code);
      await refresh();
      render();
      return;
    }
    // The token travels in a header, which EventSource cannot set, so the
    // progress stream IS this response body. Read it with a TextDecoder and
    // split on the SSE frame separator.
    if (!res.body || typeof res.body.getReader !== 'function') {
      startPoll();          // no streaming body available — recover by polling
      return;
    }
    streaming = true;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          handleFrame(frame);
        }
        // A frame this big is not a frame. Never buffer without a ceiling.
        if (buf.length > 65536) buf = buf.slice(-1024);
        if (build.status !== 'running') break;   // terminal event already handled
      }
    } catch {
      /* stream dropped — the child keeps building; fall through to polling */
    }
    // Release the body explicitly. A terminal event breaks the read loop with
    // the stream still open, and leaving it to GC shows up as an aborted
    // request in devtools for a build that in fact succeeded.
    try { await reader.cancel(); } catch { /* already closed */ }
    streaming = false;
    if (build.status === 'running') startPoll();
  }

  function handleFrame(frame) {
    let ev = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    let d = null;
    try { d = data.length ? JSON.parse(data.join('\n')) : null; } catch { return; }
    if (ev === 'ping') return;
    if (ev === 'started') {
      build.total = Number(d?.total) || 0;
      render();
    } else if (ev === 'progress') {
      build.parsed = Number(d?.parsed) || 0;
      build.cached = Number(d?.cached) || 0;
      build.failed = Number(d?.failed) || 0;
      build.total = Number(d?.total) || build.total;
      render();
    } else if (ev === 'warning') {
      build.warnings++;
      render();
    } else if (ev === 'done') {
      build.parsed = Number(d?.parsed) || build.parsed;
      build.cached = Number(d?.cached) || build.cached;
      build.failed = Number(d?.failed) || build.failed;
      build.total = Number(d?.total) || build.total;
      build.flagship = d?.flagship ?? null;
      finishBuild(build.flagship);
    } else if (ev === 'error') {
      failBuild(typeof d?.code === 'string' ? d.code : 'build-failed');
    }
  }

  function failBuild(code) {
    stopPoll();
    releaseServerBuild();
    streaming = false;
    build.status = 'failed';
    build.error = code;
    console.warn('[c-space] setup: build failed —', code);
    render();
  }

  // THE SWAP — the point of the whole round. The library was just rewritten, so
  // /data/session.json is now the operator's own flagship: load it in place
  // (session: null) rather than reloading the page, and the audio element, the
  // WebGL context and the renderer all survive the cut.
  async function finishBuild(flagship) {
    stopPoll();
    releaseServerBuild();                  // the record below is the build that just ended
    streaming = false;
    build.status = 'done';
    staleSinceBuild = false;
    await refresh();                       // library block reflects the new build
    if (!flagship) return failBuild('no-flagship');

    // swapSession is archive-only: swapping out from under a live stream would
    // orphan its EventSource. Complete the build, say so, and let the operator
    // reload — never swap while live.
    const live = ctx.playing?.mode === 'live';
    if (live || typeof ctx.swapSession !== 'function') {
      build.note = 'reload-to-apply';
      render();
      return;
    }
    // Read the mode BEFORE the swap: ctx.playing is rebound by it.
    const attract = ctx.playing?.mode === 'attract';
    render();
    let ok = false;
    try { ok = await ctx.swapSession({ session: null, attract }); } catch { ok = false; }
    if (!ok) {
      // Never retry in a loop — one honest failure with the CLI equivalent.
      build.note = 'reload-to-apply';
      return failBuild('swap-refused');
    }
    render();
    // The wall is the reward: get out of its way, but leave the chip so the
    // panel is one keystroke from coming back.
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (build.status === 'done') setOpen(false); }, 2400);
  }

  // ---- build recovery poll (contract §5.1) --------------------------------
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      await refresh();
      const sb = state?.build ?? {};
      if (sb.status === 'running') { render(); return; }
      stopPoll();
      if (build.status !== 'running') { render(); return; }
      // The build ended while we were polling: reconstruct the outcome from the
      // state block, which is refreshed after the child exits.
      build.parsed = Number(sb.parsed) || build.parsed;
      build.failed = Number(sb.failed) || build.failed;
      build.total = Number(sb.total) || build.total;
      if (sb.error) return failBuild(String(sb.error));
      finishBuild(state?.library?.flagship ?? null);
    }, POLL_MS);
  }
  function stopPoll() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---- open / close -------------------------------------------------------
  let isOpen = false;
  function setOpen(v) {
    isOpen = v;
    panel.classList.toggle('open', v);
    chip.classList.toggle('on', v);
    clearTimeout(closeTimer);
    if (v) {
      render();
      refresh().then(() => {
        render();
        if (state?.build?.status === 'running' && !streaming) startPoll();
      });
    } else {
      // Ticks are never lost by closing the panel.
      if (queued.size) flushTicks();
    }
  }
  const toggleOpen = () => setOpen(!isOpen);

  chip.addEventListener('click', toggleOpen);
  closeBtn.addEventListener('click', () => setOpen(false));
  addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.key === 's' || e.key === 'S') && !e.repeat) toggleOpen();
    else if (e.key === 'Escape' && isOpen) setOpen(false);
  });

  render();

  // AUTO-OPEN, once per page load: a machine with the runner attached and no
  // library has nothing else to do — the demo is playing behind the panel, so
  // this interrupts nothing. ?setup=1 forces it open for everyone else.
  // (mount() runs at most once per page load, so "once per page load" needs no
  // flag of its own.)
  function settle() {
    if (ctx.params.get('setup') === '1' || (state?.mutable && !state?.library?.exists)) {
      setOpen(true);
    }
    if (state?.build?.status === 'running') startPoll();
  }

  // The boot probe main.js hands us is token-less on purpose: it runs before
  // this module exists and only has to answer "does the surface exist". Under
  // the two-detail-level state route that answer arrives as authenticated:false
  // / mutable:false with the projects arrays emptied — a document that would
  // render this panel permanently read-only, with every store showing zero
  // projects, on a machine full of them. So the first thing we do with the
  // token is re-read at full detail, and the auto-open decision waits for that
  // answer rather than being taken against the degraded one.
  if (token && state?.authenticated === false) {
    refresh().then(() => { render(); settle(); }).catch(() => settle());
  } else {
    settle();
  }

  return {
    reset() {
      // A swap can re-parent chips (main.js re-adopts them after every reset
      // pass); if ours lost its row, put it back. Nothing else here is
      // session-shaped — no GPU resources, no pick entries, no cursors.
      const row = chipRow();
      if (row && chip.parentNode !== row) row.appendChild(chip);
      render();
    },
  };
}
