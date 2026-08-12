// vite.config.js — multi-page build: the session view (index.html) and the fleet
// overview (fleet.html) both ship in dist/.
import { defineConfig } from 'vite';
import { resolve, dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, statSync } from 'node:fs';
import { DATA_DIR } from './tools/cspace-paths.mjs';

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

export default defineConfig({
  plugins: [externalDataStore()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        fleet: resolve(root, 'fleet.html'),
      },
    },
  },
});
