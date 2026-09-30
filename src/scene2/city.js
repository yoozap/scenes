// SCENE 2 — The City. This is scene 2's OWN copy of the engine: scene 1 lives
// in ../city.js and the two are independent apps that happen to share a repo
// and the GLBs. Nothing here is imported by scene 1, so this file can be
// reshaped freely; the cost is that fixes do not cross over by themselves.
//
// It differs from scene 1 in three places, each marked SCENE 2 below:
//   1. city.glb is loaded, so the scenery exists and every exit gated on it
//      (Escape, the view flights, the clean-click hop) is live.
//   2. the page opens on the establishing view, not inside the bore.
//   3. nothing moves the camera on its own — no 8 s edit clock, no idle
//      auto-rotate. The rig moves when the viewer moves it and not otherwise.
//
// WebGPURenderer falls back to WebGL2 by itself when WebGPU is missing;
// any hard failure just leaves the DOM landing untouched.

import gsap from 'gsap'
import * as THREE from 'three/webgpu'
import {
  cameraProjectionMatrix, cameraWorldMatrix, color, float, instancedBufferAttribute,
  mix,
  modelViewMatrix, normalWorldGeometry, pass,
  modelWorldMatrixInverse, positionGeometry, positionLocal, positionWorld,
  renderOutput, rotateUV, sin, smoothstep,
  texture, uniform, uv as spriteUV, varying, vec2, vec3, vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { speedBlur } from './speedBlur.js'
import { initQuality } from './quality.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

// The landing page's own three darks, straight off its CSS tokens, so the
// 3D and the DOM sit in one palette: --bg, --panel, --paper.
const BG = 0x03070c // --bg    : the near-black blue the page is built on
// The logo teal (#2A9D8F) with its value pushed to the top of the range:
// same hue, bright enough to read as a lit lamp rather than painted plastic.
// EVERY light in this scene is this one colour — the moon over the city, the
// car lamps and the ceiling fixtures alike. Module scope because the moon is
// built long before the car is.
const BRAND_TEAL = 0x3fe6cf
const PANEL = 0x051f1c // --panel : the dark teal
const PAPER = 0x0c1a22 // --paper : the slate blue

// The five camera views from the model's Sketchfab demo, exactly as
// published (hotspot eye/target of sketchfab.com/3d-models/city-a694ac17…),
// stored z-up as served by the viewer and converted to y-up like the
// model's own root node does: (x, y, z) -> (x, z, -y).
const zUp = ([x, y, z]) => new THREE.Vector3(x, z, -y)
const VIEW_ORDER = ['v1', 'v2', 'v3', 'v4', 'v5']
const DEMO_VIEWS = [
  { name: 'view 1', eye: [9.1497, 12.391, 1.9578], target: [-0.9202, 8.4756, 2.3357] },
  { name: 'view 2', eye: [8.1103, -18.5141, 1.0463], target: [-2.5399, -13.6393, 1.3052] },
]

// Three shots on the car itself, framed the way the films frame cars. World
// coordinates, not the Sketchfab demo's z-up space, and each carries its own
// lens — the focal length is half of what makes these read as quotes rather
// than as camera placements.
//
// The car rests nose-north at (-1.75, 0.06, 84), 4.96 m long and 1.98 wide,
// in the open south cutting where the bore walls stand 7.5 m to the left and
// 6.1 m to the right, so there is room to get low and wide.
const CAR_VIEWS = [
  {
    // TOKYO DRIFT: down on the tarmac, off the rear quarter, on a long lens.
    // The compression is the point — it stacks car, wall and vanishing point
    // into one plane the way the drift sequences do.
    id: 'v3',
    eye: [-6.8, 0.32, 88.2],
    target: [-1.95, 0.68, 83.0],
    fov: 38,
  },
  {
    // TARANTINO: the trunk shot. Dead centre, near the floor, looking up at
    // the tail. Symmetry and a low horizon do the work.
    id: 'v4',
    eye: [-1.75, 0.38, 90.2],
    target: [-1.75, 1.2, 85.2],
    fov: 62,
  },
  {
    // GUY RITCHIE: straight down the barrel on a wide lens, subject centred,
    // camera at knee height. Wide enough to bend the walls in at the edges.
    id: 'v5',
    eye: [-1.75, 0.62, 77.6],
    target: [-1.75, 1.0, 83.4],
    fov: 74,
  },
]

// The strip's asphalt is the city road's OWN texture (see CITY_ROAD_MAT
// below), so only the painted centre line has to be drawn here: a double
// dashed line on transparent ground, laid on its own slim mesh over the
// asphalt. One tile spans 8 world units, giving a dash every 2 u.
const makeCentreLineTexture = () => {
  const width = 256 // 8 world units along the road
  const height = 64 // 0.9 world units across the line pair
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#c9a545'
  for (const y of [8, 44]) {
    for (let x = 0; x < width; x += 64) ctx.fillRect(x, y, 56, 12)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.anisotropy = 16 // grazing-angle sharpness; see sharpenTextures
  return texture
}

export const initCity = async () => {
  const canvas = document.getElementById('city-canvas')
  const hero = document.getElementById('hero')
  const camsBar = document.querySelector('[data-cams]')
  if (!canvas || !hero) return

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // the governor prices the gpu (fill bench) before the renderer exists,
  // so even the first frame renders on the rung this device earned
  const quality = initQuality()

  // The WebGPU insurance. A backend can initialise, compile, and still
  // never present a frame (a real iPhone 12 did exactly that) — no error,
  // no rejection, just a veil that never lifts. If a WebGPU boot has not
  // reached scene-live inside the window, the page reloads ONCE pinned to
  // the WebGL2 backend; the pin is remembered so the next visit skips the
  // dead end entirely. A boot that was already on WebGL2 gets no retry —
  // its failure is real and the failed overlay is the honest answer.
  if (!quality.forceWebGL) {
    setTimeout(() => {
      if (document.documentElement.classList.contains('scene-live')) return
      if (document.documentElement.classList.contains('scene-failed')) return
      try {
        if (sessionStorage.getItem('yz_gl_retry')) return // one recovery only
        sessionStorage.setItem('yz_gl_retry', '1')
        localStorage.setItem('yz_backend', 'webgl')
      } catch {}
      location.reload()
    }, 45000)
  }

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    forceWebGL: quality.forceWebGL,
  })
  await renderer.init()
  renderer.setPixelRatio(quality.dpr())
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.25

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BG) // fallback clear colour

  // --- sky ---------------------------------------------------------------
  // A flat fill reads as "nothing rendered here" and gives the skyline
  // nothing to silhouette against. This is a gradient of the page's own
  // three darks, every one of them pulled DOWN from its CSS value — a night
  // sky brighter than the darkest panel on the page would look like a
  // mistake.
  {
    const up = normalWorldGeometry.y
    // Stacked so all three are in frame in ANY view that shows a horizon:
    // slate below the line, the teal ON the line, the near-black blue above
    // it, and the deepest value overhead. The teal band swings in strength
    // with the compass so it never reads as a painted-on ring.
    const swing = normalWorldGeometry.x.mul(0.5).add(0.5).mul(0.45).add(0.55)
    const below = color(PAPER).mul(0.55)
    const glow = color(PANEL).mul(swing)
    const zenith = color(BG).mul(0.35)
    const upper = mix(color(BG), zenith, smoothstep(0.26, 0.9, up))
    const above = mix(glow, upper, smoothstep(0.02, 0.26, up))
    // ACES plus the scene's exposure crush values this dark to about half
    // their sRGB value, so the tokens were landing at #00100e instead of
    // #051f1c. Pre-compensating lands the horizon ON the palette, and
    // everything else keeps its fraction of it.
    const SKY_LIFT = 2.05
    scene.backgroundNode = mix(below, above, smoothstep(-0.22, 0.02, up)).mul(SKY_LIFT)
  }

  // image-based lighting so the car's clearcoat has something to reflect
  try {
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.3 // subtle — it is night out
  } catch {
    /* environment is a garnish; keep going without it */
  }

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 4000)

  // --- load the draco-compressed city and the street tunnel ---
  // Object form on purpose: it sets decoderPaths.dep_js = null, which drops
  // the 512 kB pure-JS fallback decoder. That file is only ever read when the
  // browser has no WebAssembly, and this scene needs WebGPU/WebGL2 anyway.
  const dracoLoader = new DRACOLoader().setDecoderPath({
    js: '/draco/draco_wasm_wrapper.js',
    wasm: '/draco/draco_decoder.wasm',
  })
  const gltfLoader = new GLTFLoader().setDRACOLoader(dracoLoader)
  // What the HERO needs, and nothing else. Scene 1 — the default, and every
  // one of the five header "Scenes" buttons — runs inside the bore: the scan
  // is hidden, the establishing rig is off, and the only things on screen are
  // the car, the tiled bore, its ceiling lamps and the road strip.
  //
  // road.glb is 0.20 MB carrying one material: the city's asphalt, which the
  // strip borrows so the surface matches across the junction. It used to come
  // out of city.glb, which is why 4.2 MB of unlit scenery sat on the hero's
  // critical path for a texture.
  // The veil's [NN%] is real bytes, weighted across the four parallel
  // fetches. Known sizes carry the weighting (a compressed transfer can
  // hide content-length), and it parks at 99 for the decode + pipeline
  // warm-up — a bar that hits 100 and then sits is a broken promise.
  const pctEl = document.querySelector('.loading__pct')
  // The scan is the one model whose weight is its TEXTURE: the 4096 atlas.
  // On the rungs a weak phone opens on, the 2048/webp variant halves the
  // download, the parse and the upload — the other models are geometry,
  // where a "phone variant" measured within 2% of the original and was
  // dropped.
  //
  // ...and the gate is the DEVICE, not the benchmark. This used to read
  // `coarse && rung <= 1`, so a phone that benched strong opened rung 2 and
  // pulled the full 2.9 MB atlas — which confuses two different budgets. The
  // rung measures what the GPU can DRAW; the download is bounded by the
  // NETWORK, and a flagship on a cell link gains nothing from the 4096 atlas
  // except 1.3 MB of waiting. Ultra still stays ultra where it shows: the
  // rung keeps its own say over dpr, the probe and the blur taps.
  //
  // min-DIMENSION rather than innerWidth is deliberate: a tablet in portrait
  // and the same tablet in landscape must resolve to the SAME asset set, or
  // turning the device mid-load downloads both.
  const smallScreen = Math.min(screen.width || 9999, screen.height || 9999) <= 1024
  const phoneAssets = quality.coarse && smallScreen
  const TUNNEL_URL = phoneAssets ? '/models/tunnel-phone.glb' : '/models/tunnel.glb'
  const LOAD_BYTES = {
    [TUNNEL_URL]: phoneAssets ? 1586676 : 2942844,
    '/models/tunnel-bore.glb': 216596,
    '/models/taycan.glb': 1865848,
    '/models/road.glb': 205736,
    // SCENE 2 (1/3): this page OPENS on the city, so the scenery cannot
    // stream in behind a hero the way the old landing did — there is no hero
    // to hide the wait. It loads with the rest and the veil counts its bytes:
    // 4.4 MB is a third of the wait, and a bar that ignored it would sit at
    // 100% doing nothing.
    '/models/city.glb': 4359016,
    '/models/ev-charger.glb': 280112,
  }
  const loadProgress = {}
  const trackLoad = (url) => (event) => {
    loadProgress[url] = Math.min(event.loaded, LOAD_BYTES[url])
    let loaded = 0
    let total = 0
    for (const [u, bytes] of Object.entries(LOAD_BYTES)) {
      total += bytes
      loaded += loadProgress[u] || 0
    }
    if (pctEl) pctEl.textContent = `[${Math.min(99, Math.round((loaded / total) * 100))}%]`
  }
  // init breadcrumbs on the veil itself: when a platform hangs between
  // the download and the first frame, the stage that stuck says where —
  // that is how the iOS Safari hang below was found at all
  const stage = (label) => {
    if (pctEl) pctEl.textContent = `[99%] ${label}`
  }
  window.addEventListener('error', (e) => stage(`ERR ${(e.message || '?').slice(0, 60)}`))
  window.addEventListener('unhandledrejection', (e) => stage(`REJ ${String(e.reason).slice(0, 60)}`))
  const parsePending = new Set(Object.keys(LOAD_BYTES))
  const markParsed = (url) => (gltf) => {
    parsePending.delete(url)
    if (parsePending.size) {
      stage(`parse ${[...parsePending].map((u) => u.split('/').pop().replace('.glb', '')).join(' ')}`)
    }
    return gltf
  }
  const loadModel = (url) => gltfLoader.loadAsync(url, trackLoad(url)).then(markParsed(url))
  const [tunnelGltf, boreGltf, taycanGltf, roadGltf, cityGltf, chargerGltf] = await Promise.all([
    loadModel(TUNNEL_URL),
    loadModel('/models/tunnel-bore.glb'),
    loadModel('/models/taycan.glb'),
    loadModel('/models/road.glb'),
    // A failed city must not take the whole scene down with it: the tunnel
    // run still works, the exits just stay shut.
    loadModel('/models/city.glb').catch((error) => {
      console.warn('[city] scenery failed to load:', error)
      parsePending.delete('/models/city.glb')
      return null
    }),
    // A prop is never worth failing the scene over.
    loadModel('/models/ev-charger.glb').catch((error) => {
      console.warn('[city] ev charger failed to load:', error)
      parsePending.delete('/models/ev-charger.glb')
      return null
    }),
  ])
  stage('build')

  // `city` is the switch the rest of the file reads: with it present, Escape,
  // the view flights and the clean-click view hop all come alive. It stays
  // null only if the fetch above failed, and then this page degrades into
  // scene 1 — the run, with the exits shut.
  const city = cityGltf?.scene ?? null
  dracoLoader.dispose() // every draco model this page uses is already in

  // Braithwaite Street Tunnel, parked at the south end of the view-1
  // boulevard, arch facing north so that road runs straight into the
  // bore. Transform found by hand against the road grid; the
  // photogrammetry is baked daylight, so its unlit material is dimmed
  // to sit in the night scene.
  const tunnel = tunnelGltf.scene
  tunnel.position.set(10.2, 0.26, 45.8)
  tunnel.rotation.y = -Math.PI / 2
  const dimmed = new Set()
  tunnel.traverse((node) => {
    if (node.isMesh && node.material?.color && !dimmed.has(node.material)) {
      dimmed.add(node.material)
      node.material.color.multiplyScalar(0.72)
    }
  })
  scene.add(tunnel)

  // the scan has street furniture baked into its one mesh (a barrier gate,
  // bollards, a freestanding mural pillar) standing on the roadway — carve
  // them out by dropping every triangle whose centroid falls inside a WORLD
  // box (boxes are only valid for the tunnel transform above)
  const carveTunnel = (boxes) => {
    const boxes3 = boxes.map(
      (b) =>
        new THREE.Box3(
          new THREE.Vector3(b.min[0], b.min[1], b.min[2]),
          new THREE.Vector3(b.max[0], b.max[1], b.max[2]),
        ),
    )
    const pa = new THREE.Vector3()
    const pb = new THREE.Vector3()
    const pc = new THREE.Vector3()
    tunnel.updateMatrixWorld(true)
    tunnel.traverse((node) => {
      if (!node.isMesh || !node.geometry.index) return
      const posAttr = node.geometry.attributes.position
      const arr = node.geometry.index.array
      const keep = []
      for (let i = 0; i < arr.length; i += 3) {
        pa.fromBufferAttribute(posAttr, arr[i]).applyMatrix4(node.matrixWorld)
        pb.fromBufferAttribute(posAttr, arr[i + 1]).applyMatrix4(node.matrixWorld)
        pc.fromBufferAttribute(posAttr, arr[i + 2]).applyMatrix4(node.matrixWorld)
        pa.add(pb).add(pc).multiplyScalar(1 / 3)
        if (!boxes3.some((box) => box.containsPoint(pa))) {
          keep.push(arr[i], arr[i + 1], arr[i + 2])
        }
      }
      if (keep.length !== arr.length) node.geometry.setIndex(keep)
    })
  }
  // the shipped tunnel.glb is already carved in Blender (mural pillar +
  // barrier gate removed). The scan's remaining roadway litter — a fallen
  // barrier bar, bollard stubs, kerb rubble, a concrete lump and the lip
  // at the tile seam — is carved here so the racing line is clean asphalt
  // end to end (boxes measured against the live scene)
  carveTunnel([
    { min: [-5.7, -0.16, 30.9], max: [0.8, 0.95, 32.0] }, // fallen bar + posts across the lanes
    { min: [-0.45, -0.16, 34.65], max: [0.75, 0.85, 35.75] }, // bollard by the centre line
    { min: [0.4, -0.16, 23.05], max: [1.45, 0.85, 24.15] }, // kerb-edge stubs, north mouth
    { min: [0.4, -0.16, 58.15], max: [1.45, 0.85, 59.25] }, // stub mid-bore
    { min: [-5.7, -0.16, 92.45], max: [1.75, 0.65, 93.45] }, // lip at the tile seam
    { min: [0.4, -0.16, 59.25], max: [1.3, 0.5, 81.45] }, // crumbled kerb ridge, east lane edge
    { min: [0.3, -0.16, 80.65], max: [0.95, 0.45, 90.65] }, // concrete lump past the kerb line
  ])

  // --- the bore tile the infinity run is actually made of ----------------
  // The scan is a PORTAL plus a bore, and it has no roof over either end:
  // the north end is the open approach outside the portal (correct — it is
  // outdoors) and the south end is simply where the scanning stopped.
  // Tiling the whole scan therefore puts ~29 m of open-topped trench into
  // every 71.5 m period, and the tunnel roof vanishes twice a lap. That is
  // the hole you see go past.
  //
  // tunnel-bore.glb is the cure, cut in Blender from this same scan: the
  // one stretch whose section is constant enough for its two ends to butt
  // invisibly (measured mismatch 0.10 m over a 4.1 m flank), 20.6 m long
  // against a 20 m period so consecutive copies overlap and no hairline can
  // open at the joint. It carries no material or texture of its own — it is
  // handed the scan's, so it is literally the same surface — and it is
  // thinned to 90k triangles from the scan's 227k over that stretch, which
  // measured 99.8% of the original surface area with no cell of the bore
  // left uncovered.
  const TUNNEL_PERIOD = 20 // world z-span of one bore tile (see boreTile)
  const boreTile = boreGltf.scene
  boreTile.position.copy(tunnel.position)
  boreTile.rotation.copy(tunnel.rotation)
  boreTile.visible = false // a template; the run uses clones of it
  {
    let scanMaterial = null
    tunnel.traverse((node) => {
      if (node.isMesh && node.material?.map) scanMaterial = node.material
    })
    boreTile.traverse((node) => {
      if (node.isMesh && scanMaterial) node.material = scanMaterial
    })
  }
  // Backdrop sleeve. The cut bore still carries a few torn patches in its
  // flanks, and the camera sees clean through them to nothing — a ragged
  // black rectangle sliding past every 20 m, which reads as a hole in the
  // world. This dark sleeve sits just outside the tile and turns any such
  // gap into shadowed masonry instead. It is OPEN-ENDED (a tube, not a
  // box) so it never caps the view down the bore, and it is a child of
  // the tile, so every clone in the chain carries one.
  {
    boreTile.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(boreTile)
    const size = bounds.getSize(new THREE.Vector3())
    const centre = bounds.getCenter(new THREE.Vector3())
    const radius = Math.hypot(size.x, size.y) / 2 + 1.2
    const sleeve = new THREE.Mesh(
      // exactly one period long, so consecutive sleeves butt end to end;
      // overlapping them would put two coincident shells in the same
      // place and they would z-fight into a flickering band every 20 m
      new THREE.CylinderGeometry(radius, radius, TUNNEL_PERIOD, 10, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x14110e,
        roughness: 0.97,
        metalness: 0,
        side: THREE.BackSide,
      }),
    )
    sleeve.quaternion.copy(boreTile.quaternion).invert() // keep it world-aligned
    sleeve.rotateX(Math.PI / 2) // cylinder runs along Y; lay it down the bore
    sleeve.position.copy(boreTile.worldToLocal(centre.clone()))
    boreTile.add(sleeve)
  }
  scene.add(boreTile)
  boreTile.updateMatrixWorld(true)
  // where the tile's own geometry starts, so the chain can be indexed off it
  const BORE_Z0 = new THREE.Box3().setFromObject(boreTile).min.z

  // SCENE 2: the blackout panels are OFF.
  //
  // They seal the scan's torn flanks at the approach zone — scene 1 lives
  // inside the bore, and certain orbit angles there showed jagged void
  // through the gaps. Scene 2's camera is out in the city for all but the
  // last second of the loop, and from out there the two panels are simply
  // 10 x 26 m black slabs standing either side of the tunnel mouth, edge-on
  // to the street. They were the black walls by the exit.
  //
  // Kept, not deleted: flip SEALS to true if an angle ever shows the void.
  const SEALS = false
  if (SEALS) {
    // These must take light. An UNLIT flat black panel keeps its colour
    // while the walls around it are lit by the ceiling fixtures, so it
    // reads as a rectangular hole punched in the tunnel rather than as
    // the dark far side of it.
    const sealMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a1613,
      roughness: 0.96,
      metalness: 0,
    })
    const eastSeal = new THREE.Mesh(new THREE.PlaneGeometry(26, 10), sealMaterial)
    eastSeal.position.set(-14.8, 4.2, 7.0) // local: world z 19..43, x ≈ +3.2
    tunnel.add(eastSeal)
    const westSeal = new THREE.Mesh(new THREE.PlaneGeometry(26, 10), sealMaterial)
    westSeal.position.set(-14.8, 4.2, 17.6) // local: world x ≈ -7.4
    westSeal.rotation.y = Math.PI
    tunnel.add(westSeal)
  }

  // Anisotropic filtering is what decides how a texture holds up when you
  // look ALONG it rather than at it — which is this whole scene: a road
  // and two walls running to the horizon. At 8 the surfaces smear into
  // mush a few metres out; the hardware maximum keeps the asphalt grain
  // and the brickwork readable into the distance. Applied to every root
  // once everything is loaded, via sharpenTextures() below.
  const maxAniso = renderer.getMaxAnisotropy?.() ?? 16
  const sharpenTextures = (root) =>
    root.traverse((node) => {
      if (!node.isMesh) return
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'emissiveMap', 'metalnessMap']) {
          if (material?.[slot]) material[slot].anisotropy = maxAniso
        }
      }
    })
  sharpenTextures(tunnel)

  // --- clearing the junction -------------------------------------------------
  //
  // The car drifts in the junction, and the junction came with a kerbed median
  // running straight through it — so the donut was being thrown over a 0.5 m
  // kerb with a grass strip on top of it.
  //
  // Six meshes, identified by the average colour of their own base maps: the
  // kerb sections all average #808175, the strip on top of them #51593a, which
  // is the grass. Object_225 was the bad one — it sat at z 5.1…10.1, right
  // inside the circle, in what the median's other two sections had made look
  // like a clean gap.
  //
  // They are hidden whole rather than cut to the drift box. A box cut leaves
  // the island's cross-section open — these are shells, so the cut end reads
  // as a hole — and a median that stops dead in mid-air looks worse than no
  // median at all. Hiding also stays reversible: nothing is destroyed.
  const JUNCTION_CLEARED = new Set([
    'Object_210', // kerb, z −22.4 … −0.4
    'Object_225', // kerb, z 5.1 … 10.1 — inside the drift circle
    'Object_227', // kerb, z 10.1 … 23.8
    'Object_887', // kerb edging, the full 42 m
    'Object_889', // the grass strip itself
    'Object_348', // a 24 cm stub dead centre of the donut
  ])

  // The median also carried a traffic signal, and that post is a COLUMN of
  // Object_481 — a mesh that holds other street furniture too, so it cannot
  // just be hidden. Its triangles inside this box are dropped instead. With
  // the median gone the post stood in bare road, in the middle of the drift.
  const POST_BOX = { x0: -1.3, x1: 1.3, z0: -2, z1: 6.5 }

  // ...and the scan left more furniture standing in the CARRIAGEWAY itself.
  // Found by walking every visible triangle, keeping the ones whose foot is
  // over drivable tarmac (Object_140 and not the Object_590 pavement), and
  // clustering what was left:
  //
  //   · two 6 m conifers growing out of the middle of the road, at (0.2, 21.4)
  //     on the tunnel approach and (0.1, −6.4) south of the junction — both
  //     dead centre of a 22.8 m wide boulevard
  //
  // What is NOT cut: the greenery reading as road-side at (5.8, 24.7) belongs
  // to Object_2, which is the TUNNEL SCAN — 387k triangles of embankment and
  // ivy above the graffiti walls. The road map calls that ground drivable
  // because the carriageway runs under it; cutting there would gouge a hole
  // in the tunnel mouth, not clear an obstruction.
  //   · three traffic-signal heads lying HORIZONTAL at 3.3 m over the
  //     centreline — 0.9 x 0.3 x 0.2 m slabs, which is a signal box on its
  //     side, and why they read as lying flat on the tarmac from above
  //
  // Each lives in a mesh that carries other copies elsewhere in the city, so
  // none can be hidden wholesale — the triangles in these columns go instead.
  const ROAD_CLEARED = [
    { names: ['Object_893', 'Object_895'], box: { x0: -2.0, x1: 2.2, z0: 19.4, z1: 24.2 } },
    { names: ['Object_893', 'Object_895'], box: { x0: -2.0, x1: 2.0, z0: -9.4, z1: -4.8 } },
    { names: ['Object_479'], box: { x0: -4.0, x1: 4.0, z0: -2.5, z1: 7.5 } },
    // The rest of the signal heads. POST_BOX is a narrow column — x −1.3…1.3 —
    // cut to take the median's post and nothing else; it left four heads on
    // their arms at 3.1–3.3 m, hanging over the middle of the junction at
    // (2.8, −1.4), (−2.1, −1.4), (2.1, 5.8) and (−2.8, 5.9). This widens the
    // column to the junction itself and takes the arms with them.
    { names: ['Object_481'], box: { x0: -3.6, x1: 3.6, z0: -2.4, z1: 6.6 } },
  ]
  const cutColumn = (mesh, box) => {
    const geo = mesh.geometry
    const pos = geo.attributes.position
    const index = geo.index
    if (!index) return 0
    const keep = []
    let dropped = 0
    const p = new THREE.Vector3()
    for (let t = 0; t < index.count; t += 3) {
      let cx = 0, cz = 0
      for (let k = 0; k < 3; k += 1) {
        p.fromBufferAttribute(pos, index.getX(t + k)).applyMatrix4(mesh.matrixWorld)
        cx += p.x / 3
        cz += p.z / 3
      }
      if (cx > box.x0 && cx < box.x1 && cz > box.z0 && cz < box.z1) {
        dropped += 1
        continue
      }
      keep.push(index.getX(t), index.getX(t + 1), index.getX(t + 2))
    }
    geo.setIndex(keep)
    return dropped
  }

  if (city) {
    scene.add(city)
    sharpenTextures(city)
    city.updateWorldMatrix(true, true)
    let cleared = 0
    city.traverse((node) => {
      if (node.isMesh && JUNCTION_CLEARED.has(node.name)) {
        node.visible = false
        cleared += 1
      }
      if (node.isMesh && node.name === 'Object_481') cutColumn(node, POST_BOX)
      if (node.isMesh) {
        for (const job of ROAD_CLEARED) {
          if (job.names.includes(node.name)) job.cut = (job.cut || 0) + cutColumn(node, job.box)
        }
      }
    })
    const missed = ROAD_CLEARED.filter((j) => !j.cut)
    if (missed.length) {
      // same contract as the median names: this export, or a warning
      console.warn(`[city] road: ${missed.length} of ${ROAD_CLEARED.length} obstruction cuts matched nothing`)
    }
    if (cleared !== JUNCTION_CLEARED.size) {
      // the names come from this exact export; if it is ever reissued they
      // may not, and the car would be back to drifting over a kerb
      console.warn(`[city] junction: cleared ${cleared} of ${JUNCTION_CLEARED.size} median meshes`)
    }
  }

  // --- the EV charger, outside the Coffee unit -------------------------------
  //
  // The city block has one coffee shop: the dark green corner unit in the base
  // of the round-cornered tower, its fascia running north-south at x ≈ -14.5
  // (the sign band is mesh Object_509, material 01_-_Default_33 — the only
  // texture in the scan with the word on it). The charger stands on the brick
  // paving in front of it.
  //
  // ANCHOR is where the charger's FOOT sits, in world metres. YAW turns it
  // about its own centre. HEIGHT is what the model is scaled to, measured off
  // its own bounds below — the source carries its own unit scale and a pair
  // of nested rotations, and none of that has to be known here.
  // Placed off the PARKED CAR, not off the pavement. The car stops at
  // (−15.97, 2.13) facing east, so its front-right wing — where a Taycan's
  // charge port is — sits at about (−14.07, 3.23). The charger stands just
  // beyond it on the pavement: the kerb is at z 3.41 and the cabinet is
  // 0.77 m deep, so z 3.9 puts its near face 0.08 m clear of the kerb and
  // about 0.25 m off the car's flank. Close enough to plug in.
  const CHARGER_ANCHOR = new THREE.Vector3(-14.1, 0, 3.9)
  // Which way it looks. The screen is the model's own +z face — the emissive
  // map has exactly one lit face and its normal points that way — so a yaw of
  // PI/2 turns the screen due east, square to the kerb beside it.
  //
  // PI faces it due SOUTH, which squares it to the car: the slot runs
  // east–west along the kerb the charger stands on, so a south-facing screen
  // puts the cabinet's wide face parallel to the car's flank and looking
  // straight at it, rather than cutting across the pavement at an angle.
  const CHARGER_YAW = Math.PI
  const CHARGER_HEIGHT = 1.8 // a real pedestal charger, kerb to top of screen
  const charger = chargerGltf?.scene ?? null
  if (charger) {
    // Measured, not assumed: the model is recentred on the anchor and stood on
    // it from its own bounds, so a different export drops in without new
    // magic numbers.
    const box = new THREE.Box3().setFromObject(charger)
    const size = box.getSize(new THREE.Vector3())
    const mid = box.getCenter(new THREE.Vector3())
    const scale = CHARGER_HEIGHT / size.y
    charger.scale.setScalar(scale)
    charger.position.set(-mid.x * scale, -box.min.y * scale, -mid.z * scale)
    // The rig carries the placement so the recentring above stays in the
    // model's own axes — rotating a pre-offset object swings it off the mark.
    const chargerRig = new THREE.Group()
    chargerRig.position.copy(CHARGER_ANCHOR)
    chargerRig.rotation.y = CHARGER_YAW
    chargerRig.add(charger)
    scene.add(chargerRig)
    // It arrives fully textured — base colour, metallic-roughness, normal and
    // a small emissive map for the screen and the status LEDs — so the only
    // thing left to do is give those maps the same anisotropy as everything
    // else. Nothing here paints it; an earlier model had no UVs at all and
    // needed its colour classified out of the geometry, which this one makes
    // pointless and would in fact overwrite.
    sharpenTextures(charger)
    window.__charger = chargerRig // live handle: nudge it from the console
  }

  // --- framing from the model bounds ---
  // Measured off city.glb, and kept as the fallback for a boot whose scenery
  // failed. When the city IS there, applyCityFraming below replaces both from
  // its own bounds — they set the fog, the orbit limits and the resting
  // overview's scale, and an estimate that is off by a factor puts the
  // horizon in the wrong place.
  const center = new THREE.Vector3(-6.8, 0, 374.4) // measured off city.glb
  let r = 512 // half the bounding box's space diagonal

  scene.fog = new THREE.FogExp2(BG, 1.35 / (r * 6))

  // ONE LIGHT over the city, and it is the moon.
  //
  // This used to be a three-point rig — a warm key at 2.2, a sky/ground
  // hemisphere at 1.1 and a teal rim at 0.5 — which is how you light a
  // STUDIO, not a street at night. Three sources from three directions in
  // three colours leave nothing for a shadow to mean: every surface catches
  // something from somewhere, so nothing reads as dark and the city comes
  // out lit rather than NIGHT-lit.
  //
  // A real night scene has one source high above it. So: a single
  // directional, placed high and raking (see applyCityFraming), in the brand
  // teal rather than moon-white — the whole city washed in the same colour as
  // the neon and the car lamps, which is the point. Faces turned away from it
  // now go genuinely dark, and the only thing filling them is the environment
  // map, which is a reflection, not a light.
  //
  // DIM, though. The instinct is to make the lone light brighter to cover for
  // the two it replaced, and 3.4 did that — and blew the pale brickwork out to
  // a flat pastel mint, which is a floodlit wall, not moonlight. A moon is
  // weak; the point of a neon scene is that the NEON is the bright thing and
  // the city is the dark it reads against. 1.6 keeps the teal legible on the
  // surfaces facing it and lets everything else fall away.
  const moon = new THREE.DirectionalLight(BRAND_TEAL, 1.6)
  scene.add(moon, moon.target)

  // Aim the establishing rig and size the fog to what the city actually
  // measures.
  function applyCityFraming() {
    if (city) {
      const box = new THREE.Box3().setFromObject(city)
      box.getCenter(center)
      r = box.getBoundingSphere(new THREE.Sphere()).radius
      scene.fog.density = 1.35 / (r * 6)
    }
    // high and off to one side: a moon, not a lamp on a stand
    moon.position.set(center.x + r * 0.8, center.y + r * 1.7, center.z + r * 0.4)
    moon.target.position.copy(center)
  }
  applyCityFraming()

  // The moon lights the city for the establishing views. Inside the bore it
  // has no business existing — a tunnel is lit by its own ceiling fixtures —
  // so scene 1 switches it off and runs on the tunnel lamps, the car's own
  // lamps and the underglow alone.
  const establishing = [moon].map((light) => ({ light, full: light.intensity }))
  const fullEnvIntensity = scene.environmentIntensity ?? 0
  const setEstablishingLights = (on) => {
    for (const e of establishing) e.light.intensity = on ? e.full : 0
  }

  // --- live reflection probe -------------------------------------------
  // Car paint is mostly a mirror, and what sells a tunnel run on the
  // bodywork is the ceiling lights sliding along it. A baked IBL cannot do
  // that: it is a fixed picture of somewhere else, so its highlights sit
  // welded to the wing no matter how fast the car goes. This renders the
  // bore the car is actually in into a cube map from the car's own
  // position, every frame, and hands that to the material system as the
  // environment — so the lamps sweep across the lacquer at exactly the
  // rate the car passes them, because they ARE the lamps it is passing.
  // The car is hidden for the six faces: a mirror of itself is nonsense,
  // and it is also the most expensive thing in the shot.

  const staticEnvironment = scene.environment
  // 128 is the sweet spot, measured: at 256 the six faces plus the prefilter
  // saturate the GPU again (4.2 ms of back-pressure against 0.3 ms here),
  // and the extra sharpness is lost to the prefilter anyway
  const reflectionProbe = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType })
  // a tight far plane: inside the bore nothing past a few tiles can be seen,
  // and every metre of it is six more faces of geometry to cull through
  const probeCamera = new THREE.CubeCamera(0.4, 45, reflectionProbe)
  let reflectionLive = false
  let probeFrame = 0
  const setLiveReflection = (on) => {
    reflectionLive = on
    scene.environment = on ? reflectionProbe.texture : staticEnvironment
    // The probe IS the bore, dark where the bore is dark, so it carries its
    // own exposure — but the ceiling lamps were tuned to a scene with NO
    // bounce at all, and now their light arrives twice: once direct, once
    // off the walls the probe just photographed. Half weight puts the paint
    // back where it was lit, not bleached.
    scene.environmentIntensity = on ? 0.55 : fullEnvIntensity
  }
  const updateReflection = () => {
    if (!reflectionLive) return
    // This is the most expensive thing in the frame by a wide margin:
    // measured at 3.3 ms of CPU submission for the six face renders and
    // another 3.4 ms to re-prefilter them, against 0.2 ms for everything
    // else put together. The prefilter's cost is in its pass COUNT, not its
    // resolution, so shrinking the cube buys nothing — but a reflection is
    // low-frequency data on a moving car, so refreshing it on alternate
    // frames hands half of that back for no visible change.
    probeFrame += 1
    if (probeFrame % quality.knobs().probeEvery !== 0) return
    probeCamera.position.set(taycan.position.x, taycan.position.y + 0.8, taycan.position.z)
    taycan.visible = false
    // inside the bore the city is six faces of scenery you cannot see out
    // to — dropping it there is most of the probe's cost
    const cityWasVisible = city?.visible
    if (scene1 && city) city.visible = false
    probeCamera.update(renderer, scene)
    if (city) city.visible = cityWasVisible
    taycan.visible = true
    reflectionProbe.texture.needsPMREMUpdate = true // re-prefilter this frame's bore
  }

  // Porsche Taycan at the far (south) mouth of the tunnel, centred on the
  // road, nose toward the city — starting its run through the bore. The
  // source model is ~5 cm long, so scale ×100 puts it at real size; the
  // body panels are repainted logo teal.
  const taycan = taycanGltf.scene
  taycan.scale.setScalar(100)
  taycan.position.set(-1.75, 0.06, 84)
  taycan.rotation.y = Math.PI
  taycan.traverse((node) => {
    // the 'swatch' mesh is nothing but the white PORSCHE / WEISSACH
    // lettering on the rear wing's endplates — hide it and the wing is
    // plain carbon, no other mesh shares the material
    if (node.isMesh && node.material?.name === 'porscheswatch') node.visible = false
    if (node.isMesh && node.material?.name === 'PaletteMaterial002') {
      const paint = node.material
      paint.map = null
      paint.color.setHex(0x2a9d8f) // the logo's exact teal (#2A9D8F)
      // Car paint is a coloured DIELECTRIC under a clear lacquer, not a
      // metal. At high metalness the colour only tints reflections and
      // the body reads near-black in a dark tunnel; keeping metalness
      // low lets the actual hue show, so the car matches the logo.
      paint.metalness = 0.12
      paint.roughness = 0.34
      if ('clearcoat' in paint) {
        paint.clearcoat = 1
        // real lacquer has a little orange peel, so highlights spread
        // slightly instead of printing as pin-sharp points
        paint.clearcoatRoughness = 0.12
      }
    }
  })

  // matte dark privacy glass — but ONLY the glasshouse. The model's
  // "Window" meshes also carry the head- and tail-lamp covers (measured:
  // headlight lenses at y 0.7–0.8 front, tail bar at y ≈ 0.9 rear, cabin
  // glass above y ≈ 0.95), so each triangle is sorted by height: faces
  // above the beltline get the tint, lamp lenses keep the original clear
  // glass and their glow. The tint is a fresh material — mutating the
  // transmissive original leaves a stale WebGPU pipeline — and renders
  // double-sided because the inner-glass faces point into the cabin.
  const windowTint = new THREE.MeshPhysicalMaterial({
    color: 0x06080a,
    roughness: 0.38,
    metalness: 0,
    specularIntensity: 0.25,
    envMapIntensity: 0.5,
    side: THREE.DoubleSide,
  })
  {
    taycan.updateMatrixWorld(true)
    const pa = new THREE.Vector3()
    const pb = new THREE.Vector3()
    const pc = new THREE.Vector3()
    taycan.traverse((node) => {
      if (!node.isMesh || !/window/i.test(node.name) || !node.geometry.index) return
      const posAttr = node.geometry.attributes.position
      const arr = node.geometry.index.array
      const glass = []
      const lamp = []
      for (let i = 0; i < arr.length; i += 3) {
        pa.fromBufferAttribute(posAttr, arr[i]).applyMatrix4(node.matrixWorld)
        pb.fromBufferAttribute(posAttr, arr[i + 1]).applyMatrix4(node.matrixWorld)
        pc.fromBufferAttribute(posAttr, arr[i + 2]).applyMatrix4(node.matrixWorld)
        const y = (pa.y + pb.y + pc.y) / 3 - taycan.position.y
        const z = Math.abs((pa.z + pb.z + pc.z) / 3 - taycan.position.z)
        const isGlass = y > 0.89 || (y > 0.79 && z < 1) // beltline; no lamp reaches amidships
        ;(isGlass ? glass : lamp).push(arr[i], arr[i + 1], arr[i + 2])
      }
      if (!glass.length) return // pure lamp lens — leave it untouched
      node.geometry.setIndex([...glass, ...lamp])
      node.geometry.clearGroups()
      node.geometry.addGroup(0, glass.length, 0)
      node.geometry.addGroup(glass.length, lamp.length, 1)
      node.material = [windowTint, node.material]
    })
  }
  sharpenTextures(taycan)
  scene.add(taycan)

  // realistic wheel spin: the model's wheel pivots are not at the hubs, so
  // each wheel mesh is re-parented onto a pivot group placed at its own
  // bounding-box centre (attach() preserves the world transform); spinning
  // the pivots rotates the wheels about their real axles. Brake calipers
  // are unsprung mass like the wheel: they get their own travel pivot so
  // they ride up and down WITH the wheel, but they never spin. Any mesh
  // spanning more than one wheel is left alone.
  const wheelPivots = []
  const caliperPivots = []
  {
    taycan.updateMatrixWorld(true)
    const wheelMeshes = []
    const caliperMeshes = []
    taycan.traverse((node) => {
      if (!node.isMesh) return
      const label = `${node.name} ${node.material?.name ?? ''}`
      if (/calliper|caliper/i.test(label)) caliperMeshes.push(node)
      else if (/wheel/i.test(label)) wheelMeshes.push(node)
    })
    const box = new THREE.Box3()
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    const makePivot = (mesh) => {
      box.setFromObject(mesh)
      box.getSize(size)
      if (size.z > 1.2 || size.y > 1.2) return null // spans several wheels — skip
      box.getCenter(center)
      const pivot = new THREE.Group()
      mesh.parent.add(pivot)
      pivot.position.copy(pivot.parent.worldToLocal(center.clone()))
      pivot.attach(mesh)
      return pivot
    }
    for (const mesh of wheelMeshes) {
      const pivot = makePivot(mesh)
      if (pivot) wheelPivots.push(pivot)
    }
    for (const mesh of caliperMeshes) {
      const pivot = makePivot(mesh)
      if (pivot) caliperPivots.push(pivot)
    }
  }

  // Visible wheel travel with EXACT ground contact. Road/wheel-space
  // analysis: at rest every wheel's meshes are measured — the group's
  // lowest vertex (bbox min) is the tyre's contact point, and its drop
  // below the wheel centre is the true rolling radius of THAT wheel,
  // taken from the real geometry rather than assumed. Each frame the
  // wheels are counter-moved against the sprung body so the contact
  // point sits exactly ON the asphalt plane — never inside it, never
  // hovering — while the body sags onto its springs in the arches above.
  // Co-located meshes (tyre, rim, brake disc, caliper) are grouped by
  // position and share one correction, so they can never separate.
  const wheelGroups = []
  {
    taycan.updateMatrixWorld(true)
    const wp = new THREE.Vector3()
    const wheelBox = new THREE.Box3()
    for (const pivot of [...wheelPivots, ...caliperPivots]) {
      pivot.getWorldPosition(wp)
      wheelBox.setFromObject(pivot)
      let group = wheelGroups.find((g) => Math.hypot(g.x - wp.x, g.z - wp.z) < 0.3)
      if (!group) {
        group = { x: wp.x, z: wp.z, members: [], bottomY: Infinity }
        wheelGroups.push(group)
      }
      group.bottomY = Math.min(group.bottomY, wheelBox.min.y)
      pivot.rotation.order = 'YXZ' // steer (Y) composes before spin (X)
      group.members.push({ pivot, centreY: wp.y })
    }
    const localWheel = new THREE.Vector3()
    for (const group of wheelGroups) {
      // reference member's centre → contact-point drop, fixed at capture
      group.centreToBottom = group.members[0].centreY - group.bottomY
      // the car's local +z is forward (that is where the headlights sit
      // and aim), so the front axle is the pair with positive local z
      localWheel.set(group.x, taycan.position.y, group.z)
      taycan.worldToLocal(localWheel)
      group.isFront = localWheel.z > 0

      // Give the corner a real upright. The knuckle sits on the wheel
      // centre and carries the whole unsprung assembly — wheel, disc and
      // calipers — so suspension travel and steering are ONE transform
      // they all share. Without it each part turned about its own centre,
      // which swung the caliper off the wheel as soon as it steered.
      const knuckle = new THREE.Group()
      taycan.add(knuckle)
      knuckle.position.copy(
        taycan.worldToLocal(
          localWheel.set(group.x, group.members[0].centreY, group.z),
        ),
      )
      for (const w of group.members) knuckle.attach(w.pivot)
      group.knuckle = knuckle
      group.rest = knuckle.position.clone()
    }

    // Whatever the name test missed. This model calls some of the corner
    // hardware polySurfaceN_phong1 — neither "wheel" nor "calliper" — so it
    // was never claimed by a corner and stayed welded to the BODY while the
    // wheel it belongs to steered and spun away from underneath it.
    //
    // Anything wheel-sized sitting within half a metre of a hub that nothing
    // else owns is adopted by that corner. Whether it then SPINS is decided
    // by geometry, not by its name: a disc is concentric with the axle, a
    // caliper is clamped to one side of it, so anything off-axis is bolted to
    // the upright and turns with the steering only.
    {
      const orphanBox = new THREE.Box3()
      const orphanMid = new THREE.Vector3()
      const claimed = new Set()
      for (const group of wheelGroups) {
        for (const member of group.members) member.pivot.traverse((n) => claimed.add(n))
      }
      const adopt = []
      taycan.traverse((node) => {
        if (!node.isMesh || claimed.has(node)) return
        orphanBox.setFromObject(node)
        const span = orphanBox.getSize(new THREE.Vector3())
        if (span.y < 0.25 || span.y > 1 || span.x > 1 || span.z > 1) return
        orphanBox.getCenter(orphanMid)
        let best = null
        let bestDist = 0.5
        for (const group of wheelGroups) {
          const d = Math.hypot(group.x - orphanMid.x, group.z - orphanMid.z)
          if (d < bestDist) {
            bestDist = d
            best = group
          }
        }
        if (best) adopt.push({ node, group: best, mid: orphanMid.clone(), offAxis: bestDist })
      })
      for (const item of adopt) {
        const pivot = new THREE.Group()
        item.node.parent.add(pivot)
        pivot.position.copy(pivot.parent.worldToLocal(item.mid.clone()))
        pivot.attach(item.node)
        pivot.rotation.order = 'YXZ'
        item.group.knuckle.attach(pivot)
        item.group.members.push({ pivot, centreY: item.mid.y })
        if (item.offAxis < 0.06) wheelPivots.push(pivot) // on the axle: it turns with the wheel
      }
    }
  }
  // true ride height, measured: how high the body origin sits above the
  // tyre contact plane when the suspension is at rest. Targeting the body
  // at roadY + rideHeight keeps the designer's wheel-arch gap — the body
  // never crushes down over the wheels
  const rideHeight = wheelGroups.length
    ? taycan.position.y - Math.min(...wheelGroups.map((g) => g.bottomY))
    : 0
  let contactShadow = null
  let groundFx = null
  const neonLights = []
  const NEON_INTENSITY = 2.4
  const wheelWorld = new THREE.Vector3()
  const wheelLift = new THREE.Vector3()
  const wheelBasis = new THREE.Matrix3()
  // roadYAt(x, z) gives the surface height under any point, so each wheel
  // is planted on ITS OWN patch of road rather than a shared average —
  // that per-corner difference is what the springs turn into body motion
  const settleWheels = (roadYAt) => {
    taycan.updateMatrixWorld(true)
    // one conversion for the whole car: the world-space lift expressed in
    // the body's own space, so travel stays true under pitch and roll
    wheelBasis.setFromMatrix4(taycan.matrixWorld).invert()
    for (const group of wheelGroups) {
      // measure from the knuckle's REST pose, never from where it sits
      // now — reading back its own output would let the springs drift
      wheelWorld.copy(group.rest).applyMatrix4(taycan.matrixWorld)
      const contactY = wheelWorld.y - group.centreToBottom // tyre's lowest point
      // lift/drop needed to kiss this wheel's own asphalt exactly
      let delta = roadYAt(wheelWorld.x, wheelWorld.z) - contactY
      delta = Math.max(-0.08, Math.min(0.1, delta)) // droop / compression travel limits
      // moving the upright carries wheel, disc and calipers as one piece
      wheelLift.set(0, delta, 0).applyMatrix3(wheelBasis)
      group.knuckle.position.copy(group.rest).add(wheelLift)
    }
    // the ground rig (shadow + neon pool + tubes) rides ON the road plane
    // under the car — it follows position and heading but NEVER tilts
    // with the sprung body, so the pool cannot dip under the asphalt
    if (groundFx) {
      groundFx.position.set(
        taycan.position.x,
        roadYAt(taycan.position.x, taycan.position.z),
        taycan.position.z,
      )
      groundFx.rotation.y = taycan.rotation.y
    }
  }
  // the front uprights turn about the steering axis through the wheel
  // centre, carrying wheel, disc and calipers together — turning each
  // part about its own centre instead would swing the caliper off the
  // wheel. The wheel still spins inside the upright.
  const steerWheels = (angle) => {
    for (const group of wheelGroups) {
      if (group.isFront) group.knuckle.rotation.y = angle
    }
  }
  const restWheels = () => {
    for (const group of wheelGroups) {
      group.knuckle.position.copy(group.rest)
      group.knuckle.rotation.y = 0
    }
  }
  // Loaded rolling radius: 36 cm. The free radius measured off the model is
  // 37.5 cm (TYRE_RADIUS, used by the blur) — a loaded tyre rolls on a
  // slightly smaller circle than it stands on, so rolling distance uses this
  // one and the visual sweep uses that one.
  const ROLLING_RADIUS = 0.36
  // The largest angle a wheel may visibly advance in one frame.
  //
  // Rolling without slip at 300 km/h is 231 rad/s — 3.86 rad, or 221°, per
  // 60 Hz frame. A wheel is rotationally symmetric about its spoke pitch, so
  // what the eye actually sees is that step MODULO the pitch: for a 5-spoke
  // face (72°) it is 5° a frame, and the wheel appears to crawl while the car
  // does 300. That is the wagon-wheel effect, and it is the single thing that
  // makes a fast car read as fake. No frame rate fixes it — at these speeds
  // the true step is always past the Nyquist limit of half a spoke pitch.
  //
  // So the rendered step is clamped below that limit and the rotational blur
  // (measureWheels) carries the speed instead — which is what racing games
  // do. 0.25 rad is 14.3°, under half the 36° pitch of even a 10-spoke face,
  // so the wheel always reads as turning FORWARD, hard. Below about 100 km/h
  // the true rate is under the clamp and the spin stays physically exact.
  const MAX_SPIN_STEP = 0.25
  const spinWheels = (speed, dt) => {
    const spin = (speed / ROLLING_RADIUS) * dt
    const step = Math.sign(spin) * Math.min(Math.abs(spin), MAX_SPIN_STEP)
    for (const pivot of wheelPivots) pivot.rotation.x += step
  }

  // working lamps: spots thrown down the road in the logo teal so the
  // headlights match the underglow, a red wash off the back, and lamp
  // glass that actually glows those colours.
  // NB: these hang off the car, which carries a ×100 scale — offsets must
  // be given in MODEL units or the lamps end up hundreds of metres ahead
  // of the bonnet, throwing their light into empty space.
  const CAR_SCALE = 100
  // The logo's teal (#2A9D8F) with its value pushed to the top of the
  // range: same hue, but bright enough to read as a lit lamp rather than
  // as painted plastic. Every light in the bore that is meant to be "the
  // brand colour" uses this one — car lamps and ceiling fixtures alike.
  const TAILLAMP_RED = 0xff1524
  for (const side of [-0.72, 0.72]) {
    // Main beam. The emitter is at the LAMP — 2.45 m forward, 0.72 m out,
    // 0.61 m up — which was already right. What was wrong is where it
    // AIMED: 38 m out and only 0.23 m below the lamp, a 22° cone. Geometry
    // does the rest: a beam that shallow does not reach the tarmac until
    // roughly 25 m ahead, so the road between the bumper and there stayed
    // dark and the pool read as a patch of light floating out in front of
    // the car rather than as the car's own headlights.
    //
    // Aimed DOWN and CLOSE instead — 13 m ahead and below road level — and
    // opened up, so the lit road starts at the bumper and runs away from
    // it. Physical falloff (decay 2) keeps it bright near the car and dying
    // with distance rather than glowing flatly to the horizon.
    // 430, not 700. The old figure was set when the pool landed 25 m out,
    // where inverse-square had already eaten most of it; now that the beam
    // lands at 7 m the same number blows the tarmac to white right in front
    // of the bumper, and the flare below seizes on it.
    const beam = new THREE.SpotLight(BRAND_TEAL, 430, 70, 0.55, 0.75, 2)
    beam.position.set(side / CAR_SCALE, 0.62 / CAR_SCALE, 2.45 / CAR_SCALE)
    beam.target.position.set((side * 1.25) / CAR_SCALE, -0.75 / CAR_SCALE, 13 / CAR_SCALE)
    taycan.add(beam)
    taycan.add(beam.target)
  }
  // NB: no tail light is mounted on the car. A point light sitting at the
  // tail has no shadows, so it floods its own rear wheel and speckles the
  // bodywork red. The tail lamps themselves are the glowing red lens
  // (emissive, below) and the road behind is washed by lights carried in
  // the ground rig, well clear of the car.

  // Head and tail lamp glass is ONE mesh on ONE material, so tinting it
  // whole would make the tail teal as well. Split it the same way as the
  // windows — by which half of the car each triangle sits in — and give
  // each half its own emissive: teal up front, red at the back. The
  // lamp texture still drives the shape, the emissive drives the colour.
  {
    taycan.updateMatrixWorld(true)
    const pa = new THREE.Vector3()
    const pb = new THREE.Vector3()
    const pc = new THREE.Vector3()
    taycan.traverse((node) => {
      const src = node.isMesh ? node.material : null
      if (!src || !/light/i.test(src.name ?? '') || !src.map || !node.geometry.index) return
      // headlamps burn brighter than the tail so they punch through the
      // tunnel's own fixtures and bloom into a proper glare
      const lampMaterial = (hex, intensity) => {
        const m = src.clone()
        m.emissive = new THREE.Color(hex)
        m.emissiveMap = src.map
        m.emissiveIntensity = intensity
        m.needsUpdate = true
        return m
      }
      const posAttr = node.geometry.attributes.position
      const arr = node.geometry.index.array
      const front = []
      const rear = []
      for (let i = 0; i < arr.length; i += 3) {
        pa.fromBufferAttribute(posAttr, arr[i]).applyMatrix4(node.matrixWorld)
        pb.fromBufferAttribute(posAttr, arr[i + 1]).applyMatrix4(node.matrixWorld)
        pc.fromBufferAttribute(posAttr, arr[i + 2]).applyMatrix4(node.matrixWorld)
        pa.add(pb).add(pc).multiplyScalar(1 / 3)
        taycan.worldToLocal(pa)
        ;(pa.z > 0 ? front : rear).push(arr[i], arr[i + 1], arr[i + 2])
      }
      node.geometry.setIndex([...front, ...rear])
      node.geometry.clearGroups()
      node.geometry.addGroup(0, front.length, 0)
      node.geometry.addGroup(front.length, rear.length, 1)
      node.material = [lampMaterial(BRAND_TEAL, 6.5), lampMaterial(TAILLAMP_RED, 8)]
    })
  }

  // Ground FX rig: contact shadow + NFS-style neon underglow in the logo
  // teal. The rig is a scene-level group placed flat ON the road surface
  // every frame — decoupled from the sprung body so nothing can dip into
  // the asphalt. The glow is done the way the racing games do it: NO
  // textured quad on the road (a quad's boundary always reads as a hard
  // line across the asphalt) — just real point lights, two rails of
  // three tubes along the sills, whose inverse-square falloff paints one
  // smooth seamless teal pool that shapes itself to the road.
  {
    groundFx = new THREE.Group()
    scene.add(groundFx)

    const size = 128
    const shadowCanvas = document.createElement('canvas')
    shadowCanvas.width = shadowCanvas.height = size
    const sctx = shadowCanvas.getContext('2d')
    const sgrad = sctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size / 2)
    sgrad.addColorStop(0, 'rgba(0,0,0,0.85)')
    sgrad.addColorStop(0.55, 'rgba(0,0,0,0.5)')
    sgrad.addColorStop(1, 'rgba(0,0,0,0)')
    sctx.fillStyle = sgrad
    sctx.fillRect(0, 0, size, size)
    contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 5.7),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(shadowCanvas),
        transparent: true,
        depthWrite: false,
        opacity: 0.6,
      }),
    )
    contactShadow.rotation.x = -Math.PI / 2
    contactShadow.position.y = 0.004
    contactShadow.renderOrder = 1
    groundFx.add(contactShadow)

    // TWO LINES, not ten lamps.
    //
    // This used to be two rails of five point lights, spaced 65 cm apart and
    // relied on to overlap into one pool. They do not: a point light's falloff
    // is sharpest directly beneath it, so each one prints its own hotspot and
    // the sill reads as a row of teal dots rather than a strip. Spacing them
    // closer only buys more dots.
    //
    // A real underglow is a TUBE, so this is one: a visible emissive bar down
    // each sill, and one continuous soft pool on the tarmac under each. The
    // pool is a texture rather than more lights, and the reason the original
    // avoided a quad — that its boundary reads as a hard line on the asphalt —
    // is handled by the texture going fully transparent well inside its own
    // edge. There is no rectangle to see, only the light it carries.
    const NEON_TEAL = 0x2fd6c0

    // the bar itself: what the eye reads as the neon, and what the bloom takes
    const tubeMat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(NEON_TEAL).multiplyScalar(2.2),
      toneMapped: false,
    })
    for (const dx of [-0.86, 0.86]) {
      // 2.0 m, not 3.2. The strip belongs on the ROCKER, between the wheel
      // openings. This car's arches clear z −1.03 … +0.97 (axles at ∓1.42/1.48
      // with a 0.36 tyre), so a 3.2 m bar ran straight into both of them and
      // lit the insides of the arches instead of the sill.
      const tube = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 2.0), tubeMat)
      // OUTBOARD, at the rocker line, not tucked under the floor. At ±0.68 the
      // bar sat inboard of the sill and the bodywork hid it from every angle
      // that matters — you only ever saw what leaked past the wheels. 14 cm up
      // clears the road and still reads from a low camera.
      //
      // It rides the ground rig rather than the sprung body, so it can never
      // dip through the asphalt on compression.
      tube.position.set(dx, 0.14, 0)
      tube.renderOrder = 2
      groundFx.add(tube)
    }

    // ...and the light it lays on the road. Bright down the centreline,
    // faded to nothing at both edges and both ends, so there is no boundary.
    const poolTex = (() => {
      const W = 64, L = 256
      const cv = document.createElement('canvas')
      cv.width = W
      cv.height = L
      const g2 = cv.getContext('2d')
      const img = g2.createImageData(W, L)
      for (let y = 0; y < L; y += 1) {
        // along the car: flat through the middle, eased off at the ends
        const v = y / (L - 1)
        const along = Math.min(1, Math.min(v, 1 - v) / 0.28)
        const ends = along * along * (3 - 2 * along)
        for (let x = 0; x < W; x += 1) {
          // across: a gaussian, so the strip has no side to catch the eye
          const u = (x / (W - 1) - 0.5) * 2
          const across = Math.exp(-u * u * 4.5)
          const a = Math.max(0, Math.min(1, across * ends))
          const i = (y * W + x) * 4
          img.data[i] = 255
          img.data[i + 1] = 255
          img.data[i + 2] = 255
          img.data[i + 3] = Math.round(a * 255)
        }
      }
      g2.putImageData(img, 0, 0)
      const t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.SRGBColorSpace
      return t
    })()
    for (const dx of [-0.52, 0.52]) {
      const pool = new THREE.Mesh(
        // 2.4 m across, not 1.15: the light has to reach OUT past the sill on
        // to open tarmac. Narrower than the car it is simply hidden underneath
        // it and the effect is invisible from the side.
        //
        // 2.8 m along, and no more — a shade longer than the bar so the pool
        // fades out before the wheels rather than under them. Its own ends
        // taper over the outer 28%, so the lit part stops around z ±0.95.
        new THREE.PlaneGeometry(2.4, 2.8),
        new THREE.MeshBasicMaterial({
          map: poolTex,
          color: new THREE.Color(NEON_TEAL),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      )
      pool.rotation.x = -Math.PI / 2
      pool.position.set(dx, 0.006, 0)
      pool.renderOrder = 2
      groundFx.add(pool)
    }

    // NO point lights under the car at all. Keeping even two put them beside
    // the wheels, where their falloff is sharpest, and they printed exactly
    // the hotspots this rewrite exists to remove. The strip and its pool carry
    // the whole effect — which is how the racing games do it too: underglow is
    // an emissive bar and a light decal, not a lamp.
    void NEON_INTENSITY

    // THE TAIL. One bar and one wash, for the same reason as the sills.
    //
    // This was two red point lights sitting behind the bumper, and two point
    // lights print two dots — which is what they looked like. The car wears a
    // FULL-WIDTH light bar, so the thing on the road behind it is one wide
    // band, not a pair of spots.
    // No emissive bar here: the car already HAS one — the tail lamp glass is
    // emissive red (see the lamp material split above) and that is the light
    // bar. Adding a second one hung a solid orange stick across the rear wing.
    // What was missing is only its wash on the tarmac. Same texture as the sills — bright down
    // the middle, gone before its own edge — turned across the car so the
    // band runs side to side and fades out behind.
    const tailWash = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 2.6),
      new THREE.MeshBasicMaterial({
        map: poolTex,
        color: new THREE.Color(TAILLAMP_RED),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        opacity: 0.3,
      }),
    )
    tailWash.rotation.x = -Math.PI / 2
    tailWash.rotation.z = Math.PI / 2 // the texture's long axis runs ACROSS here
    tailWash.position.set(0, 0.005, -3.3)
    tailWash.renderOrder = 2
    groundFx.add(tailWash)
  }

  // cinematic tunnel lighting for scene 1: visible ceiling fixtures that
  // streak past in rhythm, each backed by a soft warm pool of light — the
  // classic movie "passing under the lights" cadence, easy on the eyes
  const tunnelLighting = new THREE.Group()
  tunnelLighting.visible = false
  scene.add(tunnelLighting)
  // Neon yellow tubes, the opposite end of the wheel from the car's teal
  // so the two colours separate instead of washing into each other.
  // The tube and the light it CASTS are deliberately different: a fully
  // saturated yellow carries no blue at all, and the teal paint carries
  // no red, so lighting the car with pure yellow leaves only green and
  // the Taycan reads flat lime. The cast light therefore keeps some blue
  // (the bore still reads yellow — it is the only light in here), while
  // the tube itself burns acid neon and takes the bloom and the streaks
  // with it.
  const TUNNEL_NEON = 0xffe63c // the tube: full neon yellow
  const TUNNEL_FILL = 0xfff3c0 // what it throws: yellow, blue left in
  const tunnelLamps = []
  for (let i = 0; i < 8; i += 1) {
    const lamp = new THREE.PointLight(TUNNEL_FILL, 310, 22, 2)
    tunnelLighting.add(lamp)
    tunnelLamps.push(lamp)
  }
  // The visible bar, pushed past 1 in linear space so it clears the bloom
  // threshold and glares like a tube instead of sitting there as a flat
  // yellow box.
  const fixtureMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(TUNNEL_NEON).multiplyScalar(1.6),
  })
  const fixtureGeometry = new THREE.BoxGeometry(0.16, 0.06, 1.9)
  const tunnelFixtures = []
  for (let i = 0; i < 14; i += 1) {
    const fixture = new THREE.Mesh(fixtureGeometry, fixtureMaterial)
    tunnelLighting.add(fixture)
    tunnelFixtures.push(fixture)
  }

  const raycaster = new THREE.Raycaster()
  const down = new THREE.Vector3(0, -1, 0)

  // --- the city's road, painted over the scanned tunnel street so the
  // same asphalt runs from the junction straight through the bore ---
  const CRUISE = 300 / 3.6 // the scene runs at a locked 300 km/h, in u/s
  const TOP_SPEED = 305 / 3.6 // reference top end the aero terms scale against

  // The bore road is literally the city's asphalt: we look up the street
  // material in the loaded city model and reuse its texture and its
  // surface response, so the two read as one continuous road across the
  // junction. CITY_ROAD_TILE is that texture's measured footprint (it
  // repeats every 2.542 u), and the strip's UVs are laid out in world
  // units so the grain matches the city side exactly — no stretching.
  const CITY_ROAD_MAT = '01_-_Default_13'
  const CITY_ROAD_TILE = 2.542
  // From road.glb, not from the city: that file exists precisely so the hero
  // does not wait on 4.2 MB of scenery to find one asphalt material.
  let cityRoad = null
  roadGltf.scene.traverse((node) => {
    if (node.isMesh && node.material?.name === CITY_ROAD_MAT && !cityRoad) cityRoad = node.material
  })
  const roadMaterial = new THREE.MeshStandardMaterial({
    // fall back to a plain dark asphalt if the city ever stops shipping
    // that material, rather than rendering an untextured white slab
    map: cityRoad?.map ?? null,
    color: cityRoad ? 0xffffff : 0x2c2c2c,
    transparent: true,
    vertexColors: true, // carries the edge fade in vertex alpha
    roughness: cityRoad?.roughness ?? 0.84,
    metalness: cityRoad?.metalness ?? 0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const centreLineMaterial = new THREE.MeshStandardMaterial({
    map: makeCentreLineTexture(),
    transparent: true,
    roughness: roadMaterial.roughness,
    metalness: 0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4, // sits over the asphalt it is painted on
    polygonOffsetUnits: -4,
  })

  // Top-grade RACE asphalt: a circuit surface is laid to a few
  // millimetres of tolerance, so the profile is nearly a plane — just
  // enough life to stop the car reading as bolted to a table. This
  // profile IS the suspension's input: the wheels follow it and the
  // body answers through the springs (~4 mm all in).
  // Every wavelength divides one TUNNEL_PERIOD, so the profile is exactly
  // periodic and the tiled copies meet with no step at the seams.
  const ROAD_LEVEL = -0.14
  const ROAD_W = (2 * Math.PI) / TUNNEL_PERIOD
  const roadProfile = (x, z) =>
    ROAD_LEVEL +
    // Keep these two tiny. At 1.2 Hz the first lands right on the body's
    // own frequency, so whatever amplitude it has gets AMPLIFIED into
    // body heave — it is the wave you feel as the car bouncing.
    Math.sin(z * ROAD_W) * 0.001 + // long settlement wave (~1.2 Hz at speed)
    Math.sin(z * ROAD_W * 2 + 1.7) * 0.001 + // shorter undulation
    // The wheels' working band, held to race-surface millimetres: the
    // wheels and their uprights (disc + calipers) tremble with the
    // texture of the tarmac, and nothing ever pumps.
    Math.sin(z * ROAD_W * 3 + 0.6) * 0.0015 + // rolling swells (~3.5 Hz)
    Math.sin(z * ROAD_W * 5 + 2.1) * 0.001 + // patch-to-patch steps (~5.8 Hz)
    // gentle circuit camber drifting along the bore — left and right
    // wheels sit a touch apart, the body leans a hair, nothing rocks
    Math.sin(z * ROAD_W * 2 + 0.9) * x * 0.002

  // strip along x ({x0, x1, z}) or along z ({z0, z1, x}), plus width
  const buildRoadGeometry = (opts) => {
    const alongX = opts.z0 === undefined
    const a0 = alongX ? opts.x0 : opts.z0
    const a1 = alongX ? opts.x1 : opts.z1
    const cc = alongX ? opts.z : opts.x
    const rw = opts.width
    const lift = opts.lift ?? 0
    // dense enough to carry the profile smoothly (~0.6 u between stations);
    // 12 rows across let the edge fade roll off inside 8% of the width
    const nx = 120
    const nz = opts.fadeEdges ? 12 : 2
    const positions = []
    const uvs = []
    const colors = []
    const indices = []
    for (let iz = 0; iz <= nz; iz += 1) {
      for (let ix = 0; ix <= nx; ix += 1) {
        const a = a0 + ((a1 - a0) * ix) / nx
        const v = iz / nz
        const cross = cc - rw / 2 + rw * v
        const px = alongX ? a : cross
        const pz = alongX ? cross : a
        positions.push(px, roadProfile(px, pz) + lift, pz)
        // world-unit UVs keep the borrowed asphalt at the city's own
        // grain; the painted line wants the plain along/across layout
        if (opts.uvTile) uvs.push(px / opts.uvTile, pz / opts.uvTile)
        else uvs.push((a - a0) / 8, v)
        // edge fade lives in vertex alpha, so the colour map stays free
        // to be the city's tiling texture
        const alpha = opts.fadeEdges ? Math.min(1, Math.min(v, 1 - v) / 0.09) : 1
        colors.push(1, 1, 1, alpha)
      }
    }
    for (let iz = 0; iz < nz; iz += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const a = iz * (nx + 1) + ix
        const b = a + 1
        const c = a + nx + 1
        indices.push(a, c, b, b, c, c + 1)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    return geometry
  }

  let tunnelRoad = null
  const rebuildRoad = (opts) => {
    city?.updateMatrixWorld(true)
    tunnel.updateMatrixWorld(true)
    if (tunnelRoad) {
      scene.remove(tunnelRoad)
      tunnelRoad.traverse((n) => n.geometry?.dispose())
    }
    tunnelRoad = new THREE.Mesh(
      buildRoadGeometry({ ...opts, uvTile: CITY_ROAD_TILE, fadeEdges: true }),
      roadMaterial,
    )
    // the painted line is a child, so every infinity clone carries it and
    // it can never drift out of register with its own asphalt
    const alongX = opts.z0 === undefined
    tunnelRoad.add(
      new THREE.Mesh(
        buildRoadGeometry({
          ...opts,
          width: 0.9,
          lift: 0.001,
          ...(alongX ? { z: opts.z } : { x: opts.x }),
        }),
        centreLineMaterial,
      ),
    )
    scene.add(tunnelRoad)
  }
  // the roadway under the scan, for the establishing views and drive mode:
  // the full length of the bore the scan actually covers. The infinity run
  // stands on its own one-period strip instead (boreRoad, below)
  rebuildRoad({ z0: 26, z1: 97.5, x: -1, width: 11 })

  // The chain carries its own strip, exactly one period long so copies butt
  // with no unpainted gap. The long strip above is what the establishing
  // views and drive mode stand on, and it is hidden while the chain is up.
  const boreRoadSpan = { z0: BORE_Z0, z1: BORE_Z0 + TUNNEL_PERIOD, x: -1 }
  const boreRoad = new THREE.Mesh(
    buildRoadGeometry({ ...boreRoadSpan, width: 11, uvTile: CITY_ROAD_TILE, fadeEdges: true }),
    roadMaterial,
  )
  boreRoad.add(
    new THREE.Mesh(
      buildRoadGeometry({ ...boreRoadSpan, width: 0.9, lift: 0.001 }),
      centreLineMaterial,
    ),
  )
  boreRoad.visible = false

  // park the ground FX on whatever surface is actually visible under the
  // resting car (the scan pavement sits higher than the painted strip at
  // the parked spot), and reset the neon to its idle glow
  const parkGroundFx = () => {
    raycaster.set(
      new THREE.Vector3(taycan.position.x, taycan.position.y + 3, taycan.position.z),
      down,
    )
    const hit = raycaster.intersectObjects([city, tunnel, tunnelRoad].filter(Boolean), true)[0]
    groundFx.position.set(
      taycan.position.x,
      hit ? hit.point.y : taycan.position.y,
      taycan.position.z,
    )
    groundFx.rotation.y = taycan.rotation.y
    for (const neon of neonLights) neon.intensity = NEON_INTENSITY
  }
  parkGroundFx()

  // --- cameras: the published demo views, plus a resting overview ---
  const presets = {}
  // how far below the subject the orbit may drop. The city views are capped
  // just past level so nobody can swing under the pavement; the car shots
  // are deliberately BELOW the car and would be shoved back up to eye level
  // by that cap, which is the whole shot gone.
  const CITY_POLAR = Math.PI * 0.52
  const CAR_POLAR = Math.PI * 0.56
  DEMO_VIEWS.forEach((view, index) => {
    presets[`v${index + 1}`] = {
      eye: zUp(view.eye),
      target: zUp(view.target),
      fov: 50,
      polar: CITY_POLAR,
    }
  })
  CAR_VIEWS.forEach((view) => {
    presets[view.id] = {
      eye: new THREE.Vector3(...view.eye),
      target: new THREE.Vector3(...view.target),
      fov: view.fov,
      polar: CAR_POLAR,
    }
  })

  // resting overview, shifted so the city sits right of the hero copy
  const up = new THREE.Vector3(0, 1, 0)
  const startEye = new THREE.Vector3()
  const startTarget = new THREE.Vector3()
  // Recomputed when the city lands with its real bounds — this is the pose
  // endScene1 flies back to, so it has to follow the city, not the estimate.
  const refreshOverview = () => {
    startEye.copy(center).add(new THREE.Vector3(r * 0.85, r * 0.52, r * 0.85))
    startTarget.copy(center)
    const startDir = startTarget.clone().sub(startEye).normalize()
    const startOffset = new THREE.Vector3().crossVectors(startDir, up).normalize().multiplyScalar(-0.14 * r)
    startEye.add(startOffset)
    startTarget.add(startOffset)
  }
  refreshOverview()

  camera.position.copy(startEye)

  const controls = new OrbitControls(camera, canvas)
  controls.target.copy(startTarget)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.enableZoom = false // plain wheel scrolls the page; zoom is pinch / ctrl+scroll below
  controls.enablePan = false
  controls.minDistance = r * 0.02
  controls.maxDistance = r * 2.6
  controls.maxPolarAngle = Math.PI * 0.52 // the demo views look slightly upward
  // SCENE 2 (3/3): the resting orbit never spins by itself. The city is here
  // to be looked at, and a slow drift under a viewer who is trying to hold a
  // view is the thing this scene exists to not do.
  controls.autoRotate = false
  controls.autoRotateSpeed = 0.45
  controls.update()

  let resumeTimer = 0
  const stopAuto = () => {
    controls.autoRotate = false
    clearTimeout(resumeTimer)
  }
  // Kept as a no-op rather than deleted: the OrbitControls 'end' event, the
  // key handlers and flyTo all call it, and a scene that never auto-rotates
  // simply has nothing to resume.
  const scheduleAuto = () => {
    clearTimeout(resumeTimer)
  }
  controls.addEventListener('start', stopAuto)
  controls.addEventListener('end', scheduleAuto)

  // --- free navigation: WASD flight, pinch/ctrl+scroll zoom, click to hop views ---
  let activeView = null
  const cityInteractive = () => scrollFade > 0.05 && canvas.clientWidth > 0

  const pressed = new Set()
  let shiftHeld = false
  const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD'])
  window.addEventListener('keydown', (event) => {
    shiftHeld = event.shiftKey
    if (!FLY_KEYS.has(event.code)) return
    const tag = event.target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (!cityInteractive()) return
    if (!pressed.has(event.code)) {
      pressed.add(event.code)
      stopAuto()
      gsap.killTweensOf(camera.position)
      gsap.killTweensOf(controls.target)
    }
  })
  window.addEventListener('keyup', (event) => {
    shiftHeld = event.shiftKey
    if (pressed.delete(event.code) && pressed.size === 0) scheduleAuto()
  })
  window.addEventListener('blur', () => pressed.clear())

  // --- drive mode: GTA-style arcade car, E to get in/out, WASD to drive ---
  const drive = {
    on: false,
    speed: 0,
    heading: Math.PI,
    boost: 0, // turbo: 0 = off, 1 = on the bottle
    // suspension state: heave/pitch/roll positions and velocities
    sy: 0.06,
    svy: 0,
    sp: 0,
    svp: 0,
    sr: 0,
    svr: 0,
  }
  const carForward = new THREE.Vector3()
  const camDesired = new THREE.Vector3()
  const camLook = new THREE.Vector3()
  const groundRay = new THREE.Raycaster()
  groundRay.far = 10
  const blockRay = new THREE.Raycaster()
  blockRay.far = 6

  const setDrive = (on) => {
    if (drive.on === on) return
    drive.on = on
    controls.enabled = !on
    if (on) {
      stopShow() // the viewer has the car now
      stopAuto()
      drive.heading = taycan.rotation.y
      drive.speed = 0
      drive.sy = taycan.position.y
      drive.svy = drive.sp = drive.svp = drive.sr = drive.svr = 0
      drive.prevSpeed = 0
      gsap.killTweensOf(camera.position)
      gsap.killTweensOf(controls.target)
      setLiveReflection(true)
    } else {
      restWheels()
      startShow()
      setLiveReflection(false)
      drive.boost = 0
      setSpeedFx(null, 0, null)
      camera.fov = 50
      camera.updateProjectionMatrix()
      controls.target.copy(taycan.position)
      controls.target.y += 1
      scheduleAuto()
    }
  }
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyE') return
    const tag = event.target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (!cityInteractive()) return
    setDrive(!drive.on)
  })

  // --- speed FX bus: the one place the scene, drive mode and the post
  // chain agree on how hard the picture is being torn. `motion` is the
  // camera's own travel over one exposure, in view space — the streak is
  // derived from it per pixel, so the world rips past along the direction
  // of travel (front to back of the car) and tightens with distance, rather
  // than radiating out of the middle of the frame. `boost` (0-1) is the
  // nitrous grade. `samples` is a uniform too, so at cruise the blur loop
  // does not run at all.
  const fx = {
    motion: uniform(new THREE.Vector3()),
    focal: uniform(new THREE.Vector2(1, 1)),
    cap: uniform(1000), // arcade reach: nothing streaks as if further than this

    boost: uniform(0),
    centre: uniform(new THREE.Vector2(0.5, 0.5)),
    samples: uniform(0, 'int'),
    // the car as an oriented box in view space — the subject mask
    body: {
      centre: uniform(new THREE.Vector3(0, 0, -1000)),
      right: uniform(new THREE.Vector3(1, 0, 0)),
      up: uniform(new THREE.Vector3(0, 1, 0)),
      forward: uniform(new THREE.Vector3(0, 0, 1)),
      half: uniform(new THREE.Vector3(1, 0.7, 2.5)),
    },
    // and the four wheels inside it, the one part of the car that is NOT
    // still relative to the camera: each axle's centre in VIEW space, the
    // shared axle direction, the tyre's radius and half-width, and the
    // turn it makes during one exposure
    wheels: [0, 1, 2, 3].map(() => uniform(new THREE.Vector4(0, 0, 1000, 0))),
    wheelAxis: uniform(new THREE.Vector3(1, 0, 0)),
    // measured off the model: the wheel+caliper assembly is 0.75 across in
    // both y and z (so R = 0.375) and 0.29 wide (half-width 0.145). The
    // window has to clear the whole wheel — cut it close to the half-width
    // and the dished part of the rim gets swept while its outer lip does
    // not, which reads as a swirl sitting in the middle of the wheel
    // instead of the wheel turning.
    // Radius must sit UNDER the real tyre radius (0.375 m). The axle is
    // exactly one radius above the road — the wheel rides on it, always —
    // so a test radius of 0.4 reached past the contact patch and swept a
    // 0.28 x 0.52 m rectangle of tarmac under each wheel: it got the
    // rotational blur AND lost its place in the sharp-subject mask, which
    // is the square that appeared under each wheel. 0.35 leaves 2.5 cm of
    // clearance. The cost is the outer 2.5 cm of tread, which should not
    // smear anyway: a spinning tyre's silhouette does not move.
    wheelSize: uniform(new THREE.Vector2(0.35, 0.26)),
    spin: uniform(new THREE.Vector4(1, 0, 1, 0)), // cos/sin of the sweep, then half
    // ...and the rear pair's own, which is bigger whenever they are lit up
    spinRear: uniform(new THREE.Vector4(1, 0, 1, 0))
  }
  const fxNdc = new THREE.Vector3()
  const fxPoint = new THREE.Vector3()
  const fxTravel = new THREE.Vector3()
  const subjectNdc = new THREE.Vector3() // the framing guard's scratch
  // A rolling tyre's contact patch is stationary and its rim moves at twice
  // the car's speed; the rim itself travels exactly the car's speed around
  // the hub. At 300 km/h that is a fifth of a turn per exposure, so sharp
  // spokes are not a style choice, they are impossible. The sweep angle is
  // therefore just the distance covered, in tyre radii.
  const TYRE_RADIUS = 0.375 // measured off the model's own geometry
  const WHEEL_EXPOSURE = 0.018 // a 1/55 s shutter, for the rotational smear
  const wheelPoint = new THREE.Vector3()
  const wheelAxis = new THREE.Vector3()
  const carForwardWorld = new THREE.Vector3()
  const measureWheels = (reach, travel) => {
    // Rolling without slip: the rim covers exactly the ground the car
    // does, so the turn during one exposure is simply that distance in
    // tyre radii. The axle is the car's own left-right axis, and with
    // omega along +x a forward-rolling wheel turns positively about it —
    // reverse just flips the sign.
    taycan.getWorldDirection(carForwardWorld) // the model faces -z, so this is its nose
    const backwards = travel && travel.dot(carForwardWorld) < 0
    // Capped at ~14 degrees (half the old 0.48). The wheel really does sweep
    // much further at 300 km/h, but a finite number of taps spread over a
    // wider arc shows as separate ghost spokes, and past about a third of the
    // spoke spacing the spokes average into a featureless grey disc that
    // reads as a render bug rather than as speed. Halving it again keeps the
    // aero blades of the rim readable through the smear instead of turning
    // the whole face into a disc.
    const turn = Math.min(0.24, reach / TYRE_RADIUS) * (backwards ? -1 : 1)
    fx.spin.value.set(Math.cos(turn), Math.sin(turn), Math.cos(turn / 2), Math.sin(turn / 2))
    // THE REAR PAIR, WHEN THEY ARE LIT UP. A tyre that is spinning rather than
    // rolling covers more arc in the same exposure by exactly the ratio of its
    // tread speed to the car's, so that ratio is the whole of it — no separate
    // "drift" flag, because the surplus IS the drift and it fades in and out
    // with the throttle on its own.
    //
    // The ceiling is 0.42 rather than the front pair's 0.24. That cap exists
    // because spokes smeared past about a third of their spacing average into
    // a featureless grey disc, which reads as a broken render — but a wheel
    // genuinely spinning at three times road speed SHOULD be most of the way
    // to a disc, and stopping it at the rolling cap is what made the burnout
    // look like the car was simply driving round a circle.
    // ...and it is measured off the WHEEL, not off the camera. The front
    // sweep above is derived from `reach`, the rig's own travel over an
    // exposure, which is a fair stand-in while the wheel is merely rolling —
    // the rim covers exactly the ground the car does. It is worth nothing
    // during a burnout, where the whole point is that the tyre is NOT
    // matching the ground. Worse, the show only feeds the speed bus above
    // 11 m/s and the donut runs at 8.3, so `reach` was flatly zero for the
    // entire drift: the sweep was not small, it was absent. That is why the
    // back wheels sat there looking bolted on while they were supposed to be
    // going up in smoke.
    //
    // So: omega x exposure, straight. 1/55 s is a film shutter, and the tread
    // speed is the one showSpin is already turning the mesh at, so the blur
    // and the wheel agree by construction.
    const rearSurplus = Math.abs(wheelTread.rear) - Math.abs(wheelTread.front)
    const rearLit = rearSurplus > 0.5 // spinning, not just rolling
    const rearTurn = rearLit
      ? Math.min(0.42, (Math.abs(wheelTread.rear) / TYRE_RADIUS) * WHEEL_EXPOSURE) *
        (wheelTread.rear < 0 ? -1 : 1)
      : turn // rolling: the driven pair is no different from the front pair
    fx.spinRear.value.set(
      Math.cos(rearTurn), Math.sin(rearTurn), Math.cos(rearTurn / 2), Math.sin(rearTurn / 2),
    )
    wheelAxis.set(1, 0, 0).applyQuaternion(taycan.quaternion)
    fx.wheelAxis.value.copy(wheelAxis).transformDirection(camera.matrixWorldInverse)
    for (let i = 0; i < fx.wheels.length; i += 1) {
      const group = wheelGroups[i]
      if (!group) {
        fx.wheels[i].value.set(0, 0, 1000, 0) // nowhere near any pixel
        continue
      }
      group.knuckle.getWorldPosition(wheelPoint).applyMatrix4(camera.matrixWorldInverse)
      // w was spare; it now says which sweep this wheel takes — 1 for the
      // driven pair, 0 for the fronts, which only ever roll.
      fx.wheels[i].value.set(wheelPoint.x, wheelPoint.y, wheelPoint.z, group.isFront ? 0 : 1)
    }
    // ...last, so the wheel centres and their front/rear flags are written
    // before anything acts on the answer
    return rearLit
  }
  const BASE_EXPOSURE = 1.25
  // The car's bounding box, measured once at rest. Re-expressed each frame
  // as an ORIENTED box in view space, which is what the blur uses to decide
  // what is car and what is world: a screen rectangle plus a depth window
  // cannot separate the car from the road directly under it — same distance
  // from the lens — and would leave a sharp rectangle of asphalt with hard
  // edges wherever the car went.
  const carBox = new THREE.Box3().setFromObject(taycan)
  const carHalf = carBox.getSize(new THREE.Vector3()).multiplyScalar(0.5)
  const carMidY = carBox.getCenter(new THREE.Vector3()).y - taycan.position.y
  // The box has to stand OFF the car, not on it. A box sized exactly to the
  // car puts every one of its own surfaces on the boundary, and the mask
  // feathers its outer tenth — so the nose and the roof came out half
  // blurred, and head-on, where the only thing you can see IS the front
  // metre, the whole car smeared. The margin puts that feather in the air
  // around the car instead. The floor is raised separately: the tarmac is
  // the one thing at the car's own distance that must never be protected.
  // Metres of clear air around the car that count as subject. This has to
  // clear the 8 cm feather so the car's own surfaces never dissolve, but
  // every centimetre of it is also background held SHARP — and that is
  // where a tail lamp's bloom would otherwise start smearing. At 0.3 the
  // red trail could not begin until 30 cm behind the bumper and read as
  // detached from the lamp. 0.12 leaves 4 cm of solid protection past the
  // paint and lets the glow start streaking almost at the lens.
  const BODY_MARGIN = 0.12
  const BODY_FLOOR = 0.07 // above the road, below the splitter
  const carTop = carMidY + carHalf.y + 0.12
  const carCentre = new THREE.Vector3()
  const measureSubject = () => {
    carCentre.set(
      taycan.position.x,
      taycan.position.y + (BODY_FLOOR + carTop) * 0.5,
      taycan.position.z,
    )
    const behind = camera.position.distanceTo(carCentre) + carHalf.length()
    fx.body.centre.value.copy(carCentre).applyMatrix4(camera.matrixWorldInverse)
    fx.body.right.value
      .set(1, 0, 0)
      .applyQuaternion(taycan.quaternion)
      .transformDirection(camera.matrixWorldInverse)
    fx.body.up.value
      .set(0, 1, 0)
      .applyQuaternion(taycan.quaternion)
      .transformDirection(camera.matrixWorldInverse)
    fx.body.forward.value
      .set(0, 0, 1)
      .applyQuaternion(taycan.quaternion)
      .transformDirection(camera.matrixWorldInverse)
    fx.body.half.value.set(
      carHalf.x + BODY_MARGIN,
      (carTop - BODY_FLOOR) * 0.5,
      carHalf.z + BODY_MARGIN,
    )
    return behind
  }

  // `travel` is how far the camera moves during one exposure, in world
  // units; `focus` is the point the shot is tracking (its subject).
  const RIG_REFERENCE = 3.1 // the scene's default rig distance, in metres
  const setSpeedFx = (travel, boost, focus) => {
    camera.updateMatrixWorld() // measure against THIS frame's camera
    fx.boost.value = boost
    // The rig can be pulled back to six metres or pushed in to two. A
    // literal exposure would make the smear shrink as it pulls out — the
    // world's angular speed really does fall off with distance — and the
    // effect falls apart on zoom-out: a short trail over a frame that is
    // now mostly mid-field reads as a soft lens, not as speed. Scaling the
    // exposure AND the arcade reach with the rig distance keeps the streak
    // the same length ON SCREEN at every zoom, which is what the shot is
    // actually asking for.
    const focusDist = focus ? camera.position.distanceTo(focus) : RIG_REFERENCE
    const zoom = focusDist / RIG_REFERENCE
    const reach = (travel ? travel.length() : 0) * zoom
    if (reach > 0.0001) {
      // transformDirection normalises, so the length goes back on after
      fx.motion.value
        .copy(travel)
        .transformDirection(camera.matrixWorldInverse)
        .multiplyScalar(reach)
    } else {
      fx.motion.value.set(0, 0, 0)
    }
    fx.focal.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5])
    // on the bottle the far end of the bore has to tear too, so the field is
    // told the world is never further out than this — in rig distances, so
    // it holds up at any zoom
    fx.cap.value = focusDist * (19 - 15 * boost)
    const rearLit = measureWheels(reach, travel)
    // taps scale with the travel: a long smear needs more of them to stay
    // smooth, a short one would only waste them. The governor's cap trades
    // streak grain for frame time on the rungs that need it.
    //
    // A STILL WORLD IS NOT A STILL WHEEL. This used to read `reach > 0.02 : 0`,
    // which switched the whole pass off whenever the camera was not travelling
    // — and that is every frame of the donut. A spinning rear tyre needs the
    // loop running even though nothing else in the frame is moving, so it sets
    // its own floor: enough taps to walk a 24 degree arc without banding into
    // separate ghost spokes. The world stays sharp regardless, because with no
    // camera travel `motion` is zero and only the wheel contributes a trail.
    fx.samples.value =
      reach > 0.02
        ? Math.min(quality.knobs().samplesCap, Math.round(10 + reach * 18))
        : rearLit
          ? Math.min(quality.knobs().samplesCap, 16)
          : 0
    if (focus) {
      measureSubject()
      fxNdc.copy(focus).project(camera)
      if (fxNdc.z < 1) {
        // screen uv runs top-down in the shader, so y is 0.5 - ndc/2
        fx.centre.value.set(
          Math.min(1.4, Math.max(-0.4, fxNdc.x * 0.5 + 0.5)),
          Math.min(1.4, Math.max(-0.4, 0.5 - fxNdc.y * 0.5)),
        )
      }
    } else {
      fx.centre.value.set(0.5, 0.5)
    }
    renderer.toneMappingExposure = BASE_EXPOSURE + 0.08 * boost // the bottle flashes
  }

  // --- the show: one looping run from the tunnel to the charger -------------
  //
  // Scene 2 took away the edit clock and the auto-orbit, so nothing in it
  // moved but the viewer. This is the one thing that does. The car comes out
  // of the bore, sets up, spins two and a quarter donuts in the junction,
  // brakes straight, reverses into the kerb beside the charger, sits there a
  // while, then runs back up the road into the tunnel — where the loop turns
  // it round out of sight and starts over. It never teleports in view: the
  // seam is at z = 70, deep inside a scan that runs from z 18 to 94.5.
  //
  // WHY THE JUNCTION IS WHERE IT IS: the city's central median is two
  // separate meshes, x ≈ 0…1.6 over z −22.4…−0.4 and again over z 10.1…23.8.
  // The gap between them is the cross street, so the junction is the box at
  // z −0.4…10.1 — which is exactly where the coffee shop and the charger
  // already are. The donut is sized to fit inside that gap.
  // Two lanes, because the bore and the street do not want the same one.
  // Scene 1 runs the bore at x −1.75 and clamps its camera to walls at
  // x −4.85 … 1.4, so that is the only width there is in the tunnel. Out in
  // the city the median runs x −0.7…1.4 wherever it exists, so the car has to
  // sit further west or it clips the kerb. The run-in and run-out ease
  // between the two while inside the mouth, where nothing is watching closely.
  const SHOW_BORE_X = -1.75 // down the middle of the bore, as scene 1 proves
  const SHOW_LANE_X = -3.2 // the city's southbound lane, clear of the median
  const SHOW_HIDE_Z = 70 // the loop's seam, deep in the bore
  // The biggest circle in the city whose SWEPT FOOTPRINT stays on tarmac AND
  // clear of anything strikeable: r 8, 0.16 m to spare. The boulevard is 22.8 m
  // wide (road x −10.4 … 12.4), and that width is the whole story — r 8.5 puts
  // 16 sample points over the kerb and r 9 fouls by 0.35 m. Entered at (−6,
  // 10.3) and left at (2, 2.3) heading east, which is the charging street.
  //
  // Radius is the ONLY speed lever, because a held turn obeys R = V²/ay and ay
  // is what the tyres pass, not what the wheel asks for. More lock cannot buy a
  // tighter circle: the front saturates at 6° of slip, so past ~35° the extra
  // angle adds nothing and costs cos δ — measured, 49° of lock ran WIDER.
  //
  // Previously (the annulus version of this test, which was too conservative):
  // Not the biggest gap between obstacles — the road itself is the limit, and it
  // had to be mapped to find it: Object_140 at y 0.03 is the carriageway,
  // Object_590 at y 0.14 is the pavement, and a circle is only drivable where
  // every point from r−2.25 to r+2.25 (the car's own reach at this angle) is on
  // the first and off the second. That gives r 7.5 at this centre, entered at
  // (−5, 9.8) with the tangent due south — the way the car is already
  // travelling out of the tunnel — and leaving at (2.5, 2.3) heading east,
  // which is the charging street and the heading it keeps all the way in.
  //
  // Bigger is what lets it be FASTER, and that is not a preference either. A
  // held drift obeys V² ≤ ay·R, so speed and radius are the same dial: on the
  // old 4 m circle 9 m/s asked for 2 g and the angle collapsed to 18°. At 7.5 m
  // the same 11 m/s² the tyres actually have carries 9 m/s.
  const SHOW_DONUT = { x: 2, z: 10.3, r: 8 }
  // THE CEILING, and it is arithmetic, not taste. On a held drift the yaw
  // balance ties the front to the rear, so the lateral the pair can raise is
  //
  //     ay = 2.042 · latCapR / m = 11.1 m/s²   (1.13 g)
  //
  // and a circle needs V² = ay·R. At r 8 that is 9.4 m/s — 34 km/h — and no
  // more. The controllers will happily hold 40 km/h here, but that is 1.65 g on
  // this radius: the sideslip term making up what the tyres cannot pass, which
  // is a car on rails, not a drift. A real sports car drifts at 60+ km/h on
  // 25 m sweeping corners; a 22.8 m wide boulevard has no room for one.
  //
  // Forward speed, not speed: sliding at 35° the car is travelling 9.3 m/s
  // while pointing 7.6 m/s' worth of nose down the road, and it is the 9.3 that
  // the tyres have to hold — 9.3²/7.5 is 11.5 m/s² of lateral, which is about
  // everything they have. This is the fastest a drift this radius can be held
  // at, and the angle is what costs the rest: every degree of it trades forward
  // speed for sideways.
  const SHOW_DONUT_V = 8.3
  // At the kerb on the ROAD, facing north — which puts the car's RIGHT flank,
  // and so its charge port, toward the charger on the pavement west of it.
  // Facing any other way points the port at the traffic.
  //
  // The slot on the EAST–WEST street, not the north–south one: that street
  // runs clear the full width at z −0.78 … 3.41, and the charger stands on
  // its north pavement. Driven to and read off the car, not guessed — the
  // body hugs the north kerb with 0.08 m to spare.
  //
  // Facing EAST is what makes it work: the car's right flank, and so the
  // charge port on that side, ends up against the kerb the charger is on,
  // with the charger just off the front wing. Any other heading points the
  // port at the traffic.
  const SHOW_PARK = { x: -16.12, z: 2.13 }
  const SHOW_STOP = { x: 12, z: 2.3 } // east of the slot, to back westward in

  const showLerp = (a, b, u) => a + (b - a) * u
  const showEase = (u) => u * u * (3 - 2 * u)

  // Every segment is sampled to a polyline at build time, so straights, arcs
  // and béziers are all the same thing downstream: a table of points and the
  // distance along it. Direction comes off the polyline too, which means one
  // rule covers all three and a kink can never appear between them.
  const sampleCurve = (fn, steps) => {
    const pts = []
    for (let i = 0; i <= steps; i += 1) pts.push(fn(i / steps))
    const cum = [0]
    for (let i = 1; i < pts.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    }
    return { pts, cum, len: cum[cum.length - 1] }
  }
  const segStraight = (x0, z0, x1, z1) =>
    sampleCurve((u) => [showLerp(x0, x1, u), showLerp(z0, z1, u)], 8)
  const segArc = (cx, cz, r, a0, a1, steps = 240) =>
    sampleCurve((u) => {
      const a = showLerp(a0, a1, u)
      return [cx + Math.cos(a) * r, cz + Math.sin(a) * r]
    }, steps)
  const segBezier = (p0, c0, c1, p1, steps = 64) =>
    sampleCurve((u) => {
      const m = 1 - u
      const b0 = m * m * m, b1 = 3 * m * m * u, b2 = 3 * m * u * u, b3 = u * u * u
      return [
        p0[0] * b0 + c0[0] * b1 + c1[0] * b2 + p1[0] * b3,
        p0[1] * b0 + c0[1] * b1 + c1[1] * b2 + p1[1] * b3,
      ]
    }, steps)
  const curveAt = (poly, d) => {
    const { pts, cum, len } = poly
    const t = Math.max(0, Math.min(len, d))
    let lo = 1, hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < t) lo = mid + 1
      else hi = mid
    }
    const a = pts[lo - 1], b = pts[lo]
    const span = cum[lo] - cum[lo - 1] || 1
    const f = (t - cum[lo - 1]) / span
    return {
      x: a[0] + (b[0] - a[0]) * f,
      z: a[1] + (b[1] - a[1]) * f,
      // the car's nose is its local +z, so a heading θ points (sinθ, cosθ)
      dir: Math.atan2(b[0] - a[0], b[1] - a[1]),
    }
  }

  // A segment carries a speed PROFILE, not a duration. The profile is
  // integrated once at build time into a normalised distance curve, so the
  // segment always ends exactly on its last point however the speed is
  // shaped — including profiles that start and end at a dead stop, which a
  // plain `distance += speed × dt` can only ever approach and never reach.
  const buildSegment = (seg) => {
    if (seg.hold) return { ...seg, dur: seg.hold, len: 0 }
    const STEPS = 128
    const v = seg.v || (() => 10)
    const area = [0]
    for (let i = 1; i <= STEPS; i += 1) {
      const u0 = (i - 1) / STEPS, u1 = i / STEPS
      area.push(area[i - 1] + ((v(u0) + v(u1)) / 2) * (1 / STEPS))
    }
    const total = area[STEPS] || 1
    const dur = seg.path.len / total // ∫v du = mean speed, so len / mean = time
    return {
      ...seg,
      dur,
      len: seg.path.len,
      v,
      distAt: (u) => {
        const f = Math.max(0, Math.min(1, u)) * STEPS
        const i = Math.min(STEPS - 1, Math.floor(f))
        const frac = f - i
        return (seg.path.len * (area[i] + (area[i + 1] - area[i]) * frac)) / total
      },
    }
  }

  const buildShow = () => {
    const D = SHOW_DONUT
    const P = SHOW_PARK
    const S = SHOW_STOP
    const ENTRY_Z = 28 // the set-up crosses 2.8 m of boulevard as well as braking
    // Entered at the WEST point, where the tangent is due south — the way the
    // car is already travelling — so the set-up bézier only slides it across
    // the lane and never has to turn it. Two and a QUARTER laps then leave it
    // at the south point facing east, which is the heading it keeps from here
    // to the kerb: it backs into the slot without ever turning again.
    const a0 = Math.PI
    // THREE full circles, plus the HALF that puts the exit at the east point.
    // A counter-clockwise arc's tangent there is due north — straight back up
    // the boulevard at the tunnel — so the car leaves the drift already
    // pointing where it is going and never has to turn round.
    // (It used to be 3.25, exiting south-facing-east for the charging slot.)
    const a1 = a0 + Math.PI * 2 * 3.5
    const donutIn = [D.x - D.r, D.z]
    const donutOut = [D.x + Math.cos(a1) * D.r, D.z + Math.sin(a1) * D.r]
    return [
      { name: 'run-in',
        path: segBezier([SHOW_BORE_X, SHOW_HIDE_Z], [SHOW_BORE_X, 50],
          [SHOW_LANE_X, 38], [SHOW_LANE_X, ENTRY_Z]),
        v: (u) => showLerp(33, 15, showEase(u)) },
      { name: 'set-up',
        path: segBezier([SHOW_LANE_X, ENTRY_Z], [SHOW_LANE_X, ENTRY_Z - 4],
          [donutIn[0], donutIn[1] + 4], donutIn),
        // Down to the donut's own speed BEFORE the circle, not during it: a
        // car still doing 15 cannot turn into 4.6 m however far the wheel goes.
        v: (u) => showLerp(15, SHOW_DONUT_V, showEase(u)) },
      // Two and a quarter laps at the one speed the radius allows. The look
      // -ahead is short on purpose: the old 4 m rule aimed the driver most of
      // the way ACROSS a circle this size, which is the sawing that first
      // broke the drift.
      { name: 'donut', path: segArc(D.x, D.z, D.r, a0, a1),
        v: () => SHOW_DONUT_V, burn: 1, look: 2.5,
        // The attitude is OPPOSITE in sign to the circle, and that sign is the
        // whole difference between a drift and a car crabbing round nose-first.
        // The tail slides OUTWARD, so the nose ends up pointing further INTO
        // the corner than the car is travelling — which puts the velocity on
        // the outboard side of the nose, and that is a POSITIVE sideslip on a
        // left-hand (negative-yaw) circle. Held at −0.52 the car went round
        // with its nose pointing OUT of the circle and the wheel wound INTO it:
        // the exact opposite of a drift, on both counts at once. Normal
        // cornering really is a small negative β at the CG — the rear axle
        // tracks the tighter radius — which is what made the wrong sign look
        // plausible on the way past.
        spin: -1, radius: D.r, cx: D.x, cz: D.z, drift: () => CAR.angle },
      // Out of the circle still sliding, unwinding the slip as it brakes and
      // settling onto the east–west street. Both ends hold due east: the
      // heading it leaves the donut on, and the heading it keeps all the way
      // into the slot — the body never turns again after this.
      // THE EXIT SWEEP. No stop and no straighten: the third circle simply
      // runs out of the drift and keeps going, still sideways, in one long
      // left-hand sweep that carries the car off the boulevard and lines it up
      // on the bore. The circle is counter-clockwise, so carrying on turning
      // left is the way the car is ALREADY going — nothing has to be reversed
      // and the slide never has to be caught, only fed out.
      //
      // The drift angle decays across it rather than at the end, so the car is
      // still visibly crossed up as it leaves the junction and dead straight by
      // the time the tunnel mouth is in front of it.
      { name: 'sweep',
        // The first control sits close, at z 18 rather than 23: further out the
        // line stayed due north too long, the drifting car cut inside it and
        // the hug controller then swung it back out — a 1.8 m S halfway along.
        path: segBezier(donutOut, [donutOut[0], 18],
          [SHOW_BORE_X, 30], [SHOW_BORE_X, 43]),
        v: (u) => showLerp(SHOW_DONUT_V, 20, showEase(u)),
        hug: true,
        burn: (u) => Math.max(0, 1 - u * 1.8),
        // Unwound by the HALFWAY mark, not at the end. The car lags this
        // command — asked for 11° at 59% along it was still carrying 27° —
        // so decaying it across the whole sweep left the drift running while
        // the car was already lined up on the bore. The slide has to be over
        // by the time it is pointing down the tunnel and going forward.
        drift: (u) => CAR.angle * (1 - showEase(Math.min(1, u * 2))) },
      // ...and away up the bore.
      { name: 'run-out',
        path: segBezier([SHOW_BORE_X, 43], [SHOW_BORE_X, 52],
          [SHOW_BORE_X, 61], [SHOW_BORE_X, SHOW_HIDE_Z]),
        v: (u) => showLerp(20, 34, showEase(u)) },

      // (There was a stop here — straighten, a 3.5 s rest and a standing
      // burnout launch. Removed: the loop runs circle → sweep → tunnel now.
      // CAR.kick and the burn-held throttle stay, because the sweep uses them.)

      // ── THE CHARGER LEG, PARKED ────────────────────────────────────────
      // Commented, not deleted: the car used to leave the circle facing east,
      // beat for a moment, reverse the length of the street and sit on the
      // charger for seven seconds before pulling out. It is all still here,
      // and SHOW_PARK / SHOW_STOP / CHARGER_ANCHOR above still describe the
      // slot, so putting it back is uncommenting these four segments and
      // returning a1 to 3.25 laps.
      //
      // { name: 'beat', hold: 1.1 },
      // { name: 'reverse',
      //   path: segBezier([S.x, S.z], [S.x - 9, S.z], [P.x + 9, P.z], [P.x, P.z]),
      //   reverse: true, v: (u) => 0.25 + 5.5 * Math.sin(Math.PI * u) },
      // { name: 'charge', hold: 7 },
      // { name: 'pull-out',
      //   path: segBezier([P.x, P.z], [P.x + 10, P.z],
      //     [SHOW_LANE_X, 12], [SHOW_LANE_X, ENTRY_Z]),
      //   v: (u) => showLerp(0.4, 12, showEase(u)),
      //   burn: (u) => Math.max(0, 1 - u * 2.6) },
    ].map(buildSegment)
  }

  // The bore's road strip sits at roadProfile (≈ −0.14) and the city's
  // asphalt at +0.03, so there is a 17 cm step where they meet at z = 26.
  // Blending across it costs nothing and saves a per-frame raycast against
  // 400k triangles — the drive mode can afford that, a background loop cannot.
  const CITY_ASPHALT_Y = 0.03
  const showGroundY = (x, z) => {
    if (z <= 24) return CITY_ASPHALT_Y
    const strip = roadProfile(x, z)
    if (z >= 30) return strip
    return showLerp(CITY_ASPHALT_Y, strip, (z - 24) / 6)
  }

  // --- the car, simulated ----------------------------------------------------
  //
  // Until now the car was MOVED along a line and its slide was a number added
  // to its heading: it looked like a drift without being one. This is the
  // vehicle instead — a bicycle model with real slip angles, tyres that
  // saturate, a friction circle and weight transfer — and the drift is what
  // falls out of it when the rear axle is asked for more than the road has.
  //
  //   αf = atan2(v + a·r, u) − δ        the angle each axle is dragged at
  //   Fy = −Cα·α, clamped to μ·Fz       cornering force, until the tyre lets go
  //   latCap = √((μFz)² − Fx²)          drive and grip share one budget
  //   Izz·ṙ = a·Fyf·cosδ − b·Fyr        yaw comes from the tyres, nothing else
  //
  // That third line is the whole thing: put enough drive through the rears and
  // there is nothing left for cornering, the back steps out, and the driver
  // has to catch it. Nobody authors the angle.
  const CAR = {
    mass: 2300, // kg, Taycan Turbo GT
    izz: 3300, // yaw inertia
    a: 1.42, // CG to front axle
    b: 1.48, // CG to rear axle
    cgH: 0.46, // CG height — this is what transfers the load
    cF: 135000, // cornering stiffness, N/rad
    cR: 165000,
    muF: 1.5, // dry, warm, expensive
    muR: 1.45,
    // 13 kN is about 0.58 g — brisk, and crucially BELOW the ~16 kN the rear
    // tyres can hold, so ordinary driving keeps its grip. The donut gets
    // `boost` instead, which is deliberately past that limit: that is how the
    // back is made to step out, rather than by writing an angle down.
    drive: 13000,
    // 1.45, not 2.6. The ceiling on the whole drift is the STEERING: this
    // body's arches cap the lock at 22°, and 22° of opposite lock cannot hold
    // a 45° slide — the car passes the point the driver can catch and simply
    // spins, which is what 77° of slip was. Less torque past the limit gives
    // an angle the driver can actually sit on.
    boost: 1.45,
    // The launch-only torque spike — a clutch drop, in one number. Applied in
    // stepCar and faded out by 8 m/s so it touches the standing start and
    // nothing else. Without it the rear puts 18.9 kN down against a limit
    // weight transfer has already raised to 20.4 kN and the car just hooks up.
    kick: 0.75,
    // Power, not just force. Without this the motor pushes just as hard at
    // 120 m/s as at 2, and the car accelerates out of the city: the donut
    // reached 124,000 m/s before anything stopped it.
    watts: 760000,
    // A saturated tyre still bites. Letting lateral capacity fall to exactly
    // zero means a rear that can only spin the car — which is what it did.
    // 18% is roughly what a sliding tyre keeps, and it is the difference
    // between a drift you can hold and an instant spin.
    // What a sliding rear tyre keeps of its lateral grip. 0.42 is too
    // pessimistic to drift on: measured tyre data has a patch at 35–45° of slip
    // still making 60–80% of its peak side force, and 0.42 was what limited the
    // whole drift to 6.7 m/s — the lateral the two axles could raise between
    // them simply would not hold a circle any faster. 0.78 is as far as it can
    // usefully go: the yaw balance needs the front to carry 1.042/cos δ of
    // whatever the rear makes, and past here that exceeds capF and the
    // equilibrium breaks instead of getting faster.
    slideGrip: 0.78,
    brake: 30000,
    drag: 0.62, // N per (m/s)²
    roll: 320, // N of rolling resistance
    // 34°, which is what a road car actually has — a Taycan's own limit is
    // about 35°. The 22° this used to run was never a chassis number: it was
    // the angle at which the tyre stopped coming through the arch. That made
    // a drift geometrically IMPOSSIBLE, not just hard: a 2.9 m wheelbase at
    // 22° of lock cannot hold a circle tighter than 2.9/tan22° = 7.6 m, so
    // the car understeered out of every donut it was asked for and drifted a
    // 9 m arc through the buildings instead. The arch is now solved where it
    // belongs, by moving the wheel (see the tuck below), not by taking the
    // steering away.
    // 34°, which is what a road car actually has — a Taycan's own limit is
    // about 35°. Not the 22° this used to run: that was never a chassis
    // number, it was the angle at which the tyre stopped coming through the
    // arch, and it made a drift geometrically IMPOSSIBLE rather than merely
    // hard. The arch is solved by moving the wheel (see the tuck below), not
    // by taking the steering away.
    //
    // Nor MORE than 34°, which I tried: this model's front tyre saturates at
    // only 6° of slip angle, so past about 35° of lock the extra angle adds no
    // force and costs cos δ of what there is — at 49° the car ran WIDER, 4.3 m
    // on a 3 m circle. The most lateral force the front can make is
    // latCapF·cos δ, and that wants the SMALLEST lock that still saturates it.
    lock: 0.6,
    // The throttle the drift is held on, and it is a stability limit, not a
    // taste: the rear's grip circle is 16 kN, and this much boosted drive
    // spends 8.5 kN of it longitudinally, leaving just less lateral than the
    // circle asks for — so the back sits out on the edge. Wound past about
    // 0.5 the rear loses too much and the car genuinely spins: measured, it
    // reached 79° of slip and came to a stop mid-donut, twice a lap. A 5 m
    // circle is simply not big enough to hold more angle than this.
    drift: 0.78,
    // The attitude the drift HOLDS — 34°. It is commanded, the way a racing
    // game commands it, because a two-state car with clamped linear tyres has
    // no held large-slip equilibrium to find: left to the tyres this car sat at
    // exactly its kinematic yaw rate (1.10 rad/s against the geometric 1.18),
    // a tight circle with no slide in it anywhere. Every route to earning the
    // angle was measured and none held — more lock ran WIDER (the front
    // saturates at 6° of slip, so past 35° the extra angle is pure cos δ loss),
    // more throttle span to 86°, a handbrake yank brought the tail round to 85°
    // with nothing to land in.
    // 30°. Not a free number: with 34° of lock the steer the equilibrium needs
    // is tan β − a/(R·cos β) = tan(δ+αf), and at r 7.5 that runs out of lock at
    // about 29°. Asking 39° only saturates the wheel and settles lower.
    angle: 0.52,
    // ...and how far past it the driver lets things go before catching. Wide,
    // because the catch must not fight the angle being held.
    catchPast: 0.85,
  }
  const G = 9.81

  // The driver. Pure pursuit for the line, plus the one reflex that matters:
  // when the back goes, steer INTO it. Without this the model spins on the
  // first provocation, which is exactly what happens to people.
  const driveCar = (s, ref, want, dt) => {
    // Speed as a MAGNITUDE. Clamping the signed value at 0.4 made every
    // reversing frame look like a car doing 0.4 m/s, which threw the slip
    // angle and the cross-track gain together.
    const spd = Math.max(Math.abs(s.u), 0.4)
    const slip = Math.atan2(s.v, spd)
    // Where the line wants the nose, relative to where it is pointing —
    // and backing up, the car travels the line the WRONG WAY ROUND. Its nose
    // points 180° from the path's own direction, so the error has to be taken
    // against the flipped heading. Taken against the raw one it was ~±180° on
    // every frame of the reverse: the wheel sat on full lock 48% of the way
    // down the street and slammed stop to stop 11 times as the error wrapped.
    let head = ref.dir + (want.reverse ? Math.PI : 0) - s.yaw
    while (head > Math.PI) head -= Math.PI * 2
    while (head < -Math.PI) head += Math.PI * 2
    // cross-track: which side of the line the car sits on
    const ex = ref.x - s.x
    const ez = ref.z - s.z
    const cross = ex * Math.cos(s.yaw) - ez * Math.sin(s.yaw)
    const drawIn = Math.atan2(cross * 0.9, Math.max(spd, 5))
    const pursue = head + drawIn
    // Countersteer opposes the SLIDE, not the corner. Proportional to the
    // WHOLE slip angle it also fights a steady drift: at 9° of angle it was
    // asking for 0.21 rad of opposite lock out of the 0.38 the car has, so
    // barely half the wheel was left to turn with and the donut spiralled
    // out to a 9 m radius. Inside the drift only the part PAST the held
    // angle gets caught; everywhere else the old term stands.
    // 20°, and this is a TARGET, not a safety net. A drift is an unstable
    // equilibrium a driver holds: left to itself this car settles at whatever
    // angle the tyre forces balance at, which measured 15°, and it will sit
    // there all day looking like a car merely cornering hard. The deadband is
    // where the driver decides the angle is enough and starts holding it.
    const holdAngle = want.power ? CAR.catchPast : 0
    const excess = Math.max(0, Math.abs(slip) - holdAngle) * Math.sign(slip || 1)
    // ...and on how fast it is GROWING, which is the half a driver actually
    // feels. An angle-only reflex cannot hold a big slide: by the time the
    // angle is wrong the yaw has already gone, and the car swapped ends every
    // second lap. The rate term is what makes 25° a place the car can sit.
    const raw = (slip - (s.pslip ?? slip)) / Math.max(dt, 1e-4)
    s.pslip = slip
    s.slipRate = (s.slipRate || 0) + (raw - (s.slipRate || 0)) * Math.min(1, dt / 0.04)
    const damp = Math.max(-0.5, Math.min(0.5, s.slipRate * 0.13))
    const catchIt = -excess * 1.8 - damp
    // Reversing, the two halves of pure pursuit do NOT flip together. To swing
    // the nose toward a heading you steer the opposite way, so the heading
    // term negates — but to walk the BODY toward a line that is off to your
    // right you steer right as well, because it is the rear that leads. Both
    // negated, the cross-track correction became positive feedback: the car
    // rotated 120° down the street and arrived at the charger facing 213°.
    // In a HELD drift the steering angle is not a path-following output at all
    // — it is the control that balances the yaw moment, and it can be SOLVED
    // for. On a drift equilibrium the rear is saturated and the front is not,
    // so a·Fyf·cosδ = b·Fyr fixes Fyf, that fixes the front slip angle, and the
    // steer follows from the front axle's own velocity direction. Pointing the
    // nose down the path instead asked for almost no lock at 16° of slip, which
    // is exactly the angle it then held: the steering was quietly refusing the
    // drift the rest of the controller was trying to set up.
    //
    // This is also what counter-steer IS: the body is yawed out of the corner
    // and the wheels stay with the direction of travel, so relative to the car
    // they point the other way.
    let drift = null
    if (s.aim && s.radius) {
      const V = Math.max(2, Math.hypot(s.u, s.v))
      const rEq = (V / s.radius) * (s.spin || -1)
      const uE = V * Math.cos(s.aim)
      const vE = V * Math.sin(s.aim)
      const FzR = (CAR.mass * G * CAR.a) / (CAR.a + CAR.b)
      const latR = CAR.muR * FzR * CAR.slideGrip
      const arE = Math.atan2(vE - CAR.b * rEq, Math.abs(uE))
      const FyrE = -Math.sign(arE || 1) * latR
      const FyfE = (CAR.b * FyrE) / (CAR.a * Math.cos(s.steer))
      const afE = -FyfE / CAR.cF
      drift = Math.atan2(vE + CAR.a * rEq, Math.abs(uE)) - afE + drawIn * 0.5
    }
    const target = want.reverse ? drawIn - head : drift ?? pursue + catchIt
    // the hands have mass: no instant lock-to-lock
    const rate = 5.5 * dt
    s.steer += Math.max(-rate, Math.min(rate, target - s.steer))
    s.steer = Math.max(-CAR.lock, Math.min(CAR.lock, s.steer))

    // Throttle and brake chase the speed the phase asks for, measured ALONG
    // the gear. Comparing raw speeds instead had the driver standing on the
    // brakes to go backwards, because -4 is less than -2.
    const gear = want.reverse ? -1 : 1
    const err = (want.speed - s.u) * gear
    s.throttle = Math.max(0, Math.min(1, err * 0.22))
    s.brakes = Math.max(0, Math.min(1, -err * 0.35))
    // ...and the donut is ordered, not faked: full drive, wheel wound on
    // The donut gets the BOOST, not a pinned throttle: the driver still holds
    // the speed the phase asks for, but at 2.6x torque even that is more than
    // the rears can take, so the back goes. Pinning the throttle open instead
    // just accelerated until the maths gave up.
    s.power = !!want.power
    if (want.power) {
      // THE ANGLE IS THE THROTTLE. This is the thing a drifter actually does
      // and the reason the first attempt spun: hold the power open and the
      // slide just keeps growing — it reached 88°, which is not a drift, it
      // is a car going sideways down the road. Backing off as the angle
      // passes 40° lets the rears bite, pulls the angle down, and the driver
      // feeds it straight back in. The result sits where it is asked to.
      // hold it at about 30°, which is what 22° of lock can carry
      // the angle AND its rate: lifting only once the angle is already past
      // the target is always too late, and the car spins before the lift lands
      const over = Math.max(0, Math.abs(slip) - holdAngle) +
        Math.max(0, Math.abs(slip + s.slipRate * 0.35) - holdAngle)
      // ...but the floor and the brake lockout only apply while the car is
      // NOT already going too fast for the circle. They used to apply always,
      // and 0.42 of boosted drive sits at 6.5 m/s: on a 3.9 m circle that is
      // 1.7 m/s over what the tyres can hold, so the car ran wide however
      // hard the driver turned. Past the asked speed the ordinary brake and
      // throttle controller above stands, and the car comes back to the line.
      // The floor and the brake lockout only hold while the car is not already
      // too fast for the circle; past that the ordinary controller above stands
      // and brings it back. And the lift is FIRM — a third of a radian past the
      // held angle closes the throttle completely. Easing it instead (gain 1,
      // with a floor under it) left the rears broken open with nothing to shut
      // them, and the car span to 85° and ran backwards.
      // ...or while the phase is BURNING. A launch out-accelerates its own
      // speed profile in the first frame, which closed this gate and cut the
      // throttle to nothing on frame two — a burnout that lasted 8 ms.
      if (err > -0.4 || (s.burn || 0) > 0.5) {
        // The floor is the phase's OWN burn where that asks for more than the
        // drift's holding throttle. A standing-start burnout is the driver
        // standing on it — at 0.55 the rear puts 10.4 kN down against a 16 kN
        // limit and simply hooks up, which is why the launch made no smoke.
        // Wide open it asks 18.9 kN, the patch cannot pass it, and it lights.
        const floor = Math.max(CAR.drift, s.burn || 0)
        s.throttle = Math.max(0, Math.min(1, Math.max(s.throttle, floor) - over * 2.6))
        s.brakes = 0
      }
    }
  }

  const stepCar = (s, dt) => {
    const d = s.steer
    const u = Math.max(Math.abs(s.u), 0.6) * Math.sign(s.u || 1)
    // weight transfer — longitudinal only; it is what decides which axle grips
    const L = CAR.a + CAR.b
    const shift = (CAR.mass * s.ax * CAR.cgH) / L
    const Fzf = Math.max(500, (CAR.mass * G * CAR.b) / L - shift)
    const Fzr = Math.max(500, (CAR.mass * G * CAR.a) / L + shift)
    // sign(u) on the steer term is what makes this work BACKWARDS. A front
    // tyre's side force follows its slip velocity, and travelling the other
    // way reverses which side of the wheel plane that is: turn the wheel right
    // while reversing and the nose goes LEFT, which is why parking a car feels
    // the way it does. Without the sign the model yawed the same way whichever
    // direction it was rolling, so the driver's correction fed the error.
    // Forward, sign(u) is 1 and this is the line it always was.
    const af = Math.atan2(s.v + CAR.a * s.r, Math.abs(u)) - d * Math.sign(u)
    const ar = Math.atan2(s.v - CAR.b * s.r, Math.abs(u))
    const capF = CAR.muF * Fzf
    const capR = CAR.muR * Fzr
    let Fyf = Math.max(-capF, Math.min(capF, -CAR.cF * af))
    let Fyr = -CAR.cR * ar
    // longitudinal at the rear, then the friction circle takes its cut
    // THE LAUNCH KICK. Off the line the rear puts 18.9 kN down against a limit
    // that weight transfer has already raised to 20.4 kN, so the car simply
    // hooks up and a standing burnout makes no smoke at all — honest enough
    // for a heavy four-wheel-drive EV, and not what the phase is asking for.
    // This is the torque spike of a launch: it scales with the phase's own
    // burn and dies away by 11 m/s, so it touches the start and nothing else:
    // the donut is speed-held at its own target and the profile leads it.
    const kick = 1 + (s.burn || 0) * CAR.kick * Math.max(0, 1 - Math.abs(s.u) / 11)
    const drive = Math.min(
      CAR.drive * (s.power ? CAR.boost : 1) * kick,
      CAR.watts / Math.max(Math.abs(s.u), 3),
    )
    const Fdrive = s.throttle * drive * (s.gear || 1)
    const Fbrake = -s.brakes * CAR.brake * Math.sign(s.u || 1)
    const Fresist = -(CAR.drag * s.u * Math.abs(s.u) + CAR.roll * Math.sign(s.u || 0))
    // The brakes act on BOTH axles — 60/40, as they are on any road car — and
    // only the driven axle's share loads the rear's circle. Putting all of the
    // longitudinal force through the rear said that slowing down costs you
    // the back of the car, so it was breaking traction on a straight.
    // The DEMAND first, then what the patch can actually pass. Keeping both
    // matters: the clamped value can never exceed capR by construction, so
    // testing it for wheelspin below always said no.
    const FxWant = Fdrive + Fbrake * 0.4
    const FxR = Math.max(-capR, Math.min(capR, FxWant))
    const FxF = Fbrake * 0.6
    const latCapR = Math.max(
      capR * CAR.slideGrip,
      Math.sqrt(Math.max(0, capR * capR - FxR * FxR)),
    )
    const latCapF = Math.sqrt(Math.max(0, capF * capF - FxF * FxF))
    Fyf = Math.max(-latCapF, Math.min(latCapF, Fyf))
    const grip = Math.abs(Fyr) > latCapR
    Fyr = Math.max(-latCapR, Math.min(latCapR, Fyr))
    // A rear tyre is slipping when it is over its limit in EITHER direction.
    // This used to read lateral saturation alone, so a standing-start burnout
    // — which is pure longitudinal slip, the rear asking for more drive than
    // the contact patch can pass — reported the tyres as gripping, and the
    // launch made no smoke at all however hard it was driven.
    s.rearSlipping = grip || Math.abs(FxWant) > capR
    // body-frame accelerations
    // A steered front tyre's side force does not act sideways on the CAR: at
    // 34° of lock 56% of it points STRAIGHT BACK. Leaving it out is why the
    // donut could never be driven on the throttle — the only thing that would
    // hold the speed down was the brakes, and braking hands the rear axle its
    // grip back, so the car gripped round the circle instead of sliding round
    // it. With the drag where it belongs the driver keeps the power on, the
    // rears stay over their limit, and the angle comes out of the tyres.
    // Cornering drag — the induced drag of a tyre working at a slip angle,
    // Fy·tan α, on each axle. It is what actually bleeds a drifting car's
    // speed, and without it the throttle could only ever be a SPEED control:
    // anything enough to break the rears loose also accelerated the car, so
    // the driver had to brake, braking handed the rear its grip back, and the
    // car gripped round the circle at 15° instead of sliding round it at 21°.
    // With the drag present the throttle stays planted and sets the ANGLE.
    const bite = (f, a) => Math.abs(f * Math.tan(Math.max(-0.45, Math.min(0.45, a))))
    const induced = (bite(Fyf, af) + bite(Fyr, ar)) * Math.sign(s.u || 1)
    s.ax =
      (Fdrive + Fbrake + Fresist - Fyf * Math.sin(d) - induced) / CAR.mass + s.v * s.r
    const ay = (Fyf * Math.cos(d) + Fyr) / CAR.mass - s.u * s.r
    let rdot = (CAR.a * Fyf * Math.cos(d) - CAR.b * Fyr) / CAR.izz
    let held = 0
    let sideways = 0
    if (s.power) {
      // A held drift is THREE separate things, and trying to get them out of
      // one control is what made every earlier attempt oscillate: the driver's
      // pure pursuit and the attitude controller were both pulling on the yaw,
      // in opposite directions, at 3 Hz. They get their own jobs.
      //
      //   the CIRCLE  sets the yaw rate      — V/R, off the arc's own radius
      //   the ANGLE   sets the sideslip      — 34°, which is the drift
      //   the SPEED   sets the drive         — because at 34° the tyres' own
      //                                        drag is worth more than the
      //                                        drive can answer, and the car
      //                                        stalled and ran backwards
      //
      // The sign comes from the ARC, never from the car's own yaw rate: taken
      // from the rate, one overshoot through straight flips the target and the
      // controller then drives the very spin it exists to prevent.
      held = Math.max(-8, Math.min(8, (Math.abs(s.wantSpeed || 0) - Math.abs(s.u)) * 3.5))
    }
    // The yaw rate is commanded only where there IS a circle to hold — and it
    // is commanded from WHERE THE CAR IS on that circle, not from the radius
    // alone. A bare V/R feed-forward gives a circle of the right size in the
    // wrong place: the car drove a tidy 6.4 m arc whose centre had wandered, so
    // its distance from the donut's own centre swung between 3.4 and 8.7 m.
    // The car aims its VELOCITY down the tangent, leaned slightly inward by
    // however far out it has drifted. The nose points wherever the drift angle
    // says — that is the whole point of a drift, and why the nose cannot be
    // what steers here.
    if (s.radius || s.hug) {
      const V = Math.hypot(s.u, s.v)
      let aimPsi = s.pathDir
      let ff = 0
      if (s.radius) {
        const spin = s.spin || -1
        const dx = s.x - s.cx
        const dz = s.z - s.cz
        const at = Math.atan2(dz, dx)
        const wide = Math.max(-0.6, Math.min(0.6, (Math.hypot(dx, dz) - s.radius) / s.radius))
        aimPsi = Math.atan2(-Math.sin(at), Math.cos(at)) + spin * 2.2 * wide
        ff = (V / s.radius) * spin
      }
      let off = aimPsi - (s.yaw + Math.atan2(s.v, s.u))
      while (off > Math.PI) off -= Math.PI * 2
      while (off < -Math.PI) off += Math.PI * 2
      rdot += Math.max(-9, Math.min(9, (ff + off * 2.2 - s.r) * 30))
    }
    // The angle is a curve over the phase, not a constant, so the exit can wind
    // the drift OFF while the car still has the speed to do it. Abandoned at the
    // end of the circle instead, the 27° stayed in: the car slid to its mark
    // pointing 139° and the reverse then had to unwind it on near-full lock.
    if (s.aim) {
      const vWant = s.u * Math.tan(s.aim)
      sideways = Math.max(-20, Math.min(20, (vWant - s.v) * 30))
    }
    s.u += (s.ax + held * Math.sign(s.u || 1)) * dt
    s.v += (ay + sideways) * dt
    s.r += rdot * dt
    // a stationary car does not creep sideways or spin
    if (Math.abs(s.u) < 0.25 && s.throttle < 0.05) {
      s.v *= 0.8
      s.r *= 0.8
    }
    s.yaw += s.r * dt
    s.x += (s.u * Math.sin(s.yaw) + s.v * Math.cos(s.yaw)) * dt
    s.z += (s.u * Math.cos(s.yaw) - s.v * Math.sin(s.yaw)) * dt
    s.latAccel = ay
    s.slip = Math.atan2(s.v, Math.max(Math.abs(s.u), 0.5))
    // Divergence is not only NaN — an explicit integrator with stiff tyres
    // runs away to finite nonsense first, so the limits are checked too.
    s.blewUp = !(
      Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.yaw) &&
      Number.isFinite(s.u) && Number.isFinite(s.v) && Number.isFinite(s.r)
    ) || Math.abs(s.u) > 60 || Math.abs(s.v) > 42 || Math.abs(s.r) > 8
    // These are generous on purpose. A 5.2 m donut at 15 m/s yaws at ~3 rad/s
    // and, at 59° of slip, is travelling 25 m/s sideways — so the first
    // limits I set were calling the drift itself a divergence and resetting
    // the car mid-slide.
  }

  // --- wind ------------------------------------------------------------------
  //
  // These trees are photogrammetry: one 161k-vertex mesh holding every canopy
  // in the block, with no skeleton, no per-vertex weights and no marker saying
  // which vertex is trunk and which is leaf. So the motion is inferred from
  // the only thing the geometry does carry — HEIGHT. A vertex 6 m up is out on
  // a branch tip and moves; one at the base is trunk and does not.
  //
  // It runs entirely in the vertex stage, so the cost is a few ALU per vertex
  // and nothing at all on the CPU: no skinning, no morph targets, no per-frame
  // buffer upload. The whole thing is two uniforms.
  //
  // Sketchfab_Scene sits at identity — position 0, rotation 0, scale 1 — so
  // object space IS world space here and the phase can be taken straight from
  // positionLocal. If that root ever gains a transform this has to move to
  // world space or every tree will sway in the same direction.
  const windTime = uniform(0)
  const WIND = {
    dir: new THREE.Vector3(0.82, 0, 0.57).normalize(), // a light south-westerly
    speed: 1.6, // m/s, for the smoke to lean on
    // 0.62, not 0.28. At the old figure a 6 m tree swung 0.53 m over a seven
    // second cycle — real for a light breeze, and invisible on screen, where
    // that tree is a few dozen pixels tall and the motion is slower than the
    // eye tracks. Foliage has to be pushed past life to read as alive.
    gust: 0.62, // the mean; the envelope below swings either side of it
    now: 1, // live multiplier, 0.62 … 1.38, written every frame
  }
  const windDir = uniform(WIND.dir.clone())
  const windGust = uniform(WIND.gust)
  // Real wind does not blow at one speed — it swells and lulls, and a constant
  // is the single biggest tell that foliage is being driven by a sine. Two slow
  // unrelated rates give a wandering envelope with no audible loop. The TREES
  // and the SMOKE read the same number, so the bank leans when the canopy does.
  const windEnvelope = (t) =>
    0.62 + 0.38 * (Math.sin(t * 0.21) * 0.6 + Math.sin(t * 0.131 + 1.7) * 0.4)

  const GROUND_Y = float(0.03) // the road surface; heights are measured from it

  const leafWind = () => {
    // WORLD space, not object space. These meshes are not where their vertices
    // say they are: Object_317's local box runs y −14.4 … 12.7 and the median
    // meshes y −29.9 … 14.8, none of which is the height above the pavement.
    // Reading positionLocal gave heights 15–30 m too large, and taking each
    // mesh's own lowest vertex as the ground made it worse. positionWorld is
    // after the object AND the instance matrix, so it is the real height, and
    // it gives per-instance phase for nothing — twelve street trees from one
    // buffer land at twelve different points in the cycle because they stand
    // in twelve different places.
    const W = positionWorld
    const h = W.y.sub(GROUND_Y).max(0)
    const phase = W.x.mul(0.31).add(W.z.mul(0.27))

    // THREE LAYERS, which is how games build tree wind.
    //
    //   1. TRUNK — the whole tree leans and comes back. Slow, and LINEAR in
    //      height rather than 1.6, so it still moves something at head height
    //      instead of nothing. Without it the tree is rigid below ~2 m.
    //   2. BRANCH — grows faster than height, so a tip travels much further
    //      than its middle. Without it the tree slides sideways as a block.
    //   3. LEAF — fast, small, keyed per VERTEX rather than per tree, so the
    //      canopy shimmers rather than translating.
    //
    // Two sines per layer at unrelated rates: one alone reads as a metronome.
    const trunkOsc = sin(windTime.mul(0.55).add(phase.mul(0.5))).mul(0.62)
      .add(sin(windTime.mul(0.29).add(phase.mul(0.31))).mul(0.38))
    const trunk = h.mul(0.055).mul(trunkOsc)

    const sway = sin(windTime.mul(0.9).add(phase)).mul(0.65)
      .add(sin(windTime.mul(1.7).add(phase.mul(1.43))).mul(0.35))
    // Flutter is what the eye actually catches — it is fast enough to register
    // as movement where the slow sway just reads as a still image. Doubled,
    // and given a second rate so the shimmer does not pulse on one beat.
    const flutter = sin(windTime.mul(6.5).add(W.x.mul(3.1)).add(W.y.mul(2.7))).mul(0.2)
      .add(sin(windTime.mul(9.7).add(W.z.mul(4.3)).add(W.y.mul(1.9))).mul(0.12))
    const canopy = h.mul(0.17).pow(1.6).mul(sway.add(flutter))

    // The offset is a WORLD direction, so it has to come back into the space
    // the vertex lives in before it can be added to it.
    const offset = windDir.mul(trunk.add(canopy)).mul(windGust)
    return positionLocal.add(modelWorldMatrixInverse.mul(vec4(offset, 0)).xyz)
  }

  // Found by texture, not by name or by bounding box: a mesh is foliage when
  // its base map averages green. Object_317 is the street trees — an
  // INSTANCED mesh of twelve, which is why probing it through its base
  // transform put it nowhere near the pavement it actually stands on, and why
  // it was missed the first time round. Object_348 is the low planting.
  // Object_893/895 are the median row down the middle of the boulevard.
  const FOLIAGE = new Set(['Object_893', 'Object_895', 'Object_317', 'Object_348'])
  {
    // The GLB arrives with plain MeshStandardMaterial, which is NOT a node
    // material: setting positionNode on one is accepted silently and then
    // ignored, because the renderer converts it through a fallback path that
    // never reads the property. The trees kept every uniform up to date and
    // did not move a millimetre. They have to be rebuilt as node materials.
    const asNode = (m) => {
      const n = new THREE.MeshStandardNodeMaterial()
      n.name = m.name
      n.color.copy(m.color)
      n.map = m.map
      n.normalMap = m.normalMap
      if (m.normalScale) n.normalScale.copy(m.normalScale)
      n.roughness = m.roughness
      n.metalness = m.metalness
      n.aoMap = m.aoMap
      n.alphaMap = m.alphaMap
      n.alphaTest = m.alphaTest
      n.transparent = m.transparent
      n.opacity = m.opacity
      n.side = m.side // the canopy is double-sided; losing that hollows it out
      n.emissive.copy(m.emissive)
      n.emissiveMap = m.emissiveMap
      return n
    }
    let swayed = 0
    scene.traverse((node) => {
      if (!node.isMesh || !FOLIAGE.has(node.name)) return
      const wind = leafWind()
      const build = (m) => { const n = asNode(m); n.positionNode = wind; return n }
      node.material = Array.isArray(node.material)
        ? node.material.map(build)
        : build(node.material)
      swayed += 1
    })
    if (!swayed) console.warn('[city] wind: no foliage mesh matched; the trees are static')
  }

  // --- tyre smoke ------------------------------------------------------------
  //
  // A rear tyre smokes because its contact patch is MOVING OVER the road, so
  // the emission rate is the slip speed of that patch and nothing else — not a
  // drift flag and not the throttle. Two terms make it up: the wheelspin
  // surplus (how much faster the tread runs than the ground) and the lateral
  // slide, v − b·r at the rear axle. Through the donut the rear axle sits at
  // about 38° of slip, so the lateral term alone is ~6 m/s of rubber being
  // dragged sideways — which is why it smokes the whole way round rather than
  // only when the throttle is open.
  //
  // The look is a WebGPU shader, not a sprite sheet. One radial gradient
  // repeated 900 times reads as cotton wool however it is tuned, because every
  // puff is the same shape and they all line up. Here each puff erodes a soft
  // core with fractal noise seeded per particle, spins on its own axis, and
  // shades itself darker where it is dense — so overlapping puffs build depth
  // instead of brightness. Cost is one noise call per fragment and no texture
  // fetch at all.
  // The budget is a LIFETIME budget: rate × life. A 7 s puff on a 20 s donut is
  // still hanging in the air when the car comes round again, which is the whole
  // point — the second and third circles are driven through the first one's
  // smoke. That needs roughly three times the particles 2.4 s did.
  // Fill rate is the ONLY thing that costs here, and fill is count × area. A
  // locked-camera A/B put the plume at 8.9 ms a frame in a heavy view, so both
  // factors came down: fewer puffs, each smaller, each more opaque to keep the
  // bank reading as solid. Area falls with the SQUARE of the width, so trimming
  // 2.6 m to 1.9 m is worth more than halving the count.
  // Back up after the noise moved into a baked texture: the fragment got cheap
  // enough to afford the lingering bank again, which is what makes the second
  // and third circles drive through the first one's smoke. The count and the
  // life are ONE budget — particles = rate × life — so both moved together.
  // FEWER, BIGGER, DENSER. Reference footage of a real burnout is a solid low
  // wall that swallows the car, not a lace of wisps — and coverage from a few
  // large opaque puffs costs LESS fill than the same coverage from many small
  // transparent ones, because the overdraw stacks up far shallower.
  const SMOKE_MAX = [300, 700, 1300, 2100][quality.rung()] ?? 1300
  const SMOKE_LIFE = 7
  // the road surface, in metres. Puff centres are clamped here (see the floor
  // in smokeStep) so no part of the plume is ever born or driven under it.
  const SMOKE_FLOOR = 0.06
  const smokePos = new Float32Array(SMOKE_MAX * 3)
  const smokeVel = new Float32Array(SMOKE_MAX * 3)
  const smokeLife = new Float32Array(SMOKE_MAX)
  const smokeSize = new Float32Array(SMOKE_MAX)
  const smokeSeed = new Float32Array(SMOKE_MAX)
  let smokeHead = 0
  let smokeDebt = 0
  // An INSTANCED BILLBOARD MESH, not THREE.Points. Points renders nothing at
  // all through this renderer and post chain — verified with the plainest case
  // there is: 1500 opaque 25 px points, depth test off, parked 12 m in front of
  // a frozen camera, zero pixels. Instanced sprites are the path three's WebGPU
  // renderer actually supports for particles, and the simulation above does not
  // care which one draws it.
  // An instanced quad per puff, billboarded EXPLICITLY in the vertex stage.
  //
  // Two other paths were tried and neither draws. THREE.Points renders nothing
  // at all through this renderer and post chain — verified with the plainest
  // case there is: 1500 opaque 25 px points, depth test off, parked 12 m in
  // front of a frozen camera, zero pixels. SpriteNodeMaterial on an
  // InstancedMesh does issue its draw call, but the instance matrices never
  // reach it, so all 2600 quads collapse onto the object's origin — the
  // renderer reported one draw call and ONE triangle for 2600 instances.
  //
  // So the centre and the size travel as instanced attributes and the quad is
  // expanded in view space by hand: transform the centre, add the corner
  // offset before projection. That is what makes it face the camera, and it
  // depends on nothing the renderer has to infer.
  // It MUST be an InstancedBufferGeometry. Setting instanceCount on a plain
  // PlaneGeometry does nothing at all — three only instances a geometry that
  // says it is instanced, so exactly one quad was drawn for 2600 particles,
  // which is what the renderer's own triangle counter was reporting.
  const smokeQuad = new THREE.PlaneGeometry(1, 1)
  const smokeGeom = new THREE.InstancedBufferGeometry()
  smokeGeom.index = smokeQuad.index
  smokeGeom.setAttribute('position', smokeQuad.attributes.position)
  smokeGeom.setAttribute('uv', smokeQuad.attributes.uv)
  const smokeCentre = new Float32Array(SMOKE_MAX * 3)
  const smokeCentreAttr = new THREE.InstancedBufferAttribute(smokeCentre, 3)
  const smokeWideAttr = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_MAX), 1)
  const smokeLifeAttr = new THREE.InstancedBufferAttribute(smokeLife, 1)
  const smokeSeedAttr = new THREE.InstancedBufferAttribute(smokeSeed, 1)
  smokeGeom.setAttribute('aCentre', smokeCentreAttr)
  smokeGeom.setAttribute('aWide', smokeWideAttr)
  smokeGeom.setAttribute('aLife', smokeLifeAttr)
  smokeGeom.setAttribute('aSeed', smokeSeedAttr)

  // Tileable value noise, BAKED. mx_noise per fragment cost 7.1 ms on a plume
  // that fills the screen, because it runs once per fragment per layer and the
  // layers are many. One texture fetch is a fraction of that and, sampled at a
  // per-puff offset, gives the same thing: no two puffs share a patch, and the
  // erosion below still breaks up the silhouette.
  const smokeNoiseTex = (() => {
    const N = 512
    const CELL = 8 // lattice cells across, so the result tiles at N
    const lat = new Float32Array(CELL * CELL)
    for (let i = 0; i < lat.length; i += 1) lat[i] = Math.random()
    const at = (cx, cy) => lat[((cy % CELL) + CELL) % CELL * CELL + (((cx % CELL) + CELL) % CELL)]
    const fade = (t) => t * t * (3 - 2 * t)
    const data = new Uint8Array(N * N)
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        let v = 0
        let amp = 0.55
        let freq = 1
        // FIVE octaves. This is baked once at boot, so the detail is free —
        // the shader still does exactly one fetch. Two octaves at a 16 cell
        // lattice was what made the puffs read as soft blobs.
        for (let o = 0; o < 5; o += 1) {
          const fx = (x / N) * CELL * freq
          const fy = (y / N) * CELL * freq
          const x0 = Math.floor(fx)
          const y0 = Math.floor(fy)
          const tx = fade(fx - x0)
          const ty = fade(fy - y0)
          const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx
          const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx
          v += (a + (b - a) * ty) * amp
          amp *= 0.5
          freq *= 2
        }
        data[y * N + x] = Math.max(0, Math.min(255, Math.round(v * 255)))
      }
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RedFormat)
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    // MIPMAPS. Without them a 3 m puff a couple of metres from the lens
    // magnifies single texels and the smoke goes blocky exactly where it is
    // biggest on screen — the pixellation on the asphalt.
    t.generateMipmaps = true
    t.minFilter = THREE.LinearMipmapLinearFilter
    t.magFilter = THREE.LinearFilter
    t.anisotropy = renderer.getMaxAnisotropy?.() ?? 8
    t.needsUpdate = true
    return t
  })()

  // The sun, in VIEW space, so the puffs are lit by the same light the city is.
  // One vector a frame, not one per particle.
  const smokeSun = uniform(new THREE.Vector3(0, 1, 0))
  // 1 = soften against the road, 0 = off. A switch so the term can be bisected.
  const smokeGroundMix = uniform(1)
  const smokeMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false, // smoke must not occlude smoke
  })
  {
    const life = instancedBufferAttribute(smokeLifeAttr)
    const seed = instancedBufferAttribute(smokeSeedAttr)
    const centre = instancedBufferAttribute(smokeCentreAttr)
    const wide = instancedBufferAttribute(smokeWideAttr)
    // billboard: the corner offset is added AFTER the view transform, so the
    // quad always faces the camera however the world is oriented
    const viewCentre = modelViewMatrix.mul(vec4(centre, 1))
    const corner = positionGeometry.xy.mul(wide)
    const viewPos = vec3(viewCentre.xy.add(corner), viewCentre.z)
    smokeMat.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, viewCentre.w))
    // How high off the road THIS FRAGMENT is — not the puff's centre. The quad
    // is expanded in view space, so its world height has to come back through
    // the camera's own matrix.
    const fragY = varying(cameraWorldMatrix.mul(vec4(viewPos, 1)).y)

    // NEAR FADE. Nothing costs more than a puff a metre from the lens: it
    // covers the whole screen, and there are thousands behind it. Fading them
    // out as they close on the camera cuts the worst of the overdraw and stops
    // the frame whiting out when the car drives the camera into its own bank.
    const viewZ = viewCentre.z.negate()
    // 0.35 … 1.5 m, NOT 1.2 … 5. The wide range was cutting the collar on the
    // tyre to 31% opacity at the 2.6 m a wheel close-up is shot from — the
    // optimisation was erasing the exact thing it was meant to leave alone.
    // Only puffs effectively on the lens are worth culling.
    const nearFade = smoothstep(0.35, 1.5, viewZ)
    const age = life.oneMinus()
    // Each puff turns on its own axis, and keeps turning as it ages. Without
    // this the noise pattern is identical in every puff and the eye finds it.
    const spun = rotateUV(spriteUV(), seed.mul(6.283).add(age.mul(seed.sub(0.5).mul(3.4))), vec2(0.5, 0.5))
    const p = spun.sub(0.5).mul(2) // −1 … 1 across the quad
    const r2 = p.dot(p)
    const r = r2.sqrt()
    // Fractal noise in 3D, the third axis being the particle's own seed, so no
    // two puffs share a slice. It drifts with age too, so the puff churns
    // internally instead of merely scaling up.
    // One texture fetch, offset per puff so no two sample the same patch, and
    // drifting with age so the puff churns instead of merely scaling up.
    // offset AND scale per puff: sharing a scale makes a crowd of puffs read as
    // one repeating pattern however well they are offset
    const nScale = seed.mul(0.7).add(0.65)
    const nUV = spun.mul(nScale).add(vec2(seed.mul(7.3), seed.mul(3.1).add(age.mul(0.25))))
    // TWO OCTAVES. One fetch across a 4 m puff magnifies a 512 texture about
    // eightfold, and close to the lens the value noise starts showing its own
    // cells — that is the blockiness, and no amount of mip or anisotropy fixes
    // magnification. A second octave at 3.7x the frequency, scrolling the other
    // way, puts detail back at exactly the scale the first one has run out of,
    // and the two drifting against each other churn the puff internally.
    const n1 = texture(smokeNoiseTex, nUV).r
    const n2 = texture(smokeNoiseTex, nUV.mul(3.7).sub(vec2(age.mul(0.31), seed.mul(2.7)))).r
    const n = n1.mul(0.65).add(n2.mul(0.35)).mul(2).sub(1)
    const core = smoothstep(1, 0.1, r)
    const dens = core.mul(n.mul(0.62).add(0.66)).max(0)
    // ALPHA EROSION, not a uniform fade. A puff that fades evenly keeps its
    // shape while going transparent, which reads as a dissolving decal; real
    // smoke breaks up, thin parts first. So the cutoff RISES with age and eats
    // the puff from its edges inward.
    const eaten = smoothstep(age.mul(0.6), age.mul(0.6).add(0.42), dens)
    const fadeIn = smoothstep(1, 0.9, life)
    // Spherical billboard normal: the quad is shaded as if it were a ball,
    // which is what gives a flat sprite its roundness under a real light.
    const nrm = vec3(p, r2.oneMinus().max(0).sqrt()).normalize()
    const lit = nrm.dot(smokeSun).mul(0.5).add(0.5) // half-Lambert; smoke wraps light
    const sky = mix(color(0x0a1418), color(0xbcd2e8), nrm.y.mul(0.5).add(0.5))
    // ...and self-shadowing: dense middles are darker because less light gets
    // through them. Per fragment, this is what gives the cloud volume.
    const shade = dens.oneMinus().mul(0.72).add(0.2)
    // Each puff is nearly invisible on its own — smoke is what forty of them
    // ADD UP TO. At 0.5 they saturated to a flat white splodge the moment they
    // overlapped, which is the classic way particle smoke goes wrong.
    // ...and it THINS as it expands, because the same rubber is spread through
    // a bigger volume. Without this the puff keeps its density while growing to
    // 3.7 m, so old smoke ends up denser than fresh — the opposite of what
    // happens — and never clears into the air.
    // SOFT AGAINST THE GROUND. A billboard is a flat card, so where it passes
    // through the road it ends in a dead-straight cut across the asphalt — the
    // hard edge that reads as pixellation. Games fade a particle out as it
    // closes on whatever is behind it; the road is a known plane here, so the
    // fade can be exact instead of needing a depth buffer. Over the last half
    // metre the puff thins to nothing, and the smoke hugs the tarmac instead
    // of being sliced by it.
    const ground = mix(float(1), smoothstep(GROUND_Y, GROUND_Y.add(0.34), fragY), smokeGroundMix)
    const thin = age.mul(2.6).add(1).reciprocal()
    // 1.9 drove every puff past full opacity on its own, so forty of them
    // overlapping saturated to a flat white wall that washed the city out
    // behind it — milk, not smoke. Smoke is what a CROWD of nearly invisible
    // puffs adds up to, so each one has to stay well under 1 and let the
    // others show through it.
    smokeMat.opacityNode = eaten.mul(fadeIn).mul(thin).mul(nearFade).mul(ground).mul(0.62)
    // ...and it must stay OUT of the bloom, whose threshold is 0.75. Lit smoke
    // pushed past that glows like a light source, which is what turned the
    // plume into a lamp lying on the road. This peaks near 0.56 — bright
    // enough to read against night asphalt, dim enough for bloom to ignore it.
    // WHITE. Tyre smoke is vaporised rubber and water, not soot — the dense
    // side of a puff is mid grey, never near black, and 0x26282c was reading
    // as an explosion rather than a burnout. Both ends sit under the bloom
    // threshold of 0.75 (this peaks near 0.69), so it stays smoke and does not
    // become a light source.
    smokeMat.colorNode = mix(
      color(0x7c828a),
      sky.mul(0.32).add(color(0xfff4e2).mul(lit).mul(0.45)),
      shade,
    )
  }
  smokeGeom.instanceCount = SMOKE_MAX
  const smoke = new THREE.Mesh(smokeGeom, smokeMat)
  smoke.frustumCulled = false
  smoke.renderOrder = 2
  scene.add(smoke)

  const smokeClear = () => {
    smokeLife.fill(0)
    smokeLifeAttr.needsUpdate = true
  }

  const smokeSpawn = (x, y, z, vx, vy, vz, size) => {
    const i = smokeHead
    smokeHead = (smokeHead + 1) % SMOKE_MAX
    const j = i * 3
    smokePos[j] = x
    smokePos[j + 1] = y
    smokePos[j + 2] = z
    smokeVel[j] = vx
    smokeVel[j + 1] = vy
    smokeVel[j + 2] = vz
    smokeLife[i] = 1
    smokeSize[i] = size
    smokeSeed[i] = Math.random()
    smokeSeedAttr.needsUpdate = true
  }

  const smokeSunV = new THREE.Vector3()
  let smokeClock = 0
  // Everything the car needs to shove the air about, worked out once a frame
  const smokeWake = { on: false, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 0, rx: 0, rz: 0, spin: 0 }
  // the rear hubs, in world, refreshed each frame so the swirl follows them
  const smokeHubs = []
  const smokeHubTmp = new THREE.Vector3()
  const smokeStep = (dt, s) => {
    smokeClock += dt
    const windVX = WIND.dir.x * WIND.speed * WIND.now
    const windVZ = WIND.dir.z * WIND.speed * WIND.now
    if (s) {
      const sy = Math.sin(s.yaw)
      const cy = Math.cos(s.yaw)
      smokeWake.on = true
      smokeWake.x = s.x
      smokeWake.z = s.z
      smokeWake.fx = sy
      smokeWake.fz = cy
      smokeWake.rx = cy
      smokeWake.rz = -sy
      // the car's WORLD velocity, which in a drift is nothing like its heading
      smokeWake.vx = s.u * sy + s.v * cy
      smokeWake.vz = s.u * cy - s.v * sy
      // The wheel's ANGULAR rate, in rad/s — not a linear speed. Using the
      // linear one here is why the collar barely turned: ω = tread / radius is
      // 58 rad/s at 21 m/s of tread, and feeding 6.7 in its place made the
      // tangential velocity about three times too slow to read as rotation.
      // 0.3 is entrainment: the air near a tyre is dragged round with it, not
      // carried at the rim's own speed.
      const spinUp = s.rearSlipping ? 1 + 1.6 * Math.min(1, s.throttle) : 1
      const tread = s.u * spinUp + (s.rearSlipping ? 4 * s.throttle : 0)
      smokeWake.spin = Math.max(-26, Math.min(26, (tread / ROLLING_RADIUS) * 0.3))
      smokeHubs.length = 0
      for (const group of wheelGroups) {
        if (group.isFront) continue
        group.knuckle.getWorldPosition(smokeHubTmp)
        smokeHubs.push(smokeHubTmp.x, smokeHubTmp.y, smokeHubTmp.z)
      }
    } else {
      smokeWake.on = false
    }
    // the key light, rotated into view space for the billboard normals
    smokeSunV.copy(moon.position).sub(moon.target.position).normalize()
      .transformDirection(camera.matrixWorldInverse)
    smokeSun.value.copy(smokeSunV)
    for (let i = 0; i < SMOKE_MAX; i += 1) {
      if (smokeLife[i] <= 0) continue
      smokeLife[i] = Math.max(0, smokeLife[i] - dt / SMOKE_LIFE)
      const j = i * 3
      smokePos[j] += smokeVel[j] * dt
      smokePos[j + 1] += smokeVel[j + 1] * dt
      smokePos[j + 2] += smokeVel[j + 2] * dt
      // Turbulence. A plume that only expands and rises looks like a balloon;
      // what makes it read as smoke is the churn, so each particle gets its own
      // slow swirl keyed to its seed.
      const ph = smokeSeed[i] * 6.283
      smokeVel[j] += Math.sin(smokeClock * 1.9 + ph) * 1.5 * dt
      smokeVel[j + 2] += Math.cos(smokeClock * 1.5 + ph * 1.7) * 1.5 * dt
      // Drag against MOVING air. This is the term that makes the trail — a puff
      // is decelerated to the speed of the air around it, so the car leaves it
      // behind and the smoke streams off the back rather than following the car
      // round. The air is no longer still: it relaxes to the wind instead of to
      // zero, which is what walks the whole bank slowly downwind and keeps the
      // smoke agreeing with the trees.
      const drag = 1 - Math.min(0.9, 2.8 * dt)
      smokeVel[j] = windVX + (smokeVel[j] - windVX) * drag
      smokeVel[j + 2] = windVZ + (smokeVel[j + 2] - windVZ) * drag
      // Buoyancy, and it is WEAK and BUILDING — the opposite of what it was.
      // Tyre smoke is barely warmer than the air it is in: it does not climb,
      // it hangs and spreads into a low bank, and only drifts upward later as
      // the puff grows and entrains warmer air. Lifting hardest when young sent
      // it 7 m up inside one lap, so by the time the car came round again on
      // the second circle the smoke was overhead instead of in front of it.
      // A lap of this circle takes 5.1 s, and at that age the bank now sits
      // about 0.7 m up — under the car's roofline, so the car drives INTO it
      // rather than beneath it — and is still only ~1.1 m by the time it ages
      // out. The puffs are 4 m across, so the bank still stands about head
      // height; it is the CENTRES that stay low.
      const age = 1 - smokeLife[i]
      smokeVel[j + 1] = smokeVel[j + 1] * drag + (0.05 + age * 0.3) * dt

      // THE WHEEL'S OWN SWIRL. A spinning tyre drags the air round with it, so
      // smoke that is still in the arch turns with the wheel instead of just
      // drifting off — which is what makes a burnout look like it is coming OUT
      // of the wheel rather than past it. The tangential velocity is ω × r
      // about the axle, and the axle of an unsteered rear wheel is the car's
      // own lateral axis. Capped well under tread speed, because the air near a
      // wheel is dragged along, not carried at the rim.
      if (smokeWake.on && smokeWake.spin) {
        for (let w = 0; w < smokeHubs.length; w += 3) {
          const hx = smokePos[j] - smokeHubs[w]
          const hy = smokePos[j + 1] - smokeHubs[w + 1]
          const hz = smokePos[j + 2] - smokeHubs[w + 2]
          const d2 = hx * hx + hy * hy + hz * hz
          if (d2 > 0.81) continue // outside the arch
          const near = 1 - Math.sqrt(d2) / 0.9
          // ω about the axle, signed so the tread at the bottom runs backwards
          const wx = -smokeWake.spin * smokeWake.rx
          const wz = -smokeWake.spin * smokeWake.rz
          const tx = -wz * hy
          const ty = wz * hx - wx * hz
          const tz = wx * hy
          // the air in the arch is the car's motion PLUS the wheel's rotation
          const k = Math.min(1, near * dt * 20)
          smokeVel[j] += (tx + smokeWake.vx * 0.62 - smokeVel[j]) * k
          smokeVel[j + 1] += (ty - smokeVel[j + 1]) * k
          smokeVel[j + 2] += (tz + smokeWake.vz * 0.62 - smokeVel[j + 2]) * k
          // ...and HELD against the tyre. Tangential velocity alone throws a
          // puff straight off on the first quarter turn, so it never gets round
          // far enough to read as a collar. This pulls it back toward the
          // tread's own radius — the orbit real photographs show — and lets go
          // as the puff ages out of the arch.
          const ax = hx - smokeWake.rx * (hx * smokeWake.rx + hz * smokeWake.rz)
          const az = hz - smokeWake.rz * (hx * smokeWake.rx + hz * smokeWake.rz)
          const rp = Math.hypot(ax, hy, az)
          if (rp > 0.05) {
            const pull = (ROLLING_RADIUS + 0.07 - rp) * near * 26 * dt
            smokeVel[j] += (ax / rp) * pull
            smokeVel[j + 1] += (hy / rp) * pull
            smokeVel[j + 2] += (az / rp) * pull
          }
        }
      }

      // THE CAR'S WAKE. On the second and third circles the car drives back
      // through its own smoke, and a car going through smoke does not pass it
      // cleanly: it drags it along, shoulders it aside and sucks it upward
      // behind. Without this the plume just intersects the bodywork and the
      // whole thing reads as a decal.
      if (smokeWake.on) {
        const dx = smokePos[j] - smokeWake.x
        const dz = smokePos[j + 2] - smokeWake.z
        const lon = dx * smokeWake.fx + dz * smokeWake.fz
        const lat = dx * smokeWake.rx + dz * smokeWake.rz
        const h = smokePos[j + 1]
        if (lon > -4.5 && lon < 4.5 && lat > -3 && lat < 3 && h < 2.2) {
          const near = (1 - Math.abs(lon) / 4.5) * (1 - Math.abs(lat) / 3) * (1 - h / 2.2)
          const push = near * dt * 7
          const side = lat >= 0 ? 1 : -1
          smokeVel[j] += (smokeWake.vx * 0.5 + smokeWake.rx * side * 2.2) * push
          smokeVel[j + 2] += (smokeWake.vz * 0.5 + smokeWake.rz * side * 2.2) * push
          smokeVel[j + 1] += push * 2.6 // the low pressure behind lifts it
        }
      }

      // THE ROAD IS A FLOOR, and nothing used to say so. Two terms above drive
      // a puff DOWN: the wheel swirl is genuinely down-going at the front of
      // the tyre, and the radial hold pushes anything below the axle further
      // below it — which is every puff, because smoke is born at the contact
      // patch 0.33 m under the hub. Centres were reaching 1.47 m UNDER the
      // asphalt, so half of every plume was buried and the billboards ended in
      // hard straight cuts where they came back out through the tarmac.
      // A real plume that hits the deck cannot pass through it: it stagnates
      // and rolls OUTWARD, which is the low spreading skirt a burnout sits in.
      // So the velocity that would bury a puff is turned into lateral spread
      // away from the car rather than thrown away.
      if (smokePos[j + 1] < SMOKE_FLOOR) {
        smokePos[j + 1] = SMOKE_FLOOR
        const into = -smokeVel[j + 1]
        if (into > 0) {
          smokeVel[j + 1] = into * 0.05 // a whisper of rebound, not a trampoline
          const ox = smokePos[j] - smokeWake.x
          const oz = smokePos[j + 2] - smokeWake.z
          const orad = Math.hypot(ox, oz) || 1
          smokeVel[j] += (ox / orad) * into * 0.55
          smokeVel[j + 2] += (oz / orad) * into * 0.55
        }
      }
    }
    // Centre AND width ride as instanced attributes. Width grows as the SQUARE
    // ROOT of age: rubber flashes off the patch and billows at once, then
    // slows. Linear growth looked like an inflating balloon and ran to 7.6 m,
    // which is fog, not smoke. A dead puff is simply zero wide.
    const wide = smokeWideAttr.array
    for (let i = 0; i < SMOKE_MAX; i += 1) {
      const j = i * 3
      smokeCentre[j] = smokePos[j]
      smokeCentre[j + 1] = smokePos[j + 1]
      smokeCentre[j + 2] = smokePos[j + 2]
      wide[i] = smokeLife[i] > 0 ? smokeSize[i] + Math.sqrt(1 - smokeLife[i]) * 3.0 : 0
    }
    smokeCentreAttr.needsUpdate = true
    smokeWideAttr.needsUpdate = true
    smokeLifeAttr.needsUpdate = true
    // the seed is written once at spawn and never again, so it is flagged there
    // rather than re-uploaded with everything else on every frame
  }

  // Off the SPINNING TREAD, not merely puffed out of the contact patch. A
  // smoking tyre lays its rubber down over an arc, and the tread carries the
  // smoke round with it and flings it off tangentially — which is why in real
  // footage the plume leaves backwards along the ground and then curls UP
  // behind the wheel and into the arch. So each puff is born somewhere on the
  // tyre's rear arc and leaves along the tangent AT THAT POINT: straight back
  // at the patch, rotating to straight up a quarter turn behind it. That
  // rotation is the wheel's own.
  //
  // The speed it is flung at is the SLIP SURPLUS — how much faster the tread
  // is moving than the road. A tyre rolling in step with the ground does not
  // smoke however fast it is going, which is the whole reason this is keyed to
  // the surplus and not to the car's speed.
  const smokeAt = new THREE.Vector3()
  const smokeEmit = (s, dt) => {
    const vSigned = s.u
    // the same tread speed showSpin turns the wheels at, so smoke and wheel agree
    const spinUp = s.rearSlipping ? 1 + 1.6 * Math.min(1, s.throttle) : 1
    const tread = vSigned * spinUp + (s.rearSlipping ? 4 * s.throttle : 0)
    const surplus = Math.abs(tread - vSigned) // tread over ground: the wheelspin
    const lat = s.v - CAR.b * s.r // the rear axle's lateral slip
    const slide = Math.abs(lat)
    const slipSpeed = Math.hypot(surplus, slide)
    if (slipSpeed < 1.2) return // rolling, not sliding: no smoke

    const sy = Math.sin(s.yaw)
    const cy = Math.cos(s.yaw)
    // car axes in world: the rear wheels do not steer, so these are the tyre's
    const fwdX = sy
    const fwdZ = cy
    const rgtX = cy
    const rgtZ = -sy
    const fling = Math.min(9, surplus * 0.55)
    const sideways = Math.sign(lat || 1) * Math.min(7, slide * 0.34)
    // The car's own world velocity. Smoke held in the arch RIDES WITH THE CAR —
    // at 9 m/s the wheel is a metre past a puff a tenth of a second after it is
    // born, so without this the collar is driven out from under itself and
    // never lasts more than a frame or two however hard the swirl holds it.
    const carVx = s.u * sy + s.v * cy
    const carVz = s.u * cy - s.v * sy

    // Rate matched to the BUDGET: two wheels spawn per debt unit and a puff
    // lives SMOKE_LIFE, so anything over SMOKE_MAX/(2·SMOKE_LIFE) recycles
    // particles while they are still visible and the plume loses its tail.
    smokeDebt += Math.min(SMOKE_MAX / (2 * SMOKE_LIFE), slipSpeed * 40) * dt
    while (smokeDebt >= 1) {
      smokeDebt -= 1
      for (const group of wheelGroups) {
        if (group.isFront) continue
        group.knuckle.getWorldPosition(smokeAt)
        const centreY = smokeAt.y
        // Where on the tyre's arc: 0 is the contact patch, and it now runs to
        // 2.2 rad — up the back of the tyre, over its shoulder and INTO the
        // arch. Stopping at 1.35 left the smoke leaving the bottom of the
        // wheel only, so none of it was ever inside the wheel well.
        const th = Math.random() ** 0.7 * 2.2
        const ct = Math.cos(th)
        const st = Math.sin(th)
        // position: down from the hub, rotated backwards by th
        const rad = ROLLING_RADIUS + 0.02
        const across = (Math.random() - 0.5) * 0.28 // over the tread's width
        // tangent at that point: back at the patch, up a quarter turn behind
        const tanBack = ct
        const tanUp = st
        // Nearly two in three leave slowly. A puff thrown off at full tread
        // speed is clear of the wheel before it has turned a quarter, so if
        // they all leave hard there is never a collar on the tyre — only a
        // trail behind it. The slow ones get caught by the swirl above and ride
        // round. At two in five only 14 puffs were ever on a wheel, which is
        // not enough to see at 13% opacity apiece.
        const grip = Math.random() < 0.62 ? 0.1 : 1
        // How much of the car's motion a puff is born with. It is entrained
        // air, not a passenger: it goes with the wheel for a moment and then
        // the atmosphere — which is STILL — brings it to rest, and the car
        // drives away from it. That is what lays a trail. At 0.92 the smoke
        // kept station with the car for half a second and ~4 m, so it looked
        // glued to the bodywork instead of streaming off the back.
        const carry = grip < 1 ? 0.6 : 0.2
        smokeSpawn(
          smokeAt.x - fwdX * st * rad + rgtX * across,
          centreY - group.centreToBottom + rad * (1 - ct) + 0.02,
          smokeAt.z - fwdZ * st * rad + rgtZ * across,
          carVx * carry - fwdX * tanBack * fling * grip - rgtX * sideways * grip + (Math.random() - 0.5) * 1.1 * grip,
          tanUp * fling * 0.07 * grip + 0.06 + Math.random() * 0.12,
          carVz * carry - fwdZ * tanBack * fling * grip - rgtZ * sideways * grip + (Math.random() - 0.5) * 1.1 * grip,
          0.7 + Math.random() * 0.5,
        )
      }
    }
  }

  // Per-axle wheel spin. The shared spinWheels() turns every wheel at one
  // rate, which is right for a car that is driving and wrong for one that is
  // sideways: here the rears are lit up and the fronts are only rolling.
  // Same anti-strobe clamp as the original — past it the eye reads the wheel
  // as turning backwards and the whole car as fake.
  // What the two axles are actually doing, in m/s of tread. showSpin already
  // turns the front and rear meshes at different rates during a burnout; this
  // just remembers the pair so the BLUR can tell them apart too. Both zero
  // until the show runs, which yields a ratio of 1 and changes nothing.
  const wheelTread = { front: 0, rear: 0 }
  const showSpin = (frontSpeed, rearSpeed, dt) => {
    wheelTread.front = frontSpeed
    wheelTread.rear = rearSpeed
    for (const group of wheelGroups) {
      const v = group.isFront ? frontSpeed : rearSpeed
      const spin = (v / ROLLING_RADIUS) * dt
      const step = Math.sign(spin) * Math.min(Math.abs(spin), MAX_SPIN_STEP)
      for (const member of group.members) {
        if (wheelPivots.includes(member.pivot)) member.pivot.rotation.x += step
      }
    }
  }

  let show = null
  const showTravel = new THREE.Vector3()
  const showFocus = new THREE.Vector3()

  const stopShow = () => {
    if (!show) return
    show = null
    for (const group of wheelGroups) group.knuckle.rotation.z = 0 // drop the camber
    smokeClear()
    restWheels()
    setSpeedFx(null, 0, null)
  }

  const startShow = (at = 0) => {
    if (show) return
    // Steer first, then camber: with the default XYZ order the camber is
    // applied about the CAR's axis and a steered wheel leans partly into toe,
    // throwing its outer corner further out still. 'YZX' composes them the
    // way an upright actually works.
    for (const group of wheelGroups) group.knuckle.rotation.order = 'YZX'
    const segs = buildShow()
    const start = curveAt(segs[0].path, 0)
    show = {
      segs,
      i: Math.max(0, Math.min(8, at)),
      t: 0,
      clock: 0, // runs the whole loop; the snap edit cuts off it
      speed: 0,
      // the vehicle's own state: world pose, body-frame velocities, yaw rate
      x: start.x,
      z: start.z,
      yaw: start.dir,
      u: 33, // it comes out of the tunnel already moving, at the line's speed
      v: 0,
      r: 0,
      ax: 0,
      latAccel: 0,
      slip: 0,
      steer: 0,
      throttle: 0,
      brakes: 0,
      gear: 1,
      rearSlipping: false,
      // suspension, same spring–damper the drive mode runs
      sy: CITY_ASPHALT_Y + rideHeight,
      svy: 0, sp: 0, svp: 0, sr: 0, svr: 0,
    }
    taycan.rotation.set(0, Math.PI, 0)
  }

  const updateShow = (dt) => {
    const s = show
    let seg = s.segs[s.i]
    s.t += dt
    s.clock += dt
    // roll into the next segment, carrying any overshoot so a long frame
    // never loses time out of the choreography
    let guard = 0
    while (s.t >= seg.dur && guard < 12) {
      s.t -= seg.dur
      const wrapped = s.i === s.segs.length - 1
      s.i = (s.i + 1) % s.segs.length
      seg = s.segs[s.i]
      guard += 1
      // Round the loop: set the car back on the head of the line, facing
      // down it. A simulated car cannot be trusted to arrive at exactly the
      // seam after 29.8 s of tyre forces, and the seam is inside the bore
      // where nothing can see the correction.
      if (wrapped) {
        const head = curveAt(seg.path, 0)
        s.x = head.x
        s.z = head.z
        s.yaw = head.dir
        s.v = 0
        s.r = 0
        s.u = Math.max(s.u, 24)
      }
    }
    const u = seg.dur > 0 ? Math.max(0, Math.min(1, s.t / seg.dur)) : 0

    // The line is no longer where the car IS — it is where the driver is
    // trying to be. Position comes out of the tyres.
    // Lookahead. It must stay WELL INSIDE the radius of whatever the car is
    // driving round: at 15 m/s the old rule looked 8.25 m ahead on a 5.2 m
    // circle, so the driver aimed clean across the middle of the donut, sawed
    // at the wheel and never settled into the turn at all — the yaw rate was
    // flipping sign mid-circle. Capped at 4 m it commits to the arc, the
    // rears go, and the drift develops on its own.
    const ahead = seg.hold ? 0 : Math.max(1.4, Math.min(seg.look || 4, Math.abs(s.u) * 0.32))
    const ref = seg.hold
      ? { x: s.x, z: s.z, dir: s.yaw }
      : curveAt(seg.path, Math.min(seg.path.len, seg.distAt(u) + ahead))
    s.reverse = !!seg.reverse
    s.burn = typeof seg.burn === 'function' ? seg.burn(u) : seg.burn || 0
    s.spin = seg.spin || 0 // which way the tail is out, off the arc, not the car
    const want = {
      speed: seg.hold ? 0 : seg.v(u) * (seg.reverse ? -1 : 1),
      reverse: !!seg.reverse,
      // the donut is ORDERED: hold the wheel on and bury the throttle, and
      // let the friction circle take the rear grip away by itself
      power: !!seg.burn && !seg.hold && (typeof seg.burn === 'function' ? seg.burn(u) : seg.burn) > 0.5,
    }
    s.gear = seg.reverse ? -1 : 1
    s.wantSpeed = want.speed
    s.radius = seg.radius || 0
    s.cx = seg.cx || 0
    s.cz = seg.cz || 0
    // The exit needs the same hand on it as the circle. Unwinding the sideslip
    // alone put the nose 26° PAST straight — it left the drift pointing 116°
    // and arrived at the mark pointing 64°, having swung through east without
    // anything watching the heading.
    s.hug = !!seg.hug
    s.pathDir = seg.hold ? 0 : curveAt(seg.path, seg.distAt(u)).dir
    s.aim = typeof seg.drift === 'function' ? seg.drift(u) : seg.drift || 0

    const sub = Math.max(1, Math.ceil(dt / 0.004)) // stiff tyres want small steps
    const hsub = dt / sub
    for (let k = 0; k < sub; k += 1) {
      driveCar(s, ref, want, hsub)
      stepCar(s, hsub)
    }

    // The rubber band. Weak — it is a nudge toward the schedule, not a rail —
    // and weakest of all inside the drift, where being 30 cm off the line is
    // the point. Without it a 29.8 s lap of real physics would never park in
    // the same place twice, and the charger, the median gap and the tunnel
    // seam all depend on it doing so.
    if (!seg.hold) {
      const mark = curveAt(seg.path, seg.distAt(u))
      const pull = (want.power ? 0.35 : 3.4) * dt
      s.x += (mark.x - s.x) * Math.min(1, pull)
      s.z += (mark.z - s.z) * Math.min(1, pull)
    }

    // A parked car is parked. A hold has no line to pull the car onto, and
    // nothing in a tyre model stops a rolling one at a standstill: 0.3 m/s of
    // residual creep out of the reverse walked the car 0.40 m off the charger
    // over the 7 s it sits there. This is the handbrake going on, firmly
    // rather than instantly, so the stop still reads as a stop.
    if (seg.hold) {
      const grab = Math.min(1, dt * 6)
      s.u -= s.u * grab
      s.v -= s.v * grab
      s.r -= s.r * grab
      if (Math.abs(s.u) < 0.02) s.u = 0
    }

    // A real-time tyre model can diverge — a bad frame, a pathological step —
    // and once it does every number downstream is NaN and the scene is dead.
    // Put the car back on its mark and carry on; one lost frame beats a
    // stopped show, and it is logged so it is never silently tolerated.
    if (s.blewUp) {
      const mark = seg.hold ? { x: s.x, z: s.z, dir: s.yaw } : curveAt(seg.path, seg.distAt(u))
      s.x = Number.isFinite(mark.x) ? mark.x : 0
      s.z = Number.isFinite(mark.z) ? mark.z : 0
      s.yaw = Number.isFinite(mark.dir) ? mark.dir : 0
      s.u = seg.hold ? 0 : Math.abs(seg.v(u))
      s.v = 0
      s.r = 0
      s.ax = 0
      s.steer = 0
      s.slip = 0
      s.latAccel = 0
      s.blewUp = false
      console.warn('[show] vehicle state diverged; reset to the line')
    }

    taycan.position.x = s.x
    taycan.position.z = s.z
    taycan.rotation.y = s.yaw
    s.speed = Math.abs(s.u)

    const vSigned = s.u
    const longAccel = s.ax
    const latAccel = s.latAccel || 0

    const roadY = showGroundY(taycan.position.x, taycan.position.z)
    const targetY = roadY + rideHeight
    // Load transfer. A donut pulls v²/r = 32 m/s² across the car — over 3 g —
    // so the roll limit is what decides how the drift reads, not the input.
    // 0.14 rad is 8°: a supersport chassis leaning hard, not a boat.
    const targetPitch = Math.max(-0.07, Math.min(0.07, longAccel * 0.0022))
    const targetRoll = Math.max(-0.14, Math.min(0.14, -latAccel * 0.0045))
    const steps = Math.max(1, Math.ceil(dt / 0.02))
    const h = dt / steps
    for (let step = 0; step < steps; step += 1) {
      s.svy += (88 * (targetY - s.sy) - 17.9 * s.svy) * h
      s.sy += s.svy * h
      s.svp += (114 * (targetPitch - s.sp) - 21.4 * s.svp) * h
      s.sp += s.svp * h
      s.svr += (114 * (targetRoll - s.sr) - 21.4 * s.svr) * h
      s.sr += s.svr * h
    }
    if (s.sy < targetY - 0.05) {
      s.sy = targetY - 0.05
      if (s.svy < 0) s.svy = 0
    }
    taycan.position.y = s.sy
    taycan.rotation.x = s.sp
    taycan.rotation.z = s.sr
    settleWheels(showGroundY)

    // CAMBER. settleWheels keeps each tyre on the road, but the knuckle still
    // rides the body, so a rolling body carries the wheels over with it and
    // the loaded one swings OUT of the arch — the opposite of what a car does.
    // Leaning the uprights back against the roll keeps the tyres nearer
    // upright to the road, which tucks the loaded wheel up under the arch as
    // the body comes over it. 0.75 rather than 1 because real suspension
    // gains some camber; a wheel dead upright under 8° of roll looks pinned.
    for (const group of wheelGroups) group.knuckle.rotation.z = -s.sr * 0.5

    // The front wheels show the angle the DRIVER is holding — pure pursuit
    // plus the countersteer reflex — not a number derived from the path.
    // CAR.lock is 34° now, and the drift is what uses it.
    const applied = s.steer
    steerWheels(applied)

    // Then pull the upright inboard by what the turn just swung outboard.
    // Measured on this body: the tyre reaches 0.989 m from centreline and the
    // wing surface beside it is 0.982 — the arches are cut FLUSH, so the
    // tyre is 7 mm proud before anything turns, and every degree of lock puts
    // another ~4.5 mm of its corner through the paint (142 mm at 33°).
    // Limiting the angle cannot fix that; only moving the wheel can. Real
    // steering geometry does a little of this through scrub radius. This does
    // all of it, which is the difference between a car and a model of one.
    // ...and it has to follow the swing, which is NOT linear in the angle:
    // 68 mm at 22° but 142 mm at 33°, so it goes as about the 1.9th power.
    // Written this way the tuck is unchanged at 22° — where it was measured —
    // and keeps the tyre inside the paint all the way to full lock instead of
    // falling 90 mm behind it there.
    const TUCK_AT = 0.38 // the angle the tuck was measured at
    const tuck = ((TUCK_AT * 0.26) / 100) * (Math.abs(applied) / TUCK_AT) ** 1.9
    for (const group of wheelGroups) {
      if (!group.isFront) continue
      group.knuckle.position.x -= Math.sign(group.rest.x) * tuck
    }
    // Wheel speed is not road speed. The fronts roll; the rears turn at
    // whatever the diff is giving them, and when the friction circle has
    // taken their grip away that is a good deal faster than the car is
    // going. The mismatch IS the burnout, and it is now measured rather
    // than dialled in.
    const spinUp = s.rearSlipping ? 1 + 1.6 * Math.min(1, s.throttle) : 1
    showSpin(vSigned, vSigned * spinUp + (s.rearSlipping ? 4 * s.throttle : 0), dt)
    smokeEmit(s, dt)
    smokeStep(dt, s)

    if (s.speed > 11) {
      showTravel.set(Math.sin(s.dir), 0, Math.cos(s.dir)).multiplyScalar(s.speed * 0.0005)
      showFocus.set(taycan.position.x, taycan.position.y + 0.55, taycan.position.z)
      setSpeedFx(showTravel, 0, showFocus)
    } else {
      setSpeedFx(null, 0, null)
    }
  }

  // --- the camera edits ------------------------------------------------------
  //
  // Scene 1's five edits are cuts around a car travelling in a straight line
  // at a locked 300 km/h; its rig is a fixed orbit and every number in it
  // assumes the car never turns. None of that survives here. This car turns,
  // slides 810° inside a circle, brakes, reverses and parks, so these edits
  // are written against the SHOW'S PHASES: each shot names the segments it
  // covers and the rig follows the car through them, cutting when the phase
  // does. Scene 1 keeps its own edits, untouched, in ../city.js.
  //
  // Four kinds of shot, and choosing between them is the whole craft:
  //
  //   orbit  az/el/dist measured off the CAR'S OWN HEADING, so the framing
  //          survives the car rotating under it. Right for chase and quarter
  //          angles — and wrong for a donut, because a rig welded to the
  //          car's heading turns with it and the slide disappears.
  //   lock   a tripod at a fixed world point, panning to hold the car. This
  //          is what makes a drift read AS a drift: the world stays put and
  //          the car rotates against it.
  //   ring   circles the donut at a fixed phase offset from the car, so the
  //          car lies across frame while the background sweeps behind it —
  //          the Tokyo Drift shot, and the reason that film's donuts read.
  //   plate  eye and target both fixed. Establishing, and nothing else.
  // Every building's footprint, so the rig can be kept out of them. A camera
  // that clips inside a wall shows the room's back faces and the shot is
  // gone, and no amount of care in the numbers prevents it once the car
  // drives somewhere the shot did not expect.
  const CITY_BLOCKS = []
  if (city) {
    const box = new THREE.Box3()
    city.updateWorldMatrix(true, true)
    city.traverse((node) => {
      if (!node.isMesh || !node.geometry || !node.visible) return
      node.geometry.computeBoundingBox()
      box.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld)
      const w = box.max.x - box.min.x
      const d = box.max.z - box.min.z
      // Compact footprints only. A long thin mesh — or anything rotated off
      // the axes — has an axis-aligned box far bigger than the thing itself:
      // Object_153 is 84 x 6.5 x 42 and its box lies straight across the open
      // junction, so treating it as a building would shove the rig off the
      // road it is supposed to be filming from.
      if (box.max.y < 4 || w * d < 20 || w > 40 || d > 40) return
      CITY_BLOCKS.push({ x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z, top: box.max.y })
    })
  }
  // Then throw away everything the CAR DRIVES THROUGH. A box alone cannot
  // tell a solid tower from a hollow gantry — the signal gantry over this
  // junction is 24 x 10 x 9.4 and its box covers the road the drift happens
  // on — but the show's own path can: the car cannot drive through a
  // building, so any footprint its route crosses is not one.
  if (CITY_BLOCKS.length) {
    const route = []
    for (const seg of buildShow()) {
      if (!seg.path) continue
      for (const pt of seg.path.pts) route.push(pt)
    }
    // DEEP inside, not merely touching. A tower's box usually laps a metre or
    // two over the kerb the car drives along, and treating that as "the car
    // goes through it" threw real buildings out of the guard — which is how
    // the rig ended up inside the tower podium. The gantry is still dropped,
    // because the car crosses the middle of it.
    const DEEP = 2
    for (let i = CITY_BLOCKS.length - 1; i >= 0; i -= 1) {
      const b = CITY_BLOCKS[i]
      if (b.x1 - b.x0 < DEEP * 2 || b.z1 - b.z0 < DEEP * 2) continue
      for (const [x, z] of route) {
        if (x > b.x0 + DEEP && x < b.x1 - DEEP && z > b.z0 + DEEP && z < b.z1 - DEEP) {
          CITY_BLOCKS.splice(i, 1)
          break
        }
      }
    }
  }

  const CITY_CLEAR = 0.6 // how far outside a wall the rig is parked
  // Iterated, because these footprints overlap: coming out through one
  // tower's wall can put the rig inside the next one, and a single pass
  // leaves it there. Four passes settles every case in this block; the cap
  // stops a pathological pair of boxes from spinning here forever.
  const keepOutOfBuildings = (eye) => {
    for (let pass = 0; pass < 4; pass += 1) {
      let moved = false
      for (const b of CITY_BLOCKS) {
        if (eye.y > b.top) continue
        if (eye.x <= b.x0 || eye.x >= b.x1 || eye.z <= b.z0 || eye.z >= b.z1) continue
        // out through the nearest wall, never through the roof
        const dx0 = eye.x - b.x0, dx1 = b.x1 - eye.x
        const dz0 = eye.z - b.z0, dz1 = b.z1 - eye.z
        const m = Math.min(dx0, dx1, dz0, dz1)
        if (m === dx0) eye.x = b.x0 - CITY_CLEAR
        else if (m === dx1) eye.x = b.x1 + CITY_CLEAR
        else if (m === dz0) eye.z = b.z0 - CITY_CLEAR
        else eye.z = b.z1 + CITY_CLEAR
        moved = true
      }
      if (!moved) return
    }
  }

  // ...and never with a wall BETWEEN it and the car.
  //
  // Pushing the eye out of a footprint fixes the camera standing in a room.
  // It does not fix the other half of the same fault: an eye parked cleanly
  // outside a tower that is nonetheless looking straight through it, which on
  // screen is the identical failure — a frame full of brickwork where the car
  // should be. The rear-quarter and tunnel angles swing the rig a long way
  // round the car, so both happen.
  //
  // March from the CAR toward the eye and stop at the first block: whatever
  // is behind that wall cannot see the car, so the shot is taken from just in
  // front of it instead. Walking outward from the subject (rather than
  // inward from the eye) means the camera always ends up on the car's side of
  // the obstruction, which is the only side worth filming from.
  //
  // 48 steps over a rig that never sits more than ~20 m out is a ~0.4 m
  // probe — finer than the 0.6 m clearance the result is pulled back by, so
  // nothing slips between two samples.
  const insideAnyBlock = (v) => {
    for (const b of CITY_BLOCKS) {
      if (v.y > b.top) continue
      if (v.x <= b.x0 || v.x >= b.x1 || v.z <= b.z0 || v.z >= b.z1) continue
      return true
    }
    return false
  }
  const marchEye = new THREE.Vector3()
  const clearLineOfSight = (eye, aim) => {
    if (!CITY_BLOCKS.length) return
    const STEPS = 48
    for (let i = 1; i <= STEPS; i += 1) {
      const t = i / STEPS
      marchEye.lerpVectors(aim, eye, t)
      for (const b of CITY_BLOCKS) {
        if (marchEye.y > b.top) continue
        if (marchEye.x <= b.x0 || marchEye.x >= b.x1 || marchEye.z <= b.z0 || marchEye.z >= b.z1) continue
        // back off to the last clear sample and stop there
        const back = Math.max(0, (i - 1) / STEPS)
        eye.lerpVectors(aim, eye, back)
        return
      }
    }
  }

  const CITY_D = SHOW_DONUT
  const cityEye = new THREE.Vector3()
  const cityAim = new THREE.Vector3()
  const cityDir = new THREE.Vector3()
  const cityRight = new THREE.Vector3()
  const cityUpv = new THREE.Vector3()
  const CITY_UP = new THREE.Vector3(0, 1, 0)

  // a car-space offset — +f out of the nose, +r out of the right flank —
  // placed into the world
  const carSpace = (out, car, yaw, r, h, f) => {
    const sy = Math.sin(yaw), cy = Math.cos(yaw)
    return out.set(car.x + f * sy - r * cy, car.y + h, car.z + f * cy + r * sy)
  }
  const orbitEye = (out, car, yaw, az, el, dist) => {
    const th = yaw + az
    const rr = Math.cos(el) * dist
    return out.set(car.x + Math.sin(th) * rr, car.y + Math.sin(el) * dist, car.z + Math.cos(th) * rr)
  }

  // THE SHOT LIST.
  //
  // The loop is 29.8 s and it tells one story: out of the tunnel, into the
  // junction, two and a quarter turns, stop, reverse to the kerb, charge.
  // A spot that length carries about a dozen shots — roughly 2.5 s each.
  // Fewer and it drags; many more and nothing is on screen long enough to be
  // looked at, which is the state this was in before: 27 angles, some of them
  // under a second, reading as a trailer for itself.
  //
  // So each edit below is a DISCIPLINED shot list, not coverage. The long
  // phases (donut 5.7 s, reverse 6.4 s, charge 7 s) carry two or three cuts;
  // everything else is one shot, held. The differences between the five are
  // differences of point of view, not of shot count:
  //
  //   IMAX   five shots, all of them wide, all of them held
  //   Snap   the fast one, and still only half what it was
  //
  // `on` names the show segments; `angles` are the cuts inside them, each
  // taking over at its `from`. `push`/`arc` move the shot over its own band,
  // `frame` puts the subject off centre, `float` keeps it human.
  const phase = (on, ...angles) => ({ on, angles })
  const ANY = null // a phase with no segment list is that edit's fallback

  const CITY_MOVIES = [
    // 01 IMAX — five shots, all wide, all held. The junction is the subject
    // and the car is what draws on it.
    {
      key: 'imax',
      phases: [
        // A car 60 m down a flat road sits ON the horizon, so no plate down
        // the street can keep the sky out. This tracks from above instead and
        // looks down at it — the ground fills the frame the whole way in.
        phase(['run-in', 'set-up'],
          { from: 0, kind: 'orbit', az: Math.PI, el: 0.95, dist: 13, fov: 42, aim: [0, 0.4, 0], float: 0.03 }),
        // 21 s is far too long to hold one frame, however wide it is. The
        // tripod opens — the world stays put and the car rotates against it,
        // which is what makes a slide read AS a slide — and then drops to the
        // rear quarter, low, where the smoke is actually coming from. Even in
        // the wide edit the back axle deserves a look: it is the only part of
        // the car doing anything.
        phase(['donut'],
          { from: 0, kind: 'lock', eye: [CITY_D.x + 9, 15, CITY_D.z - 10], fov: 40, aim: [0, 0.4, 0], frame: [0.16, 0.08], float: 0.06 },
          // Rear three-quarter, off the RIGHT hip and low, framed on the back
          // axle rather than the car's centre — so the tyre sits in frame with
          // its own smoke pouring past the lens instead of behind the bodywork.
          { from: 0.46, kind: 'orbit', az: -2.15, el: 0.11, dist: 7, fov: 34, aim: [0.8, 0.45, -1.4], arc: [0, 0.22], float: 0.03 },
          { from: 0.76, kind: 'ring', phase: 2.6, lift: 4.2, out: 9, fov: 36, aim: [0, 0.5, 0], arc: [0, 0.25], float: 0.04 }),
        // The sweep out of the circle: held low on the flank while the car is
        // still crossed up, then lifted as it straightens for the bore.
        phase(['sweep'],
          { from: 0, kind: 'orbit', az: Math.PI * 0.62, el: 0.1, dist: 9, fov: 38, aim: [0, 0.55, 0], float: 0.03 },
          { from: 0.55, kind: 'orbit', az: Math.PI * 1.05, el: 0.6, dist: 14, fov: 42, aim: [0, 0.5, 0], float: 0.035 }),
        // INTO THE LENS, not away from it. Both edits used to sit behind the
        // car for this beat — az 0.9pi and az pi — so the last thing the loop
        // showed was the boot disappearing down the bore, twice. A car going
        // somewhere is filmed from where it is GOING: the rig waits ahead of
        // it inside the mouth of the tunnel, low, and the car comes at the
        // camera with its lamps on. Then one wide plan of it swallowed.
        phase(['run-out'],
          { from: 0, kind: 'orbit', az: 0.22, el: 0.07, dist: 15, fov: 40, aim: [0, 0.55, 0], float: 0.025 },
          { from: 0.58, kind: 'orbit', az: Math.PI * 0.5, el: 0.55, dist: 19, fov: 42, aim: [0, 0.5, 0], float: 0.03 }),
        phase(ANY,
          { from: 0, kind: 'orbit', az: Math.PI * 0.85, el: 0.95, dist: 14, fov: 44, aim: [0, 0.5, 0], float: 0.03 }),
      ],
    },
    // 02 SNAP CUTS — the fast one. Still cut to the phases rather than to a
    // metronome, so the rhythm tracks the car instead of fighting it.
    {
      key: 'snap',
      phases: [
        phase(['donut'],
          // THE BACK WHEEL. The whole point of this beat is a tyre being
          // destroyed, and no shot in either edit was pointed at one — the
          // close angle here framed [-0.9, ., +1.5], which is the FRONT wheel
          // on the far side. The back axle is at f -1.48 and the tyre sits
          // 0.85 out; this hangs off the right hip at wheel height and looks
          // straight at it, close enough to read the tread turning inside the
          // smoke and far enough out to clear the near-fade (which eats any
          // puff within 1.5 m of the lens).
          //
          // HALF LENGTH, both of them. At 0.22 and 0.24 of a 21.2 s beat these
          // ran 4.7 s and 5.1 s — fine in IMAX, wrong here: a detail this tight
          // reads in about two seconds and then just sits there, which is the
          // one thing the fast edit is not for. 0.11 and 0.12 put them at 2.3 s
          // and 2.5 s, still clear of the 1.4 s floor below which a cut stops
          // registering as a shot at all.
          { from: 0, kind: 'orbit', az: -2.05, el: 0.04, dist: 3.0, fov: 30, aim: [0.85, 0.36, -1.48], float: 0.012 },
          { from: 0.11, kind: 'orbit', az: -1.57, el: 0.09, dist: 3.4, fov: 26, aim: [-0.9, 0.42, 1.5], float: 0.015 },
          { from: 0.23, kind: 'lock',
            // Clamped OUT of the frontage. This eye hangs 5 m south of the
            // circle, and the circle growing to r 7.5 walked it to z −2.7,
            // which is 0.78 m from Object_317 — inside the building. The
            // frontage south of the junction begins at about z −2, so the
            // kerb line is as far back as a low camera may go.
            eye: [CITY_D.x + 3, 0.5, Math.max(0.6, CITY_D.z - CITY_D.r - 5)], fov: 44, aim: [0, 0.6, 0], frame: [0.2, -0.05], float: 0.05 },
          { from: 0.572, kind: 'ring', phase: 3.1, lift: 7.5, out: 7, fov: 40, aim: [0, 0.4, 0], arc: [0, 0.3], float: 0.03 }),
        // THE SWEEP — square behind while it is still sideways, where a drift
        // exit is shot from, then swung round to the flank as it goes away
        phase(['sweep'],
          { from: 0, kind: 'orbit', az: Math.PI, el: 0.035, dist: 6, fov: 38, aim: [0, 0.55, 0], float: 0.02 },
          { from: 0.45, kind: 'orbit', az: -1.2, el: 0.04, dist: 4.2, fov: 30, aim: [0.6, 0.5, 1.2], float: 0.015 },
          { from: 0.75, kind: 'orbit', az: 0.5, el: 0.06, dist: 6, fov: 34, aim: [0, 0.55, 0.6], float: 0.02 }),
        // Snap never named run-out, so it fell through to ANY — az pi, square
        // behind, the same boot shot IMAX was ending on. Its own phase now,
        // and from in front.
        phase(['run-out'],
          { from: 0, kind: 'orbit', az: -0.3, el: 0.05, dist: 9, fov: 34, aim: [0, 0.6, 0], float: 0.02 },
          { from: 0.62, kind: 'orbit', az: 1.35, el: 0.12, dist: 7, fov: 30, aim: [0, 0.5, -0.8], float: 0.02 }),
        phase(ANY,
          { from: 0, kind: 'orbit', az: Math.PI, el: 0.03, dist: 4.2, fov: 44, aim: [0, 0.7, 0], float: 0.02 }),
      ],
    },
  ]

  let cityCam = null // index into CITY_MOVIES, or null for the free camera
  // The viewer's lean on top of whatever the edit asked for. Same three
  // fields scene 1's rig carries, and deliberately so: the drag, pinch and
  // ctrl+scroll handlers below work on either without knowing which.
  const cityNudge = { azOff: 0, elOff: 0, distScale: 1 }
  let cityHeld = null // the shot to keep while a finger is down, so it cannot cut mid-drag

  // Returns the angle AND how far through its own band we are, so a shot can
  // move while it is held: an operator pushes in, arcs round, breathes. A
  // locked-off frame for six seconds is what a security camera does.
  // No cut may be shorter than this. A phase too short to carry its angles
  // plays only the first one — which is how a 1.1 s beat ends up as one shot
  // even if it is handed three.
  const MIN_SHOT = 1.4
  const pickAngle = (entry, u, dur = 99) => {
    const a = dur < MIN_SHOT * 2 ? entry.angles.slice(0, 1) : entry.angles
    let i = 0
    for (let k = 0; k < a.length; k += 1) if (u >= (a[k].from || 0)) i = k
    const from = a[i].from || 0
    const to = i + 1 < a.length ? (a[i + 1].from || 1) : 1
    const t = to > from ? Math.max(0, Math.min(1, (u - from) / (to - from))) : 0
    return { ...a[i], t }
  }
  const pickShot = (movie, segName, u, dur) => {
    let fallback = null
    for (const entry of movie.phases) {
      if (!entry.on) { if (!fallback) fallback = entry; continue }
      if (entry.on.includes(segName)) return pickAngle(entry, u, dur)
    }
    return fallback ? pickAngle(fallback, u, dur) : null
  }

  const updateCityCam = () => {
    const s = show
    const movie = CITY_MOVIES[cityCam]
    if (!movie || !s) return
    // While the viewer has hold of the rig the edit stops cutting — the shot
    // keeps tracking the car, but a cut landing mid-drag would throw the
    // frame out from under them. Same bargain scene 1 makes with its clock.
    const held = sceneDrag !== null || scenePointers.size > 0
    const seg = s.segs[s.i]
    const u = seg.dur > 0 ? Math.max(0, Math.min(1, s.t / seg.dur)) : 0
    let sh = held && cityHeld ? cityHeld : pickShot(movie, seg.name, u, seg.dur)
    if (!sh) return
    cityHeld = sh
    const car = taycan.position
    const yaw = taycan.rotation.y
    const t = sh.t || 0
    // the shot's own move, over its own band
    const dist = sh.dist === undefined ? 0 : sh.dist * (sh.push ? showLerp(sh.push[0], sh.push[1], showEase(t)) : 1)
    const az = (sh.az || 0) + (sh.arc ? showLerp(sh.arc[0], sh.arc[1], showEase(t)) : 0)
    const aim = sh.aim || [0, 0.8, 0]
    if (sh.kind === 'plate') {
      cityEye.set(sh.eye[0], sh.eye[1], sh.eye[2])
      cityAim.set(sh.target[0], sh.target[1], sh.target[2])
    } else {
      carSpace(cityAim, car, yaw, aim[0], aim[1], aim[2])
      if (sh.kind === 'lock') {
        cityEye.set(sh.eye[0], sh.eye[1], sh.eye[2])
      } else if (sh.kind === 'ring') {
        const a = Math.atan2(car.x - CITY_D.x, car.z - CITY_D.z) + sh.phase
        const rr = CITY_D.r + sh.out
        cityEye.set(CITY_D.x + Math.sin(a) * rr, sh.lift, CITY_D.z + Math.cos(a) * rr)
      } else {
        orbitEye(cityEye, car, yaw, az, sh.el, dist)
        if (cityEye.y < car.y + 0.25) cityEye.y = car.y + 0.25 // never through the road
      }
    }

    // COMPOSITION. A subject nailed to the centre of frame is the mark of a
    // machine; an operator puts it on a third and leaves the space in front
    // of it for it to move into. `frame` is in fractions of the half-frame,
    // and positive x slides the aim right, so the car sits LEFT of centre.
    if (sh.frame) {
      cityDir.subVectors(cityAim, cityEye)
      const len = cityDir.length() || 1
      cityDir.multiplyScalar(1 / len)
      cityRight.crossVectors(cityDir, CITY_UP).normalize()
      cityUpv.crossVectors(cityRight, cityDir).normalize()
      const halfH = Math.tan((sh.fov * Math.PI) / 360) * len
      cityAim.addScaledVector(cityRight, sh.frame[0] * halfH * camera.aspect)
      cityAim.addScaledVector(cityUpv, sh.frame[1] * halfH)
    }
    // OPERATOR FLOAT. Nothing a human holds is ever perfectly still, and a
    // perfectly still frame is the one thing that reads as CGI. Layered at
    // unrelated rates so it drifts rather than oscillates.
    if (sh.float) {
      const k = s.clock
      const f = sh.float
      cityEye.x += (Math.sin(k * 0.71) + Math.sin(k * 1.93) * 0.4) * f
      cityEye.y += Math.sin(k * 0.89 + 1.3) * f * 0.6
      cityEye.z += (Math.sin(k * 0.63 + 2.1) + Math.sin(k * 1.71) * 0.35) * f
    }
    // The lean is an orbit about whatever the shot is LOOKING AT, not about
    // the car — which is what makes one implementation serve all four kinds:
    // a chase, a tripod, a ring and a plate all have an aim point.
    if (cityNudge.azOff || cityNudge.elOff || cityNudge.distScale !== 1) {
      const ox = cityEye.x - cityAim.x
      const oy = cityEye.y - cityAim.y
      const oz = cityEye.z - cityAim.z
      const len = Math.hypot(ox, oy, oz) || 1
      const rad = len * cityNudge.distScale
      const theta = Math.atan2(ox, oz) + cityNudge.azOff
      const elev = Math.max(
        0.02,
        Math.min(1.45, Math.asin(Math.max(-1, Math.min(1, oy / len))) + cityNudge.elOff),
      )
      const rr = Math.cos(elev) * rad
      cityEye.set(
        cityAim.x + Math.sin(theta) * rr,
        cityAim.y + Math.sin(elev) * rad,
        cityAim.z + Math.cos(theta) * rr,
      )
    }
    if (cityEye.y < 0.28) cityEye.y = 0.28 // the rig never goes through the road
    // Out of the walls, then out from behind them — and repeated, because
    // each can undo the other. Three rounds settles every case this block
    // produces; the loop stops as soon as the eye is clear.
    for (let pass = 0; pass < 3; pass += 1) {
      keepOutOfBuildings(cityEye) // ...nor inside a wall
      clearLineOfSight(cityEye, cityAim) // ...nor behind one
      if (!insideAnyBlock(cityEye)) break
    }
    // The guarantee. Whatever the two guards did or failed to do, an eye
    // still inside a footprint walks straight at the car until it is out —
    // a shot from too close is recoverable, a shot from inside a wall is not.
    // It stops 1.2 m short of the subject rather than ending up in the car.
    if (insideAnyBlock(cityEye)) {
      for (let k = 1; k <= 24; k += 1) {
        marchEye.lerpVectors(cityEye, cityAim, k / 24)
        if (marchEye.distanceTo(cityAim) < 1.2) break
        if (!insideAnyBlock(marchEye)) { cityEye.copy(marchEye); break }
      }
    }
    // AND IF THAT FAILED, OVER THE ROOF. Walking at the car only works while
    // some point on that line is in the clear; when the car itself is under a
    // footprint — a forecourt, an overhang, the gantry edge — every sample is
    // inside and the march has nowhere to put the camera. Going UP always
    // does, because being inside requires being below the roof in the first
    // place. It costs a high angle on those frames, which is a worse shot but
    // still a shot; the alternative is a lens full of back-faces.
    if (insideAnyBlock(cityEye)) {
      let roof = cityEye.y
      for (const b of CITY_BLOCKS) {
        if (cityEye.y > b.top) continue
        if (cityEye.x <= b.x0 || cityEye.x >= b.x1 || cityEye.z <= b.z0 || cityEye.z >= b.z1) continue
        if (b.top > roof) roof = b.top
      }
      cityEye.y = roof + 0.8
    }
    if (cityEye.y < 0.28) cityEye.y = 0.28 // the pull-back can only lower it
    camera.position.copy(cityEye)
    camera.lookAt(cityAim)
    if (camera.fov !== sh.fov) {
      camera.fov = sh.fov
      camera.updateProjectionMatrix()
    }
  }

  const setCityCam = (index) => {
    cityCam = cityCam === index ? null : index // clicking the live one hands the camera back
    gsap.killTweensOf(cityNudge)
    cityNudge.azOff = 0
    cityNudge.elOff = 0
    cityNudge.distScale = 1
    cityHeld = null
    markActiveScene(cityCam === null ? -1 : cityCam)
    controls.enabled = cityCam === null
    if (cityCam === null) {
      camera.fov = 50
      camera.updateProjectionMatrix()
      controls.target.copy(taycan.position)
      controls.target.y += 1
    } else {
      gsap.killTweensOf(camera.position)
      gsap.killTweensOf(controls.target)
      if (!show) startShow()
    }
  }

  // --- scene 1: Fast & Furious / NFS front rolling shot. The camera hangs
  // low dead ahead of the Taycan while it charges south into an INFINITY
  // TUNNEL — clones of the bore (shared geometry) are tiled ahead of the
  // car and recycled behind it, so the tunnel streams backward forever.
  // Speed is sold with acceleration, lane sway, shake, FOV pump and
  // spinning wheels. ESC / click / any view button exits.
  let scene1 = null
  let infinitySegs = null

  // Same tile budget, split evenly front and back: three behind the car
  // and three ahead (~215 m each way). With only one tile behind, a
  // camera looking back ran out of bore and showed a black hole.
  const BORE_TILES = 7
  const BORE_TILES_BEHIND = 3
  const setInfinityTunnel = (on) => {
    if (on && !infinitySegs) {
      infinitySegs = []
      // the scan itself is the thing with the holes in it, so it sits this
      // one out; everything the camera sees in the run is tile
      tunnel.visible = false
      tunnelRoad.visible = false
      for (let k = 0; k < BORE_TILES; k += 1) {
        const seg = boreTile.clone(true)
        seg.visible = true
        scene.add(seg)
        const road = boreRoad.clone()
        road.visible = true
        scene.add(road)
        infinitySegs.push({ seg, road, offset: null })
      }
    } else if (!on && infinitySegs) {
      for (const { seg, road } of infinitySegs) {
        scene.remove(seg)
        scene.remove(road)
      }
      infinitySegs = null
      tunnel.visible = true
      tunnelRoad.visible = true
    }
  }

  const endScene1 = (flyBack = true) => {
    if (!scene1) return
    scene1 = null
    setInfinityTunnel(false)
    tunnelLighting.visible = false
    setEstablishingLights(true) // back out in the city, daylight rig returns
    setLiveReflection(false)
    setSpeedFx(null, 0, null)
    camera.fov = 50
    camera.updateProjectionMatrix()
    taycan.position.set(-1.75, 0.06, 84)
    taycan.rotation.set(0, Math.PI, 0)
    restWheels()
    parkGroundFx()
    drive.heading = Math.PI
    controls.enabled = true
    startShow() // back in the city, so the loop picks up again
    if (flyBack) {
      gsap.to(camera.position, { ...startEye, duration: 1.6, ease: 'power2.inOut', overwrite: 'auto' })
      gsap.to(controls.target, { ...startTarget, duration: 1.6, ease: 'power2.inOut', overwrite: 'auto' })
    }
    scheduleAuto()
  }

  // --- the five 8-second movies -------------------------------------
  //
  // Each one is an EDIT, not a single move: a handful of cuts inside the
  // eight seconds, each with its own rig setup and its own operator move.
  // Because the transitions between them are hard cuts, the wrap from the
  // last frame back to the first is just one more cut — nothing has to
  // match, which is exactly how a real sequence is assembled.
  //
  // Rig geometry worth knowing before changing any numbers: the camera is
  // placed on an orbit around the car, `az` swung around it (-PI/2 = the
  // near side profile, 0 = ahead of the nose, PI = behind the tail), `el`
  // lifted off the road, `dist` back from the car. The bore is only ~6 m
  // wide and the rig is clamped to its walls, so a SIDE angle cannot pull
  // further than cos(el)*dist ≈ 3.1 before it clips; shots down the bore
  // axis (az near 0 or PI) have the whole tunnel to play with and can sit
  // ten metres out. Short focal lengths (low fov) are the long-lens look.
  // (scene 1 has a MOVIE_LOOP here — the 8 s the edit clock wraps on. This
  // scene never advances that clock, so there is no loop length to keep.)
  const lerp = (a, b, u) => a + (b - a) * u
  // operators do not start or stop a move abruptly; everything eases
  const ease = (u) => u * u * (3 - 2 * u)
  // ...except a crash zoom, which is the one move that IS abrupt: the frame
  // sits still, then the lens is yanked. `at` is how far into the cut it goes
  const crash = (u, at) => (u < at ? 0 : ease((u - at) / (1 - at)))
  const cut = (hold, pose) => ({ hold, pose })

  const MOVIES = [
    {
      key: 'hero',
      // THE BRAND FILM. Mercedes, BMW, Audi: the grammar is motion control,
      // not operating. Everything is level, everything glides at a constant
      // rate with a long ease at each end, and nothing ever whips, orbits
      // fast or dutches. Four shots in eight seconds instead of five, on
      // the longest lenses the bore allows, because compression is what
      // makes bodywork look expensive.
      //
      // Cut 2 is the one that sells it: a slow constant-rate sweep past the
      // profile, which walks the specular highlight the length of the
      // shoulder line. That travelling highlight IS the car commercial.
      //
      // Note the rig cannot back off a side angle: |sin(az)| * cos(el) *
      // dist must stay under ~3.1 or the camera is clamped into the wall
      // and the framing shears. Every az/dist pair below is inside it.
      cuts: [
        // front three-quarter, low, creeping in on a long lens
        cut(2.4, (u) => ({ az: lerp(-0.45, -0.38, ease(u)), el: lerp(0.12, 0.16, ease(u)), dist: lerp(6.4, 5.8, ease(u)), fov: 28 })),
        // the flank rake: the highlight travels the shoulder line
        cut(2.0, (u) => ({ az: lerp(-1.15, -1.95, ease(u)), el: 0.16, dist: 3.05, fov: 44, aim: [0, 0.95, 0.2] })),
        // the detail beat every one of these films has: rim, on a long lens
        cut(1.9, (u) => ({ az: lerp(-1.65, -1.58, ease(u)), el: 0.085, dist: 3.05, fov: 20, aim: [-0.85, 0.37, 1.4] })),
        // crane out to the rear three-quarter and hold it level
        cut(1.7, (u) => ({ az: lerp(2.55, 2.85, ease(u)), el: lerp(0.2, 0.34, ease(u)), dist: lerp(5.2, 8.5, ease(u)), fov: lerp(34, 30, ease(u)) })),
      ],
    },
    {
      key: 'pursuit',
      // Shot like a chase: hung off the tail, whipped to the quarter, met
      // head-on, dropped to the deck as the car passes, then back on it.
      cuts: [
        cut(1.35, (u) => ({ az: Math.PI, el: 0.07, dist: lerp(3.6, 2.7, ease(u)), fov: 64 })),
        cut(1.3, (u) => ({ az: lerp(2.45, 2.25, ease(u)), el: 0.09, dist: 2.85, fov: 58 })),
        cut(1.4, (u) => ({ az: lerp(0.16, 0.06, ease(u)), el: 0.10, dist: lerp(11, 5.5, ease(u)), fov: 44 })),
        cut(1.25, (u) => ({ az: lerp(-1.35, -1.85, ease(u)), el: 0.045, dist: 2.9, fov: 68 })),
        cut(1.4, (u) => ({ az: Math.PI, el: lerp(0.62, 0.42, ease(u)), dist: lerp(8, 6, ease(u)), fov: 50 })),
        cut(1.3, (u) => ({ az: Math.PI - 0.12, el: 0.08, dist: lerp(3.2, 2.8, ease(u)), fov: 60 })),
      ],
    },
    {
      key: 'drift',
      // TOKYO DRIFT. The camera lives on the tarmac. Long lenses on the
      // wheels and the underglow, a whip along the flank, and the car
      // pulling away down the bore — the grammar is low, tight and
      // mechanical, never a polite three-quarter.
      cuts: [
        // front wheel, lens almost resting on the road
        cut(1.7, (u) => ({ az: lerp(-1.25, -1.45, ease(u)), el: 0.035, dist: 3.05, fov: 26, aim: [-0.85, 0.34, 1.35] })),
        // whip off the quarter onto the profile
        cut(1.4, (u) => ({ az: lerp(-0.95, -1.6, ease(u)), el: 0.055, dist: 3.0, fov: 58 })),
        // dropped on the deck behind as it goes away from us
        cut(1.8, (u) => ({ az: Math.PI, el: 0.045, dist: lerp(5.5, 11.5, ease(u)), fov: 32 })),
        // rear wheel and the neon pool it drags along
        cut(1.5, (u) => ({ az: lerp(-1.95, -1.8, ease(u)), el: 0.03, dist: 3.05, fov: 24, aim: [-0.85, 0.3, -1.4] })),
        // low front three-quarter, rising a touch as it settles. az and
        // dist are held so sin(az)*cos(el)*dist stays inside the 3.15 the
        // bore allows on this side — at 0.62/6.2 the rig was 0.45 m into
        // the wall and the clamp sheared the framing
        cut(1.6, (u) => ({ az: lerp(0.5, 0.38, ease(u)), el: lerp(0.05, 0.13, ease(u)), dist: lerp(5.9, 4.4, ease(u)), fov: 38 })),
      ],
    },
    {
      key: 'imax',
      // NOLAN. Scale and stillness. Four shots in eight seconds, all of them
      // wide, the car small inside the architecture rather than filling the
      // frame, and the moves so slow they read as weight rather than as
      // camera. Nothing whips, nothing orbits; the bore does the work.
      cuts: [
        // far down the bore behind, long lens, the car a detail in the tunnel
        cut(2.2, (u) => ({ az: Math.PI, el: 0.1, dist: lerp(15.5, 13.5, ease(u)), fov: 32 })),
        // the architecture plate: high and wide, the arch closing overhead
        cut(2.0, (u) => ({ az: Math.PI, el: lerp(0.98, 0.86, ease(u)), dist: lerp(11, 9.2, ease(u)), fov: 46 })),
        // head on, long lens, the whole bore stacked flat behind the car
        cut(2.2, (u) => ({ az: 0, el: 0.07, dist: lerp(14, 8.5, ease(u)), fov: 30 })),
        // locked off, low, close. No move at all — the cut is the event
        cut(1.6, () => ({ az: -Math.PI / 2 - 0.25, el: 0.04, dist: 3.05, fov: 50 })),
      ],
    },
    {
      key: 'snap',
      // GUY RITCHIE. Nine cuts, none of them the same length, and the two
      // moves he actually uses: the whip pan and the crash zoom. Beats of
      // half a second sit against beats of a second and a half, so the edit
      // lands in threes instead of ticking like a metronome.
      cuts: [
        // hold the wide, then yank the lens in
        cut(1.3, (u) => ({ az: 0, el: 0.08, dist: 6.0, fov: lerp(70, 30, crash(u, 0.55)) })),
        // whip along the flank
        cut(0.5, (u) => ({ az: lerp(-1.0, -2.1, ease(u)), el: 0.09, dist: 3.0, fov: 70 })),
        // wide on the tail, then crash in on the light bar
        cut(1.2, (u) => ({ az: Math.PI, el: 0.085, dist: 5.0, fov: lerp(68, 34, crash(u, 0.5)), aim: [0, 0.98, -2.2] })),
        // whip back the other way
        cut(0.6, (u) => ({ az: lerp(2.9, 2.2, ease(u)), el: 0.08, dist: 3.0, fov: 72 })),
        // the one shot allowed to breathe
        cut(1.4, (u) => ({ az: lerp(0.6, 0.45, ease(u)), el: 0.06, dist: lerp(5.2, 4.0, ease(u)), fov: 66 })),
        // snap to the profile, very wide
        cut(0.5, () => ({ az: -Math.PI / 2, el: 0.1, dist: 3.05, fov: 74 })),
        // plate over the roof, dropping
        cut(1.3, (u) => ({ az: Math.PI, el: lerp(0.8, 0.62, ease(u)), dist: lerp(6.6, 5.4, ease(u)), fov: 56 })),
        // whip round to head on
        cut(0.6, (u) => ({ az: lerp(-0.5, 0, ease(u)), el: 0.07, dist: 4.4, fov: 66 })),
        // and out: a crash zoom the other way to end on
        cut(0.6, (u) => ({ az: Math.PI, el: 0.08, dist: 4.6, fov: lerp(34, 72, ease(u)) })),
      ],
    }
  ]

  // where we are in the current movie: which cut, and how far through it
  const moviePose = (movie, time) => {
    let start = 0
    for (const c of movie.cuts) {
      if (time < start + c.hold) return c.pose((time - start) / c.hold)
      start += c.hold
    }
    const last = movie.cuts[movie.cuts.length - 1]
    return last.pose(1)
  }

  const playScene1 = (movieIndex = 0) => {
    setDrive(false)
    stopShow() // the run drives the car itself; two owners would fight
    stopAuto()
    gsap.killTweensOf(camera.position)
    gsap.killTweensOf(controls.target)
    controls.enabled = false
    setInfinityTunnel(true)
    tunnelLighting.visible = true
    setEstablishingLights(false) // the bore is lit by its own fixtures only
    setLiveReflection(true)
    // az/el/dist: mouse-orbit around the moving car; starts on the 2D side
    // view. The bore is ~5 m wide, so the orbit sits close.
    scene1 = {
      t: 0,
      z: 46,
      y: roadProfile(-1.75, 46) + rideHeight, // settled on the surface — no drop-in
      vy: 0,
      pitch: 0,
      vp: 0,
      roll: 0,
      vr: 0,
      // driver state: the run is a locked 300 km/h; only the line wanders
      // (±10% of the roadway, re-targeted at random intervals)
      speed: CRUISE,
      boost: 0, // turbo look, eased up to 1 over the opening second
      lane: 0,
      laneTarget: 0,
      laneUntil: 3,
      // which of the five edits is playing, and where we are in its loop
      movie: Math.min(Math.max(movieIndex | 0, 0), MOVIES.length - 1),
      movieT: 0,
      // the pose the edit asks for; the drag handlers nudge it via the
      // offsets below rather than fighting it for the same variables
      az: -Math.PI / 2,
      el: 0.24,
      dist: 3.1,
      fov: 58,
      azOff: 0,
      elOff: 0,
      distScale: 1,
    }
  }

  const updateScene1 = (dt) => {
    const s = scene1
    s.t += dt
    // The run is a LOCKED 300 km/h: the car is pinned at that number from
    // the first frame, no launch ramp and no throttle wander. Speed is
    // therefore constant, so longitudinal acceleration is exactly zero and
    // the body's attitude comes purely from the road and from aero.
    s.speed = CRUISE
    const longAccel = 0
    // TURBO. The whole run is on the bottle: the streak, the lens, the
    // mount and the underglow all read from this one number and it sits
    // pinned at 1 for the entire scene. It only eases up over the opening
    // half-second so the scene does not cut in on a hard pop.
    s.boost += (1 - s.boost) * (1 - Math.exp(-dt / 0.35))

    const speed = s.speed
    const vRatio = Math.min(speed / TOP_SPEED, 1)
    s.z += speed * dt // south, deeper into the endless bore
    const shake = vRatio * (1 + s.boost * 0.6) // the mount loads up on the bottle

    // recycle tiles so the bore always runs three tiles BEHIND the car and
    // three ahead — looking back never shows the bore ending
    const need = Math.floor((s.z - BORE_Z0) / TUNNEL_PERIOD)
    infinitySegs.forEach((entry, i) => {
      const offset = need - BORE_TILES_BEHIND + i
      if (entry.offset !== offset) {
        entry.offset = offset
        entry.seg.position.z = tunnel.position.z + offset * TUNNEL_PERIOD
        entry.road.position.z = offset * TUNNEL_PERIOD
      }
    })

    // ...and never holds one exact line either: the driver drifts up to
    // 10% of the roadway to the left or right, picking a new line at
    // random intervals and easing onto it. Heading follows the PATH —
    // yaw = lateral velocity over forward speed — so the nose always
    // points where the car is actually going.
    const STEER_TAU = 1.8
    if (s.t >= s.laneUntil) {
      s.laneTarget = (Math.random() * 2 - 1) * 0.55 // ±10% of the 11 u roadway
      s.laneUntil = s.t + 4 + Math.random() * 5
    }
    const laneVel = (s.laneTarget - s.lane) / STEER_TAU
    s.lane += laneVel * dt
    const latAccel = -laneVel / STEER_TAU // derivative of the lag = real lateral accel
    taycan.position.x = -1.75 + s.lane // measured centre of the bore roadway
    taycan.position.z = s.z
    taycan.rotation.y = Math.atan2(laneVel, speed)
    spinWheels(speed, dt)

    // pro ground contact: the surface height under each of the four
    // contact patches, read straight from the road profile the strip was
    // built from (exact, and far cheaper than raycasting the mesh). The
    // profile is periodic, so no z-wrapping is needed.
    const corner = (dx, dz) => roadProfile(taycan.position.x + dx, s.z + dz)
    const fl = corner(0.85, 1.42)
    const fr = corner(-0.85, 1.42)
    const rl = corner(0.85, -1.42)
    const rr = corner(-0.85, -1.42)

    // Race suspension, modelled rather than faked: one symmetric
    // second-order spring–damper per axis, driven ONLY by real inputs —
    // the road under each wheel, aerodynamic load, and the accelerations
    // the car is actually subject to. Nothing oscillates unless
    // something excites it, so on glass-smooth tarmac at steady speed
    // the body sits dead still, the way it does in a real rolling shot.
    const roadY = (fl + fr + rl + rr) / 4
    s.roadY = roadY

    // downforce rises with the SQUARE of speed, so the body settles onto
    // its springs progressively as the car winds up — a smooth, one-way
    // sink, never a bob
    const aero = vRatio * vRatio
    const sag = 0.014 * aero
    const targetY = roadY + rideHeight - sag
    // NB: at the scene's heading, positive rotation.x is nose-DOWN, so
    // squat (nose light, tail down) needs negative pitch
    const targetPitch =
      -Math.atan2((fl + fr - rl - rr) / 2, 2.84) - // the road under the axles
      longAccel * 0.00045 - // squat: weight shifts rearward under power
      0.0075 * aero // aero rake at speed — tail low, nose light
    // real roll gradient (~0.35°/g). The weave is gentle, so a real body
    // barely leans — faking a bigger lean reads as rocking, not grip.
    const targetRoll = Math.atan2((fl + rl - fr - rr) / 2, 1.7) + latAccel * 0.0006

    // Race-game rates: ~0.65 Hz heave, ~0.85 Hz pitch/roll, both damped
    // to ζ ≈ 0.8 — near-critical, the NFS look. The soft spring still
    // filters the road (at 3.5 Hz only about a sixth of it reaches the
    // body), but the firm damper means whatever does get through settles
    // in ONE motion and never rings — the body sits planted and any
    // after-bounce is gone. Still symmetric — an ASYMMETRIC damper
    // ratchets against a moving target and reads as bouncing however
    // soft the springs are.
    const KH = 16.7
    const CH = 6.5
    const KA = 28.5
    const CA = 8.5
    const steps = Math.max(1, Math.ceil(dt / 0.02))
    const h = dt / steps
    for (let step = 0; step < steps; step += 1) {
      s.vy += (KH * (targetY - s.y) - CH * s.vy) * h
      s.y += s.vy * h
      s.vp += (KA * (targetPitch - s.pitch) - CA * s.vp) * h
      s.pitch += s.vp * h
      s.vr += (KA * (targetRoll - s.roll) - CA * s.vr) * h
      s.roll += s.vr * h
    }
    // Bump stop, not a leash. This only catches the body if it would sink
    // through the suspension's travel — keep it well clear of normal
    // movement, because a tight floor drags the body along with every
    // rise in the road and undoes whatever the springs are doing.
    const floorY = roadY + rideHeight - sag - 0.06
    if (s.y < floorY) {
      s.y = floorY
      if (s.vy < 0) s.vy = 0
    }

    taycan.position.y = s.y
    taycan.rotation.x = s.pitch
    taycan.rotation.z = s.roll
    settleWheels(roadProfile) // each wheel planted on its own patch of asphalt

    // front wheels take the angle the path actually demands — bicycle
    // model, δ = atan(wheelbase · yawRate / v). At 300 km/h a lane drift
    // needs only a whisper of lock, exactly as in a real car.
    steerWheels(Math.atan((2.84 * (latAccel / speed)) / speed))

    // F&F neon physics: the pool punches and tightens as the body squats
    // onto it, washes out a touch under each passing ceiling lamp (they
    // leapfrog on a 13 m rhythm), and carries a live tube flicker
    const bodyGap = s.y - roadY - rideHeight // suspension travel of the body
    const neonSquat = Math.min(Math.max(-bodyGap, -0.04), 0.04)
    const underLamp = Math.max(0, Math.cos(((s.z - 6) / 13) * Math.PI * 2))
    const neonPunch = Math.min(
      1.3,
      Math.max(0.55, (1 + neonSquat * 9) * (1 - underLamp * 0.22) * (1 + (Math.random() - 0.5) * 0.06)),
    )
    for (const neon of neonLights) neon.intensity = NEON_INTENSITY * neonPunch * (1 + 0.18 * s.boost)

    // fixtures + light pools leapfrog along the ceiling in a 13 m rhythm
    // Fixtures leapfrog along the ceiling on a 13 m rhythm. They are
    // centred on the car — half the run trails BEHIND it — because these
    // are the only lights in the bore: anything they do not reach reads
    // as a black void rather than as tunnel receding into the dark.
    const lampHome = Math.floor(s.z / 13)
    tunnelLamps.forEach((lamp, i) => {
      lamp.position.set(-1.75, 5.3, (lampHome + i - (tunnelLamps.length >> 1)) * 13 + 6)
    })
    tunnelFixtures.forEach((fixture, i) => {
      fixture.position.set(
        -1.75,
        5.42,
        (lampHome + i - (tunnelFixtures.length >> 1)) * 13 + 6,
      )
    })

    // The edit clock never advances here. The rig holds the opening cut of
    // whichever edit was picked and keeps tracking the car from it, so drag
    // and zoom are the whole camera — scene 1 is where the cuts play.
    // (s.movieT stays 0; moviePose below therefore returns cut 0 at u = 0.)
    const pose = moviePose(MOVIES[s.movie], s.movieT)
    // The five edits are framed for a cinema-wide window; a portrait phone
    // shows barely a third of that width, and the same numbers crop the
    // car to a door handle. Rather than re-author every cut per device the
    // rig adapts: the lens widens toward the authored horizontal reach
    // (square-root law — full compensation fisheyes a tall phone) and the
    // dolly eases back the rest, inside the bore's own wall clamps. On
    // anything 16:9 or wider both factors are exactly 1.
    const wide = Math.max(1, 16 / 9 / camera.aspect)
    const fovComp = Math.sqrt(wide)
    const distComp = Math.min(1.35, Math.pow(wide, 0.25))
    s.az = pose.az + s.azOff
    s.el = Math.min(1.25, Math.max(0.03, pose.el + s.elOff))
    s.dist = Math.min(16, Math.max(2.2, pose.dist * s.distScale * distComp))
    s.fov = pose.fov

    // the rig sits on an orbit around the car, clamped to the bore walls
    const orbitDist = s.dist * (1 - 0.03 * s.boost) // nitrous shoves the rig in
    const orbitR = Math.cos(s.el) * orbitDist
    // film-style rig shake: layered sines at unrelated rates drift the
    // camera smoothly like a real mount. Per-frame white noise would
    // buzz, and any camera jitter reads as the CAR shaking.
    const shakeX = (Math.sin(s.t * 8.3) + Math.sin(s.t * 13.7) * 0.5) * 0.004 * shake
    const shakeY = (Math.sin(s.t * 11.1) + Math.sin(s.t * 6.7) * 0.5) * 0.003 * shake
    const shakeZ = (Math.sin(s.t * 9.7) + Math.sin(s.t * 15.3) * 0.5) * 0.004 * shake
    camera.position.set(
      Math.min(1.4, Math.max(-4.85, taycan.position.x + Math.sin(s.az) * orbitR)) + shakeX,
      // height rides on the ROAD, not the body — so the body's aero sag
      // reads against a steady camera
      Math.max(0.3, roadY + Math.sin(s.el) * orbitDist) + shakeY,
      s.z + Math.cos(s.az) * orbitR + shakeZ,
    )
    // A cut may aim somewhere other than the middle of the car — that is
    // what makes an insert shot an insert shot. Offsets are in car terms:
    // [across, up from the road, along (+ = nose)]. On a narrow frame an
    // off-axis aim walks the subject out of the picture entirely, so the
    // offsets ease back toward the car by the same factor the lens widened.
    const aim = pose.aim
    const aimTighten = 1 / fovComp
    const aimX = taycan.position.x + (aim ? aim[0] * aimTighten : 0)
    const aimY = taycan.position.y + (aim ? aim[1] : 0.72)
    const aimZ = s.z + (aim ? aim[2] * aimTighten : 0)
    camera.lookAt(aimX, aimY, aimZ)
    // The subject guard. Even tightened, some authored moves still walk
    // the car to the edge of a portrait frame — measured, the hero run
    // had it clean off an iPhone for 23% of its loop. Project the car's
    // centre through the shot as framed; past the safe line the aim
    // slides toward the car, exactly as an operator catches a subject
    // drifting out of the finder. Wide frames never enter this branch.
    if (wide > 1) {
      camera.updateMatrixWorld()
      subjectNdc.set(taycan.position.x, taycan.position.y + 0.7, s.z).project(camera)
      const err = Math.abs(subjectNdc.x) - 0.55
      if (err > 0 && subjectNdc.z < 1) {
        const pull = Math.min(1, err / 0.45)
        camera.lookAt(
          aimX + (taycan.position.x - aimX) * pull,
          aimY,
          aimZ + (s.z - aimZ) * pull,
        )
      }
    }
    // speed pumps the lens, smoothly; then the aspect compensation widens
    // it on the tan (never on raw degrees), capped shy of fisheye
    const vfov = s.fov + 8 * aero + 4 * s.boost
    camera.fov = Math.min(
      92,
      (360 / Math.PI) * Math.atan(Math.tan((vfov * Math.PI) / 360) * fovComp),
    )
    camera.updateProjectionMatrix()

    // The car is what the shot tracks, so it stays sharp while the bore
    // tears past it along the direction of travel. The exposure is what the
    // bottle lengthens: a whisper of trail is always there at 300 km/h, and
    // on the bottle the walls turn into pure light streaks.
    fxPoint.set(taycan.position.x, taycan.position.y + 0.55, s.z)
    // Exposure. Keep the cruise value short — a long smear at steady
    // speed turns the whole bore to mush; the streak should read as
    // motion, not as a soft lens. The bottle is what lengthens it.
    fxTravel.set(0, 0, speed * (0.0005 + 0.012 * s.boost)) // due south, with the car
    setSpeedFx(fxTravel, 0.7 * s.boost, fxPoint)
  }

  const sceneButtons = [...document.querySelectorAll('[data-scene]')]
  const markActiveScene = (index) => {
    sceneButtons.forEach((btn) => {
      btn.classList.toggle('is-active', Number(btn.dataset.scene) === index + 1)
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.scene) === index + 1))
    })
  }
  sceneButtons.forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault() // the links are in-page controls, not navigation
      const index = Number(btn.dataset.scene) - 1
      // Scene 2's bar picks a CAMERA over the city show; scene 1's starts the
      // tunnel run. Same markup, different job — the run has no place here,
      // because the thing worth filming is out on the street.
      if (!Number.isInteger(index) || index < 0 || index >= CITY_MOVIES.length) return
      setCityCam(index)
    })
  })
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Escape') return
    // Escape gives the camera back before it does anything else.
    if (cityCam !== null) {
      setCityCam(cityCam)
      return
    }
    // ...then leaves the run, if one is somehow playing.
    if (scene1 && city) endScene1()
  })

  // drag orbits around the car during the scene (a clean click still exits
  // through the view-hop handler); ctrl+scroll adjusts the orbit distance.
  // Touch rides the same pointer events: one finger drags the orbit, two
  // fingers pinch the distance through the same knob ctrl+scroll turns —
  // and any finger down holds the edit exactly like a mouse drag.
  let sceneDrag = null
  const scenePointers = new Map()
  let pinchDist = 0
  // The run and the city edits both carry azOff/elOff/distScale, so one set
  // of handlers steers whichever is live and neither needs to know.
  const nudgeRig = () => (scene1 || (cityCam !== null ? cityNudge : null))
  canvas.addEventListener('pointerdown', (event) => {
    const rig = nudgeRig()
    if (!rig) return
    scenePointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (scenePointers.size === 2) {
      const [a, b] = [...scenePointers.values()]
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      sceneDrag = null // two fingers zoom; neither steers the orbit
    } else {
      sceneDrag = { x: event.clientX, y: event.clientY }
    }
    gsap.killTweensOf(rig) // the viewer has the rig — stop any recentre still easing back
  })
  window.addEventListener('pointermove', (event) => {
    const rig = nudgeRig()
    if (!rig) return
    const p = scenePointers.get(event.pointerId)
    if (p) {
      p.x = event.clientX
      p.y = event.clientY
    }
    if (scenePointers.size === 2) {
      const [a, b] = [...scenePointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      // scales whatever the edit asked for, same knob as ctrl+scroll
      if (pinchDist > 0 && d > 0) {
        rig.distScale = Math.min(2.2, Math.max(0.6, rig.distScale * (pinchDist / d)))
      }
      pinchDist = d
      return
    }
    if (!sceneDrag) return
    // while the hold is on the edit clock is frozen (see updateScene1),
    // so these offsets are the only thing moving the rig
    rig.azOff -= (event.clientX - sceneDrag.x) * 0.006
    rig.elOff = Math.min(0.9, Math.max(-0.9, rig.elOff + (event.clientY - sceneDrag.y) * 0.004))
    sceneDrag.x = event.clientX
    sceneDrag.y = event.clientY
  })
  const dropScenePointer = (event) => {
    if (!scenePointers.delete(event.pointerId)) return
    pinchDist = 0
    if (scenePointers.size === 1) {
      // the finger that stays becomes a plain drag, no lift-and-retouch
      const [rest] = scenePointers.values()
      sceneDrag = { x: rest.x, y: rest.y }
      return
    }
    sceneDrag = null
    const rig = nudgeRig()
    if (!rig) return
    // hand the rig back: the clock unfreezes, and the viewer's lean eases
    // out so the movie returns to its authored framing. Wrap az first so a
    // multi-turn drag unwinds the short way, not back through every turn.
    const TAU = Math.PI * 2
    rig.azOff = ((rig.azOff % TAU) + TAU + Math.PI) % TAU - Math.PI
    gsap.to(rig, { azOff: 0, elOff: 0, duration: 1.4, ease: 'power2.inOut', overwrite: 'auto' })
  }
  window.addEventListener('pointerup', dropScenePointer)
  window.addEventListener('pointercancel', dropScenePointer)

  // pinch on a trackpad arrives as a ctrlKey wheel event, so the same branch
  // serves ctrl+scroll on a mouse; a plain wheel keeps scrolling the page
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey || !cityInteractive()) return
      event.preventDefault()
      const rig = nudgeRig()
      if (rig) {
        // scales whatever the edit asked for, so zoom survives every cut
        rig.distScale = Math.min(
          2.2,
          Math.max(0.6, rig.distScale * Math.exp(event.deltaY * 0.0015)),
        )
        return
      }
      stopAuto()
      const offset = camera.position.clone().sub(controls.target)
      const length = THREE.MathUtils.clamp(
        offset.length() * Math.exp(event.deltaY * 0.0015),
        r * 0.02,
        r * 2.6,
      )
      camera.position.copy(controls.target).add(offset.setLength(length))
      scheduleAuto()
    },
    { passive: false },
  )

  // a plain click (no drag) hops to the next demo view; dragging still orbits
  let pressAt = 0
  const pressPos = { x: 0, y: 0 }
  canvas.addEventListener('pointerdown', (event) => {
    pressAt = performance.now()
    pressPos.x = event.clientX
    pressPos.y = event.clientY
  })
  canvas.addEventListener('pointerup', (event) => {
    if (!cityInteractive()) return
    if (cityCam !== null) return // an edit owns the camera; a click must not fly it off
    const moved = Math.hypot(event.clientX - pressPos.x, event.clientY - pressPos.y)
    if (performance.now() - pressAt > 300 || moved > 6) return
    flyTo(VIEW_ORDER[(VIEW_ORDER.indexOf(activeView) + 1) % VIEW_ORDER.length])
  })

  // --- post: bloom -> nitrous speed blur -> lens fringe -> fxaa ---
  const postProcessing = new THREE.PostProcessing(renderer)
  const scenePass = pass(scene, camera)
  const bloomPass = bloom(scenePass, 0.42, 0.5, 0.75)
  // the streak is taken on the HDR frame AFTER bloom, so the ceiling lamps
  // and the neon smear into bright light trails instead of grey mush. It
  // renders at half resolution and is composited back over the sharp frame
  // (see speedBlur.js) — a full-res smear this long doubled the frame time.
  const streaked = speedBlur(scenePass.add(bloomPass), {
    viewZ: scenePass.getViewZNode(),
    focal: fx.focal,
    motion: fx.motion,
    samples: fx.samples,
    cap: fx.cap,
    center: fx.centre,
    boost: fx.boost,
    body: fx.body,
    wheels: fx.wheels,
    wheelAxis: fx.wheelAxis,
    wheelSize: fx.wheelSize,
    spin: fx.spin,
    spinRear: fx.spinRear,
  })
  // Rung 0 gets the LITE chain: bloom stays — the tunnel's lights ARE the
  // scene — but the speed streak, by far the biggest shader in the page,
  // is never even built. On the software-GL and bottom-phone class that
  // opens rung 0, compiling it alone held the main thread long enough
  // for Android's not-responding dialog; the streak it bought was barely
  // visible at dpr 1. The graph is chosen once at boot from the opening
  // rung — no runtime swap, nothing recompiles mid-run.
  // ANAMORPHIC FLARE — the blue horizontal smear a cine lens throws when you
  // point it into a light. Bloom already gives the halation (the soft halo
  // around a bright source); this is the other half, and the one that reads as
  // a camera rather than as a glow: an anamorphic lens compresses the image
  // horizontally, so a point of light spills sideways across the whole frame.
  //
  // Built the way it physically happens: isolate only what is BRIGHTER than
  // the threshold — the lamps, the neon, the car's own strip, a headlight —
  // and smear that, and only that, along X. Nothing dim streaks, so the effect
  // appears when the camera faces a light and is invisible otherwise.
  //
  // It runs at quarter resolution. A streak is a very low-frequency thing:
  // there is nothing in it that survives to full res, and this scene is fill
  // bound, so paying full rate for a blur would be spent on nothing.
  // uniforms, not constants: a flare is a taste control and has to be tunable
  // from the console without a rebuild of the node graph
  const flareThreshold = uniform(0.55) // HDR; the bloom's own cut is 0.75
  const flareStrength = uniform(2.6)
  const flareTint = uniform(new THREE.Color(0x5c86ff)) // anamorphics streak BLUE
  const flareHot = vec4(
    scenePass.rgb.sub(flareThreshold).max(0).mul(flareStrength),
    1,
  )
  // the direction IS the aspect: horizontal only, which is what makes it
  // anamorphic rather than a plain bloom
  const flare = gaussianBlur(flareHot, vec2(1, 0), 28, { resolutionScale: 0.25 })
    .rgb.mul(flareTint)

  // Rung 0 gets neither streak nor flare; rung 1 up gets both.
  postProcessing.outputNode =
    quality.rung() === 0
      ? fxaa(renderOutput(scenePass.add(bloomPass)))
      : fxaa(renderOutput(streaked.add(flare)))
  postProcessing.outputColorTransform = false
  // debug handles for bisecting the chain per backend (see __city.post)
  const post = { postProcessing, scenePass, bloomPass, streaked, flare, fxaa, renderOutput,
    smokeGroundMix,
    flareThreshold, flareStrength, flareTint }

  // --- render loop, paused when the tab or the city is not visible ---
  const clock = new THREE.Clock()
  let running = false
  let lastTime = 0
  let presentedFrames = 0
  const flyForward = new THREE.Vector3()
  const flyRight = new THREE.Vector3()
  const flyMove = new THREE.Vector3()

  const tick = () => {
    const t = clock.getElapsedTime()
    const rawDt = t - lastTime // the watchdog wants the truth, not the clamp
    const dt = Math.min(rawDt, 0.1)
    lastTime = t

    // The loading veil fades on scene-live, not has-city: the first frames
    // stall on pipeline compilation, and a fade started before them is
    // swallowed whole — it must begin only once frames actually present.
    // the wind runs on the render clock, not the show's
    windTime.value = t
    WIND.now = windEnvelope(t)
    windGust.value = WIND.gust * WIND.now
    presentedFrames += 1
    if (presentedFrames === 2) document.documentElement.classList.add('scene-live')

    // the governor watches the measured frame cost; a rung change means a
    // new canvas resolution, so the targets reallocate here and nowhere else
    if (quality.frame(rawDt, t)) {
      renderer.setPixelRatio(quality.dpr())
      renderer.setSize(window.innerWidth, window.innerHeight)
    }

    if (scene1) {
      updateScene1(dt)
      updateReflection() // the bore the car is in, as of this frame
      postProcessing.render()
      return
    }

    if (drive.on) {
      // arcade car step: throttle/brake, speed-scaled steering, wall bump,
      // road-surface follow, smoothed chase camera
      const gas = pressed.has('KeyW') ? 1 : 0
      const rev = pressed.has('KeyS') ? 1 : 0
      const steer = (pressed.has('KeyA') ? 1 : 0) - (pressed.has('KeyD') ? 1 : 0)

      // turbo: Shift while on the throttle. Same bottle, same screen effect
      // as the scene — more shove, more top end, and it bleeds off slowly.
      const turbo = shiftHeld && gas > 0
      drive.boost += ((turbo ? 1 : 0) - drive.boost) * (1 - Math.exp(-dt / (turbo ? 0.18 : 0.5)))

      drive.speed += (gas * (16 + 30 * drive.boost) - rev * (drive.speed > 0.5 ? 30 : 9)) * dt
      drive.speed -= drive.speed * 0.9 * dt // rolling drag
      drive.speed = Math.min(26 + 16 * drive.boost, Math.max(-9, drive.speed))
      if (!gas && !rev && Math.abs(drive.speed) < 0.4) drive.speed = 0

      const authority = Math.min(Math.abs(drive.speed) / 6, 1)
      drive.heading += steer * authority * 1.9 * dt * Math.sign(drive.speed || 1)
      carForward.set(Math.sin(drive.heading), 0, Math.cos(drive.heading))

      if (Math.abs(drive.speed) > 1) {
        const dir = Math.sign(drive.speed)
        camLook.copy(taycan.position).addScaledVector(carForward, 2.3 * dir)
        camLook.y = taycan.position.y + 0.6
        camDesired.copy(carForward).multiplyScalar(dir)
        blockRay.set(camLook, camDesired)
        blockRay.far = Math.abs(drive.speed) * dt + 1.6
        if (city && blockRay.intersectObject(city, true).length > 0) {
          drive.speed *= -0.2 // GTA thud
        }
      }

      taycan.position.addScaledVector(carForward, drive.speed * dt)
      taycan.rotation.y = drive.heading
      spinWheels(drive.speed, dt)

      // stick to the drivable surfaces (city streets + the painted bore road)
      camDesired.copy(taycan.position)
      camDesired.y = taycan.position.y + 4
      groundRay.set(camDesired, down)
      const surfaces = tunnelRoad ? [city, tunnelRoad] : [city]
      const ground = groundRay.intersectObjects(surfaces, true)[0]

      // supersport suspension (same spring–damper as the scene): squat on
      // throttle, dive on the brakes, roll against the steering
      // same modelled suspension as the scene: symmetric, near-critically
      // damped, driven only by the real road and real accelerations. The
      // city streets supply plenty of genuine surface change — no fake
      // noise is added on top.
      const longAccel = dt > 0 ? (drive.speed - (drive.prevSpeed ?? drive.speed)) / dt : 0
      drive.prevSpeed = drive.speed
      const yawRate = steer * authority * 1.9 * Math.sign(drive.speed || 1)
      const latAccel = drive.speed * yawRate
      const roadY = ground ? ground.point.y : drive.sy - rideHeight
      const targetY = roadY + rideHeight
      const targetPitch = longAccel * 0.002 // dive on the brakes, squat on power
      const targetRoll = -latAccel * 0.004 // lean against the cornering load
      const steps = Math.max(1, Math.ceil(dt / 0.02))
      const h = dt / steps
      for (let step = 0; step < steps; step += 1) {
        drive.svy += (88 * (targetY - drive.sy) - 17.9 * drive.svy) * h
        drive.sy += drive.svy * h
        drive.svp += (114 * (targetPitch - drive.sp) - 21.4 * drive.svp) * h
        drive.sp += drive.svp * h
        drive.svr += (114 * (targetRoll - drive.sr) - 21.4 * drive.svr) * h
        drive.sr += drive.svr * h
      }
      // body floor: never below compressed ride height — arch space stays
      if (drive.sy < roadY + rideHeight - 0.05) {
        drive.sy = roadY + rideHeight - 0.05
        if (drive.svy < 0) drive.svy = 0
      }
      taycan.position.y = drive.sy

      // body attitude comes from the springs alone
      taycan.rotation.x = drive.sp
      taycan.rotation.z = drive.sr
      settleWheels(() => roadY) // wheels stay planted on the street under the sprung body

      // front wheels show the real lock the arcade model is turning with
      // (bicycle model at speed; the raw input when crawling or stopped)
      const lock = 0.58 // ~33° of steering lock
      const geoSteer =
        Math.abs(drive.speed) > 1
          ? Math.atan((2.84 * yawRate) / Math.abs(drive.speed))
          : steer * lock
      steerWheels(Math.max(-lock, Math.min(lock, geoSteer)))

      // idle neon physics while driving: just the live tube flicker
      const neonPunch = 1 + (Math.random() - 0.5) * 0.05
      for (const neon of neonLights) neon.intensity = NEON_INTENSITY * neonPunch

      camDesired.copy(taycan.position).addScaledVector(carForward, -8)
      camDesired.y = taycan.position.y + 3.2
      camera.position.lerp(camDesired, 1 - Math.exp(-5 * dt))
      camLook.copy(taycan.position).addScaledVector(carForward, 3)
      camLook.y = taycan.position.y + 1.2
      camera.lookAt(camLook)

      updateReflection() // the street the car is in, as of this frame
      camera.fov = 50 + 11 * drive.boost
      camera.updateProjectionMatrix()
      fxPoint.copy(taycan.position)
      fxPoint.y += 0.55
      fxTravel.copy(carForward).multiplyScalar(drive.speed * (0.002 + 0.024 * drive.boost))
      setSpeedFx(fxTravel, drive.boost, fxPoint)
    } else {
      if (pressed.size) {
        camera.getWorldDirection(flyForward)
        flyRight.crossVectors(flyForward, camera.up).normalize()
        flyMove.set(0, 0, 0)
        if (pressed.has('KeyW')) flyMove.add(flyForward)
        if (pressed.has('KeyS')) flyMove.sub(flyForward)
        if (pressed.has('KeyD')) flyMove.add(flyRight)
        if (pressed.has('KeyA')) flyMove.sub(flyRight)
        if (flyMove.lengthSq() > 0) {
          // camera and orbit target move together, so drag-look stays coherent
          flyMove.normalize().multiplyScalar(r * (shiftHeld ? 1.05 : 0.35) * dt)
          camera.position.add(flyMove)
          controls.target.add(flyMove)
        }
      }
      if (cityCam === null) controls.update()
      setSpeedFx(null, 0, null) // free look: nothing is moving fast enough to tear
      // ...unless the show is running, which sets its own on the way past
      if (show) updateShow(dt)
      // the rig frames the car, so it runs after the car has moved
      if (cityCam !== null) updateCityCam()
    }
    postProcessing.render()
  }

  const setRunning = (value) => {
    if (value === running) return
    running = value
    renderer.setAnimationLoop(value ? tick : null)
  }

  let scrollFade = 1
  const updateScrollFade = () => {
    const heroHeight = Math.max(hero.offsetHeight, 1)
    scrollFade = 1 - Math.min(Math.max(window.scrollY / (heroHeight * 0.85), 0), 1)
    canvas.style.opacity = scrollFade.toFixed(3)
    setRunning(scrollFade > 0.02 && document.visibilityState === 'visible' && canvas.clientWidth > 0)
  }

  window.addEventListener('scroll', updateScrollFade, { passive: true })
  document.addEventListener('visibilitychange', updateScrollFade)

  window.addEventListener('resize', () => {
    renderer.setPixelRatio(quality.dpr())
    renderer.setSize(window.innerWidth, window.innerHeight)
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    updateScrollFade()
  })

  // --- demo buttons: fly the camera to the published views ---
  const flyTo = (name) => {
    const preset = presets[name]
    if (!preset) return
    // The establishing views ARE the city; with no scenery there is nothing
    // to fly to.
    if (!city) return
    setDrive(false)
    endScene1(false) // the flight below takes the camera from here
    activeView = name
    controls.maxPolarAngle = preset.polar ?? Math.PI * 0.52
    stopAuto()
    camsBar?.querySelectorAll('[data-cam]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.cam === name)
    })
    const duration = reducedMotion ? 0 : 1.8
    // the lens travels with the camera: a shot is its focal length as much
    // as its position
    gsap.to(camera, {
      fov: preset.fov ?? 50,
      duration,
      ease: 'power2.inOut',
      overwrite: 'auto',
      onUpdate: () => camera.updateProjectionMatrix(),
    })
    gsap.to(camera.position, { ...preset.eye, duration, ease: 'power2.inOut', overwrite: 'auto' })
    gsap.to(controls.target, {
      ...preset.target,
      duration,
      ease: 'power2.inOut',
      overwrite: 'auto',
      onComplete: scheduleAuto,
    })
  }

  camsBar?.querySelectorAll('[data-cam]').forEach((btn) => {
    btn.addEventListener('click', () => flyTo(btn.dataset.cam))
  })

  // --- reveal: swap the static hero media for the live city ---
  stage('warm')
  await renderer.renderAsync(scene, camera) // warm up pipelines before showing
  stage('reveal')
  document.documentElement.classList.add('has-city')
  // TEMP scene-lab mode: hides the landing copy so only the header, the
  // camera bar and the 3D scene remain — delete this line to bring it back
  document.documentElement.classList.add('scene-lab')
  if (camsBar) camsBar.hidden = false
  requestAnimationFrame(() => canvas.classList.add('is-ready')) // CSS fades 0 → 1
  setRunning(document.visibilityState === 'visible')
  setTimeout(() => {
    canvas.style.transition = 'none' // after the fade-in, opacity follows scroll directly
    updateScrollFade()
  }, 1300)

  // SCENE 2 (2/3): the page opens on the city, not in the bore. The rig is
  // already on the establishing pose refreshOverview() computed from the
  // city's real bounds, so this only has to hand it over: daylight rig on,
  // controls live, no edit playing and therefore no button lit. The five
  // edit buttons enter the run from here and Escape comes back out.
  setEstablishingLights(true)
  startShow() // the car starts its loop out of the tunnel...
  setCityCam(1) // ...and Snap Cuts is the edit the page opens on, already running.
  // setCityCam takes the controls and lights the button itself; Escape, or a
  // second click on 02, hands the free camera back.

  // demo handle: lets the console (or a demo script) drive the scene
  window.__city = {
    flyTo,
    presets,
    renderOnce: () => tick(),
    camera,
    controls,
    tunnel,
    rebuildRoad,
    carveTunnel,
    taycan,
    setDrive,
    drive,
    fx,
    setLiveReflection,
    reflectionProbe,
    renderer,
    scene1: () => scene1,
    playScene1,
    show: () => show,
    startShow,
    stopShow,
    // Physics-only step, no render: the schedule can be advanced at a fixed dt
    // from the console. tick() takes its dt off a wall clock, so a backgrounded
    // tab feeds it a clamp instead of a frame and the loop cannot be measured
    // at all — this is the handle that makes the drive reproducible.
    stepShow: (dt) => (show ? updateShow(dt) : null),
    // the rig, driven by hand: lets the whole loop be walked at a fixed dt
    // and every frame the camera lands on be tested, instead of trusting
    // that no shot ever ends up inside a wall
    stepCityCam: () => updateCityCam(),
    cityMovies: CITY_MOVIES,
    setCityCam,
    cityCam: () => cityCam,
    cityBlocks: CITY_BLOCKS,
    movies: MOVIES,
    wheelGroups,
    rideHeight,
    quality,
    post,
    // the wind, for the console: time is driven by the render clock, gust and
    // dir are live — nudging them re-aims every tree without a reload
    wind: { time: windTime, dir: windDir, gust: windGust, base: WIND },
    // No THREE here. Re-exporting the namespace to a global pins every export
    // of three/webgpu as live and blocks tree-shaking entirely: that one key
    // cost 171 kB raw / 38 kB brotli in the city chunk. The classes are still
    // reachable for diagnostics through the live objects above
    // (__city.renderer, __city.camera, __city.taycan.constructor, …).
  }
}
