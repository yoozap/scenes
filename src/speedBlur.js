// Arcade-racer nitrous screen effect (NFS Underground's turbo look), as a
// TSL post node for the WebGPU pipeline.
//
// The streak is TRUE CAMERA MOTION BLUR, not a radial smear around a point.
// Each pixel's view position is reconstructed from depth, pushed back along
// the camera's own travel over one exposure, and re-projected: the vector
// between the two is where that pixel was a moment ago, and the blur runs
// along it. That is what makes the wind come from the front and rip past
// toward the back of the frame, tightening with distance, instead of
// radiating out of the middle of the picture. Point the camera down the
// road and the same field turns into the zoom blur the arcade racers use —
// the vanishing point falls out of the maths rather than being faked.
//
// Two more things keep it reading as speed rather than as a dirty lens:
//
// * THE SUBJECT STAYS SHARP. Only the world moves relative to the camera —
//   the car is being tracked, so reconstructing its motion from depth is
//   simply wrong for it. A pixel counts as subject when it falls inside the
//   car's screen footprint AND sits at the car's own depth, and those
//   pixels are composited from the untouched frame. Footprint alone would
//   keep a sharp halo of tunnel around the car; depth alone would keep the
//   walls sharp whenever the rig swings behind the car.
//
// * THE STREAK IS RENDERED AT HALF RESOLUTION, from a half-resolution copy
//   of the frame. A 300 px smear is pure low-frequency data, but at full
//   res it is ~40 long-stride taps per pixel, which roughly doubled the
//   frame time of the whole scene. Half res costs a quarter of that and is
//   indistinguishable — and the sharp half of the composite is read
//   straight from the beauty pass, so it never goes through a copy at all.

import {
  Fn,
  Loop,
  float,
  int,
  interleavedGradientNoise,
  mix,
  nodeObject,
  rtt,
  screenCoordinate,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

const opt = (value, fallback) => nodeObject(value) || fallback

// Screen UV here runs TOP-DOWN (y = 0 is the top of the frame) while clip
// space runs bottom-up, so every trip between the two has to flip y. Getting
// this wrong mirrors the rebuilt world vertically: the maths still produces
// a confident answer, it is just an answer about a mirror image — which is
// why the wheel sweep landed above the wheel instead of on it.
const uvToNdc = (u) => vec2(u.x.mul(2).sub(1), float(1).sub(u.y.mul(2)))
const ndcToUv = (n) => vec2(n.x.mul(0.5).add(0.5), float(0.5).sub(n.y.mul(0.5)))
const project = (point, focal) => ndcToUv(focal.mul(point.xy).div(point.z.min(float(-0.05)).negate()))

// A rolling wheel's rim moves at exactly the car's own speed, so at 300 km/h
// its spokes cannot possibly be sharp — they sweep a fifth of a turn while
// the shutter is open.
//
// The test is done in 3D, not as a circle drawn on the picture. A screen
// disc is only a silhouette: it also catches the wheel arch, the sill, and
// whatever bodywork happens to sit in front of the far wheels, and those
// pixels then swirl on the paint. Instead the pixel's own position is
// rebuilt from depth and measured against each wheel's axle — inside the
// tyre's radius AND within its width — so only the wheel is ever swept.
// Where it is, the pixel is rotated BACKWARD about that axle by the angle
// the wheel turned during the exposure (Rodrigues, exact, not a tangent
// approximation) and re-projected: the difference is where that piece of
// spoke actually came from.
const wheelInfluence = (wheels, axis, size, spin, focal, here, baseUv, wantTrail) => {
  const weight = float(0).toVar()
  const trail = vec2(0).toVar()
  const bow = vec2(0).toVar()
  for (const wheel of wheels) {
    const centre = wheel.xyz
    const offset = here.sub(centre)
    const axial = offset.dot(axis)
    const perp = offset.sub(axis.mul(axial))
    const inside = float(1)
      .sub(smoothstep(size.x.mul(0.93), size.x, perp.length()))
      .mul(float(1).sub(smoothstep(size.y.mul(0.8), size.y, axial.abs())))
    weight.addAssign(inside)
    if (wantTrail) {
      const hub = centre.add(axis.mul(axial))
      const cross = axis.cross(perp)
      // where this bit of spoke was a whole exposure ago, and halfway back
      const was = hub.add(perp.mul(spin.x).sub(cross.mul(spin.y)))
      const half = hub.add(perp.mul(spin.z).sub(cross.mul(spin.w)))
      const wasUv = project(was, focal)
      const halfUv = project(half, focal)
      trail.addAssign(wasUv.sub(baseUv).mul(inside))
      // the pull of the real arc away from the straight chord between them
      bow.addAssign(halfUv.mul(2).sub(baseUv).sub(wasUv).mul(inside))
    }
  }
  const norm = weight.max(float(0.0001))
  return { weight, trail: trail.div(norm), bow: bow.div(norm) }
}

// the smear itself — run at half resolution, and deliberately blind to the
// subject mask: what stays sharp is decided by the composite below
const streakPass = /*#__PURE__*/ Fn(([textureNode, options = {}]) => {
  const viewZ = options.viewZ ? nodeObject(options.viewZ) : null
  const focal = opt(options.focal, vec2(1, 1))
  const motion = opt(options.motion, vec3(0, 0, 0))
  const limit = opt(options.limit, float(0.3))
  const cap = opt(options.cap, float(1000))
  const wheels = options.wheels || null
  const wheelAxis = opt(options.wheelAxis, vec3(1, 0, 0))
  const wheelSize = opt(options.wheelSize, vec2(0.36, 0.16))
  const spin = opt(options.spin, vec4(1, 0, 1, 0)) // cos/sin of the sweep, then of half of it
  const samples = opt(options.samples, int(16))

  const baseUv = vec2(textureNode.uvNode || uv())
  const color = textureNode.sample(baseUv).toVar()

  if (viewZ !== null) {
    const total = float(1).toVar()

    // Unproject: the pixel's position in front of the lens, in metres.
    // `cap` is the arcade exaggeration — a true motion field leaves the far
    // end of the bore almost still, because its angular speed really is
    // near zero. Pretending nothing is further away than `cap` metres makes
    // the distance tear along with everything else, which is the difference
    // between a documentary and a nitrous hit. Direction is untouched.
    const z = viewZ.min(float(-0.05)).max(cap.negate()) // guard the divide, then cap
    const here = vec3(uvToNdc(baseUv).div(focal).mul(z.negate()), z)
    // the camera has moved by `motion` since the exposure opened, so a
    // static point sat exactly that much further along back then
    const wasUv = project(here.add(motion), focal)

    const trail = wasUv.sub(baseUv).toVar()

    // the wheels are the one part of the car that is NOT still relative to
    // the camera; where they cover the frame the trail comes from the axle
    const bow = vec2(0).toVar() // straight for the world, curved on a wheel
    if (wheels !== null) {
      const sweep = wheelInfluence(wheels, wheelAxis, wheelSize, spin, focal, here, baseUv, true)
      const w = sweep.weight.min(float(1))
      trail.assign(mix(trail, sweep.trail, w))
      bow.assign(sweep.bow.mul(w))
    }

    // clamp the trail: a wall a metre off the lens would otherwise smear
    // across the whole screen and take the frame with it
    const reach = trail.length().max(float(0.00001))
    trail.mulAssign(reach.min(limit).div(reach))

    // per-pixel dither — a fixed step bands badly across the tunnel gradients
    const jitter = interleavedGradientNoise(screenCoordinate)

    Loop({ start: int(1), end: samples, type: 'int', condition: '<=' }, ({ i }) => {
      const t = float(i).sub(jitter).div(float(samples)) // 0 → 1 back along the trail
      const weight = float(1).sub(t.mul(0.55)) // taper: the recent taps carry the image
      // A spinning wheel's pixels travel an ARC, not a line. Walking the
      // chord instead pulls every tap toward the hub and turns the wheel
      // into a funnel; this bends the path back onto the arc for a couple
      // of extra instructions (a quadratic through its midpoint, which is
      // within a fraction of a percent of a circle at these angles).
      const curve = trail.mul(t).add(bow.mul(t.mul(float(1).sub(t)).mul(2)))
      color.addAssign(textureNode.sample(baseUv.add(curve)).mul(weight))
      total.addAssign(weight)
    })

    color.divAssign(total)
  }

  return color
})

// full-res composite: subject sharp, world streaked, plus the nitrous grade.
// `sharpNode` is the beauty pass itself, evaluated at this fragment — not a
// texture to sample, so the frame is never copied at full resolution.
const composePass = /*#__PURE__*/ Fn(([sharpNode, blurNode, options = {}]) => {
  const center = opt(options.center, vec2(0.5, 0.5))
  const boost = opt(options.boost, float(0))
  const viewZ = options.viewZ ? nodeObject(options.viewZ) : null
  const body = options.body || null // the car as an oriented box, view space
  const fringe = opt(options.fringe, float(0.004))
  const wheels = options.wheels || null
  const wheelAxis = opt(options.wheelAxis, vec3(1, 0, 0))
  const wheelSize = opt(options.wheelSize, vec2(0.36, 0.16))
  const focal = opt(options.focal, vec2(1, 1))

  const baseUv = vec2(uv())
  const outward = baseUv.sub(center)
  const radius = outward.length()

  const base = vec4(sharpNode)

  // a fast lens breaks up at the rim when it is being shaken this hard. The
  // split rides on the blurred tap, so it costs three cheap half-res reads
  // instead of a whole extra full-res pass.
  const shift = outward.mul(fringe.mul(boost))
  const smeared = vec4(
    blurNode.sample(baseUv.add(shift)).r,
    blurNode.sample(baseUv).g,
    blurNode.sample(baseUv.sub(shift)).b,
    base.a,
  )

  // how much of this pixel is world rather than subject
  const world = float(1).toVar()
  if (viewZ !== null && body !== null) {
    // The car as an ORIENTED BOX in space, tested against the pixel's own
    // rebuilt position. A screen rectangle plus a depth window cannot tell
    // the car from the road it is sitting on — they are the same distance
    // away — so it used to protect a rectangle of asphalt under the car and
    // print its edges across the tarmac. A box in metres cannot make that
    // mistake.
    const zHere = viewZ.min(float(-0.05))
    const here = vec3(uvToNdc(baseUv).div(focal).mul(zHere.negate()), zHere)
    const d = here.sub(body.centre)
    // A fixed-width feather, in metres — a fraction of each half-extent
    // would put a 28 cm soft band along the length of the car and only 6 cm
    // under it, so low bodywork (the splitter, the sills) half dissolved
    // while the road was nearly protected. 8 cm everywhere.
    const feather = float(0.08)
    const soft = (value, half) => float(1).sub(smoothstep(half.sub(feather), half, value.abs()))
    const inFootprint = soft(d.dot(body.right), body.half.x)
      .mul(soft(d.dot(body.up), body.half.y))
      .mul(soft(d.dot(body.forward), body.half.z))
    let still = inFootprint
    if (wheels !== null) {
      const spinning = wheelInfluence(
        wheels, wheelAxis, wheelSize, vec4(1, 0, 1, 0), focal, here, baseUv, false,
      )
      // the wheels are subject too, but they are SPINNING subject:
      // protecting them is what freezes the spokes
      still = still.mul(float(1).sub(spinning.weight.min(float(1))))
    }
    world.assign(float(1).sub(still))
  }

  const color = mix(base, smeared, world)

  // the grade: nitrous runs cold at the rim and closes the frame in on the car
  const rim = smoothstep(float(0.18), float(0.95), radius).mul(boost)
  const graded = mix(color.rgb, color.rgb.mul(vec3(0.74, 0.9, 1.35)), rim.mul(0.85))

  return vec4(graded.mul(float(1).sub(rim.mul(0.3))), color.a)
})

/**
 * @param {Node<vec4>} inputNode         - the frame to streak (HDR, after bloom)
 * @param {Object}     [options]
 * @param {Node<float>}[options.viewZ]   - view-space z per pixel (negative)
 * @param {Node<vec2>} [options.focal]   - projection scale, proj[0][0] / proj[1][1]
 * @param {Node<vec3>} [options.motion]  - camera travel over one exposure, view space
 * @param {Node<float>}[options.limit]   - longest trail allowed, in uvs
 * @param {Node<int>}  [options.samples] - taps along the trail (0 = off)
 * @param {Node<vec2>} [options.center]  - anchor for the rim grade, in uvs
 * @param {Node<float>}[options.boost]   - 0..1 grade strength (tint, rim, fringe)
 * @param {Object}     [options.body]    - the car as an oriented box in view
 *   space: { centre, right, up, forward, half } — what stays sharp
 * @param {Array<Node<vec4>>} [options.wheels] - wheel centres in VIEW space (xyz)
 * @param {Node<vec3>} [options.wheelAxis] - the axle direction, view space
 * @param {Node<vec2>} [options.wheelSize] - tyre radius, half-width (metres)
 * @param {Node<vec4>} [options.spin]    - cos/sin of the sweep, then of half of it
 * @param {number}     [options.scale]   - resolution the streak is rendered at
 */
export const speedBlur = (inputNode, options = {}) => {
  const scale = options.scale ?? 0.5
  // the streak reads a half-res copy and writes a half-res result; the sharp
  // subject is taken from the beauty pass directly, so the only full-size
  // work left in the effect is the composite itself
  const source = rtt(nodeObject(inputNode), null, null, { resolutionScale: scale })
  const blurred = rtt(streakPass(source, options), null, null, { resolutionScale: scale })
  return composePass(inputNode, blurred, options)
}
