// build-runner.mjs — run a library build as a CHILD PROCESS and turn its NDJSON
// into the setup panel's progress events (docs/setup-contract.md §5).
//
// WHY A CHILD, NOT AN IMPORT. `build-library.mjs` walks whole harness stores and
// parses multi-hundred-megabyte rollouts. Importing it into the runner would put
// that work on the same event loop that is serving the SSE tail and the static
// bundle: the stream would stall and the frame rate would collapse in the middle
// of setup, exactly when the operator is watching. A child also keeps the crash
// isolation the builder already relies on, and — the security half — keeps the
// builder's human output, which prints project names on every line, out of this
// process entirely. In `--json` mode the builder prints no human lines at all;
// this module forwards COUNTS AND OPAQUE STORE IDS ONLY (F6), because these
// events cross the wire into a browser and from there into screen-shares.
//
// The runner never sees, accepts or constructs a filesystem path from a request.
// Its whole input surface is `{ force: boolean }`. What gets built is decided by
// the allowlist file the builder reads for itself.
//
// USE (from tools/setup-server.mjs). The handle can be consumed three ways —
// pick ONE, they share a single event source and would otherwise double-count:
//
//   const b = startBuild({ force });
//   if (!b.ok) return json(res, 409, { error: b.code });   // 'build-in-progress'
//   for await (const { type, data } of b) sse(type, data); // (1) async iteration
//   startBuild({ force, onEvent: (ev) => sse(ev.type, ev.data) });   // (2) callback
//   const off = b.subscribe((type, data) => sse(type, data));        // (3) native
//   await b.finished;   // resolves with the terminal [type, data]
//
// and `buildStatus()` for the `build` block of GET /setup/state, which is how a
// panel that was closed mid-build reconstructs progress by polling.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_FILE } from './cspace-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUILDER = join(HERE, 'build-library.mjs');

export const BUILD_TIMEOUT_MS = 30 * 60 * 1000;  // §5.4
const KILL_GRACE_MS = 5_000;                     // SIGTERM → SIGKILL
const PROGRESS_MS = 100;                         // ≤ 10 progress events/second (§5.2)
const PING_MS = 10_000;                          // heartbeat (§5.2)
const STDERR_TAIL = 4 * 1024;                    // kept for code derivation only (§5.4)
const MAX_LINE = 64 * 1024;                      // a runaway stdout line is dropped, not buffered

// The idle record. `status` is one of idle | running | done | error.
const IDLE = Object.freeze({
  status: 'idle', parsed: 0, cached: 0, failed: 0, total: 0,
  startedAt: null, finishedAt: null, error: null, buildId: null,
});

// Module-level latch — one build at a time, per process (§5.3). A second request
// while this says `running` is refused, never queued.
let current = { ...IDLE };
let child = null;
let subscribers = new Set();
let replay = [];          // 'started' + last 'progress', for a subscriber that attached late
let settled = true;       // terminal event already delivered for the current record
let finishedResolve = null;
let timers = { progress: null, ping: null, timeout: null, kill: null };
let pendingProgress = null;
let progressGate = false; // true while inside a coalescing window

// ---------------------------------------------------------------------------
// event fan-out
// ---------------------------------------------------------------------------

function emit(type, data) {
  if (type === 'started') replay = [['started', data]];
  else if (type === 'progress') replay = [replay[0], ['progress', data]].filter(Boolean);
  for (const fn of [...subscribers]) {
    // One bad subscriber must not abort a build or wedge the latch.
    try { fn(type, data); } catch { /* subscriber's problem */ }
  }
}

/** Attach to the in-flight build. Returns an unsubscribe function. */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  // Late attach still sees a coherent stream: the opening event, the newest
  // progress, then — if it already happened — the terminal.
  for (const [t, d] of replay) { try { fn(t, d); } catch { /* ignore */ } }
  if (settled) {
    // This build is over. Deliver its terminal and do NOT retain the callback:
    // a retained one would go on to receive the NEXT build's events, which is
    // how a closed panel's stale stream ends up narrating someone else's build.
    if (current.terminal) { try { fn(current.terminal[0], current.terminal[1]); } catch { /* ignore */ } }
    return () => {};
  }
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------------------
// progress coalescing — at most one `progress` per PROGRESS_MS, and the last
// item before the terminal event is always flushed (§5.2).
// ---------------------------------------------------------------------------

function flushProgress() {
  if (!pendingProgress) return;
  const p = pendingProgress;
  pendingProgress = null;
  emit('progress', p);
}

function queueProgress(p) {
  pendingProgress = p;
  if (progressGate) return;
  progressGate = true;
  flushProgress();
  timers.progress = setTimeout(() => {
    progressGate = false;
    timers.progress = null;
    flushProgress();
  }, PROGRESS_MS);
  timers.progress.unref?.();
}

function clearTimers() {
  if (timers.ping) { clearInterval(timers.ping); timers.ping = null; }
  for (const k of ['progress', 'timeout', 'kill']) {
    if (timers[k]) { clearTimeout(timers[k]); timers[k] = null; }
  }
  progressGate = false;
}

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------

function finish(type, data, owner = null) {
  // OWNERSHIP GUARD. A child that has already delivered its verdict on stdout can
  // stay alive for a long time afterwards — the `nothing-allowed` path writes its
  // line and then exits, and the timeout path has a 5s SIGTERM→SIGKILL grace. Its
  // stdout/close handlers are still attached to this module's shared state, so
  // without this guard a dead build's exit lands on the NEXT build's record:
  // it terminates a healthy build with the corpse's error code, and because the
  // one-at-a-time latch reads `current.status`, a third child then spawns
  // alongside the second. `owner` is the buildId the handler was bound to.
  if (owner != null && current.buildId !== owner) return;
  if (settled) return;
  settled = true;
  flushProgress();
  clearTimers();
  current.status = type === 'done' ? 'done' : 'error';
  current.finishedAt = Date.now();
  current.error = type === 'error' ? (data.code ?? 'build-failed') : null;
  if (type === 'done') {
    current.parsed = data.parsed; current.cached = data.cached; current.failed = data.failed;
  }
  current.terminal = [type, data];
  // `child` is deliberately NOT cleared here. The process may well still be
  // running (see the ownership note above), and the exit reaper below has to keep
  // a handle on it — nulling it here is how a live builder became unreapable and
  // outlived the runner. It is cleared by its own 'close' handler instead.
  emit(type, data);
  // Subscriptions are per-build: nothing more will be emitted for this record,
  // and a leftover callback must not be carried into the next one.
  subscribers.clear();
  // COUNTS ONLY on the runner's own console. The child's stderr is never echoed:
  // it can carry transcript paths from the --parse-one failure path.
  if (type === 'error') console.warn(`[cspace] build failed (${data.code})`);
  else console.log(`[cspace] library build done — ${data.parsed} parsed, ${data.cached} cached, ${data.failed} failed.`);
  const r = finishedResolve; finishedResolve = null;
  r?.(current.terminal);
}

function indexMtime() {
  try { return Math.round(statSync(INDEX_FILE).mtimeMs); } catch { return Date.now(); }
}

// A crashed or hostile child must never leave the panel waiting. Everything that
// can end a build routes through here or through `finish` directly.
function failFromExit(code, signal, stderrTail, owner = null) {
  if (owner != null && current.buildId !== owner) return;
  if (settled) return;
  let errCode = 'build-failed';
  let message = signal ? `builder killed by ${signal}`
    : code == null ? 'builder could not start'
      : `builder exited ${code}`;
  if (code === 2) { errCode = 'nothing-allowed'; message = 'no projects are allowed'; }
  // errno tokens are safe to surface (they are not names and not paths) and are
  // the single most useful thing in a failed build. Nothing else from stderr is.
  const errno = /\b(ENOSPC|EACCES|EPERM|EMFILE|ENOMEM|EROFS|EBUSY|ENOENT)\b/.exec(stderrTail ?? '');
  if (errno && errCode === 'build-failed') message += ` (${errno[1]})`;
  finish('error', { code: errCode, message }, owner);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * The `build` block of GET /setup/state. Counts only — no labels, no paths.
 * Survives the child, so a panel reopened after a build reads the outcome here.
 */
export function buildStatus() {
  const { status, parsed, cached, failed, total, startedAt, finishedAt, error, buildId } = current;
  return { status, parsed, cached, failed, total, startedAt, finishedAt, error, buildId };
}

/** True while a child is in flight — the §4.5 precondition for 409. */
export function isBuildRunning() {
  return current.status === 'running';
}

// ---------------------------------------------------------------------------
// handles — three delivery shapes over ONE event source
// ---------------------------------------------------------------------------
// The consumer (tools/setup-server.mjs) picks exactly one of these and ignores
// the rest, so an event is never counted twice:
//   · `for await (const {type, data} of handle)` — async iteration;
//   · `startBuild({ onEvent })` — a callback taking `{type, data}`;
//   · `handle.subscribe((type, data) => …)` — the native form.
// `finished` (aliased `done`) resolves with the terminal `[type, data]`.

function iterateBuild() {
  const queue = [];
  let waiting = null;
  let ended = false;
  let off = subscribe((type, data) => {
    const ev = { type, data };
    if (type === 'done' || type === 'error') ended = true;
    if (waiting) { const w = waiting; waiting = null; w({ value: ev, done: false }); }
    else queue.push(ev);
  });
  const stop = () => { off?.(); off = null; };
  return {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (ended) { stop(); return Promise.resolve({ value: undefined, done: true }); }
      return new Promise((resolve) => { waiting = resolve; });
    },
    return() { stop(); return Promise.resolve({ value: undefined, done: true }); },
    throw(e) { stop(); return Promise.reject(e); },
    [Symbol.asyncIterator]() { return this; },
  };
}

function makeHandle(buildId, finished) {
  return {
    ok: true, buildId, subscribe, finished, done: finished,
    [Symbol.asyncIterator]: iterateBuild,
  };
}

// A refusal is still a legible stream: a consumer that iterates it sees one
// `error` event with the refusal code rather than an empty stream it has to
// guess about. It never attaches to the running build's events.
function refusedHandle(code) {
  const ev = { type: 'error', data: { code, message: 'a build is already running' } };
  const finished = Promise.resolve([ev.type, ev.data]);
  let sent = false;
  return {
    ok: false, code, buildId: null, finished, done: finished,
    subscribe(fn) { if (typeof fn === 'function') { try { fn(ev.type, ev.data); } catch { /* ignore */ } } return () => {}; },
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve(sent ? { value: undefined, done: true } : (sent = true, { value: ev, done: false })),
        return: () => Promise.resolve({ value: undefined, done: true }),
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

/**
 * Fork `build-library.mjs --json [--force]` and stream its progress.
 *
 * Refused with `ok: false, code: 'build-in-progress'` if one is already running
 * — per §5.3, never queued. On success returns a handle that can be consumed by
 * async iteration, by the `onEvent` option, or by `handle.subscribe`.
 */
export function startBuild({ force = false, onEvent = null } = {}) {
  // The latch is taken synchronously, before anything that can throw or await,
  // and every path out of here ends in `finish()` — so a throw between latch and
  // spawn cannot wedge the surface into permanently refusing.
  if (current.status === 'running') return refusedHandle('build-in-progress');

  const buildId = 'b_' + randomBytes(4).toString('hex');
  current = {
    ...IDLE, status: 'running', buildId, startedAt: Date.now(), terminal: null,
  };
  settled = false;
  replay = [];
  pendingProgress = null;
  const finished = new Promise((resolve) => { finishedResolve = resolve; });
  const handle = makeHandle(buildId, finished);
  if (typeof onEvent === 'function') subscribe((type, data) => onEvent({ type, data }));

  const myId = buildId;                 // every handler below is bound to THIS build

  // REAP BEFORE SPAWN. `current.status` can already be terminal while the previous
  // child is still alive — it delivered its verdict on stdout and lingered, or it
  // is inside the SIGTERM→SIGKILL grace. Spawning on top of that gives two
  // builders walking the same stores at once (each with its own --parse-one
  // grandchildren): unbounded concurrency and unbounded IO from one endpoint.
  // Kill it and detach its listeners so nothing it does later touches this build.
  if (child && child.exitCode === null && child.signalCode === null) {
    const stale = child;
    try { stale.stdout?.removeAllListeners(); } catch { /* already torn down */ }
    try { stale.stderr?.removeAllListeners(); } catch { /* already torn down */ }
    try { stale.removeAllListeners(); } catch { /* already torn down */ }
    try { stale.kill('SIGKILL'); } catch { /* already gone */ }
  }
  child = null;

  let stderrTail = '';
  let sawDone = false;
  let doneData = null;
  let lastLibraryId = null, lastSource = null;

  try {
    child = spawn(process.execPath, [BUILDER, '--json', ...(force ? ['--force'] : [])], {
      cwd: ROOT,
      // Inherit the environment so CSPACE_ALLOWLIST / CSPACE_DATA reach the
      // builder. Nothing secret is added here: the setup token is never put in
      // an env var a child could inherit (§2.1).
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    // A synchronous spawn throw is still a build that ended — the caller gets a
    // stream carrying one `error` event rather than a 500 and a dead panel.
    child = null;
    finish('error', { code: 'build-failed', message: 'builder could not start' }, myId);
    return handle;
  }

  const myChild = child;
  registerExitKill();

  // ---- stdout: NDJSON, one object per line, anything else dropped ----------
  let buf = '';
  let overlong = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (current.buildId !== myId) return;      // output from a superseded build
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (overlong) { overlong = false; continue; }   // tail of a dropped line
      handleLine(line);
    }
    if (buf.length > MAX_LINE) { buf = ''; overlong = true; }
  });

  function handleLine(line) {
    const s = line.trim();
    if (!s) return;
    let o;
    // A line that is not JSON is dropped, never forwarded: stdout is the machine
    // channel and an unrecognised line is by definition not one of our events.
    try { o = JSON.parse(s); } catch { return; }
    if (!o || typeof o !== 'object') return;

    if (o.ev === 'start') {
      current.total = Number(o.total) || 0;
      emit('started', {
        buildId, total: current.total, force: !!force, at: current.startedAt,
      });
      return;
    }
    if (o.ev === 'item') {
      if (o.status === 'parsed') current.parsed++;
      else if (o.status === 'cached') current.cached++;
      else if (o.status === 'failed') current.failed++;
      else return;
      if (typeof o.total === 'number' && o.total > current.total) current.total = o.total;
      lastLibraryId = typeof o.libraryId === 'string' ? o.libraryId : null;
      lastSource = typeof o.source === 'string' ? o.source : null;
      if (o.status === 'failed') {
        // Not coalesced: warnings are rare and each one is a distinct fact.
        emit('warning', { code: 'parse-failed', libraryId: lastLibraryId, source: lastSource });
      }
      queueProgress({
        parsed: current.parsed, cached: current.cached, failed: current.failed,
        total: current.total, source: lastSource, libraryId: lastLibraryId,
      });
      return;
    }
    if (o.ev === 'done') {
      sawDone = true;
      doneData = {
        buildId,
        parsed: Number(o.parsed) || 0,
        cached: Number(o.cached) || 0,
        failed: Number(o.failed) || 0,
        total: current.total,
        builtAt: null,          // filled at close, once index.json is on disk
        flagship: o.flagship && typeof o.flagship === 'object'
          ? {
            id: String(o.flagship.id ?? ''),
            source: String(o.flagship.source ?? ''),
            toolCalls: o.flagship.toolCalls ?? null,
          }
          : null,
      };
      return;
    }
    if (o.ev === 'error') {
      // The builder's own verdict wins over the exit code.
      doneData = null;
      finish('error', {
        code: typeof o.code === 'string' && /^[a-z-]{1,40}$/.test(o.code) ? o.code : 'build-failed',
        message: 'builder reported an error',
      }, myId);
      return;
    }
  }

  // ---- stderr: retained, never forwarded ----------------------------------
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (current.buildId !== myId) return;
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
  });

  // ---- heartbeat ----------------------------------------------------------
  timers.ping = setInterval(() => emit('ping', { t: Date.now() }), PING_MS);
  timers.ping.unref?.();

  // ---- timeout ------------------------------------------------------------
  timers.timeout = setTimeout(() => {
    if (current.buildId !== myId || settled) return;
    const c = myChild;
    finish('error', { code: 'build-timeout', message: 'builder exceeded the time limit' }, myId);
    if (c && c.exitCode === null) {
      try { c.kill('SIGTERM'); } catch { /* already gone */ }
      timers.kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
      timers.kill.unref?.();
    }
  }, BUILD_TIMEOUT_MS);
  timers.timeout.unref?.();

  // ---- child lifecycle ----------------------------------------------------
  child.on('error', () => {
    // spawn failure (ENOENT on the node binary, EACCES, …) — an error event,
    // never a hang.
    failFromExit(null, null, stderrTail, myId);
  });

  // 'close' rather than 'exit': stdio is fully drained by then, so a `done` line
  // written just before exit is not lost to a race.
  child.on('close', (code, signal) => {
    // Release the reaper's handle only for the process that actually died. This
    // is the one place `child` may be cleared, and only if it is still ours.
    if (child === myChild) child = null;
    if (current.buildId !== myId || settled) return;
    if (sawDone && doneData) {
      doneData.builtAt = indexMtime();
      finish('done', doneData, myId);
      return;
    }
    failFromExit(code, signal, stderrTail, myId);
  });

  return handle;
}

// ---------------------------------------------------------------------------
// reaping — a build must never outlive its parent
// ---------------------------------------------------------------------------

let exitHooked = false;
function registerExitKill() {
  if (exitHooked) return;
  exitHooked = true;
  // 'exit' covers a normal end and process.exit(). Only synchronous work is
  // allowed here, and kill() is synchronous.
  process.on('exit', () => { try { child?.kill('SIGKILL'); } catch { /* gone */ } });
  // Signals do not fire 'exit', so they need their own hook. Deliberately does
  // not change the host's exit semantics: it kills the child, detaches, and
  // re-raises only if nothing else was listening (i.e. the default action was
  // what would otherwise have happened).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSig = () => {
      try { child?.kill('SIGKILL'); } catch { /* gone */ }
      process.removeListener(sig, onSig);
      if (process.listenerCount(sig) === 0) {
        try { process.kill(process.pid, sig); } catch { process.exit(0); }
      }
    };
    process.on(sig, onSig);
  }
}

/** Test hook: drop all state. Never called by the server. */
export function resetBuildRunner() {
  try { child?.kill('SIGKILL'); } catch { /* gone */ }
  clearTimers();
  child = null;
  subscribers = new Set();
  replay = [];
  pendingProgress = null;
  settled = true;
  finishedResolve = null;
  current = { ...IDLE };
}
