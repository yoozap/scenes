# scenes

Standalone Three.js / WebGPU scenes. One HTML file per scene, Vite and nothing else.

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

### How it is put together

| | |
|---|---|
| `yoozap_scene_1.html` | the whole page — markup and styles, no framework |
| `src/main.js` | starts the scene |
| `src/city.js` | the scene: rig, physics, lighting, camera edits |
| `src/speedBlur.js` | the TSL post pass — real camera-motion blur, not a radial smear |
| `public/models/` | the GLBs |
| `public/draco/` | the draco decoder, wasm + wrapper only |

### Payload

~5 MB loads before the first frame:

| | |
|---|---|
| `tunnel.glb` | 2.81 MB — the scan. Simplified to 390k triangles; its 4096² atlas is untouched, because the bore's walls *are* that texture and sharpness here comes from anisotropy, not resolution |
| `taycan.glb` | 1.78 MB — the subject, untouched |
| `tunnel-bore.glb` | 0.21 MB — one 20.6 m section, tiled to make the bore endless |
| `road.glb` | 0.20 MB — one asphalt material, so the road does not wait on the city |
| `city.glb` | 4.16 MB — streams in behind the hero; only visible after **Esc** |

`vite.config.js` rewrites three's `DRACOLoader` decoder constants to literals.
Without that, Vite emits 1.3 MB of hashed decoder copies the browser never
requests, because the loader is pointed at `public/draco/` instead.

Draco stays rather than meshopt: swapping costs ~+43% raw across these models to
save ~52 kB of decoder. Nothing is quantized — draco already quantizes
internally, and stacking the two measures far larger.

## Commands

```bash
npm install
npm run dev       # dev server
npm run build     # production build into dist/
npm run preview   # preview the production build
```
