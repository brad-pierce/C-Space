// smoke.test.mjs — THE CORE hard smoke test (critique round 3 directive).
//
// Renders one deterministic frame headless at cam preset 1 (core close-up,
// ?freeze=1&cam=1&t=90) and asserts that more than 5% of framebuffer pixels
// exceed luminance 20 (Rec.709 luma, 0-255). If the protagonist is missing —
// or the post chain delivers a dead frame — this fails loudly.
//
// Zero dependencies: plain Chrome/Edge headless --screenshot + a hand-rolled
// PNG decoder over node:zlib. The Vite dev server must already be running
// (default http://localhost:5199); this script NEVER starts or stops servers.
//
// Usage:    node src/modules/core/smoke.test.mjs [baseUrl]
// Env:      HARNESS_CHROME=<path to chrome/edge exe>   HARNESS_BASE_URL=<url>
//
// Exit codes:
//   0 — PASS: core visibly renders through the default-quality pipeline.
//   1 — FAIL: core missing even at ?q=low (bloom/MSAA bypassed) — the core
//       module itself is not reaching the framebuffer.
//   2 — FAIL upstream: default-quality frame is dead, but ?q=low proves the
//       core renders — the post chain (bloom/MSAA path) is killing the frame,
//       not the core module. (Observed 2026-08-11: post.js samples:4 composer
//       RT + UnrealBloomPass sample-then-blend-back leaves the frame all-NaN
//       on this GL stack; calibrated: q=low 36.2% vs default 1.2% coverage.)
//
// Calibration (1280x720, vt=90): living core close-up measures ~36% of pixels
// above luminance 20 in the round-3 build, ~52% after the round-4 heart rework
// (heart + rings + flare + glow disc); a dead WebGL frame with only the DOM
// HUD measures ~1.2%. The 5% bar sits well clear of both.

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.argv[2] ?? process.env.HARNESS_BASE_URL ?? 'http://localhost:5199';
const SHOT_QUERY = '/?freeze=1&cam=1&t=90';        // cam1 = core close-up (frozen presets)
const WIDTH = 1280, HEIGHT = 720;
const LUM_THRESHOLD = 20;                          // 0-255 luma floor for a "lit" pixel
const MIN_LIT_FRACTION = 0.05;                     // directive: >5% of pixels must be lit
const VIRTUAL_TIME_MS = 25000;                     // lets the 30 settle frames elapse

// ---------------------------------------------------------------------------
function findBrowser() {
  const cands = [
    process.env.HARNESS_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of cands) if (c && existsSync(c)) return c;
  throw new Error('no Chrome/Edge found — set HARNESS_CHROME to a Chromium executable');
}

function capture(browser, url, outPng) {
  execFileSync(browser, [
    '--headless=new', '--disable-gpu-sandbox', '--no-first-run', '--hide-scrollbars',
    `--window-size=${WIDTH},${HEIGHT}`,
    `--virtual-time-budget=${VIRTUAL_TIME_MS}`,
    `--screenshot=${outPng}`,
    url,
  ], { timeout: 120_000, stdio: 'pipe' });
  if (!existsSync(outPng)) throw new Error('headless capture produced no screenshot: ' + url);
}

// Minimal PNG decode: 8-bit, RGB/RGBA, non-interlaced (Chrome's screenshot format).
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      const bitDepth = data[8], colorType = data[9], interlace = data[12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0)
        throw new Error(`unsupported PNG layout (depth=${bitDepth} color=${colorType} interlace=${interlace})`);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= channels && y > 0 ? px[prev + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad PNG filter ' + filter);
      }
      px[row + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

function litFraction(pngPath) {
  const { w, h, channels, px } = decodePng(readFileSync(pngPath));
  let over = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * channels;
    const lum = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    if (lum > LUM_THRESHOLD) over++;
  }
  return over / (w * h);
}

// ---------------------------------------------------------------------------
const browser = findBrowser();
const work = mkdtempSync(join(tmpdir(), 'harness-core-smoke-'));
const shotDefault = join(work, 'cam1-default.png');
const shotLow = join(work, 'cam1-qlow.png');
const pct = (f) => (100 * f).toFixed(2) + '%';

try {
  capture(browser, BASE_URL + SHOT_QUERY, shotDefault);
  const fracDefault = litFraction(shotDefault);
  console.log(`[core-smoke] cam1 default-quality: ${pct(fracDefault)} of pixels above luminance ${LUM_THRESHOLD} (need > ${pct(MIN_LIT_FRACTION)})`);

  if (fracDefault > MIN_LIT_FRACTION) {
    console.log('[core-smoke] PASS — the core reaches the framebuffer at its own close-up.');
    rmSync(work, { recursive: true, force: true });
    process.exit(0);
  }

  // Frame is dead. Attribute: does the core render when bloom/MSAA are bypassed?
  capture(browser, BASE_URL + SHOT_QUERY + '&q=low', shotLow);
  const fracLow = litFraction(shotLow);
  console.log(`[core-smoke] cam1 ?q=low diagnostic: ${pct(fracLow)} of pixels above luminance ${LUM_THRESHOLD}`);
  console.error(`[core-smoke] FAIL — default-quality core close-up is dead (${pct(fracDefault)} lit). Captures kept in ${work}`);

  if (fracLow > MIN_LIT_FRACTION) {
    console.error('[core-smoke] Attribution: core RENDERS at ?q=low — the post chain (bloom/MSAA path) is killing the frame upstream of the core module.');
    process.exit(2);
  }
  console.error('[core-smoke] Attribution: core is missing even at ?q=low — the core module itself is not reaching the framebuffer.');
  process.exit(1);
} catch (e) {
  console.error('[core-smoke] ERROR — ' + (e && e.message ? e.message : e));
  console.error('[core-smoke] Is the Vite dev server running at ' + BASE_URL + ' ? (this test never starts servers)');
  process.exit(1);
}
