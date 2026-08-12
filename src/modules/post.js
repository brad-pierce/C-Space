// post.js — owns the final frame. EffectComposer chain:
//   scene render (linear HDR, half-float; high quality goes through a
//     dedicated samples:4 target that resolves before the first fullscreen
//     pass — see MSAAScenePass; the composer ping-pong stays single-sample)
//   → stack-cap ShaderPass (linear HDR, pre-bloom): Reinhard-rolls scene
//     luminance above 1.4 toward a 2.8 asymptote, so overlapping emissives
//     (totem base + floor pool, layered core shells) sum to a BOUNDED field —
//     the chain-level stand-in for per-material emissive caps that live in
//     modules this file cannot touch
//   → UnrealBloomPass (threshold 2.5 — inside the top of the capped range, so
//     only pixels whose RAW luminance exceeded ~6.5 bloom at all, and never by
//     more than 0.3 over threshold: sub-degree hotspots only; strength 0.18
//     base, scaled down with camera height, view downtilt AND plate coverage;
//     radius 0.25 — bloom is a tight halo AROUND a hot point, never the hot
//     point itself: per-material emissive intensity reads as heat, bloom
//     confirms it)
//   → area-aware highlight-knee ShaderPass (linear HDR, pre-tonemap): a soft
//     C1 Reinhard shoulder above KNEE whose ceiling depends on NEIGHBORHOOD
//     luminance (a 12-tap ring, ~4.5% of frame height). Isolated peaks — rim
//     fresnel, seam pulses — keep the high ceiling; large hot fields — floor
//     wash, bloom spill — get the low one. Because any region wider than the
//     sampling ring is forced onto the low ceiling, no contiguous blown area
//     larger than a few percent of the frame can exist, structurally. A
//     closing per-channel shoulder rolls the max channel off toward
//     ceiling × 1.55 (neutral) shrinking to × 1.20 (fully saturated — round
//     8), pixel scaled uniformly, so saturated stacks keep their hue at the
//     display end instead of clipping to white.
//   → OutputPass (applies renderer's ACES tonemap + sRGB — r185: scene
//     materials skip tonemapping when rendering into an RT, so this pass is
//     the one and only tonemap; no double-tonemap washout, no gray frames)
//   → grade ShaderPass (display space, last, renders to screen): ONE base
//     sample per output pixel; chromatic fringing as an additive-only,
//     sub-pixel channel-max (round 8 — the old R/B split ghosted thin marks),
//     animated luminance-aware film grain (doubles as dither against fog
//     banding), gentle cinematic vignette, very subtle scanlines, slight
//     barrel distortion.
//
// Round-4 retune (critic: identical white totem caps, floor pools running to
// blowout, raw unshaped core flare — bloom doing the material's job):
//   ROOT CAUSE: the old ceilings (1.4–3.4 linear) were derived against a naive
//   ACES curve. three's ACESFilmicToneMapping scales input by exposure/0.6, so
//   through the REAL curve those ceilings landed at ~0.93–0.97 display —
//   paper white, hue stripped by the RRT desat. Every ceiling below is now
//   computed against the actual r185 fit (exposure 1.1):
//     isolated-peak ceiling 1.25–1.6 linear → ~0.92–0.94 display (small, hot)
//     hot-field ceiling     0.82–1.0 linear → ~0.87–0.90 display (bright,
//       TINTED, gradient intact — never white)
//   Bloom retuned per directive: threshold 1.2 → 1.6, strength 0.40 → 0.30,
//   radius 0.5 → 0.45. The hot point is the emissive, the halo is a garnish.
//   Saturation rolloff: ACES desaturates hard as input rises — the shoulder
//   now feeds chroma back in proportion to compression, so highlights roll
//   off toward their own hue (magenta stays magenta at 0.9 display) instead
//   of snapping to white. Mild (0.35), luminance-neutral.
//   Verification (the >1%-white law): the frame guard's screen readback now
//   samples six full-width strips and counts pure-white pixels (R,G,B ≥ 254);
//   a sampled white fraction over 1% fails the frame — in shot mode that
//   throws before SHOT_READY can fire, same machinery as the dead-frame gate.
//
// Round-5 clamp (critic: KILLSCREEN — blown-white regions where emissives
// stack on cam3/cam5; cam6's core bloom flooding the chronogram's inner
// lanes; "highlights peak large and flat"). Three root causes, three fixes:
//   1. The round-4 display targets went through the ACES fit but NOT the sRGB
//      encode OutputPass applies after it. Ceilings of 0.82–1.6 linear land
//      at display BYTES ~240–250 — whole fields of near-paper white, exactly
//      what the critic saw. Every ceiling is recomputed through the COMPLETE
//      path (× exposure 1.1/0.6 → ACES fit → sRGB encode):
//        isolated-peak ceiling 0.95–1.30 linear → bytes ~243–247 (small, hot)
//        hot-field ceiling     0.50–0.68 linear → bytes ~229–238 (bright,
//          tinted, gradient intact — visibly NOT white)
//      KNEE drops 0.6 → 0.42 to sit below the new field ceilings.
//   2. Stacked emissives sum to unbounded linear radiance and bloom saw all
//      of it. A pre-bloom STACK CAP now bounds the summed field at 2.8, and
//      the bloom threshold rises to 2.2 — only raw luminance above ~3.3
//      blooms at all, by at most 0.6. Strength 0.30 → 0.18, radius
//      0.45 → 0.35: the halo is a garnish on a hotspot, never a flood.
//   3. Compressed LUMINANCE still clips to white when a saturated emissive
//      carries single channels 3–4× its luminance (magenta's lum weight is
//      0.285) — the per-channel ACES fit flattens those to paper. The knee
//      now ends with a per-channel shoulder: the max channel rolls off toward
//      ceilL × 1.55 with the pixel scaled uniformly, so magenta peaks as
//      MAGENTA at the display end, never white.
//   And the camera adaptation is now pitch-aware: a top-down camera (cam6's
//   chronogram plate) fills the frame with floor exactly like a floor-level
//   one does, so the height factor is damped by view downtilt — the core's
//   glow can no longer flood the chronogram's inner lanes from altitude.
//
// Round-6 refine (critic LEGEND: pink/cyan ground-glow pools in cam0/cam5 and
// bloom wash on the plate flatten tick contrast and encode nothing —
// chartjunk at the compositing layer): the knee pass is now PLATE-AWARE.
// Each pixel reprojects onto the ground plane (inverse view-projection ray vs
// y = CHRONO.y); rays landing inside the chronogram annulus (CHRONO radii,
// soft aprons past both edges so glow hugging the rim is included) get plate
// discipline on top of the area-aware knee:
//   1. WASH CUT — where the ring-neighborhood average is elevated (a wide
//      glow field: pool flood or bloom spill — the knee runs after bloom, so
//      this IS the bloom clamp on the chronogram) and the pixel is not
//      locally isolated, its luminance is cut by up to 45%. The isolation
//      term spares the marks: ticks and the playhead keep their light while
//      the wash under them drops — contrast surgery, not uniform dimming.
//   2. EARLIER KNEE (0.22 vs 0.42) and LOWER FIELD CEILING (×0.62 → display
//      bytes ~211-224): any wide bright field on the plate lands visibly
//      below tick level, and the steeper ACES slope beneath it restores the
//      tick-to-ground contrast step the critique demanded.
//   uCeilHi is untouched on the plate: isolated peaks — the playhead, active
//   call ticks — still peak hot and keep their tight halos, because there
//   brightness DOES encode state. Bloom outside the plate is unchanged.
//
// Round-7 trim (critic LEGEND, refinement 3: teal pool under the core and pink
// under Edit still wash the inner lanes and quarter labels in cam0/cam5 —
// figure-ground failing exactly where the instrument is labeled). This file's
// chain-level share of "halve ground-contact glows, clamp the bloom footprint"
// (per-material pool intensity lives in core/totems; post owns what crosses
// the plate). Three constants move, nothing else:
//   1. BLOOM RADIUS 0.35 → 0.25: the halo footprint tightens so an emitter's
//      bloom can no longer bridge across a lane boundary in oblique views —
//      the emissive stays the hot point, the halo hugs it.
//   2. The plate mask now covers the LABEL BAND. Round 6 held full discipline
//      only to rOuter+0.4, but the quarter labels sit at rOuter+1.55 (ticks
//      rOuter+0.05..0.45) — the wash cut had faded to ~0.59 exactly where the
//      1:30 label fights the Edit pool. Full discipline now runs to
//      rOuter+1.9, fading out by rOuter+3.8; the inner apron reaches to
//      rInner-3.0 so the core pool's outer rim is caught before it touches
//      the hooks lane. Label glyphs reproject past the band at grazing angles
//      and are spared by the isolation term regardless — the cut lands on the
//      wash, never the mark.
//   3. Wash-cut authority: GLOW_CUT 0.45 → 0.60 — a full pool flood over the
//      plate now loses about half its light, the chain-level halving the
//      directive asked for — with engagement WASH0 0.08 → 0.06 and saturation
//      WASH1 0.35 → 0.30 so moderate veils take a meaningful cut, not a
//      token one.
//   Ceilings, knees, bloom threshold/strength, stack cap, grade: untouched.
//
// Round-8 grand refinement (user rulings UR-2/UR-3, gate + KILLSCREEN, perf
// audit P0/P1/P2 for this file):
//   1. GHOSTING KILLED (UR-2, gate-confirmed in the grade pass): the CA was a
//      full-strength per-channel split — R and B sampled up to ~4 px apart at
//      the frame edge, ~14 px under a compaction kick — so every thin
//      saturated mark lost its own R and B at its true position (a DARK twin,
//      no negative lobe needed) and grew displaced red/blue copies, oriented
//      radially from frame center: exactly the user's screenshots, static
//      ticks included. The grade pass now takes ONE base sample for all three
//      channels; fringing is rebuilt as an additive-only channel-max whose
//      offset is hard-clamped below one physical pixel (~1.6 px briefly under
//      kick). Output >= base in every channel, so a dark halo is impossible
//      by construction, and a sub-pixel offset cannot separate any mark into
//      discrete copies — clean in stills AND in motion, 1x and 4x.
//   2. Bloom discipline (KILLSCREEN r4): threshold 2.2 → 2.5 — only raw
//      luminance above ~6.5 blooms at all, by at most 0.3 over threshold
//      (stack-cap asymptote 2.8). The knee's per-channel shoulder is now
//      SATURATION-AWARE: headroom shrinks from ×1.55 (neutral) to ×1.20
//      (fully saturated), so hot magenta tops out around display (255,28,232)
//      — magenta, never white (the ACES fit's input matrix bleeds hot
//      primaries into the other channels; capping the max channel low for
//      saturated pixels keeps it out of that regime). Structurally only
//      near-neutral pixels — the core heart — can occupy the very top of the
//      range: ONE hottest point per frame, and every saturated encoding mark
//      peaks below it, in its own hue.
//   3. Oblique plate adaptation (UR-3): the round-5 downtilt damp keyed on
//      straight-down framings, so low-oblique plate views kept aerial
//      ceilings and the plate flooded. update() now unprojects a fixed
//      20-point NDC grid onto the ground plane and measures the chronogram's
//      actual share of the frame; the damp takes max(downtilt, plate-share),
//      engaging floor discipline at EVERY angle where the instrument
//      dominates the view — director presets and manual orbit alike.
//   4. Perf (audit P0/P1/P2 for post.js): the composer's ping-pong buffers
//      are single-sample — geometry MSAA lives on a dedicated samples:4 scene
//      target whose RESOLVED texture feeds the stack cap (was: both fp16
//      ping-pong buffers multisampled, a resolve per fullscreen pass, ~4-5x
//      needed bandwidth). The live frame guard performs at most ONE readback
//      per guarded frame: gates 1+3 rotate one strip per beat through a
//      PIXEL_PACK_BUFFER + fenceSync async path (sync single-strip fallback),
//      gate 2 rotates one fp16 block on beats 60 frames offset. Shot mode
//      keeps every gate, every frame, synchronous. update()'s compaction scan
//      early-breaks.
//
// Round-9 ghost-trail fix (user report: stair-step trails of fading copies
// behind every bright mark — ticks, quarter labels, pulses, the core — under
// a MOVING camera; freeze A/Bs blind). Proven live (impulse test: rt1/rt2/
// screen all drop to black ONE frame after hiding the scene — no temporal
// accumulation anywhere; knee-input capture pristine while knee-output
// carries the copies; A/B/A knee toggle on consecutive frames: smear/crisp/
// smear; still-camera delta map shows the same glyph stamps at the fixed
// ring-tap offsets): the trails were never frame accumulation. The knee's
// 12-tap ring MEAN let one hot mark grazing 1-3 taps impersonate a wide glow
// field; washT saturated and the plate wash cut stamped a dark, mark-shaped
// copy at each tap offset (37/84 px hex ring — "stair-step", "geometric
// fade"). The live drift constantly re-frames marks over bright pool glow,
// exposing the stamps; the tuned freeze presets never did. Fix: TRIMMED ring
// mean — drop the 3 hottest taps before averaging (see KneeShader). Wide
// fields have near-uniform rings and are untouched: every round-5..8
// ceiling, wash, and bloom discipline holds. Also round 9: all composer/
// target/uniform sizes are floored to INTEGER physical pixels (Windows
// fractional display scaling made 1249×1.5 = 1873.5-tall targets; GL's
// GLsizei truncation happened to keep attachments consistent — fixed at the
// source regardless, ruled out as the trail mechanism).
//
// Camera-height adaptation (round 2): as the camera drops toward the floor
// (presets 3/5 sit at y≈2-4), the floor glow fills more of the frame — both
// knee ceilings and bloom strength scale down with camera height so the wash
// reads dimmer exactly when it is largest on screen.
// quality 'low' skips bloom, the stack cap, and MSAA (knee stays — it is one
// cheap fullscreen op and the discipline must hold without bloom too).
// Registered via ctx.setComposer(fn).
// Flourish: compaction events kick aberration+grain briefly (decays < 2s).
// Output sanity guard (round 3, live cadence round 8): after each composer
// render (every gate every frame in shot mode; live rotates ONE probe per
// guarded beat, async where the platform allows) pixels are read back from
// the screen (all-black gate + white-fraction gate, 8-bit strips) and from
// the half-float chain (non-finite gate, fp16 bit test). On failure in shot
// mode: set window.__SHOT_FAILED, retitle to SHOT_FAILED, console.error, and
// THROW — main.js increments its settle counter only after composerRender
// returns, so SHOT_READY can never fire over a dead or blown frame. Live mode
// logs loudly but stays non-fatal.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

// ---- bloom + adaptation tuning ---------------------------------------------
const BLOOM_THRESHOLD = 2.5;    // round 8 (KILLSCREEN): near the top of the
                                // stack-capped range — raw scene luminance
                                // must exceed ~6.5 to bloom at all, and never
                                // by more than 0.3 (cap asymptote 2.8). Bloom
                                // is the confirmation of the frame's hottest
                                // point, not a lamp of its own.
const BLOOM_STRENGTH  = 0.18;   // base; scaled by camera height, downtilt,
                                // and plate coverage (round 8)
const BLOOM_RADIUS    = 0.25;   // round 7: the halo hugs its emitter — its
                                // footprint must never bridge a chronogram lane
// Pre-bloom stack cap (round 5): summed radiance of overlapping emissives is
// Reinhard-rolled above CAP_KNEE toward CAP_KNEE + CAP_SPAN. Keep the bloom
// threshold INSIDE (CAP_KNEE, CAP_KNEE + CAP_SPAN) or bloom dies entirely.
const CAP_KNEE = 1.4;
const CAP_SPAN = 1.4;           // asymptote at 2.8 linear
// camera-height factor: 0 at y<=3 (floor-level shots), 1 at y>=25 (aerials);
// damped by view downtilt — a top-down camera frames the floor exactly like a
// low one does (cam6's chronogram plate), so it gets floor-level discipline.
const CAM_Y_LO = 3, CAM_Y_HI = 25;
const FLOOR_LOOK_DAMP = 0.7;    // max height-factor cut when the floor rules
                                // the frame (straight-down OR oblique)
// Oblique plate coverage (round 8, UR-3): downtilt alone only modeled the
// straight-down failure — a LOW-oblique camera fills the frame with plate at
// modest pitch and kept aerial ceilings. update() unprojects this fixed NDC
// grid (5x4, biased slightly below center where the floor lives) onto the
// ground plane each frame and counts rays landing on the chronogram footprint
// — a direct measure of how much of the FRAME the instrument occupies. Grid
// and scratch are module-level constants: zero per-frame allocation.
const FLOOR_GRID = new Float32Array(40);
{
  const gxs = [-0.8, -0.4, 0.0, 0.4, 0.8];
  const gys = [-0.75, -0.35, 0.05, 0.45];
  let k = 0;
  for (const gy of gys) for (const gx of gxs) { FLOOR_GRID[k++] = gx; FLOOR_GRID[k++] = gy; }
}
const PLATE_FRAC_LO = 0.28;     // plate share of sampled rays where damping engages
const PLATE_FRAC_HI = 0.70;     // share at which full floor-level discipline applies
// Ceilings in linear scene luminance, computed through the COMPLETE display
// path (× exposure 1.1/0.6 → ACES fit → sRGB encode; round 4 omitted the
// encode — see round-5 header). Display targets in 8-bit sRGB bytes:
const CEIL_HI_RANGE = [0.95, 1.30]; // isolated peaks → ~243-247 (small, hot)
const CEIL_LO_RANGE = [0.50, 0.68]; // hot fields → ~229-238 (tinted, not white)
const BLOOM_STR_MIN = 0.55;         // bloom strength factor at floor level

// Pre-bloom stack cap — linear HDR, immediately after the scene render.
// Where totem-base glows, floor pools, and layered core shells overlap, their
// emissives ADD: the summed field can reach linear 5-10+ and dump unbounded
// energy into bloom's mip chain — that flood was the round-5 critique. This
// pass Reinhard-rolls luminance above CAP_KNEE toward CAP_KNEE + CAP_SPAN
// (hue-preserving, C1 at the knee), bounding what bloom can ever see. It is
// the chain-level enforcement of "cap emissive intensity where glows overlap"
// — the per-material caps belong to modules this file does not own, and the
// cap holds even if a future module stacks new emissives carelessly.
const StackCapShader = {
  name: 'HarnessStackCap',
  uniforms: {
    tDiffuse: { value: null },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;

    const float CAP_KNEE = ${CAP_KNEE.toFixed(3)};
    const float CAP_SPAN = ${CAP_SPAN.toFixed(3)};

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = tex.rgb;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      if (lum > CAP_KNEE) {
        float over = lum - CAP_KNEE;
        // C1-continuous Reinhard shoulder: asymptote CAP_KNEE + CAP_SPAN
        float capped = CAP_KNEE + CAP_SPAN * (over / (CAP_SPAN + over));
        col *= capped / lum;
      }
      gl_FragColor = vec4(col, tex.a);
    }`,
};

// Area-aware highlight knee — runs in linear HDR after bloom, before
// OutputPass. Below KNEE nothing is touched (low-mids keep their contrast).
// Above it, a C1-continuous Reinhard shoulder rolls luminance off toward a
// ceiling chosen per-pixel from ring-sampled neighborhood luminance:
//   neighborhood dark  → uCeilHi: a small, isolated highlight — let it peak
//                        hot (sRGB bytes ~243-247), per the lighting law.
//   neighborhood hot   → uCeilLo: this pixel sits inside a large bright field
//                        (floor wash, bloom spill) — pull the ceiling down so
//                        the whole field lands at sRGB bytes ~229-238 with
//                        its gradient and hue intact instead of clipping flat.
// The shoulder is luminance-scaled AND resaturating: compressed highlights
// get chroma fed back (SAT_KEEP × compression), pre-compensating the ACES
// RRT desat so tint rolls off gently instead of washing to white. A final
// per-channel shoulder (round 5) rolls the max channel toward ceilL × 1.55:
// saturated stacks (magenta seams over floor pools) would otherwise slam the
// per-channel ACES fit to paper even at legal luminance. Round 8: that
// headroom is saturation-aware — it shrinks to ceilL × 1.20 for fully
// saturated pixels (the ACES input matrix bleeds hot primaries into the
// other channels, so magenta only stays magenta if its max channel stays out
// of that regime), while near-neutral pixels keep × 1.55. Only the neutral
// core heart can reach the top of the luminance range: one hottest point.
// The 12 ring taps span ~4.5% of frame height: anything smaller than the ring
// reads "isolated"; anything larger is compressed. That is the structural
// guarantee that no blown region can exceed a few percent of frame area.
// Round 6: plate-aware — pixels whose ground-plane reprojection lands inside
// the chronogram annulus get an earlier knee, a lower field ceiling, and a
// neighborhood-proportional wash cut (see round-6 header). The chronogram is
// an instrument, not a lamp: on the plate, only encoded marks stay bright.
const KneeShader = {
  name: 'HarnessHighlightKnee',
  uniforms: {
    tDiffuse:     { value: null },
    uCeilHi:      { value: CEIL_HI_RANGE[1] },
    uCeilLo:      { value: CEIL_LO_RANGE[1] },
    uAspect:      { value: 16 / 9 },
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos:      { value: new THREE.Vector3() },
    uPlateR:      { value: new THREE.Vector2(6.5, 15.0) },  // set from ctx.CHRONO
    uPlateY:      { value: 0.06 },                          // set from ctx.CHRONO
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uCeilHi;
    uniform float uCeilLo;
    uniform float uAspect;
    uniform mat4  uInvViewProj;
    uniform vec3  uCamPos;
    uniform vec2  uPlateR;   // chronogram annulus [rInner, rOuter], world units
    uniform float uPlateY;   // annulus height above the grid plane
    varying vec2 vUv;

    const float KNEE     = 0.42;   // shoulder start — below the lowest field
                                   // ceiling (0.50); display byte ~224
    const float AREA0    = 0.55;   // neighborhood lum where compression begins
    const float AREA1    = 1.4;    // neighborhood lum of a fully "hot field"
                                   // (stack cap bounds the ring average at 2.8)
    const float R1       = 0.020;  // inner ring radius (fraction of frame height)
    const float R2       = 0.045;  // outer ring radius
    const float SAT_KEEP = 0.35;   // chroma fed back per unit compression
    const float CH_HEAD  = 0.55;   // per-channel headroom: max channel rolls
                                   // off toward ceilL * (1.0 + CH_HEAD)
    const float SAT_TIGHT = 0.64;  // round 8: headroom shrink at full pixel
                                   // saturation — CH_HEAD 0.55 -> 0.20, so a
                                   // pure magenta peaks at ceilL * 1.20 and
                                   // survives the ACES fit as MAGENTA
    // Plate discipline (round 6) — the chronogram is an instrument, not a lamp
    const float PLATE_KNEE = 0.22; // earlier shoulder on the plate (byte ~195)
    const float PLATE_CEIL = 0.62; // field-ceiling multiplier on the plate
                                   // (0.50-0.68 → 0.31-0.42 → bytes ~211-224)
    const float GLOW_CUT   = 0.60; // max wash attenuation over the plate — a
                                   // full flood loses ~half its light (round 7)
    const float WASH0      = 0.06; // ring-avg lum where the wash cut starts
    const float WASH1      = 0.30; // ring-avg lum of a full pool flood
    const float WASH_TAP_CAP = 0.6; // round 9: per-tap ceiling for the WASH
                                   // estimate only — wash is dim by nature
                                   // (pool taps 0.1-0.6); marks are 1.2-2.8
                                   // and must not read as wash (ghost stamps)

    float lumOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    float tap(vec2 uv) { return lumOf(texture2D(tDiffuse, uv).rgb); }

    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 col = tex.rgb;
      float lum = lumOf(col);

      // Plate mask (rounds 6+7): cast this pixel's view ray onto the ground
      // plane and test the chronogram annulus, with soft aprons past both
      // radii sized so the instrument's WHOLE labeled footprint is covered:
      // outward through the quarter-tick/label band (labels at rOuter+1.55),
      // inward far enough to catch the core pool's rim before the hooks lane.
      // The rig keeps the camera above the floor; near-horizon rays land far
      // outside the band, so the mask fades continuously — no screen-space
      // seams. Occluders are rare over the band by layout (core inside
      // rInner, totems outside rOuter), so the analytic plane test is honest
      // where it matters.
      float plate = 0.0;
      {
        vec2 ndc = vUv * 2.0 - 1.0;
        vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
        vec3 dir = normalize(farP.xyz / farP.w - uCamPos);
        if (dir.y < -1e-4) {
          float th = (uPlateY - uCamPos.y) / dir.y;
          if (th > 0.0) {
            float r = length(uCamPos.xz + dir.xz * th);
            plate = smoothstep(uPlateR.x - 3.0, uPlateR.x - 0.5, r)
                  * (1.0 - smoothstep(uPlateR.y + 1.9, uPlateR.y + 3.8, r));
          }
        }
      }
      float kneeL = mix(KNEE, PLATE_KNEE, plate);

      if (lum > kneeL || plate > 0.001) {
        // 12-tap circular neighborhood (aspect-corrected), center excluded so
        // a lone hot pixel over darkness reads a LOW average and stays hot.
        // TRIMMED ring mean (round 9, ghost-trail root cause): the plain mean
        // let ONE hot mark (a quarter label ~1.4 linear, a tick, a pulse, the
        // core rim) grazing 1-3 taps read as a "wide glow field" for every
        // dim pixel 37/84 px away — washT saturated and the wash cut stamped
        // a dark, MARK-SHAPED copy of the glyph at each tap offset: the
        // stair-step "trails of fading copies" seen under the drifting
        // camera (fixed screen-space ring offsets; the freeze presets were
        // tuned blind to them). Dropping the 3 hottest taps makes narrow
        // bright content invisible to the field estimate, while true wide
        // fields — pool floods, bloom spill, the core disc: near-uniform
        // taps — are unchanged (trimmed mean of a uniform ring is the ring).
        // Both consumers want that robustness: areaT (field ceiling) and
        // washT (plate wash cut). iso rises where avg drops, so pixels next
        // to a mark are spared MORE, never less.
        vec2 s1 = vec2(R1 / uAspect, R1);
        vec2 s2 = vec2(R2 / uAspect, R2);
        float ring[12];
        ring[0]  = tap(vUv + vec2( 1.000,  0.000) * s1);
        ring[1]  = tap(vUv + vec2( 0.500,  0.866) * s1);
        ring[2]  = tap(vUv + vec2(-0.500,  0.866) * s1);
        ring[3]  = tap(vUv + vec2(-1.000,  0.000) * s1);
        ring[4]  = tap(vUv + vec2(-0.500, -0.866) * s1);
        ring[5]  = tap(vUv + vec2( 0.500, -0.866) * s1);
        ring[6]  = tap(vUv + vec2( 0.866,  0.500) * s2);
        ring[7]  = tap(vUv + vec2( 0.000,  1.000) * s2);
        ring[8]  = tap(vUv + vec2(-0.866,  0.500) * s2);
        ring[9]  = tap(vUv + vec2(-0.866, -0.500) * s2);
        ring[10] = tap(vUv + vec2( 0.000, -1.000) * s2);
        ring[11] = tap(vUv + vec2( 0.866, -0.500) * s2);
        float sum = 0.0, sumW = 0.0;
        float m1 = 0.0, m2 = 0.0, m3 = 0.0;   // three hottest taps
        for (int i = 0; i < 12; i++) {
          float v = ring[i];
          sum += v;
          sumW += min(v, WASH_TAP_CAP);
          if      (v > m1) { m3 = m2; m2 = m1; m1 = v; }
          else if (v > m2) { m3 = m2; m2 = v; }
          else if (v > m3) { m3 = v; }
        }
        // areaT (field-ceiling) estimate: trimmed mean, unclamped — it must
        // still see genuinely hot fields (floor wash runs 0.8-1.4 linear).
        float avg = (sum - m1 - m2 - m3) * (1.0 / 9.0);
        // washT estimate: trimmed AND per-tap clamped. Wash is DIM by
        // definition (pool floods / bloom spill: taps 0.1-0.6); a hot mark is
        // 1.2-2.8. Clamping kills the residue where a WIDE glyph grazes 4+
        // taps and survives the trim (min() is order-preserving, so the raw
        // top-3 are also the clamped top-3). Uniform pools pass unchanged.
        float avgW = (sumW - min(m1, WASH_TAP_CAP) - min(m2, WASH_TAP_CAP)
                           - min(m3, WASH_TAP_CAP)) * (1.0 / 9.0);

        // Wash cut (round 6): on the plate, a raised neighborhood average is
        // a wide glow field — pool flood or bloom spill (this pass runs after
        // bloom, so this is the bloom clamp on the chronogram). Cut it, but
        // scale the cut by how NON-isolated the pixel is: a tick or the
        // playhead sits well above its ring average (iso → 1, no cut), while
        // wash sits at it (iso → 0, full cut). The marks keep their light;
        // the fog under them drops; multiplicative attenuation preserves
        // gradient shape, and the steeper ACES slope below recovers contrast.
        if (plate > 0.001) {
          float washT = smoothstep(WASH0, WASH1, avgW);
          float iso = clamp((lum - avgW) / max(avgW, 1e-3), 0.0, 1.0);
          col *= 1.0 - GLOW_CUT * plate * washT * (1.0 - iso);
          lum = lumOf(col);
        }
        if (lum <= kneeL) { gl_FragColor = vec4(col, tex.a); return; }

        float areaT = smoothstep(AREA0, AREA1, avg);

        // On the plate the FIELD ceiling drops (wide brightness lands visibly
        // below tick level); the isolated-peak ceiling stays — the playhead
        // and active-call ticks peak hot because there brightness encodes.
        float ceilL = mix(uCeilHi, uCeilLo * mix(1.0, PLATE_CEIL, plate), areaT);
        float S = max(ceilL - kneeL, 0.05);
        float over = lum - kneeL;
        float t = over / (S + over);          // 0 at knee → 1 at the ceiling
        // C1-continuous at the knee: d(compLum)/d(over) is 1 at over=0
        float compLum = kneeL + S * t;
        vec3 scaled = col * (compLum / lum);
        // mild saturation rolloff: push chroma back in proportion to how much
        // this pixel was compressed, pre-compensating ACES desat so the hot
        // point keeps its hue at the display end. Both mix ends carry compLum,
        // so luminance is untouched; clamp guards saturated-primary negatives.
        col = max(mix(vec3(compLum), scaled, 1.0 + SAT_KEEP * t), vec3(0.0));

        // per-channel shoulder (rounds 5+8): a saturated stack carries single
        // channels 3-4x its luminance (magenta's lum weight is 0.285) — after
        // luminance compression those channels still slam the per-channel
        // ACES fit, whose input matrix bleeds hot primaries into the other
        // channels and lands on paper white. Roll the max channel off toward
        // ceilL * (1 + head), pixel scaled uniformly. Round 8 (KILLSCREEN):
        // head SHRINKS with pixel saturation — a fully saturated pixel tops
        // out at ceilL * 1.20 (hot magenta displays ~(255,28,232): magenta,
        // never white), a near-neutral one keeps ceilL * 1.55. Saturation is
        // scale-invariant, so computing it after the luminance scale is
        // exact. Structurally, only near-neutral pixels — the core heart —
        // may occupy the top of the range: ONE hottest point per frame, with
        // every saturated encoding mark peaking below it in its own hue.
        float m = max(col.r, max(col.g, col.b));
        float mn = min(col.r, min(col.g, col.b));
        float sat = (m - mn) / max(m, 1e-4);
        float head = CH_HEAD * (1.0 - SAT_TIGHT * sat);
        if (m > ceilL) {
          float S2 = ceilL * head;
          float over2 = m - ceilL;
          col *= (ceilL + S2 * (over2 / (S2 + over2))) / m;
        }
      }
      gl_FragColor = vec4(col, tex.a);
    }`,
};

// One combined grade pass — single fullscreen draw for all screen-space grime.
// Raw GLSL (no three tonemapping/colorspace chunks): operates on the already
// display-encoded output of OutputPass and writes straight to screen.
const GradeShader = {
  name: 'HarnessGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime:    { value: 0 },
    uRes:     { value: new THREE.Vector2(1, 1) },
    uKick:    { value: 0 },   // compaction glitch impulse, 0..1
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2  uRes;
    uniform float uKick;
    varying vec2 vUv;

    const float BARREL     = 0.02;    // slight barrel distortion
    const float ABERRATION = 0.0045;  // chromatic fringe radial ramp (pre-clamp)
    const float CA_MAX_PX  = 0.9;     // hard fringe clamp, PHYSICAL pixels —
                                      // sub-pixel always: a mark can widen a
                                      // hair, it can never split into copies
    const float CA_KICK_PX = 0.7;     // extra clamp headroom at full compaction
                                      // kick (peak 1.6 px, decays < 2s)
    const float GRAIN      = 0.04;    // film grain amplitude (mid-tone peak)
    const float SCAN       = 0.009;   // scanline modulation (~1-2% pk-pk)
    const float VIGNETTE   = 0.34;    // corner darkening amount

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 p = vUv - 0.5;
      float r2 = dot(p, p);

      // barrel distortion — compensated so corners never sample out of frame.
      // ONE base sample feeds all three channels (round 8, UR-2): the old CA
      // split R and B by up to ~4 px at the frame edge, so a thin saturated
      // mark read dark neighbors for its own R and B — a dark twin at its
      // true position flanked by displaced red/blue copies. Gate-confirmed
      // as the frame-wide ghosting; killed here.
      vec2 q = p * (1.0 + BARREL * r2) / (1.0 + BARREL * 0.5);
      vec2 uv = q + 0.5;
      vec3 col = texture2D(tDiffuse, uv).rgb;

      // chromatic fringing — additive-only and sub-pixel. The fringe taps
      // fold in through max(), so every output channel >= the base sample:
      // a dark halo is impossible by construction. The offset ramps gently
      // with radius (center stays clean) and is hard-clamped in PHYSICAL
      // pixels, so no mark can separate into discrete channel copies; the
      // compaction kick widens the clamp briefly, still additive-only.
      float ca = ABERRATION * r2 * (1.0 + uKick * 2.5);
      vec2 off = q * ca;
      float offPx = length(off * uRes);
      float capPx = CA_MAX_PX + CA_KICK_PX * uKick;
      if (offPx > capPx) off *= capPx / offPx;
      col.r = max(col.r, texture2D(tDiffuse, uv + off).r);
      col.b = max(col.b, texture2D(tDiffuse, uv - off).b);

      // scanlines — very subtle, follow the distorted image, slow drift
      float scan = sin(uv.y * uRes.y * 2.1 + uTime * 1.5);
      col *= 1.0 + SCAN * scan;

      // film grain — luminance-aware (peaks in mid-tones, spares deep blacks
      // and hot highlights), refreshed at 24Hz for a filmic cadence
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float ft = floor(uTime * 24.0) * 0.1031;
      float n = hash(vUv * uRes + vec2(ft * 91.7, ft * 33.3));
      float w = 1.0 - abs(clamp(lum, 0.0, 1.0) * 2.0 - 1.0);
      col += (n - 0.5) * GRAIN * (0.3 + 0.7 * w) * (1.0 + uKick);

      // vignette — gentle, cinematic
      float vig = 1.0 - VIGNETTE * smoothstep(0.32, 0.88, length(p));
      col *= vig;

      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Geometry MSAA without multisampled ping-pong buffers (perf-audit P0): the
// scene renders through a wrapped RenderPass into a dedicated samples:4 fp16
// target; r185's WebGLRenderer resolves it to a plain texture at the end of
// that render, and the first ShaderPass reads the RESOLVED texture directly
// (its tDiffuse is pinned — see init). The EffectComposer's own read/write
// buffers stay single-sample, so the stack-cap, knee, Output and grade passes
// never render into MSAA storage or pay a per-pass resolve: geometry keeps
// its 4x edges at a fraction of the attachment memory and bandwidth.
class MSAAScenePass extends Pass {
  constructor(scene, camera, target) {
    super();
    this.needsSwap = false;      // output lives in this.target, not the ping-pong
    this.target = target;
    this._inner = new RenderPass(scene, camera);
  }
  setSize(w, h) { this.target.setSize(w, h); }   // composer passes PHYSICAL px
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // RenderPass renders into the buffer handed to it as "readBuffer" — give
    // it the MSAA target; the resolve happens inside renderer.render (r185).
    this._inner.render(renderer, null, this.target, deltaTime, maskActive);
  }
  dispose() { this._inner.dispose?.(); this.target.dispose(); }
}

let composer = null;
let bloomPass = null;
let kneePass = null;
let gradePass = null;
let rendererRef = null;
let cameraRef = null;
let time = 0;
let kick = 0;
const _camFwd = new THREE.Vector3();   // scratch for downtilt — never per-frame alloc
const _camPos = new THREE.Vector3();   // scratch: camera world position
const _invVP  = new THREE.Matrix4();   // scratch: inverse view-projection
const _farPt  = new THREE.Vector3();   // scratch: unprojected far-plane point
// Chronogram footprint for the oblique plate-coverage test (round 8, UR-3) —
// captured from ctx.CHRONO at init; bounds match the knee's full-discipline
// band (rInner - 0.5 .. rOuter + 1.9), squared to keep the hit test sqrt-free.
let plateHitY = 0.06;
let plateR2In = 0;
let plateR2Out = 0;

// ---- output sanity guard (rounds 3+4, live cadence round 8 / audit P1) -----
// gl.readPixels is a GPU sync stall, so cadence matters. Shot mode probes
// every gate every frame (capture fidelity beats fps there, and all 30 settle
// frames are guarded before main.js can raise SHOT_READY). Live mode — where
// the old guard stacked up to 11 synchronous readbacks onto one frame, a
// visible hitch beat every ~2 s — now performs AT MOST ONE readback on any
// frame: gates 1+3 rotate ONE full-width strip per beat (frame 10, then every
// 120th) through a PIXEL_PACK_BUFFER + fenceSync async path polled on later
// frames (zero stall; single-strip sync fallback if the platform misbehaves),
// and gate 2 (non-finite fp16) rotates ONE probe block on beats offset 60
// frames from the strips. Full strip coverage cycles in ~12 s — fine for a
// guard that only logs in live mode.
const PROBE = 8;                     // fp16 probe block edge, px (gate 2)
const PROBE_POINTS = [               // gate-2 sites: center + quadrants
  [0.50, 0.50], [0.30, 0.35], [0.70, 0.35], [0.30, 0.65], [0.70, 0.65],
];
const STRIP_H = 2;                   // screen strip height, px (gates 1 + 3)
const STRIP_YS = [0.12, 0.28, 0.42, 0.55, 0.68, 0.85];   // frame-height fracs
const WHITE_BYTE = 254;              // R,G,B all >= this counts as pure white
const WHITE_FRAC_MAX = 0.01;         // the law: >1% sampled white = dead frame
const HALF_SENTINEL = 0x3c01;        // finite fp16 (~1.001) prefill — a no-oped
                                     // readback leaves it intact, and no real
                                     // frame is bit-exact 0x3c01 everywhere

let shotMode = false;
let frameNo = 0;
let lastVt = 0;
let stripBytes = null;               // Uint8Array  — screen strip readback
let probeHalf = null;                // Uint16Array — fp16 readback block
let hdrGuardOk = true;               // gate 2 available on this platform
let hdrGuardChecked = false;         // first-probe self-validation done
let lastGuardReport = -Infinity;     // live-mode console throttle
// Live rotation + async readback state (round 8, audit P1)
let liveStripIdx = 0;                // which STRIP_YS entry the next beat reads
let liveProbeIdx = 0;                // which PROBE_POINTS entry gate 2 reads
let pbo = null;                      // PIXEL_PACK_BUFFER for async strip reads
let pboBytes = 0;                    // current PBO allocation, bytes
let pboFence = null;                 // in-flight fenceSync, null when idle
let pboPendingLen = 0;               // byte length of the in-flight read
let pboPendingW = 0;                 // drawing-buffer width at queue time
let pboOk = true;                    // async path healthy on this platform
let scanMax = 0, scanWhites = 0;     // scanStrip outputs — no per-call alloc

function clampi(v, hi) { return v < 0 ? 0 : v > hi ? hi : v; }

function ensureStripBuffer(len) {    // init/resize only — not a per-frame alloc
  if (!stripBytes || stripBytes.length < len) stripBytes = new Uint8Array(len);
}

function failFrame(reason) {
  const msg = `[c-space] post: FRAME GUARD — ${reason} (vt=${lastVt.toFixed(2)}, frame=${frameNo})`;
  if (shotMode) {
    // Fail the capture loudly: flag + title for the pipeline to inspect, then
    // throw. main.js only increments settleFrames after composerRender returns,
    // so the throw structurally prevents SHOT_READY over a dead frame.
    window.__SHOT_FAILED = reason;
    document.title = 'SHOT_FAILED';
    console.error(msg);
    throw new Error(msg);
  }
  if (time - lastGuardReport > 5) {  // live: loud but throttled, non-fatal
    lastGuardReport = time;
    console.error(msg);
  }
}

// Scan the current stripBytes contents: gate 1 max byte + gate 3 white count.
// Gate 1 (all-black): the void background (#05060a) plus fog and the grade
// pass's grain make any legitimately rendered frame mathematically nonzero
// across a full-width strip, so literal zeros in every probed RGB byte mean
// the pipeline delivered nothing. Gate 3 (white fraction): counts pixels with
// R,G,B all >= 254. The knee ceilings cap even isolated peaks near display
// byte ~247 (fields ~238, max single channel ~251), so any measurable white
// fraction is a discipline breach; over 1% is a dead frame.
function scanStrip(len) {
  scanMax = 0; scanWhites = 0;
  for (let i = 0; i < len; i += 4) {               // alpha excluded — opaque
    const r = stripBytes[i], g = stripBytes[i + 1], b = stripBytes[i + 2];
    if (r > scanMax) scanMax = r;
    if (g > scanMax) scanMax = g;
    if (b > scanMax) scanMax = b;
    if (r >= WHITE_BYTE && g >= WHITE_BYTE && b >= WHITE_BYTE) scanWhites++;
  }
}

function stripYPx(gl, idx) {
  const H = gl.drawingBufferHeight;
  return clampi(Math.round(STRIP_YS[idx] * H) - (STRIP_H >> 1), Math.max(H - STRIP_H, 0));
}

// Gate 2 — non-finite pixels in the HDR chain, caught before the 8-bit flush
// hides them. After the full pass sequence the ping-pong leaves the
// OutputPass result in composer.writeBuffer (the grade pass reads readBuffer,
// renders to screen, then its needsSwap flips the pair) — the exact image the
// screen pass consumed, still fp16 where NaN/Inf survive. fp16 bit test:
// exponent all-ones (0x7c00) is NaN or ±Inf, no decode needed. Reads `count`
// blocks starting at PROBE_POINTS[first]; the first successful call
// self-validates the platform via the sentinel prefill.
function probeBlocks(gl, first, count) {
  if (!hdrGuardOk || !composer) return false;
  const rb = composer.writeBuffer;
  if (!rb || !rb.texture || rb.texture.type !== THREE.HalfFloatType) {
    hdrGuardOk = false;
    return false;
  }
  let nonFinite = false;
  try {
    if (!hdrGuardChecked) {
      probeHalf.fill(HALF_SENTINEL);
      for (let d = 0; d < 8 && gl.getError() !== gl.NO_ERROR; d++) { /* drain */ }
    }
    for (let p = 0; p < count && !nonFinite; p++) {
      const pt = PROBE_POINTS[(first + p) % PROBE_POINTS.length];
      const x = clampi(Math.round(pt[0] * rb.width) - (PROBE >> 1), Math.max(rb.width - PROBE, 0));
      const y = clampi(Math.round(pt[1] * rb.height) - (PROBE >> 1), Math.max(rb.height - PROBE, 0));
      rendererRef.readRenderTargetPixels(rb, x, y, PROBE, PROBE, probeHalf);
      for (let i = 0; i < probeHalf.length; i++) {
        if ((probeHalf[i] & 0x7c00) === 0x7c00) { nonFinite = true; break; }
      }
    }
    if (!hdrGuardChecked) {
      // Self-validate once: if the platform cannot read fp16 back, the
      // readPixels either no-ops (sentinel intact) or raises a GL error.
      // Disable this gate rather than trust garbage — gates 1+3 still hold.
      hdrGuardChecked = true;
      let untouched = true;
      for (let i = 0; i < probeHalf.length; i++) {
        if (probeHalf[i] !== HALF_SENTINEL) { untouched = false; break; }
      }
      if (untouched || gl.getError() !== gl.NO_ERROR) {
        hdrGuardOk = false;
        nonFinite = false;
      }
    }
  } catch (e) {
    hdrGuardOk = false;              // readback unsupported here — keep gates 1+3
    nonFinite = false;
  }
  return nonFinite;
}

// Shot mode — every gate, every frame, synchronous: capture fidelity beats
// fps, and the throw must land before main.js can raise SHOT_READY.
function shotGuard(gl) {
  const W = gl.drawingBufferWidth;
  const stripLen = W * STRIP_H * 4;
  ensureStripBuffer(stripLen);       // no-op except after an upsize resize
  let maxByte = 0, whites = 0;
  for (let s = 0; s < STRIP_YS.length; s++) {
    gl.readPixels(0, stripYPx(gl, s), W, STRIP_H, gl.RGBA, gl.UNSIGNED_BYTE, stripBytes);
    scanStrip(stripLen);
    if (scanMax > maxByte) maxByte = scanMax;
    whites += scanWhites;
  }
  const blackDead = maxByte === 0;
  const whiteFrac = whites / (W * STRIP_H * STRIP_YS.length);
  const whiteBlown = whiteFrac > WHITE_FRAC_MAX;
  const nonFinite = probeBlocks(gl, 0, PROBE_POINTS.length);

  if (blackDead || nonFinite || whiteBlown) {
    const parts = [];
    if (blackDead) parts.push('output all-black across every probe strip');
    if (nonFinite) parts.push('non-finite (NaN/Inf) pixels in composer output');
    if (whiteBlown) parts.push(
      `pure-white pixels at ${(whiteFrac * 100).toFixed(2)}% of sampled frame (law: <=1%)`);
    failFrame(parts.join(' + '));
  }
}

function evalLiveStrip(W, len) {
  scanStrip(len);
  if (scanMax === 0) {
    failFrame('output all-black across a full-width probe strip');
    return;
  }
  const whiteFrac = scanWhites / (W * STRIP_H);
  if (whiteFrac > WHITE_FRAC_MAX) {
    failFrame(`pure-white pixels at ${(whiteFrac * 100).toFixed(2)}% of sampled strip (law: <=1%)`);
  }
}

// Queue one strip readback into the PBO and fence it — the CPU never waits.
// Falls back to a single synchronous strip read if the async path ever fails:
// still at most ONE readback on this frame, just a stalling one.
function queueLiveStrip(gl) {
  if (pboFence) return;              // previous read still in flight — skip beat
  const W = gl.drawingBufferWidth;
  const len = W * STRIP_H * 4;
  ensureStripBuffer(len);
  const y = stripYPx(gl, liveStripIdx);
  liveStripIdx = (liveStripIdx + 1) % STRIP_YS.length;
  if (!pboOk) {
    gl.readPixels(0, y, W, STRIP_H, gl.RGBA, gl.UNSIGNED_BYTE, stripBytes);
    evalLiveStrip(W, len);
    return;
  }
  try {
    if (!pbo) pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    if (pboBytes < len) { gl.bufferData(gl.PIXEL_PACK_BUFFER, len, gl.STREAM_READ); pboBytes = len; }
    gl.readPixels(0, y, W, STRIP_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    pboFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();                      // the fence must reach the GPU queue
    pboPendingLen = len;
    pboPendingW = W;
  } catch (e) {
    pboOk = false;                   // sync fallback from the next beat on
    try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch { /* context lost */ }
    pboFence = null;
  }
}

// Poll the in-flight fence (every live frame, free when idle); when signaled,
// map the bytes out and run gates 1+3 on the strip they hold.
function pollLiveStrip(gl) {
  if (!pboFence) return;
  let st;
  try { st = gl.clientWaitSync(pboFence, 0, 0); }
  catch (e) { pboOk = false; pboFence = null; return; }
  if (st === gl.TIMEOUT_EXPIRED) return;           // still cooking — next frame
  try { gl.deleteSync(pboFence); } catch { /* context lost */ }
  pboFence = null;
  if (st === gl.WAIT_FAILED) { pboOk = false; return; }
  if (gl.drawingBufferWidth !== pboPendingW) return;   // resized mid-flight — stale
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, stripBytes, 0, pboPendingLen);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  } catch (e) {
    pboOk = false;
    return;
  }
  evalLiveStrip(pboPendingW, pboPendingLen);
}

function runFrameGuard() {
  frameNo++;
  const gl = rendererRef.getContext();
  if (shotMode) { shotGuard(gl); return; }
  // Live cadence (audit P1): at most ONE synchronous readback on any frame —
  // and none at all on strip beats while the async path is healthy.
  pollLiveStrip(gl);
  if (frameNo === 10 || frameNo % 120 === 0) {
    queueLiveStrip(gl);
  } else if (frameNo === 40 || frameNo % 120 === 60) {
    if (probeBlocks(gl, liveProbeIdx, 1)) {
      failFrame('non-finite (NaN/Inf) pixels in composer output');
    }
    liveProbeIdx = (liveProbeIdx + 1) % PROBE_POINTS.length;
  }
}

export default {
  name: 'post',

  init(ctx) {
    const { renderer, scene, camera, quality, CHRONO } = ctx;
    rendererRef = renderer;
    cameraRef = camera;

    // Guard state + readback buffers — allocated here, reused every probe.
    shotMode = ctx.params.get('freeze') === '1';
    frameNo = 0; time = 0; kick = 0; lastVt = 0;
    hdrGuardOk = true; hdrGuardChecked = false; lastGuardReport = -Infinity;
    liveStripIdx = 0; liveProbeIdx = 0;
    pbo = null; pboBytes = 0; pboFence = null; pboPendingLen = 0; pboPendingW = 0;
    pboOk = typeof renderer.getContext().fenceSync === 'function';
    probeHalf = new Uint16Array(PROBE * PROBE * 4);

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    // INTEGER physical pixels (round 9): on fractional display scaling
    // (Windows 150% → pr 1.5) logical×pr is non-integer (e.g. 1249×1.5 =
    // 1873.5) while the renderer floors its drawing buffer (1873). Fractional
    // target sizes survive as-is on WebGLRenderTarget/viewport objects and
    // only GL's GLsizei truncation keeps attachments consistent — never rely
    // on that: floor once, size EVERYTHING (targets, composer, uRes, guard
    // strips) from the same integers the canvas actually has.
    const pw = Math.floor(size.x * pr);
    const ph = Math.floor(size.y * pr);
    stripBytes = null;
    ensureStripBuffer(pw * STRIP_H * 4);

    // Chronogram footprint for the oblique plate-coverage damp (round 8) —
    // same world-space contract the knee's plate mask is built from.
    plateHitY = CHRONO.y;
    const rIn = Math.max(CHRONO.rInner - 0.5, 0);
    const rOut = CHRONO.rOuter + 1.9;
    plateR2In = rIn * rIn;
    plateR2Out = rOut * rOut;

    // Half-float HDR chain, SINGLE-SAMPLE ping-pong (audit P0): r185 clones
    // this target for renderTarget2, so any samples set here would multisample
    // every fullscreen pass and force a resolve per pass for zero visual gain
    // — fullscreen quads have no geometry edges. Geometry MSAA lives on the
    // dedicated scene target below instead.
    const rt = new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.HalfFloatType,
    });
    composer = new EffectComposer(renderer, rt);
    // The composer must run at PHYSICAL resolution: sized in logical px it
    // runs every downstream pass at a fraction of the canvas — the upscale
    // smeared thin ticks into the UR-2 "shadows". Round 9: r185's composer
    // takes _pixelRatio from the renderer unconditionally (1.5 here), and
    // setSize(w, h) allocates w*ratio × h*ratio — feeding it logical size
    // re-derives the fractional 1873.5, feeding it physical size would
    // super-sample 1.5x on top. Pin the ratio to 1 FIRST, then hand it the
    // FLOORED physical size: integer-in, integer-out, exactly the drawing
    // buffer's pixels (resize() below follows the same rule).
    composer.setPixelRatio(1);
    composer.setSize(pw, ph);

    let stackCapPassRef = null;   // for the ?post= diagnostic bisect below
    // ?post=plain — bisect the scene-feed itself: plain RenderPass instead of
    // the MSAA-target + pinned stack-cap pair (rest of the chain unchanged).
    const plainFeed = ctx.params.get('post') === 'plain';
    if (plainFeed) console.warn('[post] diagnostic: plain RenderPass scene feed');
    if (quality === 'low' || plainFeed) {
      // Low skips MSAA entirely (as before) — plain scene render into the
      // composer's read buffer; the knee reads it directly.
      composer.addPass(new RenderPass(scene, camera));
    } else {
      // Scene geometry keeps its 4x MSAA on a dedicated fp16 target; the
      // renderer resolves it to a plain texture the moment the scene render
      // ends (renderer's antialias flag does not reach composer RTs).
      const msaaRT = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType,
        samples: 4,
      });
      composer.addPass(new MSAAScenePass(scene, camera, msaaRT));

      // Stack cap first (round 5): bound the summed radiance of overlapping
      // emissives BEFORE the mip chain can see it — one cheap fullscreen op.
      // Its input is PINNED to the resolved scene texture: the unused
      // textureID keeps ShaderPass from rebinding tDiffuse to the (stale)
      // composer read buffer, and WebGLRenderTarget.setSize preserves the
      // texture object, so the pinned reference survives resizes.
      const stackCapPass = new ShaderPass(StackCapShader, 'tSceneResolved');
      stackCapPass.uniforms.tDiffuse.value = msaaRT.texture;
      composer.addPass(stackCapPass);
      stackCapPassRef = stackCapPass;

      // Bloom discipline (round 8): threshold 2.5 sits just under the cap
      // asymptote (knee 1.4, asymptote 2.8), so neither the floor wash nor a
      // compressed stack can feed the mip chain — only genuinely hot emissive
      // cores (raw lum > ~6.5) bloom, by at most 0.3 over threshold, and
      // radius 0.25 keeps their halos tight. Strength is scaled per frame in
      // update() by camera height, downtilt, and plate coverage.
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
      composer.addPass(bloomPass);
    }

    // Area-aware tone-map shoulder in linear HDR, AFTER bloom — it compresses
    // scene + bloom together, so nothing bloom adds can re-blow a region. See
    // KneeShader header: this is the structural no-blown-fields guarantee.
    kneePass = new ShaderPass(KneeShader);
    kneePass.uniforms.uAspect.value = pw / ph;   // buffer aspect, not logical
    // Plate geometry from the world-space contract — the knee's ground-plane
    // reprojection must agree with where chronogram.js actually draws.
    kneePass.uniforms.uPlateR.value.set(CHRONO.rInner, CHRONO.rOuter);
    kneePass.uniforms.uPlateY.value = CHRONO.y;
    composer.addPass(kneePass);

    // OutputPass reads renderer.toneMapping (ACES) + outputColorSpace + exposure
    // (1.1) — the single tonemap application for the whole chain.
    composer.addPass(new OutputPass());

    gradePass = new ShaderPass(GradeShader);
    gradePass.uniforms.uRes.value.set(pw, ph);   // integer physical px
    composer.addPass(gradePass);   // last pass → renders to screen

    // Diagnostic bisect: ?post=off,<name>[,name…] disables named passes at
    // boot (names: cap, bloom, knee, grade). Shot-mode safe; costs nothing
    // when the param is absent. Example: ?post=off,knee isolates the knee.
    const postOff = (ctx.params.get('post') ?? '').split(',');
    if (postOff[0] === 'off') {
      const byName = { cap: stackCapPassRef, bloom: bloomPass, knee: kneePass, grade: gradePass };
      for (const n of postOff.slice(1)) if (byName[n]) byName[n].enabled = false;
      console.warn('[post] diagnostic bisect — disabled:', postOff.slice(1).join(','));
    }

    // debug handle for artifact forensics — enumerate pass configs at runtime
    if (typeof window !== 'undefined') window.__CSPACE_POST = { composer };

    ctx.setComposer((dt) => {
      time += dt;
      gradePass.uniforms.uTime.value = time;
      // Plate-reprojection uniforms (round 6) — refreshed here, after every
      // module update (the rig included), so the knee unprojects with exactly
      // the camera the RenderPass is about to use. Camera.updateMatrixWorld
      // also refreshes matrixWorldInverse; invert() runs in place — no
      // per-frame allocation.
      cameraRef.updateMatrixWorld();
      kneePass.uniforms.uInvViewProj.value
        .multiplyMatrices(cameraRef.projectionMatrix, cameraRef.matrixWorldInverse)
        .invert();
      kneePass.uniforms.uCamPos.value.setFromMatrixPosition(cameraRef.matrixWorld);
      composer.render(dt);
      runFrameGuard();   // perceptual gate — dead frames must not pass (header)
    });
  },

  update(dt, state) {
    if (!gradePass) return;
    lastVt = state.vt;   // diagnostics for guard failure messages
    for (const e of state.fired) {
      if (e.kind === 'compaction') { kick = 1; break; }   // audit P2: early out
    }
    if (kick > 0.001) kick *= Math.exp(-dt * 2.6);   // eased decay, gone < 2s
    else kick = 0;
    gradePass.uniforms.uKick.value = kick;

    // Camera adaptation (rounds 2 + 5 + 8): the lower the camera, the harder
    // it tilts toward the floor, OR the more of the frame the chronogram
    // plate actually occupies, the tighter the highlight ceilings and bloom
    // get — the glow dims exactly when it looms largest. Downtilt was added
    // because altitude alone lied (cam6's top-down plate is high AND all
    // floor); round 8 adds direct plate coverage because downtilt ALSO lied —
    // a low-oblique camera fills the frame with plate at modest pitch (UR-3:
    // the plate flooded at exactly those angles). The rig eases all camera
    // motion and the coverage fraction is quantized by 20 samples, but it
    // only steers a smoothstepped damp — no visible popping.
    cameraRef.updateMatrixWorld();
    _camPos.setFromMatrixPosition(cameraRef.matrixWorld);
    const hfRaw = Math.min(Math.max(
      (_camPos.y - CAM_Y_LO) / (CAM_Y_HI - CAM_Y_LO), 0), 1);
    cameraRef.getWorldDirection(_camFwd);
    const down = Math.min(Math.max(-_camFwd.y, 0), 1);   // 0 level, 1 straight down
    const dT = Math.min(Math.max((down - 0.45) / 0.45, 0), 1);  // smoothstep 0.45..0.9

    // Plate coverage: unproject the fixed NDC grid, intersect the ground
    // plane, count hits on the chronogram footprint. Pure scratch math —
    // zero allocation, ~20 ray-plane tests.
    _invVP.multiplyMatrices(cameraRef.projectionMatrix, cameraRef.matrixWorldInverse)
      .invert();
    let hits = 0;
    for (let i = 0; i < FLOOR_GRID.length; i += 2) {
      _farPt.set(FLOOR_GRID[i], FLOOR_GRID[i + 1], 1).applyMatrix4(_invVP);
      const dy = _farPt.y - _camPos.y;
      if (dy >= -1e-4) continue;                   // ray never descends
      const t = (plateHitY - _camPos.y) / dy;
      if (t <= 0) continue;                        // plane is behind the camera
      const px = _camPos.x + (_farPt.x - _camPos.x) * t;
      const pz = _camPos.z + (_farPt.z - _camPos.z) * t;
      const r2 = px * px + pz * pz;
      if (r2 >= plateR2In && r2 <= plateR2Out) hits++;
    }
    const pf = hits / (FLOOR_GRID.length / 2);
    const oT = Math.min(Math.max((pf - PLATE_FRAC_LO) / (PLATE_FRAC_HI - PLATE_FRAC_LO), 0), 1);

    const damp = Math.max(dT * dT * (3 - 2 * dT), oT * oT * (3 - 2 * oT));
    const hf = hfRaw * (1 - FLOOR_LOOK_DAMP * damp);
    kneePass.uniforms.uCeilHi.value =
      CEIL_HI_RANGE[0] + (CEIL_HI_RANGE[1] - CEIL_HI_RANGE[0]) * hf;
    kneePass.uniforms.uCeilLo.value =
      CEIL_LO_RANGE[0] + (CEIL_LO_RANGE[1] - CEIL_LO_RANGE[0]) * hf;
    if (bloomPass) bloomPass.strength =
      BLOOM_STRENGTH * (BLOOM_STR_MIN + (1 - BLOOM_STR_MIN) * hf);
  },

  resize(w, h) {
    if (!composer) return;
    // Same integer-physical rule as init (round 9): floor once, feed the
    // floored size to the composer (its _pixelRatio stays 1), and derive
    // every dependent uniform/buffer from the same integers.
    const pr = rendererRef.getPixelRatio();
    const pw = Math.floor(w * pr);
    const ph = Math.floor(h * pr);
    composer.setSize(pw, ph); // cascades to every pass, bloom mip chain included
    kneePass.uniforms.uAspect.value = pw / ph;
    gradePass.uniforms.uRes.value.set(pw, ph);
    ensureStripBuffer(pw * STRIP_H * 4);
  },
};
