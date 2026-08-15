// setup-token.mjs — the per-run secret that fences the setup surface, and the
// keyed digest that gives (source, project) pairs an opaque wire id.
//
// WHY A TOKEN AT ALL. Until this round the server was read-only with respect to
// its own configuration: a page could ask for data, it could not change what
// data exists. The setup surface hands the page a write verb (edit the
// allowlist, spawn a build), so it is gated by a secret that exists only inside
// this process and only for this run.
//
// RULES, all load-bearing:
//   · minted ONCE per process, at module load;
//   · NEVER written to disk, never put in an env var a child inherits, never
//     logged, never returned by any endpoint, never in a URL or query string;
//   · reaches the page ONLY by injection into the served HTML (below), so there
//     is nothing to GET;
//   · not rotated within a run — a restart mints a new one and every previously
//     injected page is then unauthenticated, which is correct, not a bug.
//
// SETUP_ID_SALT is a SEPARATE secret. Ids appear in the DOM and travel back on
// every mutation; keying that digest with the authentication secret would hand
// an attacker 200 chosen-plaintext oracles for the thing that authenticates.

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export const SETUP_TOKEN = randomBytes(32).toString('base64url');   // 43 chars
export const SETUP_ID_SALT = randomBytes(32);

// A base64url string structurally cannot contain '<', '&' or a quote. Asserting
// the shape before embedding makes that structural rather than incidental — the
// injector below refuses to emit anything that fails it.
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const ID_RE = /^p_[A-Za-z0-9_-]{22}$/;

/** The wire id for a (source, project) pair. One-way: nothing decodes out of
 *  it, and no filesystem path ever enters it. Stable for the life of the
 *  process, meaningless across processes (a restart re-salts). */
export function projectId(source, project) {
  const key = String(source) + '\u001f' + (project == null ? '\u0000null' : String(project));
  return 'p_' + createHmac('sha256', SETUP_ID_SALT).update(key, 'utf8').digest('base64url').slice(0, 22);
}

/** Constant-time token check. A LENGTH MISMATCH SHORT-CIRCUITS without a
 *  compare — timingSafeEqual throws on unequal lengths, and the length of a
 *  fixed-length secret is not itself a secret. */
export function tokenValid(presented) {
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(SETUP_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The inline bootstrap the page reads. `mutable:false` (token null) is the
 *  honest read-only form: no runner, a non-loopback bind, or a static server
 *  with no injector at all. */
export function setupBootstrap(mutable) {
  const armed = mutable === true && TOKEN_RE.test(SETUP_TOKEN);
  return 'window.__CSPACE_SETUP={token:' + (armed ? JSON.stringify(SETUP_TOKEN) : 'null') +
    ',mutable:' + armed + ',origin:location.origin};';
}

/** Inject the bootstrap as the first child of <head>. Idempotent: HTML that
 *  already carries __CSPACE_SETUP is returned untouched, so a second injector
 *  in the chain cannot leak a second (or stale) token. Never runs at build
 *  time — injection happens at SERVE time only, so dist/ holds no token. */
export function injectSetupBootstrap(html, mutable) {
  if (typeof html !== 'string' || html.includes('__CSPACE_SETUP')) return html;
  const tag = '<script>' + setupBootstrap(mutable) + '</script>';
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const script = html.search(/<script/i);
  if (script !== -1) return html.slice(0, script) + tag + html.slice(script);
  return html;   // no <head>, no <script> — not a document we recognise
}
