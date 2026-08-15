// labels.test.mjs — the behaviour table for src/lib/labels.js.
//
// This is a PRIVACY rule with a display job, not a display rule with a privacy
// side effect. C-Space is screen-shared and there is a demo video of it in the
// README; the SETUP panel's tick list and the LIBRARY panel's PROJECT column
// both paint a harness's "project" field, and that field is a working directory.
// Left alone it spells out the OS username. The table below is the contract: for
// every path shape that reaches these panels, what the operator's audience sees.
//
// Every username in this file is fictional ("zaphod", "ford-prefect"). Nothing
// here may be derived from the machine it runs on — a test that hardcodes the
// real home directory to prove the home directory is hidden has published it.
//
// Pure imports, no I/O, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressProject, projectTag, HOME_LABEL, UNKNOWN_LABEL, TAG_MAX,
} from '../src/lib/labels.js';

const USER = 'zaphod';

// ---------------------------------------------------------------------------
// (a) THE TABLE
// ---------------------------------------------------------------------------
// input → exact rendered text. Grouped by the shape being pinned, because a
// flat list of 40 assertions is a list nobody reads when one of them breaks.
const TABLE = [
  // -- Windows slugs, the common case -------------------------------------
  ['C--Users-zaphod-myapp', 'myapp', 'windows slug, project under home'],
  ['C--Users-zaphod-harness-viz', 'harness-viz', 'hyphenated project name survives whole'],
  ['C--Users-zaphod-a', 'a', 'one-character project'],
  ['c--users-zaphod-myapp', 'myapp', 'already lowercase'],
  ['D--Users-zaphod-myapp', 'myapp', 'any drive letter'],

  // -- THE REGRESSION: the working directory IS the home directory --------
  // The old rule required a separator AFTER the username, so these matched
  // nothing and rendered "c--users-zaphod" — the OS username, as a project row,
  // in the panel that warns about screen-shares.
  ['C--Users-zaphod', HOME_LABEL, 'windows slug, cwd IS home'],
  ['C-Users-zaphod', HOME_LABEL, 'windows PATH "C:\\Users\\zaphod", cwd IS home'],
  ['C--Users-zaphod-', HOME_LABEL, 'trailing separator, cwd IS home'],
  ['C--Users-zaphod--', HOME_LABEL, 'doubled trailing separator'],
  ['/Users/zaphod', HOME_LABEL, 'macOS path, cwd IS home'],
  ['-Users-zaphod', HOME_LABEL, 'macOS slug, cwd IS home'],
  ['/home/zaphod', HOME_LABEL, 'linux path, cwd IS home'],
  ['-home-zaphod', HOME_LABEL, 'linux slug, cwd IS home'],
  ['/c/Users/zaphod', HOME_LABEL, 'MSYS path, cwd IS home'],
  ['-c-Users-zaphod', HOME_LABEL, 'MSYS slug, cwd IS home'],

  // -- macOS / Linux, project under home ----------------------------------
  // These leaked too: the old rule demanded a drive letter, so no Unix form
  // matched at all and every one of them rendered the username verbatim.
  ['-Users-zaphod-myapp', 'myapp', 'macOS slug'],
  ['/Users/zaphod/myapp', 'myapp', 'macOS path'],
  ['-home-zaphod-myapp', 'myapp', 'linux slug'],
  ['/home/zaphod/myapp', 'myapp', 'linux path'],
  ['/var/home/zaphod/myapp', 'myapp', 'linux /var/home (ostree)'],
  ['/c/Users/zaphod/myapp', 'myapp', 'MSYS / Git-Bash path'],
  ['/mnt/c/Users/zaphod/myapp', 'myapp', 'WSL onto the windows disk'],
  ['/cygdrive/c/Users/zaphod/myapp', 'myapp', 'cygwin'],
  ['C:/Users/zaphod/myapp', 'myapp', 'windows path, forward slashes'],
  ['C:\\Users\\zaphod\\myapp', 'myapp', 'windows path, native separators'],

  // -- worktrees, folded to the parent repo -------------------------------
  // Same folding tools/setup-discovery.mjs already does when it enumerates, so
  // the two panels agree on how many projects there are.
  ['C--Users-zaphod-northwind--claude-worktrees-eager-wu-c101c5', 'northwind',
    'worktree folds to its parent repo'],
  ['-Users-zaphod-northwind--claude-worktrees-eager-wu-c101c5', 'northwind',
    'macOS worktree — the old rule painted this one whole, username included'],
  ['C--Users-zaphod--claude-worktrees-eager-wu-c101c5', HOME_LABEL,
    'worktree of the home directory itself'],
  ['C--work-alpha--claude-worktrees-feature', 'work-alpha',
    'worktree outside home'],

  // -- not under a home directory -----------------------------------------
  ['C--work-alpha', 'work-alpha', 'drive prefix dropped, project stands alone'],
  ['C--Acme-Billing-Workspace', 'acme-billing-workspace', 'multi-segment project'],
  ['harness-viz', 'harness-viz', 'a bare label passes through'],
  ['/opt/tools/thing', 'opt-tools-thing', 'a unix path with no home in it'],
  ['/srv/app', 'srv-app', 'ditto, two segments'],

  // -- LABELS THAT ARE NOT PATHS AT ALL -----------------------------------
  // A Codex "project" is the BASENAME of the working directory, so these arrive
  // as ordinary words. The old drive rule (/^-*([A-Za-z])-+/) ran against every
  // label and ate a leading single letter as a drive letter: "i-need-an-icon-
  // logo-for" rendered as "need-an-icon-logo-for" — a word taken out of the
  // operator's own sentence. Worse than cosmetic: setup.js's readsAsProse()
  // reads the FIRST WORD to decide whether to caution about a screen-share, and
  // "i" is in its PERSONAL_LEAD set while "m" is not, so the compression was
  // switching the caution off for exactly the labels that needed it.
  ['i-need-a-parser-for', 'i-need-a-parser-for',
    'codex cwd basename — a leading "i" is a word, not a drive letter'],
  ['i-m-trying-to-figure-out', 'i-m-trying-to-figure-out',
    'the label the caution heuristic has to read whole'],
  ['a-quick-note-about-pay', 'a-quick-note-about-pay', 'leading "a" survives'],
  ['x-ray-scheduler', 'x-ray-scheduler', 'a real repo name that opens with a letter'],
  ['c-work-alpha', 'c-work-alpha',
    'one letter, one separator, no colon and no path shape — kept whole'],
  ['C:\\work\\alpha', 'work-alpha', 'a REAL windows path still loses its drive'],
  ['C:/work/alpha', 'work-alpha', 'ditto, forward slashes'],

  // -- drive and filesystem roots -----------------------------------------
  ['C--', 'c:', 'the drive root IS the project'],
  ['C-', 'c:', 'the path "C:"'],
  ['C:\\', 'c:', 'the path "C:\\"'],
  ['C--Users', 'users', 'the Users folder itself — no username in it'],
  ['-Users', 'users', 'ditto, unix form'],
  ['/', UNKNOWN_LABEL, 'the filesystem root compresses to nothing'],

  // -- nothing at all ------------------------------------------------------
  [null, UNKNOWN_LABEL, 'null'],
  [undefined, UNKNOWN_LABEL, 'undefined'],
  ['', UNKNOWN_LABEL, 'empty string'],
  ['-', UNKNOWN_LABEL, 'a lone separator'],
  ['---', UNKNOWN_LABEL, 'only separators'],
];

for (const [input, expected, why] of TABLE) {
  test(`compressProject ${JSON.stringify(input)} → ${JSON.stringify(expected)} (${why})`, () => {
    assert.equal(compressProject(input), expected);
  });
}

// ---------------------------------------------------------------------------
// (b) THE PROPERTY THAT ACTUALLY MATTERS
// ---------------------------------------------------------------------------
// The table says what each shape renders as. This says the thing the table is
// FOR, over every shape at once, so a shape added later without a table row
// still has to clear the bar.

const HOME_SHAPES = (u) => [
  `C--Users-${u}`,
  `C--Users-${u}-myapp`,
  `C--Users-${u}-myapp--claude-worktrees-feature`,
  `C-Users-${u}`,
  `C:\\Users\\${u}`,
  `C:\\Users\\${u}\\myapp`,
  `C:/Users/${u}/myapp`,
  `-Users-${u}`,
  `-Users-${u}-myapp`,
  `/Users/${u}`,
  `/Users/${u}/myapp`,
  `-home-${u}`,
  `-home-${u}-myapp`,
  `/home/${u}`,
  `/home/${u}/myapp`,
  `/var/home/${u}/myapp`,
  `-c-Users-${u}`,
  `/c/Users/${u}`,
  `/c/Users/${u}/myapp`,
  `/mnt/c/Users/${u}/myapp`,
  `/cygdrive/c/Users/${u}/myapp`,
];

test('no home-shaped label renders the username, in any casing', () => {
  for (const u of [USER, 'Zaphod', 'ZAPHOD', 'x', 'user1']) {
    for (const input of HOME_SHAPES(u)) {
      const out = compressProject(input);
      assert.ok(
        !out.toLowerCase().includes(u.toLowerCase()),
        `"${input}" rendered as "${out}", which still contains the username`
      );
    }
  }
});

test('nothing ever renders as the empty string — every row stays tickable', () => {
  const inputs = [
    ...HOME_SHAPES(USER),
    ...TABLE.map(([i]) => i),
    'C--', '-', '---', '/', '\\', '::', '--claude-worktrees-feature', 0, false, NaN,
  ];
  for (const input of inputs) {
    const out = compressProject(input);
    assert.equal(typeof out, 'string', `"${String(input)}" did not render a string`);
    assert.ok(out.length > 0, `"${String(input)}" rendered as the empty string`);
    assert.equal(out, out.trim(), `"${String(input)}" rendered with edge whitespace`);
  }
});

test('the home row is distinguishable from every other row', () => {
  // It must not collide with a real project, or the picker cannot tell them
  // apart — "do not silently drop the row" includes "do not silently merge it".
  const others = [
    'C--work-alpha', 'C--Users-zaphod-myapp', 'harness-viz', 'C--', 'C--Users',
    '/opt/tools/thing',
  ].map(compressProject);
  assert.ok(!others.includes(HOME_LABEL));
  assert.equal(new Set(others).size, others.length);
});

// ---------------------------------------------------------------------------
// (c) THE FALSE POSITIVES IT REFUSES TO MAKE
// ---------------------------------------------------------------------------
// A rule that collapses everything is not a safer rule, it is a broken picker:
// two unrelated projects rendering as the same row is a defect of its own. These
// pin the boundary of how greedy the home rule is allowed to be.

test('a project directory merely NAMED users or home is not a home directory', () => {
  assert.equal(compressProject('C--home-app'), 'home-app');
  assert.equal(compressProject('C--repos-users-guide'), 'repos-users-guide');
  assert.equal(compressProject('C--work-src-users-model'), 'work-src-users-model');
  assert.equal(compressProject('/opt/home/app'), 'opt-home-app');
  assert.equal(compressProject('/srv/users/app'), 'srv-users-app');
});

test('a path with no home segment keeps every segment it had', () => {
  assert.equal(compressProject('/opt/tools/thing'), 'opt-tools-thing');
  assert.equal(compressProject('-mnt-data-archive'), 'mnt-data-archive');
  assert.equal(compressProject('\\\\server\\share\\proj'), 'server-share-proj');
});

test('the rule is stateless — repeated calls agree', () => {
  // Guards against a /g regex leaking lastIndex between calls, which is the
  // classic way a "sometimes it leaks" bug gets shipped.
  for (let i = 0; i < 4; i++) {
    assert.equal(compressProject(`C--Users-${USER}`), HOME_LABEL);
    assert.equal(compressProject(`C--Users-${USER}-myapp`), 'myapp');
  }
});

test('compressProject is idempotent on its own output', () => {
  // Both panels render, re-render on a swap, and re-render again on a rebuild.
  // Running the rule over an already-compressed label must not keep eating it.
  for (const [input] of TABLE) {
    const once = compressProject(input);
    assert.equal(compressProject(once), once, `not idempotent for ${String(input)}`);
  }
});

test('the first word of a prose label survives compression', () => {
  // This is the seam setup.js's readsAsProse() sits on: it classifies a row as a
  // sentence by looking at w[0]. If compression eats the first word, the caution
  // that keeps somebody's own question off a screen-share never fires. Asserted
  // on the shape rather than by importing setup.js, which owns DOM.
  for (const [label, first] of [
    ['i-m-trying-to-figure-out', 'i'],
    ['i-need-a-parser-for', 'i'],
    ['we-should-talk-about-comp', 'we'],
    ['my-notes-about-the-thing', 'my'],
  ]) {
    assert.equal(compressProject(label).split('-')[0], first,
      `"${label}" lost its leading word, which is the word the caution reads`);
  }
});

// ---------------------------------------------------------------------------
// (d) THE KNOWN LIMIT, PINNED ON PURPOSE
// ---------------------------------------------------------------------------
test('a username containing the separator is only partly recoverable', () => {
  // "ford-prefect" flattens into the slug exactly the way "<user>/<project>"
  // does, and nothing in a browser can tell them apart — there is no homedir()
  // to compare against. The first segment comes off; the rest reads as project.
  // This is a documented limit, not an accident: tools/pii-scan.mjs knows the
  // real local home and is the check that can say the word out loud.
  assert.equal(compressProject('C--Users-ford-prefect-myapp'), 'prefect-myapp');
  // It still never renders the FULL name, and the home case is still clean.
  assert.ok(!compressProject('C--Users-ford-prefect-myapp').includes('ford-prefect'));
  assert.equal(compressProject('C--Users-ford-prefect'), 'prefect');
});

// ---------------------------------------------------------------------------
// (e) THE FLEET'S VOICE — SAME RULE, UPPERCASE AND CLIPPED
// ---------------------------------------------------------------------------
// The fleet paints project labels on machine nameplates, in the HUD roster, and
// in the hover card, in uppercase micro-type at a fixed width. That is a
// FORMATTING difference, not a rule difference, so it is an argument here rather
// than three more implementations.

test('projectTag is compressProject in uppercase', () => {
  for (const [input, expected] of TABLE) {
    assert.equal(projectTag(input, 64), expected.toUpperCase());
  }
});

test('projectTag never renders the username, in any casing', () => {
  for (const u of [USER, 'Zaphod', 'ZAPHOD', 'x', 'user1']) {
    for (const input of HOME_SHAPES(u)) {
      const out = projectTag(input);
      assert.ok(
        !out.toLowerCase().includes(u.toLowerCase()),
        `"${input}" tagged as "${out}", which still contains the username`
      );
    }
  }
});

test('projectTag clips to width and still never renders empty', () => {
  assert.equal(projectTag('C--Users-zaphod-a-very-long-project-name-indeed', 15).length, 15);
  assert.equal(projectTag('C--Users-zaphod'), HOME_LABEL);
  assert.equal(projectTag(null), UNKNOWN_LABEL);
  assert.equal(projectTag(''), UNKNOWN_LABEL);
  assert.equal(TAG_MAX, 18);
  for (const [input] of TABLE) {
    for (const max of [1, 8, 15, 18, undefined]) {
      const out = projectTag(input, max);
      assert.ok(out.length > 0, `"${String(input)}" tagged as the empty string`);
      if (Number.isFinite(max)) assert.ok(out.length <= max, `"${String(input)}" overflowed ${max}`);
    }
  }
});

// ---------------------------------------------------------------------------
// (f) EVERY SURFACE ACTUALLY USES THIS MODULE
// ---------------------------------------------------------------------------
// The bug this module exists to close survived two fix rounds because the rule
// was COPIED — first into setup.js and library.js, then again into all three
// fleet modules, where the copies knew Windows slugs and nothing else and so
// printed "USERS-<NAME>-APP" for every macOS and Linux session. Five
// implementations of one privacy rule IS the defect. If any surface grows its
// own copy back, this fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// [file, the binding it must import]
const CONSUMERS = [
  ['../src/modules/setup.js', 'compressProject'],
  ['../src/modules/library.js', 'compressProject'],
  ['../src/fleet/machines.js', 'projectTag'],
  ['../src/fleet/fleetHud.js', 'projectTag'],
  ['../src/fleet/fleetInteract.js', 'projectTag'],
];

for (const [rel, binding] of CONSUMERS) {
  test(`${rel} imports the shared rule instead of redefining it`, () => {
    const text = src(rel);
    assert.match(
      text,
      new RegExp(`import\\s*\\{[^}]*\\b${binding}\\b[^}]*\\}\\s*from\\s*'\\.\\./lib/labels\\.js'`),
      `expected an import of ${binding} from src/lib/labels.js`
    );
    assert.doesNotMatch(
      text,
      /(?:const|let|var|function)\s+(?:compressProject|projectTag|projectLabel)\b/,
      'the rule is defined locally again — that is the duplication that hid the bug'
    );
  });
}

test('no consumer keeps a private copy of the compression regexes', () => {
  for (const [rel] of CONSUMERS) {
    const text = src(rel);
    // the old shared copy: /^Users-[^-]+-?/i and /^Users-+/i
    assert.doesNotMatch(text, /Users-\+/i, `${rel} still carries a home-prefix regex`);
    assert.doesNotMatch(text, /Users-\[\^-\]\+/i, `${rel} still carries a home-prefix regex`);
    // the old fleet copy's drive strip: /^[A-Za-z]--/
    assert.doesNotMatch(text, /\^\[A-Za-z\]--/, `${rel} still carries a drive-prefix regex`);
  }
});
