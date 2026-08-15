#!/usr/bin/env node
// cspace.mjs — THE RUNNER. One port serves everything: the built viz (dist/)
// as static files, plus the live-tail endpoints (/sessions, /stream) mounted
// from tools/live-server.mjs. Node stdlib only.
//
//   node tools/cspace.mjs [--port N] [--no-open] [--kiosk]
//
//   --port N    base port (default 5199); if busy, walks up to +10
//   --no-open   don't launch a browser
//   --kiosk     try a Chrome kiosk-mode launch; falls back to plain open
//
// Read-only against ~/.claude (via live-server.mjs); never writes anywhere.

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createTailHandler, listSessions, guard } from './live-server.mjs';
import { createSetupHandler, injectSetupBootstrap, isLoopbackBind } from './setup-server.mjs';
import { DATA_DIR, FLAGSHIP_FILE } from './cspace-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// ---------- flags ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] != null) return argv[i + 1];
  const kv = argv.find(a => a.startsWith(name + '='));
  return kv ? kv.slice(name.length + 1) : dflt;
};

const BASE_PORT = parseInt(opt('--port', '5199'), 10);
const NO_OPEN = flag('--no-open');
const KIOSK = flag('--kiosk');
// Loopback-only by default (transcripts must never reach the LAN). Opt into a
// wider bind explicitly with --host 0.0.0.0.
const HOST = opt('--host', '127.0.0.1');

if (!Number.isInteger(BASE_PORT) || BASE_PORT < 1 || BASE_PORT > 65535) {
  console.error(`[c-space] invalid --port value`);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('[c-space] dist/ is missing — run: npm run build');
  process.exit(1);
}

// ---------- static serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.map':  'application/json',
  '.txt':  'text/plain; charset=utf-8',
  '.woff2':'font/woff2',
  '.wasm': 'application/wasm',
};

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// Serve one file out of `root`, with the same guards for every root: lexical
// containment, then a realpath re-check so a symlink cannot escape.
// realpath of each root, resolved once at startup. The symlink re-check below
// must compare like with like: on Windows %TEMP% and many user-configured
// CSPACE_DATA paths are junctions or differ in case, so comparing a realpath'd
// FILE against a raw ROOT made every request under such a root 403 — the guard
// rejected the store wholesale instead of catching escapes. Falls back to the
// raw root when the directory does not exist yet (then nothing resolves anyway).
const realRoot = (p) => { try { return realpathSync(p); } catch { return p; } };
const REAL = { [DIST]: realRoot(DIST), [DATA_DIR]: realRoot(DATA_DIR) };

function sendFrom(req, res, root, pathname, spaFallback) {
  let file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) {   // traversal guard
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!isFile(file)) {
    if (spaFallback && !extname(pathname)) file = join(root, 'index.html');
    else { res.writeHead(404); res.end('not found'); return; }
  }
  try {
    const real = realpathSync(file);
    const base = REAL[root] ?? root;
    if (real !== base && !real.startsWith(base + sep)) { res.writeHead(403); res.end('forbidden'); return; }
  } catch { res.writeHead(404); res.end('not found'); return; }

  let body = readFileSync(file);
  const ext = extname(file).toLowerCase();

  // SETUP BOOTSTRAP INJECTION. The per-run setup token reaches the page ONLY
  // here — there is no endpoint that returns it, which is what makes the token
  // worth having. Injection happens at SERVE time, into the response buffer, so
  // dist/ on disk never contains it and a `vite build` output can be published
  // anywhere. Applies to every .html document served out of dist/ (index and
  // fleet alike — uniformity beats a special case; fleet.html simply ignores the
  // global). /data/* responses are never injected into.
  let cache = 'no-cache';
  if (ext === '.html' && root === DIST) {
    body = Buffer.from(injectSetupBootstrap(body.toString('utf8'), SETUP_MUTABLE), 'utf8');
    // no-store, not no-cache: a proxy or bfcache must never hand one run's
    // token to a later run, where it would be silently unauthenticated.
    cache = 'no-store';
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cache,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // /data/* maps to the out-of-repo session store (tools/cspace-paths.mjs), not
  // to dist/. Parsed transcripts therefore never live in the source tree and are
  // never baked into a build. No SPA fallback here: a missing data file must 404
  // so the app's own fallbacks (tail replay, allowlist guidance) can fire.
  if (pathname === '/data' || pathname.startsWith('/data/')) {
    sendFrom(req, res, DATA_DIR, pathname.slice('/data'.length) || '/', false);
    return;
  }
  sendFrom(req, res, DIST, pathname, true);
}

// ---------- browser launch ----------
function findChrome() {
  const candidates = [
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find(p => p && existsSync(p)) ?? null;
}

function plainOpen(url) {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin. The empty "" fills its window-title slot so
      // the quoted URL isn't mistaken for a title; verbatim args hand cmd the
      // exact string so its own quote rules apply, not node's re-quoting.
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`],
        { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* best-effort — the URL is in the startup log */ }
}

function openBrowser(url) {
  if (KIOSK) {
    const chrome = findChrome();
    if (chrome) {
      try {
        const child = spawn(chrome, ['--kiosk', '--new-window', url],
          { detached: true, stdio: 'ignore' });
        child.on('error', () => plainOpen(url));
        child.unref();
        return;
      } catch { /* fall through to plain open */ }
    }
    console.log('[c-space] --kiosk: chrome not found, opening default browser');
  }
  plainOpen(url);
}

// ---------- server ----------
const handleTail = createTailHandler();

// THE SETUP SURFACE IS ARMED ONLY AFTER WE KNOW WHAT WE BOUND TO. Both of these
// are decided in onListening from the resolved bind, and requests cannot arrive
// before then — so until that moment the surface declines everything and the
// injected bootstrap is the honest read-only form.
let handleSetup = () => false;
let SETUP_MUTABLE = false;

const server = createServer((req, res) => {
  // Loopback Host/Origin gate on every request (blocks LAN peers that slipped
  // through and DNS-rebinding domains); binding to 127.0.0.1 is the primary
  // defense, this is belt-and-suspenders and keeps CORS off `*`. It answers 403
  // on EVERY path, so it advertises nothing about /setup in particular; the
  // setup handler's own socket-peer check is the part that catches a server
  // mistakenly bound wide being reached by a peer forging `Host: localhost`.
  if (!guard(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (handleSetup(req, res)) return;  // /setup/* (loopback bind only; 404 otherwise)
  if (handleTail(req, res)) return;   // /sessions, /stream
  serveStatic(req, res, url);
});

function listen(port, attemptsLeft) {
  // paired once-listeners: whichever fires first detaches the other, so a
  // failed attempt's stale 'listening' callback can never fire on a retry
  const onError = (err) => {
    server.off('listening', onListening);
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`[c-space] port ${port} busy — trying ${port + 1}`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`[c-space] failed to bind: ${err.message}`);
      process.exit(1);
    }
  };
  const onListening = () => {
    server.off('error', onError);

    // AUTO-OFF. The setup surface exists only on a loopback bind. `--host
    // 0.0.0.0` is an explicit decision to expose transcripts to a network, and
    // a config-write verb has no business existing in that shape — so the
    // factory hands back a handler that declines everything and /setup/* 404s
    // like any unknown path, for the local operator too.
    const bound = server.address()?.address ?? HOST;
    SETUP_MUTABLE = isLoopbackBind(bound);
    handleSetup = createSetupHandler({ boundHost: bound, mutable: SETUP_MUTABLE });

    // The demo is the first thing a new operator sees: `npm start` must never
    // be blank or scolding. ?demo=1 plays the bundled SYNTHETIC session (no
    // real transcript) until a library exists.
    const hasFlagship = existsSync(FLAGSHIP_FILE);
    const url = `http://localhost:${port}/${hasFlagship ? '' : '?demo=1'}`;

    let sessionCount = 0;
    try { sessionCount = listSessions().length; } catch { /* ~/.claude absent */ }
    if (port !== BASE_PORT) console.log(`[c-space] port ${BASE_PORT} was busy — port ${port} won`);
    console.log(`[c-space] serving dist/ + live tail on http://localhost:${port}/`);
    console.log(`[c-space] ${sessionCount} allowlisted session(s) visible via /sessions`);
    // Says that the surface is armed and how it is fenced. THE TOKEN VALUE IS
    // NEVER PRINTED — it reaches the page by HTML injection and nothing else,
    // and this line lands in screen-shares.
    console.log(SETUP_MUTABLE
      ? `[c-space] setup surface armed at ${'http://localhost:' + port}/setup — loopback only, per-run token, this process only`
      : '[c-space] setup surface OFF (non-loopback bind) — configure with: npm run allowlist');
    console.log('[c-space] C-SPACE ONLINE');
    if (!NO_OPEN) openBrowser(url);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

listen(BASE_PORT, 10);
