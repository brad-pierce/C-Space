// dehome.test.mjs — hermetic node:test suite for the HUD event ticker's
// home-directory collapse (src/modules/hud.js: learnHome / dehome).
//
// Why this file exists: ticker lines are built from raw tool arguments
// (file_path, command, pattern, query, url), so an absolute path in a
// transcript puts the operator's OS account name on screen — in a tool that is
// screen-shared and has a demo video committed to the README. That is a defect,
// not a cosmetic issue, so the collapse is pinned by tests here.
//
// Hermetic: imports the module under test and reads only public/demo/session.json,
// which is committed, synthetic and safe to print. Nothing here touches
// ~/.claude, ~/.cspace or any other transcript store.
//
// EVERY NAME BELOW IS A PLACEHOLDER — 'you' / 'pat-lee' / 'myapp', the same
// convention as the projectLabel note in hud.js. This repo is public and these
// fixtures are the exact strings the collapse exists to keep off screen, so no
// real account or project name is written into them, and the leak oracles grep
// for the SHAPE of a home path rather than for any literal name (which also
// keeps the suite meaningful on any machine).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { dehome, learnHome } from '../src/modules/hud.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_FILE = join(__dirname, '..', 'public', 'demo', 'session.json');

// hud.js's trunc(), mirrored, so the ticker-width tests measure what the screen
// measures. The width sweep below asserts the leak is gone at EVERY plausible
// width rather than only at today's — the munged form stayed invisible in the
// first cut solely because the ticker cut one character short of it.
const trunc = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// a home path that still names an account, in any shape the ticker can carry
const HOME_RESIDUE =
  /(?:[A-Za-z]:[\\/]+|\/[a-z]\/|\/mnt\/[a-z]\/|\/cygdrive\/[a-z]\/|file:\/{2,3}(?:[A-Za-z]:[\\/]+)?|\\{2}[^\\/\s]+[\\/]+)users[\\/]+[^\\/\s"'`~]/i;
// Claude's munged directory key — 'C--Users-<name>' / '-Users-<name>'
const MUNGED_RESIDUE = /[A-Za-z]--users-|(?:^|[\\/\s"'`])-users-/i;

// ---------------------------------------------------------------------------
// 1. learnHome(): the account name comes from what the SESSION reports
// ---------------------------------------------------------------------------

test('learnHome reads the account name off an absolute cwd, any platform', () => {
  assert.equal(learnHome('C:\\Users\\you\\myapp'), 'you');
  assert.equal(learnHome('C:/Users/ada/myapp'), 'ada');
  assert.equal(learnHome('/c/Users/grace/myapp'), 'grace');
  assert.equal(learnHome('/mnt/c/Users/wsluser/myapp'), 'wsluser');   // WSL operator
  assert.equal(learnHome('/home/ops/myapp'), 'ops');                  // Linux
  assert.equal(learnHome('/Users/mac/myapp'), 'mac');                 // macOS
});

test('learnHome falls back to the munged project key when there is no cwd', () => {
  assert.equal(learnHome(null, 'C--Users-you-myapp'), 'you');
  assert.equal(learnHome(undefined, '-Users-ada-myapp'), 'ada');
  // the absolute path wins when both are present: it survives a hyphenated name
  assert.equal(learnHome('C:\\Users\\pat-lee\\myapp', 'C--Users-pat-lee-myapp'), 'pat-lee');
});

test('learnHome yields null when nothing reports a home, and dehome still works', () => {
  assert.equal(learnHome('D:\\work\\myapp'), null);
  assert.equal(learnHome('demo'), null);
  assert.equal(learnHome(null, undefined, ''), null);
  // the shape pass alone still collapses a rooted home path
  assert.equal(dehome('C:\\Users\\someone\\myapp\\a.js'), '~\\myapp\\a.js');
});

// ---------------------------------------------------------------------------
// 2. NO LEAK — the shapes the first cut already handled (regression guard)
// ---------------------------------------------------------------------------

test('the three original shapes still collapse, with or without a learned home', () => {
  for (const learned of [null, 'C:\\Users\\you\\myapp']) {
    learnHome(learned);
    assert.equal(dehome('C:\\Users\\you\\myapp\\a.js'), '~\\myapp\\a.js');
    assert.equal(dehome('C:/Users/you/myapp/a.js'), '~/myapp/a.js');
    assert.equal(dehome('/c/Users/you/myapp/a.js'), '~/myapp/a.js');
  }
});

// ---------------------------------------------------------------------------
// 3. NO LEAK — the residual shapes. Each of these renders the account name
//    under the first cut.
// ---------------------------------------------------------------------------

test('file:// URLs collapse — a url tool argument is a live vector, not theory', () => {
  // hud.js's own note lists `url` among the fields a ticker line is built from,
  // and the parser reads block.input.url for WebFetch / browser tool calls, so
  // one fetch of a local file is enough to put the account name on screen.
  learnHome(null);
  assert.equal(dehome('file:///C:/Users/you/docs/paper.pdf'), '~/docs/paper.pdf');
  assert.equal(dehome('file://C:/Users/you/docs/paper.pdf'), '~/docs/paper.pdf');
  assert.equal(dehome('file:///C:/Users/you/AppData/Local/Temp/x'), '~/AppData/Local/Temp/x');
  // bare-unix under file:// needs the learned name (see the over-eat tests)
  learnHome('/home/ops/myapp');
  assert.equal(dehome('file:///home/ops/notes.md'), '~/notes.md');
  assert.equal(dehome('file:///Users/ops/notes.md'), '~/notes.md');
});

test('UNC paths collapse', () => {
  learnHome(null);
  assert.equal(dehome('\\\\fileserver\\Users\\you\\share\\x.txt'), '~\\share\\x.txt');
  assert.equal(dehome('\\\\nas01\\Users\\you'), '~');
});

test('extended-length and device paths collapse', () => {
  learnHome(null);
  assert.equal(dehome('\\\\?\\C:\\Users\\you\\long\\x.txt'), '~\\long\\x.txt');
  assert.equal(dehome('\\\\.\\C:\\Users\\you\\dev\\x.txt'), '~\\dev\\x.txt');
  assert.equal(dehome('\\\\?\\UNC\\srv\\Users\\you\\x.txt'), '~\\x.txt');
});

test('the WSL mount collapses — /mnt/c/Users/<name> IS a real home', () => {
  // The first cut documented this as a deliberate non-match to protect WSL
  // paths. That inverted the risk: for an operator working through WSL this is
  // exactly where the account name shows up. Enumerating '/mnt/<d>/' as a root
  // removes the mangling worry ('/mnt~/…') that motivated the exclusion.
  learnHome(null);
  assert.equal(dehome('/mnt/c/Users/you/myapp/dist'), '~/myapp/dist');
  assert.equal(dehome("wsl.exe -e bash -c 'ls -la /mnt/c/Users/you/'"), "wsl.exe -e bash -c 'ls -la ~/'");
  assert.equal(dehome('/cygdrive/c/Users/you/myapp'), '~/myapp');
  assert.ok(!dehome('/mnt/c/Users/you/x').includes('/mnt~'));
});

test("the munged project key collapses — 'C--Users-<name>', at any depth", () => {
  // The one the first cut got away with by luck: it sits deep inside a temp
  // path and the ticker truncated one character short of it. Widen the ticker,
  // shorten a prefix or hit a shallower path and it renders.
  learnHome(null);
  assert.equal(dehome('C--Users-you-myapp'), '~-myapp');
  assert.equal(dehome('C--Users-you'), '~');
  assert.equal(
    dehome('C:\\Users\\you\\AppData\\Local\\Temp\\claude\\C--Users-you\\abc\\scratch'),
    '~\\AppData\\Local\\Temp\\claude\\~\\abc\\scratch',
  );
  assert.equal(
    dehome('~/.claude/projects/-Users-you-myapp/log.jsonl'),
    '~/.claude/projects/~-myapp/log.jsonl',
  );
});

test('a hyphenated account name collapses whole, not half', () => {
  // Shape-first ordering would collapse 'C--Users-pat-lee' to '~-lee' and leave
  // half the name on screen; the learned pass runs first for exactly this.
  learnHome('C:\\Users\\pat-lee\\myapp');
  assert.equal(dehome('C:\\Users\\pat-lee\\myapp\\a.js'), '~\\myapp\\a.js');
  assert.equal(dehome('C--Users-pat-lee-myapp'), '~-myapp');
  assert.equal(dehome('/home/pat-lee/x'), '~/x');
  for (const s of ['C:\\Users\\pat-lee\\myapp\\a.js', 'C--Users-pat-lee-myapp']) {
    assert.ok(!dehome(s).includes('lee'), `half-collapsed: ${dehome(s)}`);
  }
});

test('the learned home collapses bare unix shapes the shape pass will not guess', () => {
  learnHome('/home/ops/myapp');
  assert.equal(dehome('/home/ops/myapp/main.go'), '~/myapp/main.go');
  learnHome('/Users/mac/myapp');
  assert.equal(dehome('/Users/mac/myapp/main.go'), '~/myapp/main.go');
  // a DIFFERENT account under the same bare shape is left alone: guessing at
  // bare '/home/<x>' on shape alone would eat the '/home/' out of URL paths
  assert.equal(dehome('/Users/someoneelse/myapp'), '/Users/someoneelse/myapp');
});

// ---------------------------------------------------------------------------
// 4. NO BLANKING — the ticker must keep saying WHAT was touched. A fix that
//    eats the payload is worse than the leak it prevented.
// ---------------------------------------------------------------------------

test('a collapsed line keeps its payload and can never come out empty', () => {
  learnHome('C:\\Users\\you\\myapp');
  const cases = [
    ['C:\\Users\\you\\myapp\\internal\\store.go', 'internal\\store.go'],
    ['file:///C:/Users/you/docs/paper.pdf', 'docs/paper.pdf'],
    ['/mnt/c/Users/you/myapp/dist', 'myapp/dist'],
    ['\\\\?\\C:\\Users\\you\\long\\x.txt', 'long\\x.txt'],
    ['C--Users-you-myapp', 'myapp'],
  ];
  for (const [raw, tail] of cases) {
    const out = dehome(raw);
    assert.ok(out.length > 0, `blanked: ${raw}`);
    assert.ok(out.startsWith('~'), `lost the ~ marker: ${out}`);
    assert.ok(out.includes(tail), `payload lost: ${raw} -> ${out}`);
  }
  // a bare home with no tail collapses to the marker, not to nothing
  assert.equal(dehome('C:\\Users\\you'), '~');
});

test('collapsing frees width rather than spending it — the tail survives trunc', () => {
  learnHome('C:\\Users\\you\\myapp');
  const raw = 'C:\\Users\\you\\myapp\\internal\\pkg\\store.go';   // 39 chars, 28 collapsed
  // 34 is the tool_call width in hud.js _makeLine
  assert.ok(trunc(dehome(raw), 34).includes('store.go'));
  assert.ok(!trunc(raw, 34).includes('store.go'));
});

// ---------------------------------------------------------------------------
// 5. NO OVER-EAT — path-ish text that is not a home directory
// ---------------------------------------------------------------------------

test('text that merely looks path-ish is left byte-identical', () => {
  learnHome('C:\\Users\\you\\myapp');
  const keep = [
    'docs/guide/12-users-roles.md',        // a filename, not a home directory
    'Write alerts/siem, users/rbac, audit',
    'power-users-group',
    'https://example.com/users/you/repo',  // a URL host must survive
    'https://example.com/orgs/you-two/x',
    '`home/Backup` contains three folders',
    'C:\\Program Files\\node\\node.exe',
    '/etc/hosts',
    'grep -n "users" src/app.js',
    'SSO is not implemented|users-rbac',
    '',
    'short',
  ];
  for (const s of keep) assert.equal(dehome(s), s, `over-ate: ${s}`);
});

test('non-strings pass through untouched (spawn labels can be undefined)', () => {
  learnHome('C:\\Users\\you\\myapp');
  for (const v of [undefined, null, 0, 42, false, {}]) assert.equal(dehome(v), v);
});

// ---------------------------------------------------------------------------
// 6. Hot-path properties — this runs once per rendered ticker line
// ---------------------------------------------------------------------------

test('a non-matching subject comes back as the SAME string, not a copy', () => {
  learnHome('C:\\Users\\you\\myapp');
  const plain = 'RESULT 4.2KB — nothing path-shaped in this line at all';
  assert.equal(dehome(plain), plain);
  // .replace() with no match returns the original reference; this is what keeps
  // the common ticker line allocation-free.
  assert.ok(Object.is(dehome(plain), plain));
});

test('the global regexes are safe to reuse — repeated calls agree', () => {
  learnHome('C:\\Users\\you\\myapp');
  const s = 'cd C:\\Users\\you\\myapp && ls /c/Users/you/other';
  const first = dehome(s);
  for (let i = 0; i < 5; i++) assert.equal(dehome(s), first);
  assert.ok(!HOME_RESIDUE.test(first));
});

test('dehome is idempotent', () => {
  learnHome('C:\\Users\\you\\myapp');
  for (const s of [
    'C:\\Users\\you\\myapp\\a.js',
    'file:///C:/Users/you/x',
    '/mnt/c/Users/you/x',
    'C--Users-you-myapp',
    '\\\\srv\\Users\\you\\x',
  ]) assert.equal(dehome(dehome(s)), dehome(s));
});

test('re-learning the same account does not change behaviour', () => {
  assert.equal(learnHome('C:\\Users\\you\\myapp'), 'you');
  assert.equal(learnHome('C:\\Users\\you\\other'), 'you');   // same account, new project
  assert.equal(dehome('/home/you/x'), '~/x');
});

// ---------------------------------------------------------------------------
// 7. The committed demo session — the only session that is screenshot-safe by
//    construction, and the one in the README recording. It must render clean,
//    and it must not have moved.
// ---------------------------------------------------------------------------

// the fields _makeLine can put on screen
const renderable = (e) =>
  e.kind === 'tool_call' || e.kind === 'spawn' ? e.label
  : e.kind === 'hook' ? e.name
  : e.kind === 'user' || e.kind === 'say' ? e.preview
  : null;

const demoFields = () => {
  const demo = JSON.parse(readFileSync(DEMO_FILE, 'utf8'));
  const fields = [];
  for (const e of demo.events ?? []) {
    const raw = renderable(e);
    if (raw) fields.push(raw);
  }
  return { demo, fields };
};

test('the bundled demo renders with no home residue at any ticker width', () => {
  const { demo, fields } = demoFields();
  learnHome(demo.meta?.cwd);
  assert.ok(fields.length > 500, 'demo fixture looks empty — did public/demo move?');
  for (const w of [28, 30, 32, 34, 48, 64, 80, 120]) {
    for (const raw of fields) {
      const line = trunc(dehome(raw), w);
      assert.ok(!HOME_RESIDUE.test(line), `home path on screen at width ${w}: ${line}`);
      assert.ok(!MUNGED_RESIDUE.test(line), `munged key on screen at width ${w}: ${line}`);
      assert.ok(line.length > 0, `blanked at width ${w}: ${raw}`);
    }
  }
});

test('the bundled demo is unchanged by this pass — every line byte-identical', () => {
  // The first cut's dehome, verbatim. The demo is synthetic and carries none of
  // the residual shapes, so widening the collapse must not move a single
  // character of what the README recording shows.
  const OLD_RE = /(^|[^A-Za-z0-9_.~\\\/-])((?:[a-z]:[\\\/]|\/[a-z]\/)users[\\\/])[^\\\/\s"'`]+/gi;
  const oldDehome = (s) => (typeof s === 'string' && s.length > 7 ? s.replace(OLD_RE, '$1~') : s);

  const { demo, fields } = demoFields();
  learnHome(demo.meta?.cwd);
  for (const raw of fields) assert.equal(dehome(raw), oldDehome(raw), 'demo line moved');
  assert.ok(fields.length > 500);
});
