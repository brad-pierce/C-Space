# Performance Audit — HISTORICAL (2026-08-11)

> ## Read this first
>
> **This is a historical document, retained for provenance. It is NOT an open
> defect list.** It is a snapshot of the tree as it stood on **2026-08-11**,
> written by the frame-budget audit pass of the build campaign. It is linked
> from the README's *Provenance* section for exactly that reason.
>
> **Both P0s and every headline finding have since been fixed** (verified against
> the tree on 2026-08-12 — see *Resolution status* immediately below, and the
> `FIXED` markers on individual rows). Line numbers throughout refer to the
> audited tree and have drifted since; treat them as landmarks, not addresses.
> The "Next campaign directives" section at the end was the fixer worklist for
> that campaign and has been carried out — it is kept verbatim as a record of
> what was asked for, not as a TODO.
>
> A handful of lower-priority items were deliberately not taken (see the same
> section). Nothing here is a correctness or security finding; every item is a
> frame-cost observation.

## Resolution status (verified against the tree, 2026-08-12)

**Fixed** — confirmed present in the current code:

| Item | Evidence in the current tree |
|---|---|
| **P0** post.js:599 — MSAA'd composer ping-pong | Composer target is built single-sample; geometry MSAA lives on a dedicated `samples: 4` fp16 scene target that resolves before the first fullscreen pass (see the post.js header and the target construction around `samples: 4` / the "any samples set here would multisample" comment). |
| **P0** core.js:890 — 28k-tri pick geometry | The hi-res heart and gyro tori are no longer registered. `ctx.pick.register` now takes invisible low-poly proxies only: an 8×6 sphere for the heart, three coarse 8×24 torus hulls riding the spin group, and a torus proxy for the gauge, all on one shared `MeshBasicMaterial({ visible: false })`. |
| **P1** post.js:509 — up to 11 sync readbacks in one frame | `runFrameGuard` now performs **at most one** readback per frame: gates 1+3 rotate a single full-width strip through a `PIXEL_PACK_BUFFER` + `fenceSync` async path polled on later frames, and gate 2 rotates one probe block on beats offset 60 frames from the strips. Full strip coverage cycles in ~12s. |
| **P1** environment.js:334 — 24 sin() per sky fragment | The two 3-octave fbm fields are baked once at init into one 256×256 tiling RG `DataTexture` (mip-free, `RepeatWrapping`); the shader does two `texture2D` fetches with scrolled UVs. |
| **P1** chronogram.js:598 — invisible tick layer | Wiring finished rather than stripped: `aKeep` is authored as an `InstancedBufferAttribute`, `uLod` is bound per-mesh (`uLodTick` for detail ticks, `uLodBand` for the density twin), `bandMesh` is built and added, and both uniforms are driven from camera distance in `update()`. |
| **P1** totems.js:509 — 640 always-submitted pulse instances | Pulse geometry dropped to `SphereGeometry(0.14, 6, 4)` and `pulseMesh.count` now tracks live demand (`live * TRAIL`), so dead pool slots submit no vertex work. |
| **P1** core.js:1027 — per-frame gauge canvas reupload | The displayed token value is quantized to the nearest 10 while the ease is moving and snapped exact when it settles (< 1 token) or under `dt === 0` shot mode; the canvas/texture upload is gated on the quantized string changing. |
| **P1** hud.js:82 — backdrop-filter over the live canvas | **Partial.** `hud.js` scrims no longer blur at all (near-opaque gradient + scanlines, with a header comment recording why). `library.js` and `fleet/fleetHud.js` panels still use `backdrop-filter: blur(7px)` — see *open* below. |
| **P2** post.js:666 — unbroken compaction scan | `if (e.kind === 'compaction') { kick = 1; break; }`. |
| **P2** environment.js:596 — undisposed luma probe RT | The probe target is disposed after the single frame-2 probe. |

**Deliberately open / not re-verified** (spot-checked 2026-08-12; none is a frame-rate hazard on its own):

- **P1** fleetMain.js:160 — the render loop still calls `tl.tick(dt)` per live stream and discards the allocating result; no `tickQuiet` path was added.
- **P1** machines.js:613 / :261 — the per-attribute dirty-flag split and the `hWritten` guard were not implemented; matrix buffers still re-upload with the color flush.
- **P1** hud.js:82 residue — `library.js` and `fleet/fleetHud.js` still blur behind their panels (the session HUD, the per-frame-worst case, no longer does).
- **P2** fleetCamera.js:470 — still no `dispose()`; the window key listeners and chip are not torn down.
- The remaining P2 rows were not individually re-verified for this header. Assume unfixed unless the code says otherwise.

---

*Everything below is the original 2026-08-11 audit text, unedited except for `FIXED` markers.*

## Headline (as written 2026-08-11)

**Estimated draw calls: 119 / 120 budget** (world 25, infographic 31, actors 52, fleet 11). At budget with no headroom; any additive feature must fund itself.

**Findings: 31 total — 2 P0, 9 P1, 20 P2.** *(Both P0s and six of the nine P1s are now fixed — see Resolution status above.)*

The two P0s are the frame-rate hazards: a 4x-multisampled fp16 post chain (both composer ping-pong buffers MSAA'd, ~265MB attachment memory at dpr 2 / 1080p, 4-5x needed bandwidth) and unproxied full-resolution pick geometry (~28k CPU ray-triangle tests per frame with the cursor near the core). Both stack on top of 4x-playback storm cost. **Both have since been fixed.**

## P0 — both FIXED (2026-08-12)

| Cluster | File:Line | Issue | Fix |
|---|---|---|---|
| world | src/modules/post.js:599 | **FIXED.** EffectComposer built on a full-res half-float target with samples:4; r185 clones it for renderTarget2, so every fullscreen pass (stack-cap, knee, OutputPass) renders into a 4x-MSAA fp16 target and forces a resolve per pass. ~265MB of attachments and 4-5x needed bandwidth at dpr 2 / 1080p; fullscreen quads gain nothing from MSAA. Largest steady-state frame cost; direct 60fps hazard during 4x playback. | Keep MSAA only where geometry rasterizes: give RenderPass its own samples:4 target and hand EffectComposer a non-MSAA HalfFloatType target so both ping-pong buffers are single-sample; or set composer-target samples to 0 and use the RenderPass-only MSAA path (r185 lets the first ShaderPass read the resolved texture). |
| actors | src/modules/core.js:890 | **FIXED.** ctx.pick.register(heart) and register(gyro, {recursive:true}) register full-res render geometry for picking: heart is ~6.9k tris, the gyro walk hits three 7,200-tri tori (~21.6k) plus three InstancedMesh sets. interact.js re-raycasts the registry every frame (interact.js:401-403), so a cursor near the center-frame core costs ~28k CPU ray-triangle tests per frame with no BVH — multi-ms spikes stacked on 4x storm processing. | Register invisible low-poly proxies (8-segment icosphere for the heart, coarse ~8x24 torus proxies for the gyro) with material.visible=false, as drones.js:885-894 already does; or set `mesh.raycast = () => {}` on the hi-res meshes and keep one proxy per assembly. |

## P1 — six of nine FIXED (2026-08-12); the three fleet/HUD items remain

| Cluster | File:Line | Issue | Fix |
|---|---|---|---|
| world | src/modules/post.js:509 | **FIXED.** runFrameGuard performs up to 11 synchronous GPU readbacks in one frame (six full-width readPixels strips + five fp16 readRenderTargetPixels blocks), each a full pipeline stall. Live mode runs it every 120th frame — a visible hitch beat every ~2s that lands on 4x-storm frames. | Collapse the six strip reads into one readPixels region (or rotate one strip per guarded frame), move gate 2 to a different frame than gates 1+3; better, use PIXEL_PACK_BUFFER + fenceSync async readback checked a frame or two later — the guard only logs, it does not gate the current frame in live mode. |
| world | src/modules/environment.js:334 | **FIXED.** DOME_FRAG runs two 3-octave fbm calls per fragment (24 sin-hash evaluations) on a 720-radius BackSide sky sphere; sky is 30-50% of wide framings, ~60-100M sin() calls per frame at 3840x2160 for a barely-visible aurora band mostly masked to near zero. | Bake the two noise fields into one small tiling RG texture (e.g. 256x256, generated once at init) and scroll UVs with uTime — two fetches replace 24 sin calls; also early-out when band < 0.01 so horizon/zenith fragments pay nothing. |
| infographic | src/modules/chronogram.js:598 | **FIXED** (wiring finished, not stripped). TICK_VERT multiplies brightness by mix(uLod, 1.0, aKeep) but uLod is never bound (defaults 0) and aKeep is never authored (reads 0), so all ~5.5k instanced event ticks render black: full draw, vertex, and fill cost every frame for zero output, and the primary data layer is invisible. ROUND 2 LOD state (uLodTick/uLodBand, bandMesh, lodEase) is declared but never wired. | Either finish the wiring (bind uLod, author aKeep=1 for user gates and spawn nodes, build bandMesh, drive the LOD uniforms from camera distance in update()), or strip the uLod/aKeep terms from TICK_VERT and delete the dead LOD state. |
| infographic | src/modules/totems.js:509 | **FIXED.** pulseMesh submits 640 SphereGeometry(0.14, 10, 8) instances (~102k tris) every frame regardless of activity; zero-scaled dead slots still run the full vertex stage. Typical load is under half the pool — ~17% of the 600k-tri budget burned on invisible geometry. | Set pulseMesh.count to live slots by compacting active pulses to the front (or tracking the highest live slot), and drop per-pulse geometry to SphereGeometry(0.14, 6, 4) or a camera-facing quad impostor. |
| actors | src/modules/core.js:1027 | **FIXED.** Gauge readout redraw gate is ineffective: gaugeTok eases toward a continuously-lerped target, so Math.round(gaugeTok) changes nearly every frame — per-frame 448x112 canvas clear+fillText, string build, and a full CanvasTexture GPU reupload (~200KB) for all 180s of playback. | Quantize the displayed value while moving (nearest 10 tokens, or update at most every 100ms) and only redraw when the quantized string differs; snap exact on dt===0 shot mode and when the ease settles. |
| actors | src/modules/hud.js:82 | **FIXED for hud.js** (blur removed entirely, near-opaque gradient + scanlines instead); library.js and fleet/fleetHud.js panels still blur. ~7 HUD scrim regions plus library.js chips/panel use backdrop-filter: blur(7px) brightness(.62) saturate(1.15) over a WebGL canvas that repaints every frame — the compositor re-blurs ~15-20% of the screen every frame even when HUD text is static. | Replace backdrop-filter with a slightly more opaque static gradient scrim (bump scrim alpha ~0.85 to ~0.94, drop the blur), or keep blur only on the one or two largest blocks. |
| fleet | src/fleet/fleetMain.js:160 | Render loop calls tl.tick(dt) per live stream and discards the return, but tick allocates a fired[] array, a result object, and a subagents.filter() array every call — ~720 garbage objects/s at 4 streams x 60fps, plus large short-lived arrays and GC pauses during 4x storms on 8121-event sessions. | Add an allocation-free advance path to LiveTimeline (tickQuiet(dt) that only updates vt/cursor, or a reused result object + preallocated fired array with a length counter); fleetMain only needs the time advance. |
| fleet | src/fleet/machines.js:613 | Dirty flags couple instanceMatrix and instanceColor: ringsDirty re-uploads the full 1344-instance ring matrix buffer (~86KB) every live frame though ring matrices are written once and never change; orbs and pads flushes have the same coupling. | Split flags per attribute (ringsColorDirty, padsMatrixDirty vs padsColorDirty); only writeOrb and writeColumn legitimately dirty matrices. |
| fleet | src/fleet/machines.js:261 | writeColumn recomposes all 24 slab matrices per active machine per frame even when m.h has settled, marking the shared 1152-instance slab matrix buffer dirty and uploading ~74KB/frame on top of the color upload the breathing actually needs. | Track m.hWritten and skip the setMatrixAt loop plus the matrix dirty when abs(m.h - m.hWritten) < epsilon and slab count is unchanged; matrices then upload only during height transitions. |

## P2 — mostly unfixed by design (two marked FIXED below)

| Cluster | File:Line | Issue | Fix |
|---|---|---|---|
| world | src/modules/environment.js:206 | MONO_FRAG does per-fragment work that is constant per instance or per window cell (pow on a varying, sin-hash chains, ~8 extra hash calls) across 168 instanced monoliths filling the mid-band. | Precompute ringI/density/runW on the CPU into instanced attributes as flat varyings; swap the sin-fract hash for a cheaper fract-permutation hash. |
| world | src/modules/environment.js:402 | Ground is two stacked full-extent 1200x1200 planes (lit MeshStandardMaterial + additive grid ShaderMaterial, depthWrite:false, frustumCulled:false) — every floor pixel shaded twice, up to ~half the frame in low camera presets. | Fold the matte grade + two point lights + hemisphere analytically into the grid shader and drop to one floor draw; or at minimum downgrade the matte floor to MeshLambertMaterial and remove frustumCulled=false. |
| world | src/modules/post.js:666 | **FIXED.** update() scans the whole state.fired array for a compaction with no early break — during shot-mode seek it carries all 8121 events and keeps scanning after kick is set. | Add `{ kick = 1; break; }`, matching environment.js:609-613. |
| world | src/modules/cameraRig.js:147 | Conduit-trench repoussoir is 5 separate Mesh draws (slab, seam, 3 ribs) plus two veil Points clouds — 7 camera-attached draws in shot presets 0 and 5 for one static silhouette. | Merge slab + 3 ribs via BufferGeometryUtils.mergeGeometries at init (shared dark MeshBasicMaterial), reducing the trench to 2 draws. |
| world | src/modules/environment.js:596 | **FIXED.** Shot-mode luma probe's 160x90 render target and 57.6KB Uint8Array are never disposed after the single frame-2 probe; the RT stays resident all session. | On probe.done (line 631) call probe.rt.dispose() and null probe.buf/probe. |
| infographic | src/modules/interact.js:196 | _setCard reads offsetWidth/offsetHeight right after textContent writes — a forced reflow per frame while hovering the chronogram plate with the pointer moving, plus per-call garbage from spec.card(). | Only re-measure when a textContent guard actually fired (card size is content-determined); optionally rate-limit same-target refreshes to ~10Hz. |
| infographic | src/modules/interact.js:403 | update() re-raycasts the entire pick registry every frame even with pointer and camera static; intersectObject allocates records + Vector3s and re-sorts per hit. | Skip the raycast when neither this._moved nor the camera matrix changed since last frame (cached matrixWorld hash or rig dirty flag). |
| infographic | src/modules/totems.js:618 | cap/disc instanceColor and pulse instanceMatrix/instanceColor are flagged needsUpdate unconditionally every frame; in steady state identical buffers are re-uploaded. | Mirror the conduitDirty pattern (line 620): flag only when setColorAt wrote a value differing beyond epsilon; skip pulse uploads on frames with no active/spawned/expired pulse. |
| infographic | src/modules/totems.js:414 | Each of 13 obelisk bodies has its own 512x1024 canvas emissiveMap and MeshStandardMaterial — 13 non-batchable draws and ~26MB (+mipmaps ~35MB) texture memory for mostly-black masks. | Pack the 13 masks into one 2048x2048 atlas, merge bodies with per-vertex accent color + atlas UV offset, drive per-totem emissive via a per-instance attribute + onBeforeCompile — 13 draws/materials collapse to 1. |
| infographic | src/modules/totems.js:620 | During filter/hover eases, writeConduitColor fires for all 13 conduits per frame for ~0.5s and needsUpdate re-uploads the whole ~46KB merged color buffer though only changed spans were rewritten. | Use conduitColAttr.addUpdateRange per written conduit span (clearUpdateRanges after upload); conduitRanges already has the bookkeeping. |
| actors | src/modules/core.js:798 | Gauge furniture is 10 separate THREE.Sprite objects, each with its own CanvasTexture and SpriteMaterial (transparent, depthTest:false, renderOrder 20) — 10 draws + 10 texture binds for static text. | Bake the 9 static labels into one canvas atlas on one quad (or one sprite sheet with UV quads in a single BufferGeometry + one material), keep the live readout separate: 10 draws -> 2. |
| actors | src/modules/contextStack.js:701 | Shard instanceMatrix/instanceColor set needsUpdate unconditionally every frame and the loop rewrites zeroMat for all 140 dead slots — ~10.6KB uploaded per frame even with zero shards alive (most of playback). Seams buffer (676-677) has the same unconditional upload. | Track aliveCount/anyChanged: zero dead slots once, set needsUpdate only when a shard was alive this frame or last; same one-shot zeroing for seams when si===0 twice in a row. |
| actors | src/modules/core.js:217 | HEART_FRAG runs double-domain-warped noise (~80 hash3 evaluations per fragment) on a sphere that fills the frame at close-ups and feeds bloom; no octave drop for wide shots where the heart is dozens of pixels. | Bake vnoise into a small tileable noise texture sampled 3x, or drop octaves at uGain > ~1.8 (fbm2/fbm3 via compile-time variant or mix-out). |
| actors | src/modules/hud.js:536 | Four style.transform writes (_mFill/_mTip, _sFill/_sHead) are unconditional per frame despite the "gated" header comment — fresh template strings + style-diff churn even during idle/pause. | Apply the existing last-value string cache (_numStr/_pctStr/_tpXf pattern): compare the built transform string and assign only when different. |
| actors | src/modules/hud.js:450 | _renderTicker restarts its enter animation via `void top.offsetWidth` (forced reflow) up to every 90ms; _flashMeter (459) same on compactions; each flush also invalidates the backdrop-filtered region. | Restart without layout: remove class then re-add in a double-rAF, or alternate two identical keyframe animation names (enter-a/enter-b). |
| fleet | src/fleet/fleetHud.js:438 | _arrivals restarts the dot flash with the `void dot.offsetWidth` reflow idiom — up to ~27 forced reflows/s with 4 live rows in a tool-call storm, on a document carrying three backdrop-filter panels. | Toggle between two equivalent keyframe names or use the Web Animations API (el.animate); or drive the flash from the existing 4Hz UI pass. |
| fleet | src/fleet/fleetHud.js:155 | Three HUD panels use backdrop-filter blur over the per-frame-repainting WebGL canvas (rail alone ~15% of a 1080p frame) — a per-frame compositor tax, worst on integrated GPUs, compounding with DPR 2. | Add a q=low path swapping backdrop-filter for a more opaque static gradient, mirroring the ctx.quality gate cityLayout already uses. |
| fleet | src/fleet/fleetCamera.js:470 | _bindKeys attaches window keydown/keyup/blur listeners and _makeChip appends DOM, but the module has no dispose() — on module teardown/hot-swap the listeners and chip leak and fire against dead state S. | Add a dispose() symmetrical to fleetHud's: store bound handlers, removeEventListener on window, remove S.chip, null S. |
| fleet | src/fleet/fleetHud.js:539 | update() allocates a fresh `rest = [b, c]` array literal every frame purely for the signature-tolerant ctx sniff — the only unconditional per-frame allocation in the HUD hot path. | Unroll into sequential if statements checking b then c; or fast-path `if (bag === this._ctx)`. |
| fleet | src/fleet/machines.js:586 | tl.contextAt(tl.duration) is evaluated up to three times per stream per frame (fleetMain.js:160, machines.update, fleetHud.js:460) — redundant triple binary search, and the mid-curve path allocates an object + closure. | Cache the edge sample once per frame on the timeline (tl.edgeContext refreshed in tick) or stash it on the stream entry in fleetMain; consumers read the cache. |

## Next campaign directives — ISSUED 2026-08-11, ALL SIX COMPLETED 2026-08-12

**Historical worklist. Not a TODO — every directive below was carried out**; the
evidence for each is in *Resolution status* at the top of this file. Kept verbatim
as the record of what the fixer pass was asked to do.

Top six issues as fixer directives, as issued:

1. In src/modules/post.js (~line 599), stop multisampling the post chain: construct the EffectComposer's render target with samples: 0 (HalfFloatType, full res) and give the RenderPass its own samples:4 target whose resolved texture feeds the first ShaderPass, so geometry keeps MSAA while both composer ping-pong buffers are single-sample; verify the stack-cap, knee, and OutputPass passes all read a non-MSAA texture and that visual output is unchanged at dpr 2.
2. In src/modules/core.js (~line 890), replace the pick registrations for heart and gyro with invisible low-poly proxy meshes (8-segment icosphere for the heart; three coarse ~8x24 torus hulls for the gyro rings) using material.visible = false, following the existing pattern at drones.js:885-894, and set `raycast = () => {}` on the hi-res render meshes so interact.js's per-frame raycast never touches the 28k-triangle geometry.
3. In src/modules/post.js (~line 509), restructure runFrameGuard so no frame performs more than one synchronous readback: merge the six strip readPixels calls into a single composite-region read (or rotate one strip per guarded frame through STRIP_YS), schedule gate 2 on a different guarded frame than gates 1+3, and where WebGL2 allows, convert the reads to PIXEL_PACK_BUFFER + fenceSync async readbacks polled a frame or two later — the guard only logs in live mode, so latency is acceptable.
4. In src/modules/chronogram.js (~line 598), fix the invisible event-tick layer: bind uLod (wired to uLodTick) into tickMat's uniforms and author the aKeep InstancedBufferAttribute (1.0 for user gates and spawn nodes, 0.0 otherwise), then either drive uLodTick/uLodBand/lodEase from camera distance in update() and build bandMesh, or strip the mix(uLod, 1.0, aKeep) term and delete the dead bandMesh/uLodBand/lodEase state — the ~5.5k ticks must render visibly either way.
5. In src/modules/totems.js (~line 509), stop submitting dead pulse geometry: compact active pulses to the front of the instance range each update and set pulseMesh.count to the live count instead of zero-scaling dead slots, and reduce per-pulse geometry to SphereGeometry(0.14, 6, 4) or a camera-facing quad impostor, cutting the fixed ~102k-triangle submission to actual demand.
6. In src/modules/core.js (~line 1027), make the gauge readout redraw gate effective: quantize the displayed token value while the ease is moving (nearest 10 tokens or a 100ms accumulator), redraw the 448x112 canvas and set tex.needsUpdate only when the quantized string changes, and snap to the exact value on dt===0 shot mode and when the ease settles below a 1-token delta.
