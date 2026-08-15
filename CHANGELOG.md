# Changelog

Notable changes. Versions are pre-1.0: minor bumps carry features and may change
visuals; patch bumps are fixes.

## 0.3.0 — 2026-08-15

**First run became a thing you click, not a file you edit.** Setup previously
meant hand-editing a JSON allowlist, running two CLI commands and restarting.

### Added

- **Two commands to run it: `npm install` then `npm start`.** `npm start` now
  builds first (via `prestart`), so a fresh clone no longer needs a separate
  build step, and the runner can never serve a stale `dist/`. The quickstart is
  one process in one terminal; `npm run dev` + `npm run live` remains as the
  two-process developer path, now documented as such — running only the first
  leaves live mode silently inert, which is a trap the README used to set.
- **`npm start` always shows a city.** Unconfigured is a deliberate state, not
  the end of a fallback chain: the bundled synthetic demo boots immediately and
  setup state is fetched in parallel, never gating first paint.
- **`npm run pii`** — a scanner that checks the repo, the working tree or the
  full git history for personal data before a push, and exits non-zero so it can
  gate one. It hard-codes nothing: the sensitive terms are derived at runtime
  from the local machine (username, home, hostname, project directories, adapter
  labels), held in memory, and never printed — a scanner shipping a list of your
  project names would be the leak it exists to prevent. Binaries are reported as
  REVIEW REQUIRED rather than passing silently, because a clean text scan over a
  repo containing a screen recording is not an all-clear.
- **In-world setup panel** (`SETUP` chip, `s`), a sibling of the library panel
  in the same idiom. Lists each harness with session counts, expanding to
  per-project rows with counts and last-active. Ticking writes the allowlist;
  building streams progress and then swaps the wall in place to your flagship —
  no reload, audio and WebGL preserved.
- **Per-project ticks only.** There is deliberately no select-all control: a
  one-click wildcard is how a sensitive workspace gets indexed by accident. The
  file still honors a hand-written `"*"`; the writer refuses to produce one.
- The panel states plainly that ingesting parses transcripts into a derived copy
  on disk, rather than letting a checkbox imply it is only viewing.

### Security

The setup surface is the first thing in C-Space that writes configuration, so
it is fenced and the fences are tested:

- **Loopback-only, auto-off.** On a non-loopback bind the routes never register
  and `/setup/*` is byte-identical to any other 404 — the surface is not
  advertised. A remote peer forging `Host: localhost` gets the same 404.
- **Per-run token**, injected into the served HTML only — never on disk, in a
  URL, a log, an error body, or the build stream. Absent from built `dist/`.
- **Opaque ids, rebuilt per request.** Project ids are per-process-salted
  digests resolved only against what the server itself just enumerated. Verified
  by instrumenting `fs`: path-shaped ids perform zero filesystem calls, and no
  request byte reaches a filesystem argument.
- **`/setup/state` requires the token** for project labels. Without it the
  response carries counts only — a local process cannot enumerate projects you
  never opted in.
- Fixed a genuinely exploitable defect in the build runner: builds could orphan
  child processes and one build's exit could terminate another's stream.
- **The OS username is no longer rendered anywhere in the product.** It was
  reaching the screen through five separate paths: the HUD identity block (which
  stripped the home slug correctly and then restored the username through a
  basename fallback), the 3D hover card, subagent labels, the fleet's
  macOS/Linux project labels, and the setup panel's raw-slug tooltips. The root
  cause was that one privacy rule existed in six copies; there is now exactly
  one implementation of each of the two rules — `compressProject()` in
  `src/lib/labels.js` and `dehome()` in `src/lib/paths.js` — and every surface
  imports them. Event-stream paths still show what was touched, collapsed to `~`.

### Fixed

- The library panel latched on a failed index fetch and still read `INDEX
  UNREACHABLE` after a successful build — which every first run hit.
- A UTF-8 BOM on the config (PowerShell and Notepad write one by default on
  Windows) wedged the allowlist unrecoverably.
- `deny` that could not take effect — because a broader entry or wildcard still
  exposes the project — returned a silent success.
- The console reported every project directory while the panel offered only
  those holding transcripts, so the two disagreed (35 vs 23) on the same machine.
- Two test files hard-coded a real local session id to locate their fixture,
  which put a genuine session identifier in a public repo and only ever worked
  on one machine. They now discover any transcript that has a matching built
  fixture, so the suite is portable and names nothing.
- The allowlist writer emitted bare LF into a CRLF file, leaving the operator's
  hand-curated config with mixed line endings (Notepad and PowerShell both write
  CRLF on Windows). It now keeps whatever style the file arrived in. A
  `.gitattributes` pins the repo's own checkout to LF, so a Windows clone and a
  macOS clone have the same bytes — the drift was invisible to `git diff` and
  broke a test for a reason unrelated to the code under test.
- A leading single letter in a project label was treated as a drive letter even
  when the label was not a path, so a Codex label like `i-need-a-parser-for`
  rendered as `need-a-parser-for` — and, worse, that silently suppressed the
  prose-label caution for exactly the labels most likely to need it.

## 0.2.0 — 2026-08-15

**Other harnesses became first-class.** The adapter registry was already a
library with tests, but nothing outside those tests called it, so only Claude
Code sessions could reach the screen. Validating against real Codex rollouts
exposed that gap and two encoding failures behind it.

### Added

- **Adapter-backed discovery.** `npm run live` and `npm run build-library` both
  enumerate through `tools/adapters/`, so Codex, Hermes and OpenClaw sessions
  appear in the library panel and the fleet district beside Claude ones. Library
  ids are namespaced (`codex-<id>`) so free-form ids from different stores
  cannot collide.
- **Source-aware allowlist.** New optional `sources` key opts each non-Claude
  store in, per project, matched exactly, with `["*"]` for all. Safe by default:
  a source with no entry is never opened — having `~/.codex` on the machine is
  not consent — and a config written before this key existed behaves exactly as
  it did. A flat `"codex:project"` shorthand is accepted in `allow`.
- **Harness-neutral tool families.** `toolFamily()` classifies the other
  harnesses' vocabularies into the same eight families, so one legend reads the
  same whichever harness produced the session. Across 21 real Codex rollouts,
  all 11 distinct tool names previously fell through to `other`; they now spread
  across `shell`, `mutate`, `meta`, `search` and `other`.
- **Per-session context ceiling.** `contextCapFor()` derives the tower's ceiling
  from the session's own model instead of assuming Claude's 1M, so a
  200k-window session is measured against 200k. Tower axis labels, the HUD
  meter, the library peak bars, the fleet columns and the audio bed all follow
  it, and all re-read it on swap.

### Fixed

- The tool ring always raised an `OTHER` monolith even when nothing spilled into
  it (`count: Math.max(otherCount, 1)`), so a totem representing nothing stood
  in every session's ring, Claude included. Unknown tools with no spill bucket
  now resolve to -1 and are skipped.
- `write_stdin` classified as `mutate` via the `write_*` heuristic; it feeds a
  running process, so it is `shell`.

### Notes

- **Only Claude sessions tail live.** The SSE tail is an incremental Claude
  JSONL reader. Every other source is archive-only: rows are marked
  `"streamable": false`, and `/stream` refuses them with a 501 naming the
  archive path rather than hanging or returning an empty stream.
- A harness with a small tool vocabulary makes a visibly sparser city. A Codex
  session calling two distinct tools raises two monoliths and leaves most of the
  legend unlit — the data being honest, not a bug.

## 0.1.0 — 2026-08-12

Initial public release: archive playback, live tail, fleet view, attract mode,
wall modes, SomaFM audio, and the project allowlist.
