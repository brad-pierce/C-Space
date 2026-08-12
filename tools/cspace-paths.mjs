// cspace-paths.mjs — where C-Space keeps parsed session data.
//
// DELIBERATELY OUTSIDE THE REPO. Parsed sessions contain transcript-derived
// content (dialogue previews, tool arguments, file paths), and keeping that
// inside the source tree is a standing hazard:
//   · one .gitignore slip commits it;
//   · `vite build` copies public/ into dist/, so it would be baked into the
//     built bundle and shipped anywhere dist/ is deployed.
// Neither risk is worth the convenience of a relative path, so the store lives
// in the user's own data directory and the servers map the /data/* URLs onto
// it. The URL contract is unchanged — the app still fetches /data/session.json
// and /data/library/index.json — so no front-end code knows the difference.
//
//   default:   ~/.cspace/data           (override: CSPACE_DATA env var)
//   layout:    <data>/session.json      the flagship (default archive)
//              <data>/library/<id>.json parsed library sessions
//              <data>/library/index.json library index

import { join, normalize, sep } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

// CSPACE_DATA is taken verbatim apart from normalization: a trailing separator
// ("D:\store\") would otherwise make every join produce a doubled separator and
// break the servers' containment checks, and an un-normalized path defeats the
// string comparison those checks rely on.
export const DATA_DIR = normalize(
  process.env.CSPACE_DATA && process.env.CSPACE_DATA.trim()
    ? process.env.CSPACE_DATA.trim()
    : join(homedir(), '.cspace', 'data'),
).replace(new RegExp(`\\${sep}+$`), '') || join(homedir(), '.cspace', 'data');

export const LIBRARY_DIR = join(DATA_DIR, 'library');
export const FLAGSHIP_FILE = join(DATA_DIR, 'session.json');
export const INDEX_FILE = join(LIBRARY_DIR, 'index.json');

/** create the store if absent; returns DATA_DIR */
export function ensureDataDir() {
  mkdirSync(LIBRARY_DIR, { recursive: true });
  return DATA_DIR;
}
