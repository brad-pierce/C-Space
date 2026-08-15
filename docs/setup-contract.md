# C-Space in-app setup — the contract

Status: **normative for the setup round**. Four agents build against this in parallel.
Where this document and a comment in code disagree, this document wins; raise the
conflict rather than improvising.

Scope of the round: `npm start` must never be blank or scolding. It boots the bundled
synthetic demo, discovers which harness stores exist on the machine, and offers an
in-world panel where the operator ticks projects and builds the library — ending with
the wall swapping **in place** to their own flagship session while the audio element and
the WebGL context keep running.

---

## 0. What is actually being given up, and the five fences

Until this round the server was **read-only with respect to its own configuration**. The
page could ask for data; it could not change what data exists. `cspace.allowlist.json` is
the only thing that makes a session visible, and session transcripts are sensitive. This
round hands the page a write verb, deliberately. It is fenced by five properties, all of
which are load-bearing and none of which may be relaxed for convenience:

| # | Fence | Where enforced |
|---|-------|----------------|
| F1 | **Per-run token**, random per process, required on every mutating request | §2 (mint/inject), §4 (verify) |
| F2 | **Bounded verbs only** — `allow` / `deny` / `build` against ids the server itself enumerated. No request body field is ever a filesystem path. Traversal is impossible *by construction*, not by validation | §3, §4 |
| F3 | **Loopback-only, auto-off** — not bound to loopback, or the caller is not local, or the request is not same-origin ⇒ the surface **does not exist** (404, never 403; do not advertise it) | §4.1 |
| F4 | **No allow-all control** in the UI. Per-project ticks only. The allowlist *file* still honours `["*"]`; the UI must never produce one, and must refuse to silently expand one | §6, §7 |
| F5 | **Honest disclosure** — the panel states that ingesting **parses transcripts into a derived copy on disk** under the C-Space data dir, not that it is "just viewing" | §7.4 |

Plus the standing rule, unchanged and extended to everything added this round:

> **F6 — never print discovered project names to the console. Counts only.** That line
> lands in screen-shares. This now also covers child-process stdout/stderr (§5.4).

And the standing invariant: the harness stores (`~/.claude`, `~/.codex`, `~/.hermes`,
`~/.openclaw`) stay **read-only, forever**. Nothing in this round writes to them. The only
two things written are `cspace.allowlist.json` (at its resolved path) and the C-Space data
dir (`~/.cspace/data` by default) via `build-library`.

---

## 1. Module ownership and the shape of the change

Advisory split; the orchestrator assigns. The point is that these are disjoint.

| Area | Files |
|---|---|
| A — setup server | `tools/setup-server.mjs` *(new)*, `tools/setup-token.mjs` *(new)*, `tools/setup-allowlist.mjs` *(new)*; edits to `tools/cspace.mjs` (mount, HTML injection, open-URL) and `tools/live-server.mjs` (§1.1) |
| B — dev parity | `vite.config.js` (one plugin: `transformIndexHtml` + `/setup` middleware) |
| C — discovery + builder | `tools/setup-discovery.mjs` *(new)*, `tools/build-library.mjs` (`--json` quiet mode) |
| D — UI | `src/modules/setup.js` *(new)*, registration in `src/main.js` `MODULES` |
| tests | `tests/setup.test.mjs` *(new)* — must keep `npm test` green |

### 1.1 Two existing facts that will bite, called out first

**(a) `discoverAll()` cannot enumerate candidate Claude projects.**
`adapters/claude.mjs → discover()` delegates to `live-server.mjs → listSessions()`, which is
**already allowlist-filtered**. On a fresh machine it returns `[]`. So the setup panel's
Claude candidate list must **not** come from `discoverAll()`. It comes from a new,
purpose-built scan (§3.2). `discoverAll({ sources })` remains the enumerator for
codex / hermes / openclaw, where the adapters do not consult the allowlist.

This does not weaken F2. The invariant F2 asserts is: *the set of ids the server will act
on is produced by the server, from its own scan, on this request.* Both enumerators satisfy
that.

**(b) The allowlist is loaded exactly once, at module load.**
`live-server.mjs` has `const ALLOWLIST = loadAllowlist();` and derives `ALLOWED_PROJECTS`
from it at module scope. After a mutation, `/sessions`, `listAllowedSessions()` and every
adapter path would keep serving the *old* config until restart. Required change:

```js
// tools/live-server.mjs
let ALLOWLIST = loadAllowlist();                 // was: const
export function reloadAllowlist() {              // NEW — re-reads the resolved path
  ALLOWLIST = loadAllowlist();
  sourceCache = { at: 0, rows: [] };             // drop the 30s non-Claude cache
  coverageReported = true;                       // never re-print the coverage lines (F6)
  return { claude: ALLOWLIST.claude.length,
           sources: Object.keys(ALLOWLIST.sources).length };   // COUNTS ONLY
}
```

Every read of `ALLOWED_PROJECTS` must become a read through the live binding
(`ALLOWLIST.claude`), not a module-scope copy captured at load. `projectAllowed`,
`sourceOptedIn`, `optedInSources`, `sessionAllowed` all fall out of that.
`reloadAllowlist()` returns counts and **must not** log or return names (F6).

---

## 2. The token

### 2.1 Minting

`tools/setup-token.mjs`:

```js
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
export const SETUP_TOKEN   = randomBytes(32).toString('base64url');  // 43 chars
export const SETUP_ID_SALT = randomBytes(32);                        // separate secret
```

- Minted **once per process**, at module load.
- **Never** written to disk, never put in an env var a child inherits, never logged, never
  included in any response body or header, never in a URL or query string.
- Not rotated within a run. A restart mints a new one; every previously-injected page is
  then unauthenticated and must degrade (§2.4), which is correct.
- `SETUP_ID_SALT` is a **separate** secret from the token. Ids appear in the DOM; do not
  key the id digest with the authentication secret.

### 2.2 How the page gets it — injected, never fetchable

The token reaches the page **only** by injection into the served HTML. There is no endpoint
that returns it. If any local page could `GET` it, the fence is worthless.

Injected form, as the **first** child of `<head>`:

```html
<script>window.__CSPACE_SETUP={token:"<TOKEN>",mutable:true,origin:location.origin};</script>
```

Read-only form (no runner / non-loopback bind / dev without the surface):

```html
<script>window.__CSPACE_SETUP={token:null,mutable:false,origin:location.origin};</script>
```

Injector requirements, both paths:

- Assert `/^[A-Za-z0-9_-]{16,128}$/` on the token before embedding. Refuse to inject
  otherwise (fall back to the read-only form). Base64url cannot contain `<` or `&`; the
  assertion makes that structural rather than incidental.
- Idempotent: if the HTML already contains `__CSPACE_SETUP`, do not inject again.
- The token is never baked into `dist/`. Injection happens at **serve** time only.
  A test asserts `dist/index.html` contains no `__CSPACE_SETUP` after `npm run build`.

### 2.3 Path 1 — production (`tools/cspace.mjs` serves `dist/`)

`sendFrom()` currently reads the file and writes it verbatim. For responses whose resolved
extension is `.html` **and** whose root is `DIST`:

1. read as before (all containment + realpath guards unchanged — do not touch them),
2. inject the bootstrap script after the first `<head...>` tag (if no `<head>` exists,
   inject before the first `<script`; if neither, do not inject),
3. recompute `Content-Length` from the **new** Buffer,
4. set `Cache-Control: no-store` on HTML (was `no-cache`) so a proxy or bfcache never
   serves one run's token into another run.

Applies to every `.html` document served from `DIST` (`index.html` and `fleet.html`).
`fleet.html` ignores the global; uniformity beats a special case. `/data/*` responses are
never injected into.

### 2.4 Path 2 — dev (`npm run dev`, Vite 8.2)

One plugin in `vite.config.js`, `apply: 'serve'`, alongside the existing
`externalDataStore()` plugin. Dev and prod must behave the same: the dev server mounts its
**own** setup surface with its **own** per-run token.

```js
function cspaceSetup() {
  let mutable = false, handler = null;
  return {
    name: 'cspace-setup',
    apply: 'serve',
    configureServer(server) {
      const host = server.config.server.host;              // undefined/true/'0.0.0.0'/…
      const loopback = host === undefined || host === false ||
                       host === 'localhost' || host === '127.0.0.1' || host === '::1';
      if (!loopback) return;                                // auto-off (F3) — nothing mounts
      handler = createSetupHandler({ boundHost: '127.0.0.1' });   // tools/setup-server.mjs
      mutable = true;
      // NOTE: Connect strips the mount prefix — inside this handler req.url is
      // '/state', not '/setup/state'. Re-prefix before dispatch, exactly as the
      // existing '/data' middleware has to.
      server.middlewares.use('/setup', (req, res, next) => {
        req.url = '/setup' + (req.url === '/' ? '' : req.url);
        if (!handler(req, res)) next();
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => ({
        tags: [{
          tag: 'script',
          children: `window.__CSPACE_SETUP=${JSON.stringify({
            token: mutable ? SETUP_TOKEN : null, mutable,
          })};window.__CSPACE_SETUP.origin=location.origin;`,
          injectTo: 'head-prepend',
        }],
      }),
    },
  };
}
```

Vite 8.2 supports both the bare-function and the `{ order, handler }` object form of
`transformIndexHtml`; use the object form with `order: 'pre'`. `apply: 'serve'` keeps the
hook out of `vite build`, which is what keeps the token out of `dist/`.

### 2.5 Token absent — degrade to read-only, never to unauthenticated writes

Three ways the token can be absent: a `vite preview` or a third-party static server
(no injector at all), a dev server bound non-loopback, a runner bound non-loopback.

| Condition | Behaviour |
|---|---|
| `window.__CSPACE_SETUP` missing entirely | UI treats it as `{token:null,mutable:false}`, then probes `GET /setup/state`. 404 ⇒ the panel is not offered at all (no chip, no key binding). |
| `token === null`, `GET /setup/state` returns 200 | **Read-only discovery**: the panel renders the full state — stores found, counts, what is allowed, whether a library exists — with every tick disabled and one line naming the CLI path (`npm run allowlist`, `npm run build-library`). |
| `token === null` and the UI attempts a mutation | Must be structurally impossible (controls disabled). If one leaks through, the server answers **403**; the UI shows the read-only banner. It must never retry, never prompt for a token, and never offer a token input field. |

There is no fallback authentication. There is no "trust this browser". Nothing about the
token is persisted between runs.

---

## 3. The id space

### 3.1 Format

An id names a **(source, project)** pair. It is a one-way digest — nothing decodes out of
it, and no path ever enters it.

```
key = source + "\u001f" + (project ?? "\u0000null")   // literal U+001F and U+0000 separators
id  = "p_" + createHmac('sha256', SETUP_ID_SALT).update(key, 'utf8').digest('base64url').slice(0, 22)
```

- `p_` prefix, then 22 base64url chars (132 bits). Wire regex: `/^p_[A-Za-z0-9_-]{22}$/`.
- Stable for the life of the process (the UI can poll state without its ticks moving),
  meaningless across processes (a restart re-salts).
- `project: null` — sessions whose label could not be recovered — gets its own stable id
  under the `\u0000null` sentinel. Ticking it is equivalent to the allowlist's `"*"`
  semantics for unlabelled sessions, and the UI must say so on that row (§7.6).

### 3.2 Mapping back — enumerate, then match. Never decode.

On **every** mutating request the server:

1. re-runs the enumeration (§3.3) from scratch,
2. computes the digest of each `(source, project)` it just found itself,
3. looks the submitted id up in that freshly built map.

An id that is not in the freshly-discovered set is **404**, always — including an id that
was valid thirty seconds ago for a project that has since vanished. The server never keeps
a long-lived id→path table, never trusts a table the client echoed back, and never derives
a filesystem location from client bytes.

Why a path can never round-trip: the client sends 24 characters that are the output of a
keyed hash over a `(source, project)` pair; the only thing the server does with those
characters is `Map.get`. The value in that map came from the server's own directory scan
one millisecond earlier. There is no code path from request bytes to `join()`, `open()`,
or `readdir()`. Traversal is not validated against — it is unrepresentable.

If two distinct keys ever digest to the same id while building the map, the server fails
the whole request with **500 `id-collision`** rather than acting on an ambiguous id.

### 3.3 Enumeration — `tools/setup-discovery.mjs`

```js
export function enumerateCandidates() -> {
  sources: [{
    id, label, storePresent,
    sessionsTotal,                 // count only
    projects: [{ project, sessions, lastActiveAt, onThisMachine }]
  }]
}
```

- **claude**: scan `~/.claude/projects` **directly** — not through the adapter (§1.1a).
  Mirror `tools/allowlist-init.mjs`: skip `*--claude-worktrees*` entries, fold a worktree's
  sessions into its parent slug's count, count `*.jsonl` files, `lastActiveAt` = newest
  mtime. A directory with zero transcripts is omitted. A missing store ⇒
  `storePresent:false, projects:[]` (never a throw).
- **codex / hermes / openclaw**: `discoverAll({ sources: [present ids] })`, grouped by
  `row.project` (`null` preserved). Only stores whose adapter reports `storeExists()` are
  opened. A source whose adapter is not installed is simply absent from the list.
- **stale entries**: an allowlist entry that matches no discovered project is still
  emitted, with `sessions: 0, onThisMachine: false`, so the operator can *untick* it. It
  gets an id from the same digest space, so `deny` works on it.
- Enumeration reads **project labels and session counts only**. It opens no transcript, it
  parses nothing, it writes nothing. Hermes and OpenClaw open SQLite read-only.
- Cached in-process for **5 s** to keep a polling panel from re-opening SQLite; the cache
  is invalidated immediately after any successful mutation.
- Labels are returned to the local page (the operator must see what they are ticking) and
  are **never** logged, never written to a file, never included in any console line (F6).

---

## 4. Endpoints

Base path `/setup`. Same origin as the page by construction — in prod the runner serves
both; in dev the Vite server serves both. There is no cross-port variant of the setup
surface (unlike `/sessions`, which supports the 5199→5198 dev split).

### 4.1 Locality — the surface either exists or it does not

`createSetupHandler({ boundHost })` returns a `handler(req, res) -> boolean`.

- If `boundHost` is not loopback (`127.0.0.1`, `::1`, `localhost`), the factory returns a
  handler that **returns `false` for everything**. The routes are never registered, so
  `/setup/*` falls through to the static server and 404s like any unknown path — for
  remote callers *and* for the local operator. That is the intended auto-off (F3).
  In `tools/cspace.mjs` this is decided from the resolved bind (`--host`, default
  `127.0.0.1`), after `listen`.
- Per request, before anything else, all three must hold:
  1. `req.socket.remoteAddress` is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`),
  2. `Host` matches `LOOPBACK_HOST` (reuse the regex in `live-server.mjs`),
  3. `Origin` is absent **or** exactly equal to `<proto>://<Host>` — same-origin only.
- Any of them failing ⇒ **404**, `text/plain`, body `not found`, byte-identical to the
  static server's 404. No `Access-Control-Allow-Origin` header is ever set on `/setup/*`.
  Do not distinguish "you are not allowed" from "this does not exist".

Note on the existing `guard()`: it runs first in `cspace.mjs` and answers **403** for a
non-loopback `Host`/`Origin` on *every* path. That is path-independent and therefore
advertises nothing, so it is not a deviation from the 404 rule. The socket-peer check above
is still load-bearing: a server mistakenly bound wide can be reached by a remote peer that
forges `Host: localhost`, and only the peer check catches that.

`OPTIONS /setup/*` ⇒ **404**. The mutation requests carry a custom header, so they are
never "simple" requests; with no CORS headers and no preflight answer, a cross-origin page
cannot reach them at all.

### 4.2 Common rules for every `/setup/*` request

| Rule | Value |
|---|---|
| Max request body | **16 KiB**. Reading aborts the moment the cap is exceeded — no unbounded buffering — and answers **413**. |
| JSON parsing | Only after the body is fully read under the cap; `JSON.parse` inside `try` ⇒ **400** on throw. |
| Content-Type on mutations | must start with `application/json` ⇒ else **415**. |
| Max ids per mutation | **200** ⇒ else **400**. |
| Wrong method for a route | **405** with `Allow`. |
| Mutation rate | **30 per minute** per process ⇒ else **429** with `Retry-After: 60`. |
| Responses | `application/json; charset=utf-8`, `Cache-Control: no-store`. |
| Error body | `{"error":"<code>","message":"<short, name-free>"}` — never contains a project label or a filesystem path. |

### 4.3 Failure taxonomy (normative)

| Condition | Status | `error` code |
|---|---|---|
| Not local / not same-origin / bind not loopback | **404** | *(plain-text `not found`, no JSON body)* |
| Missing, malformed, or wrong token on a mutation | **403** | `forbidden` |
| Unknown / stale / non-matching id | **404** | `unknown-id` |
| Malformed body, bad JSON, wrong types, >200 ids | **400** | `bad-request` |
| Body over 16 KiB | **413** | `too-large` |
| Non-JSON content type on a mutation | **415** | `unsupported-media-type` |
| Second concurrent build | **409** | `build-in-progress` |
| Build requested with an empty effective allowlist | **409** | `nothing-allowed` |
| Deny of a project covered by a `"*"` wildcard | **409** | `wildcard-in-effect` |
| Rate limit | **429** | `rate-limited` |
| Allowlist write failed | **500** | `allowlist-write-failed` (errno code only, no path) |
| Digest collision | **500** | `id-collision` |
| Anything else uncaught | **500** | `internal` |

### 4.4 `GET /setup/state`

Token **optional** (see §2.5 — this is what makes read-only degradation possible). Gated by
§4.1 locality only.

```json
{
  "ok": true,
  "mutable": true,
  "generation": "g_1f4c9a2b",
  "dataDir": "~/.cspace/data",
  "allowlistPath": "~/harness-viz/cspace.allowlist.json",
  "allowlistWritable": true,
  "wildcards": { "claude": false, "codex": false, "hermes": false, "openclaw": false },
  "sources": [
    {
      "id": "claude",
      "label": "Claude Code",
      "storePresent": true,
      "sessionsTotal": 412,
      "projectCount": 17,
      "streamable": true,
      "labelsAreTitles": false,
      "projects": [
        {
          "id": "p_Vq1sZ8k3Ld0aQm7xTr2Bn9",
          "label": "C--Users-you-harness-viz",
          "sessions": 63,
          "lastActiveAt": 1755200000000,
          "allowed": false,
          "viaWildcard": false,
          "onThisMachine": true
        }
      ]
    },
    {
      "id": "codex", "label": "Codex", "storePresent": false,
      "sessionsTotal": 0, "projectCount": 0, "streamable": false,
      "labelsAreTitles": false, "projects": []
    }
  ],
  "library": {
    "exists": true,
    "sessions": 128,
    "builtAt": 1755199999999,
    "flagship": { "id": "8f1c…", "source": "claude", "toolCalls": 4021 }
  },
  "build": {
    "status": "idle",
    "parsed": 0, "total": 0, "failed": 0,
    "startedAt": null, "finishedAt": null, "error": null
  }
}
```

Field notes:

- `mutable` — `true` iff this process holds a token and the surface is mounted. The UI
  keys every control off this, not off the presence of `window.__CSPACE_SETUP.token`.
- `dataDir` / `allowlistPath` — **home-collapsed** (`~/…`) when under `homedir()`, verbatim
  otherwise (the operator set that path themselves). This is deliberate: `/sessions`
  already strips absolute paths because they leak the OS username and home layout, and
  these two strings land in screenshots. They are display-only; no endpoint accepts them.
- `generation` — a digest over the sorted id list. Advisory: the UI may use it to notice
  the candidate set changed. The server never requires the client to send it back.
- `wildcards[src]` — the config has `["*"]` for that source. Every project of that source
  reports `allowed:true, viaWildcard:true`.
- `library` — read from `<dataDir>/library/index.json`; `builtAt` is that file's mtime.
  Absent file ⇒ `{"exists":false,"sessions":0,"builtAt":null,"flagship":null}`.
- `labelsAreTitles` — `true` for hermes and openclaw, whose "project" is content-derived
  (a session title). The UI must surface this (§7.6).
- `streamable` — `true` only for `claude`; the rest are archive-only. Display hint.

### 4.5 Mutations

All three: `POST`, `Content-Type: application/json`, header
**`X-CSpace-Setup-Token: <token>`**. The token is compared with
`crypto.timingSafeEqual` after an explicit length check; a length mismatch short-circuits
to 403 without a compare. The token is never accepted in a query string, a cookie, or a
body field — only that header.

Every mutation responds **200** with the *complete, freshly recomputed* `GET /setup/state`
body (plus `"changed": <n>` for allow/deny), so the UI has exactly one renderer.

#### `POST /setup/allow`

```json
{ "ids": ["p_Vq1sZ8k3Ld0aQm7xTr2Bn9", "p_9mXk2Lp0Qa8Zs1Rt4Vd7Bn"] }
```

Set-union, idempotent. Each id is resolved through §3.2; **any** unknown id fails the whole
request with 404 and writes nothing (all-or-nothing — a partially applied tick list is a
worse outcome than a rejected one). Claude ids append the raw slug to `allow`; other
sources append the label to `sources[<id>]`, creating the key if absent.

#### `POST /setup/deny`

Same body. Removes the entry, and also removes the prefixed shorthand form
(`"codex:the-dreaming"`, `"claude:<slug>"`) if present. Denying an id whose source is
covered by `"*"` ⇒ **409 `wildcard-in-effect`**; the server must not rewrite a wildcard
into an enumerated list, because that silently changes what happens to *future* projects.
The UI shows a line telling the operator to edit the file by hand for that source.

#### `POST /setup/build`

Body `{}` or `{ "force": true }` (`force` ⇒ pass `--force` to the builder; re-parses
cached sessions). Responds `text/event-stream` — see §5.

Preconditions, checked before spawning anything:
- a build already running ⇒ **409 `build-in-progress`**;
- the effective allowlist is empty ⇒ **409 `nothing-allowed`** (do not spawn a child just
  to have it exit 1).

### 4.6 Allowlist writing — `tools/setup-allowlist.mjs`

- Writes to **exactly** the resolved path: `CSPACE_ALLOWLIST` if set (authoritative, per
  `loadAllowlist()`'s existing rule), else `<repo>/cspace.allowlist.json`. There is no
  other path, and no request field can influence it.
- Read-modify-write inside a single in-process mutex, and the **read happens inside the
  mutex** immediately before the write, so a hand edit made during the session is merged
  rather than clobbered.
- Preserves every key it does not own: all `_comment*` keys, `discovered`, and any unknown
  keys, verbatim and in place.
- Legacy bare-array config (`["slug", …]`) is migrated to `{ "allow": [...] }` on first
  write; the response reports `"migrated": true` once.
- No config present ⇒ create `{ "_comment": "…created by the C-Space setup panel…",
  "allow": [], "sources": {} }` then apply.
- Atomic: write `cspace.allowlist.json.tmp-<rand>` in the **same directory**, `fsync`,
  `rename` over the target. Best-effort `chmod 0600` (no-op on Windows).
- After a successful write, call `reloadAllowlist()` (§1.1b) and invalidate the enumeration
  cache, in that order, before building the response state.
- **During development, never write the real `cspace.allowlist.json`.** Tests and manual
  runs point `CSPACE_ALLOWLIST` at a temp file.

---

## 5. Build progress

### 5.1 Transport

The progress stream **is** the response to `POST /setup/build`:
`Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`,
status 200, same SSE framing as `live-server.mjs`'s `sse()` helper
(`event: <type>\ndata: <json>\n\n`).

Rationale: the token travels in a request header, which `EventSource` cannot set. Putting a
per-run secret in a query string to satisfy `EventSource` would undo F1. The UI reads the
streaming body with `fetch()` and a `TextDecoder`, splitting on `\n\n`.

A client that disconnects (reload, panel closed) does **not** cancel the build — the child
keeps running and `GET /setup/state` keeps reporting `build.status` with live `parsed` /
`total`. That polling path (1 Hz) is the documented recovery for a lost stream; there is no
second SSE endpoint and no re-attach.

### 5.2 Event shapes

```
event: started
data: {"buildId":"b_7a1f","total":128,"force":false,"at":1755200000000}

event: progress
data: {"parsed":12,"cached":40,"failed":0,"total":128,"source":"claude","libraryId":"8f1c…"}

event: warning
data: {"code":"parse-failed","libraryId":"8f1c…","source":"claude"}

event: done
data: {"buildId":"b_7a1f","parsed":86,"cached":40,"failed":2,"total":128,
       "builtAt":1755200030000,
       "flagship":{"id":"8f1c…","source":"claude","toolCalls":4021}}

event: error
data: {"code":"build-failed","message":"builder exited 1"}
```

- Exactly one terminal event per stream: `done` **or** `error`. The response ends after it.
- `progress` is coalesced to at most **10 events/second**; the last item before `done` is
  always emitted.
- `flagship` may be `null` (everything failed). The UI must handle that as a failed build.
- No event ever carries a project label or a filesystem path. `libraryId` is the store key
  (an opaque session id, already used in `/data/library/<id>.json` URLs) — safe.
- A heartbeat `event: ping` `data: {"t":…}` every 10 s so a long parse does not look hung.

### 5.3 Concurrency

One build at a time, per process, tracked by a module-level `currentBuild` record.
A second `POST /setup/build` while `status === "running"` ⇒ **409 `build-in-progress`**
(JSON, not a stream). The latch is set **before** the first `await`/`spawn` and released in
a `finally`, so a throw between the two cannot wedge the surface into a permanently-refusing
state.

### 5.4 How the build actually runs — child process, quiet mode

The server **spawns** `node tools/build-library.mjs --json [--force]`; it never imports the
builder into its own event loop. Two reasons: crash isolation (unchanged from today's
per-session `--parse-one` design) and F6 — the builder's existing human output prints
`${s.project}` on every line, which must never reach the runner's console.

- `stdio: ['ignore', 'pipe', 'pipe']`, `env: { ...process.env }` so `CSPACE_ALLOWLIST` and
  `CSPACE_DATA` are inherited, `cwd` = repo root.
- **`--json` implies quiet**: with the flag set, `build-library.mjs` prints **no** human
  lines at all (including the coverage lines from `reportSourceCoverage()` and the
  `NOTHING TO PARSE` block) and emits one JSON object per line on stdout:

```
{"ev":"start","total":128,"force":false}
{"ev":"item","i":13,"total":128,"status":"parsed"|"cached"|"failed","libraryId":"…","source":"claude"}
{"ev":"done","parsed":86,"cached":40,"failed":2,"flagship":{"id":"…","source":"claude","toolCalls":4021}}
{"ev":"error","code":"nothing-allowed"}
```

  Exit codes: `0` success, `2` nothing allowed, `1` anything else. Stdout is line-buffered
  NDJSON and nothing else; a line that does not parse as JSON is dropped by the server, not
  forwarded.
- **Child stderr is never forwarded verbatim.** It can contain transcript paths from the
  `--parse-one` failure path. Keep the last 4 KiB in memory for the `error` event's *code*
  derivation only; the runner console gets at most `[cspace] build failed (exit N)`.
- Timeout **30 minutes**: `SIGTERM`, then `SIGKILL` after 5 s ⇒ `error` with
  `{"code":"build-timeout"}`.
- On child exit ≠ 0 without a `done` line ⇒ `error` with `{"code":"build-failed"}`.
- After `done`, the server refreshes its `library` state (re-stat `index.json`) so the very
  next `GET /setup/state` reflects the new build.

---

## 6. Boot and the swap

### 6.1 Boot

- `tools/cspace.mjs` opens the browser at **`/?demo=1`** when the flagship file
  (`<dataDir>/session.json`) does not exist, and at `/` otherwise. `?demo=1` already routes
  through the bundled synthetic session with `playing.mode: 'attract'` — nothing in
  `bootTimeline()` changes this round.
- The panel auto-opens once per page load when `state.mutable && !state.library.exists`.
  `?setup=1` force-opens it. `?freeze=1` (shot mode) suppresses it entirely, chip included.
- The existing fallback chain in `bootTimeline()` stays exactly as it is. The setup panel
  is an addition to the boot experience, not a replacement for any fallback.

### 6.2 The swap — the whole point of the round

After `event: done` with a non-null `flagship`, the UI calls, per the **SESSION SWAP
CONTRACT** in `src/main.js`:

```js
await ctx.swapSession({ session: null, attract: ctx.playing?.mode === 'attract' });
```

`session: null` loads the flagship (`/data/session.json`), which `build-library` has just
rewritten. The page is not reloaded, so the SomaFM `<audio>` element, the WebGL context,
the renderer and the whole audio graph survive the cut.

- `swapSession` is **archive-only**. If `ctx.playing.mode === 'live'` it warns and proceeds,
  leaving an orphaned EventSource. The panel must therefore **not** offer the build→swap
  finish while live: in live mode it completes the build and shows "reload to apply", with
  no swap call.
- `swapSession` returns `false` if a swap is already in flight or the load failed. On
  `false`, the panel stays open and shows the build-failed state (§7.5) with the same
  "reload to apply" line. Never retry in a loop.
- The panel must not hold a reference to `ctx.session` / `ctx.timeline` across the swap;
  read through `ctx` at use time, per the contract.
- `src/modules/setup.js` implements `reset(ctx)` (a swap calls it) and must rebuild or
  re-adopt its chip there, like every other module.

---

## 7. UI states

`src/modules/setup.js` is DOM/CSS inside `#hud` — the same construction as
`src/modules/library.js` (top-center chip in `#chips`, panel, ESC closes, own `<style>`
block, no THREE, no canvas, no module-scope DOM access). Six states, all of which must
render:

### 7.1 No stores found
`sources` all report `storePresent:false`. Say plainly that no harness store was found on
this machine, name the four stores it looked for, and state that the demo currently on
screen is a bundled synthetic session — nothing from a real transcript. No controls except
close.

### 7.2 Stores found, nothing allowed — **the default first run**
One group per present store: label, session count, project count. Per-project rows, each an
unticked checkbox: compressed project name (reuse `library.js`'s `compressProject` rule),
session count, last-active age. Raw label on `title=` hover.
**No select-all, no "allow all", no group-level tick, no shift-range multi-select** (F4).
A one-click select-all is how a sensitive workspace gets indexed by accident. The disclosure
of §7.4 is visible in this state, before any tick is made.
Primary action `INGEST N PROJECT(S)` is disabled until at least one tick.

### 7.3 Allowed but never built
`library.exists === false` while some projects are allowed. Show the allowed count and lead
with the build action. This is the state a CLI-configured machine lands in, and the state
left behind if the operator ticks projects and closes the panel.

### 7.4 Built and current
Show library session count and build age ("built 4 minutes ago"), the flagship's id/source,
and keep the tick list available for adding or removing projects. A tick change while built
marks the library **stale** — show `REBUILD` rather than `INGEST`.

The disclosure line is **required copy** and must be present in states 7.2, 7.3 and 7.4,
adjacent to the action button, not hidden behind a disclosure triangle:

> Ingesting **parses the transcripts of the ticked projects into a derived copy on disk**
> at `~/.cspace/data`. That copy is what C-Space plays back, and anything that can read
> your home directory can read it. Nothing is uploaded, and nothing is written back to the
> harness stores.

`~/.cspace/data` is substituted from `state.dataDir`. Wording may be tightened; it may not
be softened into implying that ticking a project merely "views" it.

### 7.5 Build in flight / build failed
In flight: a determinate bar from `parsed+cached / total`, the counts, and the last
`warning` count ("2 sessions could not be parsed"). Ticks disabled. Panel closable — the
build continues, and on reopen the panel reconstructs progress from `GET /setup/state`.
Failed (`error`, or `done` with `flagship: null`, or `swapSession` returned `false`): show
the error **code**, keep the tick list intact, offer retry, and name the CLI equivalent
(`npm run build-library`). Never show a raw child stderr blob.

### 7.6 Read-only
`mutable === false` (§2.5). Everything above renders with disabled controls plus one banner:
the setup surface is unavailable in this context (dev server without the runner, or a
non-loopback bind), and the CLI path is `npm run allowlist` then `npm run build-library`.

Cross-cutting UI rules:

- A source with `labelsAreTitles: true` (hermes, openclaw) carries a per-group note: these
  labels are **session titles**, so exposing them exposes titles as well as sessions.
- The `project: null` row is labelled "unlabelled sessions" and notes that it corresponds to
  the allowlist's `"*"` matching, not to a named project.
- A source with `wildcards[src] === true` renders its rows ticked, disabled, with one line:
  the config exposes every project of this source via `"*"`; edit the file to narrow it.
- Rows with `onThisMachine:false` render dimmed under "configured, not on this machine",
  and remain untickable-but-deniable.
- Never render a filesystem path other than `state.dataDir` / `state.allowlistPath`.
- The panel never logs project names to the console (F6) — including in error handlers.

---

## 8. Out of scope this round

Named so nobody improvises:

1. **Any select-all / allow-all / "expose everything" control**, in any form (button, menu
   item, keyboard shortcut, drag-select, group tick). The file format still honours `["*"]`;
   the UI neither produces nor expands one.
2. **Editing or removing a `"*"` wildcard** from the UI. Hand-edit only.
3. **Un-ingesting** — no delete/prune verb over `~/.cspace/data`, no per-session removal.
4. **Per-session ticks.** The unit is the project, exactly as the allowlist file's unit is.
5. **Cancelling, pausing, or resuming a build**; no build queue, no resume across restart.
6. **Auto-rebuild / file watching / rebuild-on-new-session.**
7. **Any path input anywhere** — no field that sets `CSPACE_DATA`, `CSPACE_ALLOWLIST`, a
   store location, or an output directory. The server accepts no path, in any request, ever.
8. **Remote or multi-user setup**, LAN exposure, any auth beyond the per-run token, any
   token persistence or "remember this browser".
9. **Setup UI in `fleet.html`.** `index.html` only.
10. **Live-mode swapping.** Going live or to the fleet still navigates (SESSION SWAP
    CONTRACT). The panel's finishing swap is archive-only.
11. **Configuring anything that is not "which projects" and "build now"** — wall mode,
    audio, attract playlist, ports, kiosk. Not this round.
12. **Writing to any harness store.** Unchanged, permanent.
13. **New npm dependencies.** Node stdlib and the existing Three/Vite only.

---

## 9. Invariants a reviewer will check

- [ ] No request body field in `/setup/*` is, contains, or is used to build a filesystem
      path. `grep` the handler for `join(`, `resolve(`, `readFile` fed by request data:
      there should be no hits.
- [ ] No endpoint returns the token; `dist/` after `npm run build` contains no token and no
      `__CSPACE_SETUP`.
- [ ] Non-loopback bind ⇒ `/setup/*` 404s for everyone, including localhost.
- [ ] Mutation without the header ⇒ 403; with a wrong-length token ⇒ 403 without a compare.
- [ ] A `p_` id from a previous process ⇒ 404.
- [ ] 20 KiB body ⇒ 413, and the server did not buffer 20 KiB.
- [ ] Two concurrent builds ⇒ the second gets 409, the first is unaffected.
- [ ] `reloadAllowlist()` is called after every successful write, and `/sessions` reflects
      the new allowlist without a restart.
- [ ] No console line anywhere in the new code prints a project label, a session title, or
      a transcript path — including child stderr passthrough and error handlers.
- [ ] The UI has no control that ticks more than one project per click.
- [ ] The disclosure copy of §7.4 is present and not collapsed.
- [ ] `npm test` green, `npm run build` clean, and the real `cspace.allowlist.json` is
      unmodified after the test run.
