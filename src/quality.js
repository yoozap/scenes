// The quality governor — the usectl landing's 12-webgpu phone ladder, cut
// down to the knobs THIS scene owns. Nothing in here guesses WHICH device
// it is on; it MEASURES:
//
//   · every device opens on the rung its own gpu earns: the fill bench —
//     a real timed render on a throwaway context at boot — prices the gpu
//     before the renderer even initialises. Masked gpu strings (every
//     iphone) cannot lie to a stopwatch.
//   · the static probe (cores, ram, coarse pointer) can pull a weak
//     android DOWN from what the bench said, never up.
//   · what a visit learns is REMEMBERED for a week, per device shape, so
//     the next load opens settled instead of re-janking its way down.
//   · a live watchdog on the measured frame cost has the last word. It
//     only walks down; a climb back needs six seconds of clean frames,
//     and it locks itself out if the climb is followed by another demote
//     (that oscillation IS the jank it exists to prevent).
//
// What each rung moves, in order of what it buys:
//   dpr        canvas resolution — every pass in the chain scales with it,
//              so this one knob is most of the frame.
//   probeEvery the live reflection probe: six cube faces plus a PMREM
//              prefilter, the most expensive single item in the frame.
//              2 is the page as written; 4 halves it again on weak gpus.
//   samplesCap ceiling on the speed-blur taps (the scene asks up to 40
//              by motion; a weak gpu caps lower and the streak simply
//              gets slightly coarser grain).
//
// Rung 3 is ULTRA — and it does not ask for a RATIO, it asks for a PIXEL
// COUNT: dpr-3 panels get their own pixels back only as far as ~3.2M
// device pixels buys (render targets are ~40 bytes a pixel down this
// chain), never more than the device has.
//
// Dev knobs: ?rung=N pins a rung (watchdog off), ?dpr=X fakes the panel's
// ratio, ?webgl forces the WebGL2 backend — the path an older phone takes.

const RUNGS = [
  // 0 — the bad phone: the probe at quarter cadence, dpr 1, a coarse
  // streak. Bloom and the neon stay — they ARE the scene, and a rung
  // that turns the tunnel's lights off does not read as cheaper, it
  // reads as broken.
  { dpr: 1, probeEvery: 4, samplesCap: 12 },
  // 1 — the mid phone
  { dpr: 1.5, probeEvery: 2, samplesCap: 20 },
  // 2 — the page as written (dpr capped at 2, the old fixed behaviour)
  { dpr: 2, probeEvery: 2, samplesCap: 40 },
  // 3 — ULTRA: the panel's own pixels, budgeted (see dpr() below)
  { dpr: 3, probeEvery: 2, samplesCap: 40 },
]

const PIXEL_BUDGET = 3.2e6 // device pixels rung 3 may ask the chain for
const MEM_KEY = 'yz_scene_q1'
const MEM_TTL = 7 * 24 * 3600 * 1000

// ── the fill bench ──────────────────────────────────────────────────
// A fragment-heavy quad drawn 16 times over 768² with blending — the
// shape of this page's cost (fullscreen passes × ALU) — and a 1×1
// readPixels to force a tile gpu to actually finish. ~4-8 ms on a
// desktop, tens on a phone soc, hundreds on the ones rung 0 exists for.
// The context is throwaway and explicitly lost afterwards.
const fillBench = () => {
  try {
    const cv = document.createElement('canvas')
    cv.width = 768
    cv.height = 768
    const gl = cv.getContext('webgl', {
      antialias: false,
      depth: false,
      alpha: false,
      powerPreference: 'high-performance',
    })
    if (!gl) return -1
    const sh = (type, src) => {
      const h = gl.createShader(type)
      gl.shaderSource(h, src)
      gl.compileShader(h)
      return h
    }
    const pr = gl.createProgram()
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'))
    gl.attachShader(
      pr,
      sh(
        gl.FRAGMENT_SHADER,
        'precision highp float;uniform float u;void main(){float a=0.;vec2 q=gl_FragCoord.xy*0.013;' +
          'for(int i=0;i<40;i++){a+=sin(q.x*float(i)+u)*cos(q.y+a);}gl_FragColor=vec4(vec3(a*0.01+0.5),0.5);}',
      ),
    )
    gl.linkProgram(pr)
    gl.useProgram(pr)
    const b = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(pr, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const un = gl.getUniformLocation(pr, 'u')
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    const px = new Uint8Array(4)
    gl.uniform1f(un, 0.5)
    gl.drawArrays(gl.TRIANGLES, 0, 3) // warm: compile + first tile pass
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const t0 = performance.now()
    for (let f = 0; f < 16; f += 1) {
      gl.uniform1f(un, f * 0.37)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const ms = performance.now() - t0
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return ms
  } catch {
    return -1
  }
}

export const initQuality = () => {
  const params = new URLSearchParams(location.search)
  const forcedRung = params.has('rung') ? Math.min(3, Math.max(0, params.get('rung') | 0)) : null
  const fakeDpr = params.has('dpr') ? +params.get('dpr') || 0 : 0
  const forceWebGL = params.has('webgl')
  const native = () => fakeDpr || window.devicePixelRatio || 1

  const coarse = window.matchMedia('(pointer: coarse)').matches
  const shape = [
    Math.round(screen.width),
    Math.round(screen.height),
    native(),
    navigator.hardwareConcurrency || 0,
    coarse ? 'm' : 'd',
    forceWebGL ? 'gl' : 'gpu',
  ].join('x')

  let rung
  let why
  if (forcedRung !== null) {
    rung = forcedRung
    why = 'forced'
  } else {
    // a remembered rung opens settled — no re-jank on the way down
    let remembered = null
    try {
      const m = JSON.parse(localStorage.getItem(MEM_KEY) || 'null')
      if (m && m.shape === shape && Date.now() - m.t < MEM_TTL) remembered = m.rung
    } catch {}
    if (remembered !== null) {
      rung = remembered
      why = 'remembered'
    } else {
      const ms = fillBench()
      // bands measured against the bench's own reference points: flagship
      // desktop ~5, apple/android flagship phone ~15-35, mid phone ~60+
      rung = ms < 0 ? 1 : ms < 14 ? 3 : ms < 40 ? 2 : ms < 95 ? 1 : 0
      // the static probe pulls a weak machine down, never up
      const cores = navigator.hardwareConcurrency || 8
      const mem = navigator.deviceMemory || 8
      if ((cores <= 4 || mem <= 4) && rung > 1) rung = 1
      // a fine-pointer machine never opens below the page as written —
      // desktops with a slow first paint bench worse than they run
      if (!coarse && rung < 2) rung = 2
      why = `bench ${ms < 0 ? 'n/a' : ms.toFixed(1) + 'ms'}`
    }
  }
  const ceil = coarse ? 3 : Math.max(rung, 3) // measured strong = earned, either way
  console.info(`[quality] rung ${rung} (${why}), shape ${shape}`)

  const remember = () => {
    try {
      localStorage.setItem(MEM_KEY, JSON.stringify({ shape, rung, t: Date.now() }))
    } catch {}
  }
  if (forcedRung === null && why !== 'remembered') remember()

  // ── the watchdog ──────────────────────────────────────────────────
  // Raw frame-to-frame time, exponentially averaged. Compile stalls
  // (the >quarter-second frames pipelines cost when a movie cut brings
  // a new shader variant in) reset the window instead of poisoning it.
  let ema = 0
  let refresh = 1 / 60
  let warmup = 60 // the compile-stall opening frames teach nothing
  const refDts = []
  let slowSince = 0
  let cleanSince = 0
  let climbed = false
  let climbLocked = false
  let lastDemoteAt = 0

  const frame = (dt, now) => {
    if (forcedRung !== null) return false
    if (dt <= 0 || dt > 0.25) {
      slowSince = 0
      cleanSince = 0
      return false
    }
    if (warmup > 0) {
      warmup -= 1
      return false
    }
    // the panel's own rate: the vsync interval is the FLOOR of the clean
    // frames, so take a low percentile — a median would swallow jank and
    // set the slow line too loose to ever fire
    if (refDts.length < 48) {
      refDts.push(dt)
      if (refDts.length === 48) {
        const sorted = [...refDts].sort((a, b) => a - b)
        refresh = Math.max(1 / 144, Math.min(1 / 30, sorted[7]))
      }
      return false
    }
    ema += (dt - ema) * 0.08
    const slow = ema > Math.max(0.022, refresh * 1.4)
    const clean = ema < refresh * 1.12
    if (slow && rung > 0) {
      slowSince = slowSince || now
      cleanSince = 0
      if (now - slowSince > 1.4) {
        rung -= 1
        slowSince = 0
        ema = refresh // restart the average on the new rung's cost
        if (climbed) climbLocked = true // climbing again would oscillate
        lastDemoteAt = now
        remember()
        console.info(`[quality] demoted to rung ${rung}`)
        return true
      }
    } else if (clean && rung < ceil && !climbLocked && now - lastDemoteAt > 8) {
      slowSince = 0
      cleanSince = cleanSince || now
      if (now - cleanSince > 6) {
        rung += 1
        cleanSince = 0
        ema = refresh
        climbed = true
        remember()
        console.info(`[quality] promoted to rung ${rung}`)
        return true
      }
    } else {
      slowSince = 0
      cleanSince = 0
    }
    return false
  }

  return {
    forceWebGL,
    frame,
    knobs: () => RUNGS[rung],
    rung: () => rung,
    // rung 3 asks for a pixel COUNT, not a ratio: the panel's full dpr
    // only as far as the budget buys, and never below the old cap of 2
    dpr: () => {
      const k = RUNGS[rung]
      if (rung < 3) return Math.min(native(), k.dpr)
      const cssPx = Math.max(1, window.innerWidth * window.innerHeight)
      return Math.max(2, Math.min(native(), Math.sqrt(PIXEL_BUDGET / cssPx)))
    },
  }
}
