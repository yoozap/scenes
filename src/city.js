// Fixed WebGPU city composition behind the landing (desktop only).
// WebGPURenderer falls back to WebGL2 by itself when WebGPU is missing;
// any hard failure just leaves the DOM landing untouched.

import gsap from 'gsap'
import * as THREE from 'three/webgpu'
import { color, mix, normalWorldGeometry, pass, renderOutput, smoothstep, uniform } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { speedBlur } from './speedBlur.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

// The landing page's own three darks, straight off its CSS tokens, so the
// 3D and the DOM sit in one palette: --bg, --panel, --paper.
const BG = 0x03070c // --bg    : the near-black blue the page is built on
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

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  })
  await renderer.init()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
  const [tunnelGltf, boreGltf, taycanGltf, roadGltf] = await Promise.all([
    gltfLoader.loadAsync('/models/tunnel.glb'),
    gltfLoader.loadAsync('/models/tunnel-bore.glb'),
    gltfLoader.loadAsync('/models/taycan.glb'),
    gltfLoader.loadAsync('/models/road.glb'),
  ])

  // The city streams in behind the hero and attaches itself when it lands.
  // Everything that touches it is guarded, because between first frame and
  // arrival there is genuinely no city in the scene. A visitor only ever
  // reaches it by pressing Escape or calling __city.flyTo(), and both wait
  // on cityReady.
  let city = null
  const cityReady = gltfLoader
    .loadAsync('/models/city.glb')
    .then((gltf) => {
      city = gltf.scene
      scene.add(city)
      sharpenTextures(city)
      applyCityFraming() // fog density and the establishing rig's aim
      refreshOverview() // the resting camera is framed on the city's bounds
      dracoLoader.dispose()
      return city
    })
    .catch((error) => {
      // The hero does not depend on this, so a failure here must not take
      // the scene down — it just means the establishing views stay empty.
      console.warn('[city] scenery failed to load:', error)
      dracoLoader.dispose()
      return null
    })

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

  // blackout panels sealing the scan's torn flanks at the approach zone —
  // certain orbit angles used to show jagged void through the gaps. They
  // are children of the tunnel, so every infinity clone inherits them.
  {
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

  // --- framing from the model bounds ---
  // These describe the CITY, which arrives late, so they start from its
  // measured extents and are recomputed from the real object when it lands.
  // Nothing on screen depends on them before that: scene 1 is inside a closed
  // bore with the establishing rig switched off, so neither the fog density
  // nor the sun's aim is visible until the city is there to be lit.
  const center = new THREE.Vector3(-6.8, 0, 374.4) // measured off city.glb
  let r = 512 // half the bounding box's space diagonal

  scene.fog = new THREE.FogExp2(BG, 1.35 / (r * 6))

  const hemi = new THREE.HemisphereLight(0xbcd2e8, 0x0a1418, 1.1)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xffe7c4, 2.2)
  scene.add(sun, sun.target)
  const rim = new THREE.DirectionalLight(0x2a9d8f, 0.5)
  scene.add(rim)

  // Aim the establishing rig and set the fog to the city's real size. Called
  // once with the measured constants above so the first frame is valid, and
  // again from cityReady with the loaded object's own bounds.
  function applyCityFraming() {
    if (city) {
      const box = new THREE.Box3().setFromObject(city)
      box.getCenter(center)
      r = box.getBoundingSphere(new THREE.Sphere()).radius
      scene.fog.density = 1.35 / (r * 6)
    }
    sun.position.set(center.x + r, center.y + r * 1.3, center.z + r * 0.4)
    sun.target.position.copy(center)
    rim.position.set(center.x - r, center.y + r * 0.5, center.z - r)
  }
  applyCityFraming()

  // These three light the city for the establishing views. Inside the
  // bore they have no business existing — a tunnel is lit by its own
  // ceiling fixtures — so scene 1 switches them off and runs on the
  // tunnel lamps, the car's own lamps and the underglow alone.
  const establishing = [hemi, sun, rim].map((light) => ({ light, full: light.intensity }))
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
    if (probeFrame % 2 === 0) return
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
  const BRAND_TEAL = 0x3fe6cf
  const TAILLAMP_RED = 0xff1524
  for (const side of [-0.72, 0.72]) {
    // Main beam. A real headlight throws light DOWN THE ROAD and never
    // onto its own car, so the emitter sits just ahead of the bumper and
    // the cone is narrow enough to clear the bodywork — a wide cone from
    // inside the nose washes the fenders and instantly looks fake.
    // Physical falloff (decay 2) keeps the pool bright near the car and
    // fading with distance instead of glowing flatly to the horizon.
    const beam = new THREE.SpotLight(BRAND_TEAL, 700, 90, 0.38, 0.6, 2)
    beam.position.set(side / CAR_SCALE, 0.62 / CAR_SCALE, 2.45 / CAR_SCALE)
    beam.target.position.set((side * 1.35) / CAR_SCALE, 0, 38 / CAR_SCALE)
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

    // Two rails of seven tubes along the sills. The count and spacing are
    // what make it read as one strip instead of a row of blobs: samples
    // every 65 cm, mounted 22 cm up (too low and each light's falloff is
    // so sharp it prints its own hotspot on the tarmac), each one soft
    // with a generous radius so neighbours overlap into a seamless pool.
    // Reach is deliberately SHORT (1 u). These are point lights with no
    // shadows, so any reach that extends past the sills shines straight
    // through the bodywork and prints a row of teal specular dots along
    // the spoiler and rear deck. At 1 u each tube still lights the road
    // 0.36 u below it at full strength — the inverse-square term barely
    // changes — but dies well before the tail. The rails also stop short
    // of the bumpers for the same reason.
    for (const dx of [-0.62, 0.62]) {
      for (const dz of [-1.3, -0.65, 0, 0.65, 1.3]) {
        const neon = new THREE.PointLight(0x2fd6c0, NEON_INTENSITY, 1, 2)
        neon.position.set(dx, 0.22, dz)
        groundFx.add(neon)
        neonLights.push(neon)
      }
    }

    // The tail lamps' glow on the tarmac behind. Carried here rather than
    // on the car, and set back past the rear bumper with a short reach,
    // so it lands on the road without flooding the rear wheel red.
    for (const dx of [-0.62, 0.62]) {
      const tailPool = new THREE.PointLight(TAILLAMP_RED, 4, 1.3, 2)
      tailPool.position.set(dx, 0.16, -3.0)
      groundFx.add(tailPool)
    }
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

  // Real tarmac is never a mathematical plane — it settles in long waves
  // and carries a crossfall that wanders along the bore. This profile IS
  // the suspension's input: the wheels follow it and the body answers
  // through the springs, which is what makes the damping visible without
  // a single frame of faked motion. Amplitudes are road-realistic (~2 cm
  // all in), too subtle to see as a shape but plainly felt in the body.
  // Every wavelength divides one TUNNEL_PERIOD, so the profile is exactly
  // periodic and the tiled copies meet with no step at the seams.
  const ROAD_LEVEL = -0.14
  const ROAD_W = (2 * Math.PI) / TUNNEL_PERIOD
  const roadProfile = (x, z) =>
    ROAD_LEVEL +
    // Keep this one small. At 1.2 Hz it lands right on the body's own
    // frequency, so whatever amplitude it has gets AMPLIFIED into body
    // heave — it is the wave you feel as the car bouncing.
    Math.sin(z * ROAD_W) * 0.003 + // long settlement wave (~1.2 Hz at speed)
    Math.sin(z * ROAD_W * 2 + 1.7) * 0.003 + // shorter undulation
    // The wheels' working band. At 300 km/h these arrive at 3.5 and 5.8 Hz
    // — above the body's 1.5 Hz, so the springs soak up most of them: the
    // WHEELS and their uprights (disc + calipers) visibly rise and fall in
    // the arches while the body still glides. Keep these harmonics low;
    // anything shorter turns the whole car into a buzz.
    Math.sin(z * ROAD_W * 3 + 0.6) * 0.011 + // rolling swells (~3.5 Hz)
    Math.sin(z * ROAD_W * 5 + 2.1) * 0.006 + // patch-to-patch steps (~5.8 Hz)
    // crossfall that drifts along the bore, so the left and right wheels
    // sit at slightly different heights and the body rolls a little
    Math.sin(z * ROAD_W * 2 + 0.9) * x * 0.004

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
  controls.autoRotate = !reducedMotion
  controls.autoRotateSpeed = 0.45
  controls.update()

  let resumeTimer = 0
  const stopAuto = () => {
    controls.autoRotate = false
    clearTimeout(resumeTimer)
  }
  const scheduleAuto = () => {
    clearTimeout(resumeTimer)
    if (!reducedMotion) {
      resumeTimer = setTimeout(() => {
        controls.autoRotate = true
      }, 6000)
    }
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
    spin: uniform(new THREE.Vector4(1, 0, 1, 0)) // cos/sin of the sweep, then half
  }
  const fxNdc = new THREE.Vector3()
  const fxPoint = new THREE.Vector3()
  const fxTravel = new THREE.Vector3()
  // A rolling tyre's contact patch is stationary and its rim moves at twice
  // the car's speed; the rim itself travels exactly the car's speed around
  // the hub. At 300 km/h that is a fifth of a turn per exposure, so sharp
  // spokes are not a style choice, they are impossible. The sweep angle is
  // therefore just the distance covered, in tyre radii.
  const TYRE_RADIUS = 0.375 // measured off the model's own geometry
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
    wheelAxis.set(1, 0, 0).applyQuaternion(taycan.quaternion)
    fx.wheelAxis.value.copy(wheelAxis).transformDirection(camera.matrixWorldInverse)
    for (let i = 0; i < fx.wheels.length; i += 1) {
      const group = wheelGroups[i]
      if (!group) {
        fx.wheels[i].value.set(0, 0, 1000, 0) // nowhere near any pixel
        continue
      }
      group.knuckle.getWorldPosition(wheelPoint).applyMatrix4(camera.matrixWorldInverse)
      fx.wheels[i].value.set(wheelPoint.x, wheelPoint.y, wheelPoint.z, 0)
    }
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
    measureWheels(reach, travel)
    // taps scale with the travel: a long smear needs more of them to stay
    // smooth, a short one would only waste them
    fx.samples.value = reach > 0.02 ? Math.min(40, Math.round(10 + reach * 18)) : 0
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
  const MOVIE_LOOP = 8
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

    // Magic-carpet rates: ~0.65 Hz heave (ζ ≈ 0.45), ~0.85 Hz pitch/roll
    // (ζ ≈ 0.5). Softening the spring is what buys the plush ride: the
    // further the road's frequency sits above the body's, the less of it
    // gets through, so at 3.5 Hz only about a sixth of the road reaches
    // the body. The WHEELS still take the full surface — that is the
    // point, and what you see working in the arches. Damping stays
    // modest for the same reason: over-damping bolts the body back to
    // the road. Still symmetric — an ASYMMETRIC damper ratchets against
    // a moving target and reads as bouncing however soft the springs are.
    const KH = 16.7
    const CH = 3.67
    const KA = 28.5
    const CA = 5.34
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

    // Run the edit: advance through the 8 s loop, take the cut we are in,
    // and let the drag/zoom offsets nudge it without overwriting it.
    s.movieT = (s.movieT + dt) % MOVIE_LOOP
    const pose = moviePose(MOVIES[s.movie], s.movieT)
    s.az = pose.az + s.azOff
    s.el = Math.min(1.25, Math.max(0.03, pose.el + s.elOff))
    s.dist = Math.min(16, Math.max(2.2, pose.dist * s.distScale))
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
    // [across, up from the road, along (+ = nose)].
    const aim = pose.aim
    camera.lookAt(
      taycan.position.x + (aim ? aim[0] : 0),
      taycan.position.y + (aim ? aim[1] : 0.72),
      s.z + (aim ? aim[2] : 0),
    )
    camera.fov = s.fov + 8 * aero + 4 * s.boost // speed pumps the lens, smoothly
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
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.scene) - 1
      if (!Number.isInteger(index) || index < 0 || index >= MOVIES.length) return
      playScene1(index)
      markActiveScene(index)
    })
  })
  window.addEventListener('keydown', (event) => {
    // Same reason as flyTo: leaving the bore reveals the city, so wait for it.
    if (event.code === 'Escape' && scene1) cityReady.then(() => endScene1())
  })

  // drag orbits around the car during the scene (a clean click still exits
  // through the view-hop handler); ctrl+scroll adjusts the orbit distance
  let sceneDrag = null
  canvas.addEventListener('pointerdown', (event) => {
    if (scene1) sceneDrag = { x: event.clientX, y: event.clientY }
  })
  window.addEventListener('pointermove', (event) => {
    if (!scene1 || !sceneDrag) return
    // nudge the edit rather than overwrite it: the movie keeps cutting,
    // the viewer just leans the rig a little off the operator's framing
    scene1.azOff -= (event.clientX - sceneDrag.x) * 0.006
    scene1.elOff = Math.min(0.9, Math.max(-0.9, scene1.elOff + (event.clientY - sceneDrag.y) * 0.004))
    sceneDrag.x = event.clientX
    sceneDrag.y = event.clientY
  })
  window.addEventListener('pointerup', () => {
    sceneDrag = null
  })

  // pinch on a trackpad arrives as a ctrlKey wheel event, so the same branch
  // serves ctrl+scroll on a mouse; a plain wheel keeps scrolling the page
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey || !cityInteractive()) return
      event.preventDefault()
      if (scene1) {
        // scales whatever the edit asked for, so zoom survives every cut
        scene1.distScale = Math.min(
          2.2,
          Math.max(0.6, scene1.distScale * Math.exp(event.deltaY * 0.0015)),
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
  })
  postProcessing.outputNode = fxaa(renderOutput(streaked))
  postProcessing.outputColorTransform = false

  // --- render loop, paused when the tab or the city is not visible ---
  const clock = new THREE.Clock()
  let running = false
  let lastTime = 0
  const flyForward = new THREE.Vector3()
  const flyRight = new THREE.Vector3()
  const flyMove = new THREE.Vector3()

  const tick = () => {
    const t = clock.getElapsedTime()
    const dt = Math.min(t - lastTime, 0.1)
    lastTime = t

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
      controls.update()
      setSpeedFx(null, 0, null) // free look: nothing is moving fast enough to tear
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    updateScrollFade()
  })

  // --- demo buttons: fly the camera to the published views ---
  const flyTo = (name) => {
    const preset = presets[name]
    if (!preset) return
    // The establishing views ARE the city. If it has not landed yet, hold the
    // flight rather than pan across an empty void, and run it on arrival.
    if (!city) {
      cityReady.then(() => flyTo(name))
      return
    }
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
  await renderer.renderAsync(scene, camera) // warm up pipelines before showing
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

  // Scene 1 plays by default — the hero opens on the tunnel run
  // (ESC, a click on the city, or any view button hands control back)
  if (!reducedMotion) {
    playScene1(0)
    markActiveScene(0)
  }

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
    movies: MOVIES,
    wheelGroups,
    rideHeight,
    // No THREE here. Re-exporting the namespace to a global pins every export
    // of three/webgpu as live and blocks tree-shaking entirely: that one key
    // cost 171 kB raw / 38 kB brotli in the city chunk. The classes are still
    // reachable for diagnostics through the live objects above
    // (__city.renderer, __city.camera, __city.taycan.constructor, …).
  }
}
