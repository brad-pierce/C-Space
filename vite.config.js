// vite.config.js — multi-page build: the session view (index.html) and the fleet
// overview (fleet.html) both ship in dist/.
import { defineConfig } from 'vite';
import { resolve, dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, statSync } from 'node:fs';
import { DATA_DIR } from './tools/cspace-paths.mjs';
import { SETUP_TOKEN, TOKEN_RE } from './tools/setup-token.mjs';

const root = dirname(fileURLToPath(import.meta.url));

// Parsed session data lives OUTSIDE the repo (see tools/cspace-paths.mjs), so
// dev has to map /data/* onto that store exactly as the runner does — otherwise
// the URL contract would differ between `npm run dev` and `npm run start`.
// Contained + realpath-free but lexically guarded, GET/HEAD only, no directory
// listing: this middleware exists only to hand back JSON the app asks for.
function externalDataStore() {
  return {
    name: 'cspace-external-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let rel;
        try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
        catch { res.statusCode = 400; return res.end('bad request'); }
        const file = normalize(join(DATA_DIR, rel));
        if (file !== DATA_DIR && !file.startsWith(DATA_DIR + sep)) {
          res.statusCode = 403; return res.end('forbidden');
        }
        let st;
        try { st = statSync(file); } catch { res.statusCode = 404; return res.end('not found'); }
        if (!st.isFile()) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('Content-Type', extname(file) === '.json'
          ? 'application/json' : 'application/octet-stream');
        res.setHeader('Content-Length', st.size);
        res.setHeader('Cache-Control', 'no-cache');
        if (req.method === 'HEAD') return res.end();
        createReadStream(file).pipe(res);
      });
    },
  };
}

// DEV PARITY FOR THE SETUP SURFACE. `npm run dev` must behave exactly like
// `npm start`, or the panel would be untestable in the only environment where
// it is actually iterated on. So the dev server mounts its OWN setup surface
// with its OWN per-run token — never the runner's, and never a shared one.
//
// `apply: 'serve'` is load-bearing twice over: it keeps this plugin out of
// `vite build`, which is what keeps the token out of dist/, and it keeps
// tools/setup-server.mjs (which loads the allowlist) out of the build process.
function cspaceSetup() {
  let mutable = false;
  let handler = null;
  return {
    name: 'cspace-setup',
    apply: 'serve',
    async configureServer(server) {
      // AUTO-OFF (F3). `vite --host` exposes the dev server to the LAN; a
      // config-write verb has no business existing in that shape, so nothing
      // mounts and /setup/* falls through to Vite's own 404.
      const host = server.config.server.host;
      const loopback = host === undefined || host === false ||
                       host === 'localhost' || host === '127.0.0.1' || host === '::1';
      if (!loopback) return;

      // Imported through a runtime-built URL on purpose. Vite bundles this
      // config file before running it, and a literal specifier would drag the
      // whole server graph — including its own lazy `import('./setup-discovery
      // .mjs')` — into that bundle, where an optional module that is meant to
      // degrade at runtime becomes a hard build failure instead.
      const here = new URL('./tools/setup-server.mjs', import.meta.url).href;
      const { createSetupHandler } = await import(/* @vite-ignore */ here);
      handler = createSetupHandler({ boundHost: '127.0.0.1', mutable: true });
      mutable = true;

      server.middlewares.use('/setup', (req, res, next) => {
        // Connect strips the mount prefix, so req.url is '/state' here, not
        // '/setup/state'. Re-prefix before dispatch — the handler routes on the
        // full path, exactly as it does behind the runner.
        req.url = '/setup' + (req.url === '/' ? '' : req.url);
        if (!handler(req, res)) next();
      });

      // MOVE IT IN FRONT OF VITE'S OWN CORS MIDDLEWARE. Anything registered here
      // lands behind `corsMiddleware`, which answers OPTIONS itself with a 204
      // plus `Access-Control-Allow-Origin` / `-Allow-Headers` for any origin in
      // Vite's default dev allow-list — every port on localhost, and every
      // *.localhost subdomain. That hands a cross-origin page a SUCCESSFUL
      // preflight for `X-CSpace-Setup-Token` on /setup/allow, which is precisely
      // the answer the contract says must never exist (§4.1: OPTIONS ⇒ 404, no
      // CORS header, ever). The mutation itself still fails the exact-Origin
      // check, but "the preflight is refused" is a fence in its own right and it
      // must not be dev-only theatre. Running first also means our 404 for a
      // non-local caller is not preceded by Vite headers we then have to strip.
      const stack = server.middlewares.stack;
      const mine = stack.pop();
      if (mine) stack.unshift(mine);
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => ({
        tags: [{
          tag: 'script',
          children: 'window.__CSPACE_SETUP=' + JSON.stringify({
            // The shape assertion is structural, not decorative: base64url
            // cannot contain '<' or '&', and refusing to embed anything else
            // means no token value can ever break out of the script element.
            token: mutable && TOKEN_RE.test(SETUP_TOKEN) ? SETUP_TOKEN : null,
            mutable: mutable && TOKEN_RE.test(SETUP_TOKEN),
          }) + ';window.__CSPACE_SETUP.origin=location.origin;',
          injectTo: 'head-prepend',
        }],
      }),
    },
  };
}

export default defineConfig({
  plugins: [externalDataStore(), cspaceSetup()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        fleet: resolve(root, 'fleet.html'),
      },
    },
  },
});
