# Changelog

Notable changes. Versions are pre-1.0: minor bumps carry features and may change
visuals; patch bumps are fixes.

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
