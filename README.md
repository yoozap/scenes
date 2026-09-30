# scenes

Standalone Three.js / WebGPU scenes. One HTML file per scene, one domain per
scene, Vite and nothing else.

Each scene is its OWN app: its own page, its own entry, its own copy of the
engine. They share the repo and the GLBs and nothing else, so a change to one
scene cannot reach the other. The cost is deliberate — a fix in `src/city.js`
does not cross into `src/scene2/city.js` by itself.

## Scene 1 — Tunnel Run (`yoozap_scene_1.html`)

A Porsche Taycan at a locked 300 km/h through the Braithwaite Street Tunnel, a
photogrammetry scan tiled into an endless bore. Five camera edits, switchable
from the bar at the top.

- **Hero Run / Pursuit / Drift / IMAX / Snap Cuts** — each is an 8-second list
  of hard cuts (`MOVIES` in `src/city.js`). Drag to orbit, scroll to zoom: that
  nudges the edit rather than fighting it.
- **E** enters drive mode (WASD, Shift for turbo). **Esc** leaves the tunnel for
  the city. `window.__city` exposes live handles for the console.
- Renders through `WebGPURenderer` (auto-falls back to WebGL2) with ACES tone
  mapping and a TSL bloom + FXAA + speed-blur post chain.
- **Every device gets its best picture** (`src/quality.js`): a fill bench at
  boot prices the gpu and opens on the rung it earned — dpr, reflection-probe
  cadence and blur taps per rung, with rung 3 (ultra) giving strong panels
  their full device ratio under a ~3.2M-pixel budget. A live watchdog demotes
  on measured frame cost (and climbs back once, carefully); the settled rung
  is remembered per device shape for a week. Dev knobs: `?rung=N` pins a
  rung, `?dpr=X` fakes a panel ratio, `?webgl` forces the WebGL2 backend.
- Touch is first-class: one finger orbits, two fingers pinch-zoom, any hold
  pauses the edit. The five camera edits adapt to narrow frames — the lens
  widens toward the authored horizontal reach and off-axis aims recentre, so
  a portrait phone sees the shot, not a crop of it.

### How it is put together

| | |
|---|---|
| `yoozap_scene_1.html` | scene 1's page — markup and styles, no framework |
| `yoozap_scene_2.html` | scene 2's page, same markup, its own entry |
| `src/main.js` | starts scene 1 |
| `src/city.js` | scene 1: rig, physics, lighting, camera edits |
| `src/speedBlur.js` | the TSL post pass — real camera-motion blur, not a radial smear |
| `src/scene2/` | scene 2's own copy of all four, and nothing imports across |
| `public/models/` | the GLBs |
| `public/draco/` | the draco decoder, wasm + wrapper only |

### Payload

~5 MB loads before scene 1's first frame, ~11 MB before scene 2's:

| | |
|---|---|
| `tunnel.glb` | 2.81 MB — the scan. Simplified to 390k triangles; its 4096² atlas is untouched, because the bore's walls *are* that texture and sharpness here comes from anisotropy, not resolution |
| `taycan.glb` | 1.78 MB — the subject, untouched |
| `tunnel-bore.glb` | 0.21 MB — one 20.6 m section, tiled to make the bore endless |
| `road.glb` | 0.20 MB — one asphalt material, so the road does not wait on the city |
| `city.glb` | 4.16 MB — scene 2 only, and it blocks the first frame there: a page that opens ON the city has no hero to hide the wait behind |
| `ev-charger.glb` | 2.19 MB — scene 2 only, and the one model in the set draco never touched. Its weight is four PNG maps (base colour, metallic-roughness, emissive, normal), ~1.7 MB of the 2.19: the obvious thing to shrink if scene 2's payload starts to hurt |

`vite.config.js` rewrites three's `DRACOLoader` decoder constants to literals.
Without that, Vite emits 1.3 MB of hashed decoder copies the browser never
requests, because the loader is pointed at `public/draco/` instead.

Draco stays rather than meshopt: swapping costs ~+43% raw across these models to
save ~52 kB of decoder. Nothing is quantized — draco already quantizes
internally, and stacking the two measures far larger.

## Scene 2 — The City (`yoozap_scene_2.html`)

The same world as scene 1, opened from the outside instead of from inside the
bore: `city.glb` is loaded, the page rests on the establishing view, and
**nothing moves the camera but you** — no 8-second edit clock, no idle
auto-rotate. Drag to orbit, pinch or ctrl+scroll to zoom, WASD to fly.

The run is still here: the five edit buttons enter it, and **Esc** comes back
out to the city. Inside the run the edit clock stays frozen too — the rig
holds the opening cut of whichever edit was picked and tracks the car from
there, so drag and zoom are the whole camera.

### The show

The car drives a loop, forever, and it is the only thing in the scene that
moves on its own:

| | | |
|---|---|---|
| run-in | 2.1 s | out of the bore at 33 m/s, braking to 19 |
| set-up | 0.4 s | slides west onto the circle, slip building to 46° |
| donut | 6.3 s | 2½ laps of a 5.2 m circle, leaving it facing north |
| straighten | 2.4 s | brakes across to the kerb line, slip unwinding |
| beat | 1.1 s | stands still |
| reverse | 4.1 s | backs down the kerb line, still facing north |
| charge | 7.0 s | parked at the kerb beside the charger |
| pull-out | 2.2 s | straight off up the road — already pointing the right way |
| run-out | 2.4 s | back into the tunnel |

**27.9 s a lap, and it never teleports.** The seam is at z = 70, deep inside a
scan that runs z 18 → 94.5, so the turn-around happens where nothing can see
it. Every segment joins the next at 0.000 m and on a matching heading.

Three things set the geometry, and all three were measured rather than
guessed:

- **The median is gone, so the junction is road.** It used to be a kerbed
  island with a grass strip, and the car was throwing the donut over it. Six
  meshes made it up — identified by the average colour of their own base maps,
  the kerb sections at #808175 and the strip on top at #51593a — and they are
  hidden whole (see `JUNCTION_CLEARED`). Its traffic signal is a *column of*
  `Object_481`, a mesh that holds other street furniture too, so that one is
  cut by triangle instead. Whole meshes are hidden rather than trimmed
  because these are shells: a box cut leaves the cross-section open.
- **The circle is placed by measurement, not by eye.** Every point in the
  junction between 0.08 m and the car's roof is checked against the swept
  ring, allowing 2.8 m for the body's own half-diagonal. Centred (0, 10) at
  r = 5.2 it clears the lot by **2.05 m**; the first attempt, before the
  median came out, was 2.78 m *inside* it.
- **The bore and the street want different lanes.** Scene 1 proves the bore is
  clear at x = −1.75 and clamps its camera to walls at x −4.85…1.4; out in the
  city that lane would clip the median kerb. So the run eases between x −1.75
  and −3.2 while it is inside the mouth, where nothing is watching closely.
- **It parks on the road, port side to the charger.** The Taycan's charge
  port is on its right, so the car is left facing north at the kerb — that is
  the only heading that turns its right flank toward a charger sitting on the
  pavement to the west. The slot's x is measured too: the kerb edge there is
  at x −10.5 and the car is 2.41 m wide, so −8.9 leaves its flank 0.4 m off
  the kerb, on the road. The charger's own screen faces east to meet it,
  which `CHARGER_YAW` already did — the emissive map has exactly one lit
  face, and its normal points along the model's +z.
- **Speed is a profile, not a duration.** Each segment carries `v(u)`, which is
  integrated once at build time into a normalised distance curve. The segment
  then always ends exactly on its last point however the speed is shaped —
  including the profiles that start and end at a dead stop, which a plain
  `distance += speed × dt` can only approach and never reach. The wheels are
  spun from the same number that moves the car, so they cannot disagree with
  the ground.

`SHOW_DONUT`, `SHOW_PARK`, `SHOW_LANE_X` and the segment list at the top of
the block are the handles. The run, drive mode (**E**) and the show are three
owners of one car, so each one stops the others; `window.__city.show()`,
`.startShow()` and `.stopShow()` drive it from the console.

An EV charger stands on the brick pavement outside the block's coffee shop —
the dark corner unit in the base of the round-cornered tower, the only place
in the scan with the word on it (`Object_509`, material `01_-_Default_33`).
It arrives fully textured (base colour, metallic-roughness, emissive and
normal maps over 5 sub-meshes), so the scene only sharpens those maps and
places it; nothing tints it.

`CHARGER_ANCHOR`, `CHARGER_YAW` and `CHARGER_HEIGHT` at the top of the
placement block are the only numbers to touch. The model is recentred and
stood on the anchor from its **own measured bounds**, so its unit scale and
its nested export rotations never have to be known here — a different export
drops in without new constants. In the browser `window.__charger` is the live
object: spin or slide it from the console before committing a change.

Scene 2 is a separate app. `src/scene2/` is its own copy of `city.js`,
`quality.js`, `speedBlur.js` and `main.js`; `yoozap_scene_2.html` loads
`/src/scene2/main.js` and never touches `src/`. The three places it differs
from scene 1 are marked `SCENE 2 (n/3)` in `src/scene2/city.js`:

| | scene 1 | scene 2 |
|---|---|---|
| the city | never loaded | loaded, and it blocks the first frame |
| the EV charger | — | on the pavement outside the Coffee unit |
| the edit clock | cuts on its own 8 s loop | frozen |
| the resting orbit | drifts back to auto-rotate | never spins by itself |
| opens on | the run, inside the bore | the establishing view |

## One pod, one scene

Each pod on usectl serves a single scene at its domain root, so the build
copies the chosen page to `index.html`. `SCENE` chooses, defaulting to 1:

```bash
npm run build              # index.html = scene 1
SCENE=2 npm run build      # index.html = scene 2
docker build --build-arg SCENE=2 .
```

Every page is built either way. They are separate bundles over a shared
three.js vendor chunk, so the pod carries the other scene's ~37 kB of scene
code and its HTML; each stays reachable at its own filename. The dev server mirrors the same rule: `SCENE=2 npm run
dev` serves scene 2 at `/`. An unknown `SCENE` fails the build rather than
quietly shipping the wrong scene at the root.

## Commands

```bash
npm install
npm run dev       # dev server (SCENE=2 npm run dev for scene 2 at /)
npm run build     # production build into dist/
npm run preview   # preview the production build
```
