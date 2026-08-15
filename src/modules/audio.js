// audio.js — THE SOUNDSCAPE. Two beds, one gate:
//
// RADIO (default texture) — a curated SomaFM ambient stream on a plain
// HTMLAudioElement. Deliberately OUTSIDE the WebAudio graph: SomaFM's icecast
// mounts ship without CORS headers, so routing through a MediaElementSource
// would legally output pure silence. The element keeps its own volume, eased
// by an interval ramp (never a jump). Three listener-supported channels, each
// with an ordered failover list of direct mounts; 'error'/'ended' or a stall
// lasting >8s advances to the next mount, and when every mount fails the menu
// shows a non-blocking RADIO OFFLINE state (reselecting retries; the synth —
// if enabled — keeps playing).
//
// SYNTH (optional data-sonification layer) — the original fully procedural
// WebAudio score: no samples, no network assets, every voice synthesized from
// oscillators and one seeded noise buffer.
//
// GATE — browsers block autoplay, so neither bed makes a sound before a user
// gesture. One self-owned chip ("⏻ SOUND", HUD micro-typography, top center)
// expands on click into a micro-menu: OFF / RADIO / SYNTH / RADIO+SYNTH plus
// the channel list; ESC or click-away closes it. Mode + channel persist in
// localStorage under 'cspace-audio' (guarded; a value left under the pre-rename
// 'harness-audio' key is adopted and re-homed on first read, so an earlier
// visitor's armed preference survives). If a stored mode is not OFF the chip renders
// "armed" and the first gesture anywhere (pointer/key — not ESC, which is not
// a user activation) starts the audio; until then everything is silent, even
// with a persisted RADIO preference. Under ?freeze=1 the module is entirely
// absent — no chip, no menu, no element, no context, no update work.
//
// MIX — radio bed targets ~0.55 with eased ramps. In RADIO+SYNTH the synth is
// demoted to sonification: its event voices run through evMix at −10 dB from
// solo, the token bucket refills at half rate, and the procedural bed hum is
// muted (the radio owns the texture). The compaction boom stays at full level
// on fxBus — it is the one event that must punch through the bed — and it
// briefly ducks the radio the same way it ducks the synth bed.
//
// BED — the core's hum (SYNTH solo only in the blend). Two detuned saws
// through a slow-swept lowpass (~11s LFO), plus a barely-there 41Hz sub whose
// gain breathes on a ~6s cycle. Bed level scales gently with context fill
// (state.context.ctx / cap).
//
// EVENTS — short eased envelopes, never harsh:
//   tool_call   FM blip, pitch by toolFamily (shell low, search mid, mutate
//               bright, agents low root + fifth), stereo-panned by the tool's
//               totem azimuth (pan = sin(ringAngle), same ordering math as
//               totems.js: session.tools sorted by count desc, top 12 + OTHER)
//   tool_result softer half-gain octave-down echo of the call; errors land a
//               flattened-fifth (tritone) dissonance instead
//   user        warm gate swell (filtered saw pair, slow attack)
//   say         gentle amber chime cluster (three staggered sine partials)
//   thinking    filtered noise whisper (bandpass swell)
//   spawn       rising three-note triangle arpeggio; despawn = its inversion
//   compaction  the big one: lowpass-swept noise fall + pitch-dropped sine
//               boom + 300ms bed duck (procedural AND radio). Bypasses the
//               rate bucket (rare, load-bearing), guarded by its own cooldown.
//
// BUS — voices → evMix (RADIO+SYNTH duck stage) → fxBus → master gain (eased
// ramps only) → gentle compressor → destination. A cheap feedback-delay
// ambience (delay + lowpass + feedback gain, NO ConvolverNode) hangs off
// fxBus. Rate limit: token bucket, ~12 event voices/sec, burst 6 (both halved
// in RADIO+SYNTH) — 4× playback storms drop excess quietly. Fired batches
// larger than SEEK_FLOOD are seeks and stay silent. Voice slots (gain+panner
// pairs) are pooled and reused; only per-event source nodes are created, and a
// frame with no fired events allocates nothing.
//
// timeline.playing === false → beds only, no event voices. Live mode works
// unchanged (state.fired flows identically; unknown tools pan to OTHER, same
// as totems' idxFor fallback).
//
// Rapid toggle hygiene: exactly one HTMLAudioElement ever exists; channel and
// failover swaps pause it before changing src, so two streams can never stack.
//
// Module discipline: owns only this file; DOM/AudioContext/Audio-element/
// localStorage access happens in init()/gesture handlers, never at module top
// level, so the file imports clean under plain node.

// ---- tuning (plain data only — keep the top level node-safe) -----------------
const LS_KEY = 'cspace-audio';
const LS_KEY_LEGACY = 'harness-audio';  // pre-rename key — adopted once on read
const TOP_N = 12;          // mirror totems.js ring selection exactly
const PAN_WIDTH = 0.85;    // azimuth pan span — full ring, never hard-panned
const MAX_VOICES = 24;     // pooled gain+panner slots
const RATE = 12;           // event voices per second (token refill)
const BURST = 6;           // bucket cap — instant burst on dense frames
const SEEK_FLOOD = 50;     // fired batches beyond this are seeks — stay silent
const COMP_COOLDOWN = 0.5; // s between compaction hits

const MASTER_LEVEL = 0.85;
const BED_LEVEL = 0.16;    // scaled by context fill: 40%..100% of this

const RADIO_LEVEL = 0.55;     // radio bed target — reached by eased ramp only
const RADIO_GUARD_MS = 8000;  // stall watchdog before failover advances
const EV_DUCK = 0.316;        // −10 dB — synth event layer under the radio bed

const MODE_LABEL = {
  off: 'OFF',
  radio: 'RADIO',
  synth: 'SYNTH',
  'radio+synth': 'RADIO+SYNTH',
};

// SomaFM — listener-supported, commercial-free (somafm.com). Direct icecast
// mounts, ordered per channel as its failover chain. DEF CON and THE TRIP
// orders are user-specified; DRONE ZONE mounts were fetched live from
// https://somafm.com/dronezone.pls on 2026-08-11 (File1..File3 verbatim).
const CHANNELS = [
  {
    id: 'defcon', name: 'DEF CON', urls: [
      'https://ice2.somafm.com/defcon-128-mp3',
      'https://ice6.somafm.com/defcon-128-mp3',
      'https://ice5.somafm.com/defcon-128-mp3',
    ],
  },
  {
    id: 'thetrip', name: 'THE TRIP', urls: [
      'https://ice6.somafm.com/thetrip-128-mp3',
      'https://ice2.somafm.com/thetrip-128-mp3',
      'https://ice5.somafm.com/thetrip-128-mp3',
    ],
  },
  {
    id: 'dronezone', name: 'DRONE ZONE', urls: [
      'https://ice6.somafm.com/dronezone-128-mp3',
      'https://ice2.somafm.com/dronezone-128-mp3',
      'https://ice5.somafm.com/dronezone-128-mp3',
    ],
  },
];

// family → carrier Hz. shell low, search mid, mutate bright, agents a low
// root with a fifth partner (the violet-low-fifth). All picks sit on one
// C/G harmonic lattice so simultaneous blips chord instead of clashing.
const FAMILY_FREQ = {
  shell: 130.81,   // C3 — low
  search: 392.0,   // G4 — mid
  mutate: 784.0,   // G5 — bright
  agents: 98.0,    // G2 — violet low root
  web: 523.25,     // C5
  browser: 329.63, // E4
  meta: 440.0,     // A4
  other: 261.63,   // C4
};
const AGENTS_FIFTH = 146.83; // D3 — fifth above the agents root
const TRITONE = Math.SQRT2;  // flattened fifth ratio for error dissonance

const ARP_UP = [293.66, 440.0, 587.33];   // spawn: D4 A4 D5 rising
const ARP_DOWN = [587.33, 440.0, 293.66]; // despawn: the inversion falling
const CHIME = [880.0, 1174.66, 1567.98];  // say: A5 D6 G6 cluster
const CHIME_LVL = [0.05, 0.04, 0.032];

// ---- module state (assigned in init/gesture handlers — plain at top level) ---
let CTX = null;
let frozen = false;
let mode = 'off';          // persisted: 'off' | 'radio' | 'synth' | 'radio+synth'
let channelId = 'defcon';  // persisted alongside mode
let AC = null;             // AudioContext — exists only after a user gesture
let master, comp, fxBus;                    // spine
let evMix;                                  // event sub-bus (RADIO+SYNTH duck)
let bedMix, bedDuck;                        // bed level (fill) / compaction duck
let bedScale = 1;          // 0 in RADIO+SYNTH — the radio owns the texture
let noiseBuf = null;
let voices = [];           // pooled { g: Gain, p: StereoPanner|Gain, until }
let toolPan = null;        // Map tool name → pan; misses fall to otherPan
let otherPan = 0;
let tokens = BURST;
let compCool = 0;
let bedTimer = 0, bedLast = -1;
let chip = null;
let menuEl = null, statusEl = null, menuOpen = false;
let modeRows = [], chanRows = [];
let disarm = null;         // one-shot first-gesture listeners (armed state)

// radio state — the single HTMLAudioElement and its failover machine
let radioEl = null;
let radioActive = false;   // we intend it to be playing
let radioOffline = false;  // every mount of the current channel failed
let radioIdx = 0;          // position in the channel's failover chain
let radioAttempt = 0;      // monotonic token — stale handlers self-discard
let radioGuard = 0;        // stall-watchdog timeout id
let rampT = 0;             // volume ramp interval id

// ---- helpers -----------------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hasSynth = () => mode === 'synth' || mode === 'radio+synth';
const hasRadio = () => mode === 'radio' || mode === 'radio+synth';
const currentChannel = () => CHANNELS.find((c) => c.id === channelId) ?? CHANNELS[0];

// Totem azimuth → stereo pan. Replicates totems.js ordering byte for byte:
// numOf coercion, count-desc sort (stable), slice(0,12), OTHER appended last,
// angle a = (i/N)*2π + π/N, world x = sin(a)·R. Default camera looks down -z
// with +x screen-right, so pan = sin(a) scaled into a comfortable width.
function buildPanTable(session) {
  const numOf = (v, k = 'count') => (Number.isFinite(v?.[k]) ? Math.max(0, v[k]) : 0);
  const entries = Object.entries(session.tools ?? {})
    .sort((a, b) => numOf(b[1]) - numOf(a[1]));
  const top = entries.slice(0, TOP_N);
  const N = top.length + 1;                 // + OTHER, same as totems' list
  toolPan = new Map();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.PI / N;
    const pan = PAN_WIDTH * Math.sin(a);
    if (i < top.length) toolPan.set(top[i][0], pan);
    else otherPan = pan;                    // OTHER slot — idxFor fallback
  }
}
function panOf(tool) {
  const p = toolPan.get(tool);
  return p === undefined ? otherPan : p;
}

// Disconnect a finished voice's private nodes so the pooled bus stays lean.
function autoKill(src, nodes) {
  src.onended = () => { for (let i = 0; i < nodes.length; i++) nodes[i].disconnect(); };
}

// Claim a pooled slot that has fully decayed; null = pool saturated → drop
// quietly (a second, softer rate limit — no clicks from voice stealing).
function grabVoice(now, dur, pan) {
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (v.until <= now) {
      v.until = now + dur;
      if (v.p.pan) v.p.pan.value = pan;
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setValueAtTime(0, now);
      return v;
    }
  }
  return null;
}

// Standard eased envelope on a (already zeroed) gain param: quick linear
// attack, exponential-approach release. Never a hard edge.
function envAt(param, t0, attack, peak, tail) {
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.setTargetAtTime(0, t0 + attack, tail);
}

// ---- persistence (guarded — private mode / corrupt values fall to defaults) --
function loadPref() {
  try {
    let raw = localStorage.getItem(LS_KEY);
    if (raw === null) {
      // A visitor who armed sound before the C-SPACE rename stored it under the
      // old key. Adopt that value once and re-home it under the new key, so the
      // rename never silently un-arms someone's audio.
      const legacy = localStorage.getItem(LS_KEY_LEGACY);
      if (legacy !== null) {
        raw = legacy;
        try { localStorage.setItem(LS_KEY, legacy); } catch { /* private mode */ }
      }
    }
    if (raw === '1') { mode = 'radio'; return; }  // legacy ON → the new default texture
    if (!raw || raw === '0') return;              // legacy OFF / nothing stored
    const p = JSON.parse(raw);
    if (MODE_LABEL[p?.mode]) mode = p.mode;
    if (CHANNELS.some((c) => c.id === p?.channel)) channelId = p.channel;
  } catch { /* keep defaults */ }
}
function savePref() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ mode, channel: channelId })); }
  catch { /* private mode */ }
}

// ---- graph construction (inside the first user gesture) ----------------------
function buildGraph() {
  const t = AC.currentTime;

  // spine: master (eased ramps only) → gentle compressor → out
  master = AC.createGain();
  master.gain.value = 0;
  comp = AC.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 18;
  comp.ratio.value = 3;
  comp.attack.value = 0.008;
  comp.release.value = 0.3;
  master.connect(comp);
  comp.connect(AC.destination);

  // event bus + cheap feedback-delay ambience (delay→lowpass→feedback loop)
  fxBus = AC.createGain();
  fxBus.connect(master);
  const dSend = AC.createGain(); dSend.gain.value = 0.22;
  const delay = AC.createDelay(1); delay.delayTime.value = 0.31;
  const dFilt = AC.createBiquadFilter();
  dFilt.type = 'lowpass'; dFilt.frequency.value = 1800;
  const dFb = AC.createGain(); dFb.gain.value = 0.34;
  const dWet = AC.createGain(); dWet.gain.value = 0.45;
  fxBus.connect(dSend);
  dSend.connect(delay);
  delay.connect(dFilt);
  dFilt.connect(dFb);
  dFb.connect(delay);
  dFilt.connect(dWet);
  dWet.connect(master);

  // event sub-bus: pooled voices land here so RADIO+SYNTH can pull the data
  // layer down −10 dB without touching the compaction path (which connects
  // straight to fxBus and stays full — it must punch through the bed).
  evMix = AC.createGain();
  evMix.gain.value = 1;
  evMix.connect(fxBus);

  // BED — detuned saw pair through a slow-swept lowpass, breathing sub
  bedDuck = AC.createGain(); bedDuck.gain.value = 1;   // compaction duck stage
  bedDuck.connect(master);
  bedMix = AC.createGain(); bedMix.gain.value = 0;     // fill-scaled level
  bedMix.connect(bedDuck);

  const bedFilter = AC.createBiquadFilter();
  bedFilter.type = 'lowpass';
  bedFilter.frequency.value = 260;
  bedFilter.Q.value = 0.8;
  bedFilter.connect(bedMix);

  const oscA = AC.createOscillator();
  oscA.type = 'sawtooth'; oscA.frequency.value = 55; oscA.detune.value = -6;
  const oscB = AC.createOscillator();
  oscB.type = 'sawtooth'; oscB.frequency.value = 55; oscB.detune.value = +7;
  oscA.connect(bedFilter);
  oscB.connect(bedFilter);

  const lfoF = AC.createOscillator();                  // ~11s filter sweep
  lfoF.type = 'sine'; lfoF.frequency.value = 0.09;
  const lfoFGain = AC.createGain(); lfoFGain.gain.value = 130;
  lfoF.connect(lfoFGain);
  lfoFGain.connect(bedFilter.frequency);

  const sub = AC.createOscillator();                   // barely-there sub pulse
  sub.type = 'sine'; sub.frequency.value = 41.2;
  const subGain = AC.createGain(); subGain.gain.value = 0.05;
  sub.connect(subGain);
  subGain.connect(bedMix);
  const breath = AC.createOscillator();                // the ~6s breath
  breath.type = 'sine'; breath.frequency.value = 1 / 6;
  const breathGain = AC.createGain(); breathGain.gain.value = 0.045;
  breath.connect(breathGain);
  breathGain.connect(subGain.gain);

  oscA.start(t); oscB.start(t); lfoF.start(t); sub.start(t); breath.start(t);

  // seeded noise buffer — whispers and the compaction sweep share it
  const len = (AC.sampleRate * 1.5) | 0;
  noiseBuf = AC.createBuffer(1, len, AC.sampleRate);
  const data = noiseBuf.getChannelData(0);
  let s = 0xBADA55;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1103515245) + 12345) | 0;
    data[i] = (s / 2147483648) * 0.6;
  }

  // pooled voice slots: gain → panner → evMix, reused across events
  voices = [];
  const hasPan = !!AC.createStereoPanner;
  for (let i = 0; i < MAX_VOICES; i++) {
    const p = hasPan ? AC.createStereoPanner() : AC.createGain();
    p.connect(evMix);
    const g = AC.createGain();
    g.gain.value = 0;
    g.connect(p);
    voices.push({ g, p, until: 0 });
  }
}

// ---- synth gate control -------------------------------------------------------
function ensureAudio() {
  if (!hasSynth() || frozen) return;
  if (!AC) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    AC = new Ctor();
    buildGraph();
  }
  applyMix();
  const kick = () => {
    const now = AC.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setTargetAtTime(MASTER_LEVEL, now, 0.25);  // eased fade-in
    bedLast = -1; bedTimer = 0;                            // re-push bed level
    paintChip();
  };
  if (AC.state !== 'running') AC.resume().then(kick, () => {});
  else kick();
  paintChip();
}

function muteAudio() {
  if (!AC) return;
  const now = AC.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.setTargetAtTime(0, now, 0.08);               // eased fade-out
  setTimeout(() => {
    if (!hasSynth() && AC && AC.state === 'running') AC.suspend().then(paintChip);
  }, 450);
}

// Blend law: RADIO+SYNTH demotes the synth to a sonification layer — event bus
// eased to −10 dB, procedural bed hum muted (the radio owns the texture), and
// the token bucket (see update) refills at half rate. SYNTH solo restores all.
function applyMix() {
  if (!AC) return;
  const mixed = mode === 'radio+synth';
  evMix.gain.setTargetAtTime(mixed ? EV_DUCK : 1, AC.currentTime, 0.2);
  bedScale = mixed ? 0 : 1;
  bedLast = -1;                                            // force bed re-push
}

// ---- radio bed (plain HTMLAudioElement — never in the WebAudio graph) --------
// Eased volume ramp: step element.volume on an interval, easeOutQuad, never a
// jump. New ramps cancel pending ones (their done-callbacks are dropped).
function rampVol(to, secs, done) {
  if (!radioEl) return;
  if (rampT) { clearInterval(rampT); rampT = 0; }
  const from = radioEl.volume;
  const t0 = performance.now();
  const ms = Math.max(secs * 1000, 1);
  rampT = setInterval(() => {
    const k = clamp01((performance.now() - t0) / ms);
    const e = 1 - (1 - k) * (1 - k);
    radioEl.volume = clamp01(from + (to - from) * e);
    if (k >= 1) {
      clearInterval(rampT); rampT = 0;
      if (done) done();
    }
  }, 33);
}

function clearGuard() {
  if (radioGuard) { clearTimeout(radioGuard); radioGuard = 0; }
}
function armGuard() {
  clearGuard();
  const at = radioAttempt;
  radioGuard = setTimeout(() => { radioGuard = 0; failCurrent(at); }, RADIO_GUARD_MS);
}

// Fully release the stream after a pause: a paused HTMLAudioElement with a
// live icecast src keeps the socket open and buffering forever (a zombie
// stream, worst after a stall-failover where the mount is still healthy).
// removeAttribute('src') + load() aborts the fetch without firing 'error'
// (and the radioActive guard covers browsers that fire one anyway).
function detachRadioSrc() {
  try { radioEl.pause(); radioEl.removeAttribute('src'); radioEl.load(); }
  catch { /* already dead */ }
}

function buildRadioEl() {
  if (radioEl) return;        // exactly one HTMLAudioElement, ever
  radioEl = new Audio();
  radioEl.preload = 'none';   // no network activity before the user asks
  radioEl.volume = 0;
  radioEl.addEventListener('error', () => { if (radioActive) failCurrent(radioAttempt); });
  radioEl.addEventListener('ended', () => { if (radioActive) failCurrent(radioAttempt); });
  const stall = () => { if (radioActive && !radioGuard) armGuard(); };
  radioEl.addEventListener('stalled', stall);
  radioEl.addEventListener('waiting', stall);
  radioEl.addEventListener('timeupdate', () => { if (radioGuard) clearGuard(); });
  radioEl.addEventListener('playing', () => { clearGuard(); paintChip(); paintMenu(); });
  radioEl.addEventListener('pause', () => paintChip());
}

// Start (or restart) the current channel's current mount. Hygiene: the one
// element is paused BEFORE the src swap so two streams can never stack.
function playCurrent() {
  clearGuard();
  const at = ++radioAttempt;                // invalidates all stale handlers
  radioEl.pause();
  radioEl.src = currentChannel().urls[radioIdx];
  radioEl.load();
  radioEl.volume = 0;
  const p = radioEl.play();
  if (p && p.catch) p.catch((err) => {
    if (at !== radioAttempt || !radioActive) return;       // stale attempt
    if (err && err.name === 'NotAllowedError') {
      // autoplay policy said no — the "gesture" wasn't one (ESC-adjacent).
      // Stay armed rather than burning failover mounts on a policy error.
      radioActive = false;
      armForGesture();
      paintChip();
    } else {
      failCurrent(at);
    }
  });
  armGuard();
  rampVol(RADIO_LEVEL, 1.2);
  paintChip(); paintMenu();
}

// A mount died ('error'/'ended'/8s stall) — advance the failover chain. When
// the chain is exhausted the channel goes OFFLINE: non-blocking (synth keeps
// playing if enabled), retried on the next manual selection in the menu.
function failCurrent(at) {
  if (at !== radioAttempt || !radioActive) return;
  clearGuard();
  radioIdx++;
  if (radioIdx >= currentChannel().urls.length) {
    radioOffline = true;
    radioActive = false;
    radioAttempt++;
    detachRadioSrc();          // a stalled mount is still buffering — release it
    paintChip(); paintMenu();
    return;
  }
  playCurrent();
}

// Called only from gesture context. OFFLINE is sticky here by design — only a
// manual reselect (setMode / selectChannel clears the flag) retries.
function ensureRadio() {
  if (frozen || !hasRadio()) return;
  if (radioOffline) { paintChip(); paintMenu(); return; }
  if (!radioEl) buildRadioEl();
  if (radioActive && !radioEl.paused) { rampVol(RADIO_LEVEL, 0.6); return; }
  radioActive = true;
  radioIdx = 0;
  playCurrent();
}

function stopRadio() {
  clearGuard();
  radioActive = false;
  radioAttempt++;                            // stale failover timers self-discard
  if (!radioEl) return;
  rampVol(0, 0.3, () => {
    detachRadioSrc();          // pause + drop the stream — no buffering zombie
    paintChip();
  });
  paintChip();
}

// Compaction punches through the radio bed too: fast eased dip, ~300ms hold
// (matching bedDuck), eased recovery — all through the same ramp engine.
function duckRadioForBoom() {
  if (!radioEl || !radioActive) return;
  rampVol(RADIO_LEVEL * 0.3, 0.05, () => {
    setTimeout(() => {
      if (radioActive && hasRadio()) rampVol(RADIO_LEVEL, 0.5);
    }, 300);
  });
}

// ---- mode / channel selection (always called from a user gesture) ------------
function setMode(m) {
  if (!MODE_LABEL[m]) return;
  mode = m;
  savePref();
  if (disarm) disarm();                      // this gesture supersedes the arm
  if (hasRadio()) { radioOffline = false; radioIdx = 0; }  // manual pick retries
  if (hasSynth()) ensureAudio();
  else if (AC) muteAudio();
  if (hasRadio()) ensureRadio();
  else stopRadio();
  applyMix();
  paintChip(); paintMenu();
}

function selectChannel(id) {
  if (!CHANNELS.some((c) => c.id === id)) return;
  const same = id === channelId;
  channelId = id;
  radioOffline = false;                      // manual selection always retries
  radioIdx = 0;
  savePref();
  if (!hasRadio()) {                         // picking a channel implies radio
    setMode(mode === 'synth' ? 'radio+synth' : 'radio');
    return;
  }
  if (!radioEl) buildRadioEl();
  if (same && radioActive && !radioEl.paused) { paintMenu(); return; }
  radioActive = true;
  playCurrent();
}

// First-gesture unlock for a persisted non-OFF mode: idempotent install of
// one-shot pointer/key listeners. ESC is excluded (browsers do not count it
// as a user activation), and gestures on the chip or menu are excluded — they
// run their own handlers, so acting here too would double-drive the gate (the
// armed-click contradiction an earlier review fixed).
function armForGesture() {
  if (disarm || frozen || mode === 'off') return;
  const arm = (e) => {
    if (e.type === 'keydown' && e.key === 'Escape') return;
    const t = e.target;
    if (t === chip || (chip && chip.contains(t))) return;
    if (menuEl && menuEl.contains(t)) return;
    disarm();
    unlock();
  };
  disarm = () => {
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
    disarm = null;
  };
  addEventListener('pointerdown', arm);
  addEventListener('keydown', arm);
}

// The actual gate-open, called only from genuine gesture context.
function unlock() {
  if (hasSynth()) ensureAudio();
  if (hasRadio()) ensureRadio();
  paintChip();
}

// ---- chip + menu painting ------------------------------------------------------
function paintChip() {
  if (!chip) return;
  const radioLive = !!(radioEl && radioActive && !radioEl.paused);
  const synthLive = !!(AC && AC.state === 'running' && hasSynth());
  const audible = radioLive || synthLive;
  const stuckOffline = radioOffline && !hasSynth();        // nothing left to arm
  let cls = 'audiox-chip';
  if (audible) cls += ' on';
  else if (mode !== 'off' && !stuckOffline) cls += ' armed';
  if (chip.className !== cls) chip.className = cls;
  const label = '⏻ SOUND' + (mode !== 'off' ? ' · ' + MODE_LABEL[mode] : '');
  if (chip.textContent !== label) chip.textContent = label;
  chip.title = mode === 'off'
    ? 'audio off — click for modes'
    : audible
      ? `audio on (${MODE_LABEL[mode].toLowerCase()}) — click for modes`
      : stuckOffline
        ? 'radio offline — click to retry or switch channel'
        : 'audio armed — click or press any key to start';
}

function paintMenu() {
  if (!menuEl) return;
  for (let i = 0; i < modeRows.length; i++) {
    const [m, el] = modeRows[i];
    const cls = 'audiox-mi' + (m === mode ? ' act' : '');
    if (el.className !== cls) el.className = cls;
  }
  for (let i = 0; i < chanRows.length; i++) {
    const [id, el] = chanRows[i];
    const cls = 'audiox-mi' + (id === channelId ? ' act' : '');
    if (el.className !== cls) el.className = cls;
  }
  // OFFLINE reads only while radio is part of the mode — stale otherwise
  const scls = 'audiox-status' + (radioOffline && hasRadio() ? ' show' : '');
  if (statusEl.className !== scls) statusEl.className = scls;
}

// ---- voices ------------------------------------------------------------------
// FM blip: sine carrier + fast-decaying modulator into carrier frequency.
function fmBlip(now, freq, pan, level, tail = 0.07, bright = 2.2) {
  const v = grabVoice(now, 0.5 + tail * 4, pan);
  if (!v) return;
  const car = AC.createOscillator();
  car.type = 'sine'; car.frequency.value = freq;
  const mod = AC.createOscillator();
  mod.type = 'sine'; mod.frequency.value = freq * 2.7;
  const mg = AC.createGain();
  mg.gain.setValueAtTime(freq * bright, now);
  mg.gain.setTargetAtTime(0, now, 0.055);                  // brightness decays first
  mod.connect(mg);
  mg.connect(car.frequency);
  car.connect(v.g);
  envAt(v.g.gain, now, 0.006, level, tail);
  car.start(now); mod.start(now);
  const stop = now + 0.35 + tail * 3;
  car.stop(stop); mod.stop(stop);
  autoKill(car, [car, mod, mg]);
}

function toolCall(now, ev) {
  const fam = CTX.toolFamily(ev.tool);
  const f = FAMILY_FREQ[fam] ?? FAMILY_FREQ.other;
  const pan = panOf(ev.tool);
  fmBlip(now, f, pan, 0.11);
  if (fam === 'agents') fmBlip(now, AGENTS_FIFTH, pan, 0.06, 0.09, 1.4); // low fifth
}

function toolResult(now, ev) {
  const fam = CTX.toolFamily(ev.tool);
  const f = FAMILY_FREQ[fam] ?? FAMILY_FREQ.other;
  const pan = panOf(ev.tool);
  if (ev.err) {
    // flattened-fifth dissonance: root + tritone, longer sour tail
    const root = f * 0.5;
    fmBlip(now, root, pan, 0.07, 0.16, 1.2);
    fmBlip(now, root * TRITONE, pan, 0.06, 0.16, 1.2);
  } else {
    fmBlip(now, f * 0.5, pan, 0.05, 0.05, 1.1);            // softer octave-down echo
  }
}

// Warm gate swell — filtered saw pair, slow attack, centered (the user arrives
// at the core, not on the ring).
function userSwell(now) {
  const v = grabVoice(now, 1.9, 0);
  if (!v) return;
  const filt = AC.createBiquadFilter();
  filt.type = 'lowpass'; filt.Q.value = 0.7;
  filt.frequency.setValueAtTime(420, now);
  filt.frequency.linearRampToValueAtTime(1400, now + 0.42);
  filt.frequency.setTargetAtTime(500, now + 0.5, 0.4);
  filt.connect(v.g);
  const o1 = AC.createOscillator();
  o1.type = 'sawtooth'; o1.frequency.value = 110;
  const o2 = AC.createOscillator();
  o2.type = 'sawtooth'; o2.frequency.value = 164.81;       // warm fifth
  o1.connect(filt); o2.connect(filt);
  v.g.gain.linearRampToValueAtTime(0.085, now + 0.38);     // the swell
  v.g.gain.setTargetAtTime(0, now + 0.55, 0.28);
  o1.start(now); o2.start(now);
  o1.stop(now + 1.8); o2.stop(now + 1.8);
  autoKill(o1, [o1, o2, filt]);
}

// Gentle amber chime cluster — three staggered sine partials, bell decays.
function sayChime(now) {
  const v = grabVoice(now, 1.6, 0.1);
  if (!v) return;
  v.g.gain.setValueAtTime(1, now);                         // partials own their envelopes
  let last = null;
  const kill = [];
  for (let i = 0; i < CHIME.length; i++) {
    const t0 = now + i * 0.055;
    const o = AC.createOscillator();
    o.type = 'sine'; o.frequency.value = CHIME[i];
    const og = AC.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(CHIME_LVL[i], t0 + 0.012);
    og.gain.setTargetAtTime(0, t0 + 0.012, 0.24);
    o.connect(og);
    og.connect(v.g);
    o.start(t0); o.stop(t0 + 1.3);
    kill.push(o, og);
    last = o;
  }
  autoKill(last, kill);
}

// Filtered noise whisper — thinking. Bandpass swell, very quiet.
function thinkWhisper(now) {
  const v = grabVoice(now, 1.0, 0);
  if (!v) return;
  const src = AC.createBufferSource();
  src.buffer = noiseBuf;
  const bp = AC.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.4;
  src.connect(bp);
  bp.connect(v.g);
  v.g.gain.linearRampToValueAtTime(0.028, now + 0.22);
  v.g.gain.setTargetAtTime(0, now + 0.3, 0.18);
  src.start(now, (now * 7.13) % 1);                        // wander the buffer
  src.stop(now + 0.95);
  autoKill(src, [src, bp]);
}

// Spawn: rising triangle arpeggio. Despawn: the inversion, falling.
function arp(now, notes, pan) {
  const v = grabVoice(now, 1.1, pan);
  if (!v) return;
  v.g.gain.setValueAtTime(1, now);
  let last = null;
  const kill = [];
  for (let i = 0; i < notes.length; i++) {
    const t0 = now + i * 0.09;
    const o = AC.createOscillator();
    o.type = 'triangle'; o.frequency.value = notes[i];
    const og = AC.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.055, t0 + 0.012);
    og.gain.setTargetAtTime(0, t0 + 0.012, 0.11);
    o.connect(og);
    og.connect(v.g);
    o.start(t0); o.stop(t0 + 0.55);
    kill.push(o, og);
    last = o;
  }
  autoKill(last, kill);
}

// Compaction — the big one. Bypasses the pool (rare, must never be dropped)
// and the evMix duck (straight into fxBus, full level in every mode):
// lowpass-swept noise fall + pitch-dropped boom + a 300ms bed duck.
function compactionHit(now) {
  // bed duck: fast eased dip, hold 300ms, eased recovery
  const d = bedDuck.gain;
  d.cancelScheduledValues(now);
  d.setValueAtTime(d.value, now);
  d.linearRampToValueAtTime(0.12, now + 0.05);
  d.setValueAtTime(0.12, now + 0.3);
  d.setTargetAtTime(1, now + 0.3, 0.3);

  // noise sweep down — the tower shedding its slabs
  const src = AC.createBufferSource();
  src.buffer = noiseBuf;
  const f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.Q.value = 1;
  f.frequency.setValueAtTime(3800, now);
  f.frequency.exponentialRampToValueAtTime(110, now + 1.1);
  const ng = AC.createGain();
  ng.gain.setValueAtTime(0, now);
  ng.gain.linearRampToValueAtTime(0.16, now + 0.06);
  ng.gain.setTargetAtTime(0, now + 0.25, 0.35);
  src.connect(f); f.connect(ng); ng.connect(fxBus);
  src.start(now); src.stop(now + 1.4);
  autoKill(src, [src, f, ng]);

  // pitch-dropped boom
  const bo = AC.createOscillator();
  bo.type = 'sine';
  bo.frequency.setValueAtTime(120, now);
  bo.frequency.exponentialRampToValueAtTime(38, now + 0.7);
  const bg = AC.createGain();
  bg.gain.setValueAtTime(0, now);
  bg.gain.linearRampToValueAtTime(0.3, now + 0.015);
  bg.gain.setTargetAtTime(0, now + 0.05, 0.3);
  bo.connect(bg); bg.connect(fxBus);
  bo.start(now); bo.stop(now + 1.6);
  autoKill(bo, [bo, bg]);
}

// ---- module ------------------------------------------------------------------
export default {
  name: 'audio',

  init(ctx) {
    CTX = ctx;
    frozen = ctx.params.get('freeze') === '1';
    if (frozen) return;                     // shot mode: no chip, no audio, ever

    buildPanTable(ctx.session);
    loadPref();

    // ---- chip + menu: HUD micro-typography, self-owned DOM in #hud ----------
    const C = ctx.CSS;
    const st = document.createElement('style');
    st.id = 'audiox-style';
    st.textContent = `
#hud .audiox-chip{position:absolute;top:16px;left:50%;transform:translateX(-50%);
 pointer-events:auto;cursor:pointer;
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 font-size:9px;letter-spacing:.3em;text-transform:uppercase;line-height:1.2;
 padding:5px 9px 5px 12px;color:${C.hudDim};
 background:linear-gradient(168deg,${C.void}d9 0%,${C.void}b3 55%,${C.void}d9 100%);
 border:1px solid ${C.hudDim}66;
 -webkit-backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 box-shadow:0 0 18px ${C.void}99;user-select:none;
 transition:color .25s ease,border-color .25s ease,text-shadow .25s ease;
 animation:audioxIn .7s cubic-bezier(.2,.9,.2,1) .8s both;}
#hud .audiox-chip:hover{color:${C.hudText};border-color:${C.cache};text-shadow:0 0 7px ${C.cache}55;}
#hud .audiox-chip.on{color:${C.cache};border-color:${C.cache}aa;text-shadow:0 0 8px ${C.cache}66;}
#hud .audiox-chip.armed{color:${C.cache};border-color:${C.cache}55;animation:audioxArm 1.6s ease-in-out infinite;}
@keyframes audioxIn{from{opacity:0;transform:translate(-50%,6px);}to{opacity:1;transform:translate(-50%,0);}}
@keyframes audioxArm{0%,100%{opacity:.5;}50%{opacity:1;}}
#hud .audiox-menu{position:absolute;top:46px;left:50%;transform:translateX(-50%);
 pointer-events:auto;display:none;min-width:200px;padding:9px 0;
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 font-size:8.5px;letter-spacing:.26em;text-transform:uppercase;line-height:1.2;
 color:${C.hudDim};text-align:left;
 background:
  repeating-linear-gradient(0deg,transparent 0 2px,${C.cache}07 2px 3px),
  linear-gradient(168deg,${C.void}e6 0%,${C.void}c4 55%,${C.void}e6 100%);
 border:1px solid ${C.hudDim}66;
 -webkit-backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 box-shadow:0 0 18px ${C.void}99;user-select:none;}
#hud .audiox-menu.open{display:block;animation:audioxIn .22s cubic-bezier(.2,.9,.2,1) both;}
#hud .audiox-menu .audiox-mh{padding:2px 14px 5px;font-size:7px;letter-spacing:.3em;color:${C.hudDim};opacity:.75;}
#hud .audiox-menu .audiox-mi{display:flex;align-items:center;gap:8px;padding:5px 14px;cursor:pointer;
 color:${C.hudDim};transition:color .15s ease,background .15s ease;}
#hud .audiox-menu .audiox-mi:hover{color:${C.hudText};background:${C.cache}0d;}
#hud .audiox-menu .audiox-mi.act{color:${C.cache};text-shadow:0 0 7px ${C.cache}55;}
#hud .audiox-menu .audiox-sw{width:7px;height:7px;flex:none;box-sizing:border-box;
 border:1px solid currentColor;background:transparent;transition:background .15s ease;}
#hud .audiox-menu .audiox-mi.act .audiox-sw{background:currentColor;box-shadow:0 0 5px ${C.cache}88;}
#hud .audiox-menu .audiox-div{height:1px;margin:7px 12px;
 background:linear-gradient(90deg,${C.hudDim}55,${C.hudDim}22 70%,transparent);}
#hud .audiox-menu .audiox-status{display:none;padding:5px 14px 0;font-size:7.5px;letter-spacing:.24em;
 color:${C.error};text-shadow:0 0 6px ${C.error}55;}
#hud .audiox-menu .audiox-status.show{display:block;}
#hud .audiox-menu .audiox-foot{padding:7px 14px 0;font-size:7px;letter-spacing:.2em;}
#hud .audiox-menu .audiox-foot a{color:${C.hudDim};opacity:.75;text-decoration:none;
 transition:color .15s ease,opacity .15s ease;}
#hud .audiox-menu .audiox-foot a:hover{color:${C.hudText};opacity:1;}`;
    document.head.appendChild(st);

    const hud = document.getElementById('hud');
    chip = document.createElement('button');
    chip.type = 'button';
    hud.appendChild(chip);

    // micro-menu — OFF / RADIO / SYNTH / RADIO+SYNTH, channels, offline state,
    // and the listener-supported footer. Built once, toggled by class.
    menuEl = document.createElement('div');
    menuEl.className = 'audiox-menu';
    const mkHead = (txt) => {
      const d = document.createElement('div');
      d.className = 'audiox-mh'; d.textContent = txt;
      menuEl.appendChild(d);
    };
    const mkDivider = () => {
      const d = document.createElement('div');
      d.className = 'audiox-div';
      menuEl.appendChild(d);
    };
    const mkRow = (label, onPick) => {
      const d = document.createElement('div');
      d.className = 'audiox-mi';
      const sw = document.createElement('span');
      sw.className = 'audiox-sw';
      d.appendChild(sw);
      const t = document.createElement('span');
      t.textContent = label;
      d.appendChild(t);
      d.addEventListener('click', onPick);
      menuEl.appendChild(d);
      return d;
    };
    mkHead('// MODE');
    modeRows = Object.entries(MODE_LABEL).map(([m, label]) => [m, mkRow(label, () => setMode(m))]);
    mkDivider();
    mkHead('// CHANNEL');
    chanRows = CHANNELS.map((c) => [c.id, mkRow(c.name, () => selectChannel(c.id))]);
    statusEl = document.createElement('div');
    statusEl.className = 'audiox-status';
    statusEl.textContent = 'RADIO OFFLINE — RESELECT TO RETRY';
    menuEl.appendChild(statusEl);
    mkDivider();
    const foot = document.createElement('div');
    foot.className = 'audiox-foot';
    const a = document.createElement('a');
    a.href = 'https://somafm.com';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'SOMAFM.COM — LISTENER-SUPPORTED';
    foot.appendChild(a);
    menuEl.appendChild(foot);
    hud.appendChild(menuEl);

    // menu open/close — ESC or click-away closes; listeners live only while open
    const onAway = (e) => {
      const t = e.target;
      if (menuEl.contains(t) || t === chip || chip.contains(t)) return;
      closeMenu();
    };
    const onEsc = (e) => { if (e.key === 'Escape') closeMenu(); };
    const openMenu = () => {
      if (menuOpen) return;
      menuOpen = true;
      menuEl.classList.add('open');
      paintMenu();
      addEventListener('pointerdown', onAway, true);
      addEventListener('keydown', onEsc, true);
    };
    const closeMenu = () => {
      if (!menuOpen) return;
      menuOpen = false;
      menuEl.classList.remove('open');
      removeEventListener('pointerdown', onAway, true);
      removeEventListener('keydown', onEsc, true);
    };

    paintChip();
    paintMenu();

    // Stored mode is not OFF but autoplay policy holds the gate: arm on the
    // first real gesture anywhere (chip/menu excluded — they drive the gate
    // through their own handlers).
    armForGesture();

    // Chip click: a genuine gesture. Never a blind toggle-off (that was the
    // armed-click contradiction) — it opens the menu, and on the way in it
    // opens the gate: first-ever click defaults the mode to RADIO (the
    // curated bed is the default texture), an armed click starts the stored
    // mode, a live click just shows the menu.
    chip.addEventListener('click', () => {
      if (menuOpen) { closeMenu(); return; }
      if (mode === 'off') setMode('radio');
      else { if (disarm) disarm(); unlock(); }
      openMenu();
    });

    console.log(`[audio] soundscape ready — mode ${MODE_LABEL[mode]}` +
      `${mode !== 'off' ? ' (armed for first gesture)' : ''}, channel ${channelId.toUpperCase()}, ` +
      `${toolPan.size} totem pans + OTHER`);
  },

  update(dt, state, ctx) {
    if (frozen || !AC || !hasSynth() || AC.state !== 'running') return;
    const now = AC.currentTime;

    // RADIO+SYNTH demotes the event layer: half the token rate AND cap.
    const rl = mode === 'radio+synth' ? 0.5 : 1;
    if (compCool > 0) compCool -= dt;
    tokens = Math.min(tokens + dt * RATE * rl, BURST * rl);

    // BED — level tracks context fill; automation pushed only on real change.
    // bedScale mutes the hum in RADIO+SYNTH (the radio owns the texture).
    bedTimer -= dt;
    if (bedTimer <= 0) {
      bedTimer = 0.25;
      // per-session ceiling, re-read every tick so a swap retunes the bed
      const fill = clamp01(state.context.ctx / (CTX.contextCap ?? CTX.CONTEXT_TOKEN_CAP));
      if (bedLast < 0 || Math.abs(fill - bedLast) > 0.004) {
        bedLast = fill;
        bedMix.gain.setTargetAtTime(BED_LEVEL * bedScale * (0.4 + 0.6 * fill), now, 0.6);
      }
    }

    // EVENTS — paused timeline = beds only; seek floods stay silent
    const tl = (ctx ?? CTX).timeline;
    if (!tl.playing) return;
    const fired = state.fired;
    const n = fired.length;
    if (n === 0 || n > SEEK_FLOOD) return;

    for (let i = 0; i < n; i++) {
      const ev = fired[i];
      if (ev.kind === 'compaction') {       // the big one bypasses the bucket
        if (compCool <= 0) {
          compCool = COMP_COOLDOWN;
          compactionHit(now);
          duckRadioForBoom();               // it punches through the radio bed too
        }
        continue;
      }
      if (tokens < 1) continue;             // rate limit: drop excess quietly
      switch (ev.kind) {
        case 'tool_call': tokens--; toolCall(now, ev); break;
        case 'tool_result': tokens--; toolResult(now, ev); break;
        case 'user': tokens--; userSwell(now); break;
        case 'say': tokens--; sayChime(now); break;
        case 'thinking': tokens--; thinkWhisper(now); break;
        case 'spawn': tokens--; arp(now, ARP_UP, 0.25); break;
        case 'despawn': tokens--; arp(now, ARP_DOWN, -0.25); break;
        // hook / queued: silent by design
      }
    }
  },
};
