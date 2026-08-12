# C-SPACE — Art Bible (binding for every module)

## Concept
A real Claude Code session (19 days, 2,322 tool calls, 29 subagent
spawns, 10 compactions, peak context 997k tokens) rendered as a place: the
harness as a machine-city in the void. The fiction: you are inside the
machine's working memory, watching it think. Neon-noir. A city of light made
of data, receding into fog. Consensual hallucination, rendered honestly.

## The scene (world-space contract in src/lib/palette.js LAYOUT)
- **THE CORE** (origin, y=7): the agent loop. A nested gyroscope reactor —
  rotating rings around a fresnel plasma heart. It pulses when the model
  speaks, flares when the user speaks, stutters on thinking.
- **THE STACK** (towerPos): the context window. A tower of memory slabs that
  grows toward a 1M-token ceiling. Cache-read tokens: cold cyan, archival,
  stable. Fresh input: hot magenta seams. Compaction: a glitch-flash collapse —
  the tower loses height, debris dissolves upward.
- **THE RING** (totemRingRadius): tool totems. One monolith per tool, height by
  call volume. Conduits of light run core→totem. A call is a pulse outward; a
  result is a pulse back; an error pulse is red and leaves a scorch flicker.
- **THE SHELL** (droneOrbitRadius): subagent minds. Violet drones spawned from
  the core, tethered by beams, orbiting while alive, dissolving on return.
- **THE FLOOR & BEYOND**: an infinite emissive grid fading into fog; distant
  data-skyline silhouettes; drifting motes. The void is never pure black —
  depth is layered: fog gradients, dim skyline, mid machine, near particles.

## Palette — src/lib/palette.js only. No color outside it.
cyan = cache/machine calm · magenta = fresh input/heat · amber = model output ·
violet = subagents · red = errors only · mint = hooks. The night is #05060a.

## Lighting law
- Emissive surfaces are the light sources of record. Bloom belongs to emissives.
- Discipline: no blown-white frames. Highlights peak small and hot; large areas
  stay in the low-mids. Fog gives every silhouette a depth cue.
- Contrast is the aesthetic: hard neon against deep shadow, rim-lit edges.

## Material law
- The default-material look is failure. Every surface: deliberate metalness/
  roughness, fresnel edge response where it reads, emissive maps with texture
  (banding, circuitry, scanline detail — procedural or canvas-generated).
- No external assets of any kind.† Procedural geometry, shaders, canvas textures.

† **One sanctioned exception, and it is not a rendering asset.** The optional
ambient radio bed in `src/modules/audio.js` streams SomaFM (DEF CON Radio / The
Trip / Drone Zone) over the network — OFF by default, armed only by an explicit
user gesture, and never touched under `?freeze=1`. Its alternative, the SYNTH
bed, is fully procedural and makes no requests. Everything the scene *draws*
stays under the rule without exception: no fetched geometry, textures, fonts,
HDRIs or images, ever. See the **Sound** section of `README.md`.

## Motion law
- Nothing is static. Everything breathes: slow rotation, pulse decay, drift.
- All pulses ease (expo/cubic out). Linear motion is failure.
- Event-driven flourishes must decay within ~2s; the resting scene stays calm.

## Performance law
- 60fps at 1080p. Instancing for anything repeated. PixelRatio already capped.
- Target < 600k triangles, < 120 draw calls. Allocate in init(), never per frame.

## Module discipline
- You own exactly your file (plus an optional folder src/modules/<name>/).
- Never edit main.js, lib/, index.html, or another module's files.
- Module must import cleanly under plain node (no top-level DOM/GL access).
- Respect the frame-state contract in lib/timeline.js and main.js header.
- cameraRig presets 0–5 are frozen — the critique pipeline depends on them.

## Information design law (v2 — the scene IS the infographic)
Pretty is table stakes. The center of the frame must now be information design
of the highest order. Principles, in force everywhere:
- **Data-ink**: every geometric property of a central element encodes a real
  quantity (angle = time, height = tokens, thickness = volume, color = family).
  Pure ornament may exist only at the periphery (skyline, motes).
- **Overview first, zoom and filter, details on demand** (Shneiderman). The
  chronogram gives the whole session at a glance; clicking filters; hovering
  explains. Nothing requires documentation to read.
- **THE CHRONOGRAM** (floor annulus, CHRONO in palette.js): the whole 180s
  playback mapped to 360° starting at 12 o'clock, clockwise. Concentric lanes:
  outer = tool calls (ticks colored by TOOL_COLORS family), middle = dialogue
  (user gates magenta, say amber, thinking dim cyan), inner = subagent Gantt
  arcs (violet, spawn→despawn span) and hook ticks (mint). Compactions cut
  radial scars across all lanes. A radar-sweep playhead marks now; its wake
  stays lit (past bright, future dim). Clicking the ring seeks. It must read
  like the finest radial infographic ever printed, rendered in neon.
- **Labels are part of the design**: axis marks on the tower (250k/500k/750k/1M),
  totem names, chronogram quarter-marks (0:00 / 0:45 / 1:30 / 2:15). Small,
  precise, uppercase, never decorative.
- **Subagents are first-class**: every spawn visible as a drone in flight AND a
  Gantt arc on the chronogram; hover either → card (label, type, lifespan).

## Interaction law
- ctx.pick registry (see main.js): modules register pickable objects with card
  data. interact.js owns the raycaster, hover cards, and click routing.
- Hover: cyan-bracket card near cursor, monospace, <120ms response, never
  blocks the view. Click totem: filter the world to that tool (its pulses and
  chronogram ticks stay lit, all else dims 60%); click again to clear.
- Click chronogram: seek. Drag canvas: orbit (exists). Scrubber: seek (exists).
- Every interactive surface must communicate affordance on hover (brighten).

## The bar
Every frame should be believable as a marketing still from a AAA neon-noir
release AND survive scrutiny from a master information designer. If a
screenshot looks like "a three.js demo", it failed. If an element is pure
decoration in the center of frame, it failed.
