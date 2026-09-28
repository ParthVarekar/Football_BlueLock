/**
 * First-person body: a full toon footballer — jersey torso, shorts, jointed
 * legs (thigh · knee · shin · sock · boot) and arms hanging at the sides —
 * anchored UNDER THE PLAYER in world space. The Game calls `place()` every
 * frame to pin the hips under the eye and yaw the body with the view.
 *
 * Framing mirrors a real body: the eye sits a hand's width IN FRONT of the
 * spine (and drifts further forward as the head tips down), so a look-down
 * shows the chest and belly curving in along the bottom edge with the legs
 * striding beneath — never a torso poking up into the middle of the view.
 * Only the LEGS reach forward with the look-down (hip flexion), so the boots
 * stay in frame while the torso stays upright.
 *
 * The flair skills (rainbow / rabona / roulette / elastico / crouyff /
 * backheel / juggle / volley) drive a blended ADDITIVE action layer over the
 * run cycle: base swing is damped while the action pose is added on top, so
 * every entry and exit is smooth.
 */
import * as THREE from 'three'
import { SKILL2, type Quality, QUALITY } from '../core/constants'
import { clamp } from '../core/math'
import { makeToonMaterial } from './toon'
import { addOutline } from './outline'

/** Flair-action state fed by the Game each frame (mirrors LocalPlayer). */
export interface LegActionState {
  /** 1 rainbow · 2 rabona · 3 roulette · 4 elastico · 5 crouyff · 6 backheel · 8 volley. */
  kind: number
  /** Seconds remaining. */
  t: number
  /** Total duration. */
  total: number
  /** Side / direction param (±1). */
  s: number
  /** Sustained juggle flag. */
  juggle: boolean
  /** Juggle bounce phase (cycles; even = foot contact, odd = knee contact). */
  jugglePhase: number
}

/** Additive pose offsets that make up the action layer. */
interface ActionPose {
  /** Right (action) leg hip rotations + lateral hip shift. */
  legRx: number
  legRz: number
  legRpx: number
  legLx: number
  legLz: number
  groupY: number
  groupX: number
  groupZ: number
  /** Multiplier on the run-cycle swing (1 = untouched). */
  swingDamp: number
  /** Stride-phase rate multiplier (roulette shuffle steps). */
  phaseRate: number
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Fade an action in over its first ~70 ms and out over its final ~22 %. */
const actionEnv = (u: number, total: number): number => {
  const inT = Math.min(0.07, total * 0.3)
  const fadeIn = smooth(clamp((u * total) / inT, 0, 1))
  const fadeOut = smooth(clamp((1 - u) / 0.22, 0, 1))
  return fadeIn * fadeOut
}

// ---- body dimensions (metres, hip-joint space: +Y up, -Z forward)
/** Hip-joint height above the turf. */
const HIP_Y = 0.94
/** Lateral hip-joint offset. */
const HIP_X = 0.1
const THIGH = 0.45
const SHIN = 0.43
/** Spine sits this far behind the eye at a level gaze … */
const SPINE_BACK = 0.08
/** … plus this much more at a full look-down (the head tips forward over the chest). */
const SPINE_BACK_LOOK = 0.1
const SHOULDER_Y = 0.46
const SHOULDER_X = 0.215
const UPPER_ARM = 0.28
/** Pitch (rad, looking down) that counts as a full look-down. */
const FULL_LOOK = 1.2

/** One jointed leg: hip → thigh → knee → shin → boot. */
interface Leg {
  hip: THREE.Group
  knee: THREE.Group
}

/** One jointed arm: shoulder → upper arm → elbow → forearm → hand. */
interface Arm {
  shoulder: THREE.Group
  elbow: THREE.Group
}

export class LegsView {
  readonly group = new THREE.Group()
  /** Torso + arms (upright, independent of the legs' look-down reach). */
  private readonly upper = new THREE.Group()
  private readonly legL: Leg
  private readonly legR: Leg
  private readonly armL: Arm
  private readonly armR: Arm
  private phase = 0
  /** 0..1 throw blend — arms rise + legs plant. */
  private throwBlend = 0
  /** 0..1 slide blend — everything drops and stretches back. */
  private slideBlend = 0
  /** -1..1 stepover feint sway. */
  private stepSway = 0
  /** 0..1 flick toe-poke envelope. */
  private flickPoke = 0
  /** 0..1 look-down amount (from the visual pitch). */
  private look = 0
  /** Hip drop below HIP_Y (slide crouch + action hops), set by update(). */
  private hipDrop = 0

  constructor(quality: Quality) {
    const q = QUALITY[quality]
    const outline = (m: THREE.Mesh): THREE.Mesh => {
      addOutline(m, { widthPx: q.outlinePx })
      return m
    }
    const kitMat = makeToonMaterial({ color: '#f6f2e8' })
    const shortsMat = makeToonMaterial({ color: '#34425f' })
    const bootMat = makeToonMaterial({ color: '#2e2620' })
    const soleMat = makeToonMaterial({ color: '#e8b04a' })
    const skinMat = makeToonMaterial({ color: '#c68958' })
    /** A capsule hanging DOWN from its joint: top cap at y = -top, bottom cap at y = -(top + len). */
    const limb = (r: number, len: number, top: number): THREE.CapsuleGeometry =>
      new THREE.CapsuleGeometry(r, len, 4, 12).translate(0, -(top + r + len / 2), 0) as THREE.CapsuleGeometry

    const makeLeg = (side: 1 | -1): Leg => {
      const hip = new THREE.Group()
      hip.position.set(side * HIP_X, 0, 0)
      // thigh (skin) with the shorts leg over its upper half
      hip.add(outline(new THREE.Mesh(limb(0.066, THIGH - 0.1, -0.02), skinMat)))
      hip.add(outline(new THREE.Mesh(limb(0.09, 0.08, 0.02), shortsMat)))
      const knee = new THREE.Group()
      knee.position.set(0, -THIGH, 0)
      hip.add(knee)
      // shin (skin) + sock over the lower two thirds
      knee.add(outline(new THREE.Mesh(limb(0.056, SHIN - 0.08, -0.03), skinMat)))
      knee.add(outline(new THREE.Mesh(limb(0.062, SHIN - 0.2, 0.1), kitMat)))
      // boot: toe forward (-Z), heel just behind the ankle, sole underneath
      const boot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8).scale(1.05, 0.8, 1.9).translate(0, -SHIN + 0.005, -0.06), bootMat)
      knee.add(outline(boot))
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.26).translate(0, -SHIN - 0.047, -0.06), soleMat)
      knee.add(sole)
      return { hip, knee }
    }
    this.legL = makeLeg(1)
    this.legR = makeLeg(-1)
    this.group.add(this.legL.hip, this.legR.hip)

    // pelvis / shorts seat — bridges both thighs into one mass
    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.08, 4, 12).rotateZ(Math.PI / 2).scale(1, 1, 0.78), shortsMat)
    this.group.add(outline(pelvis))

    // ---- upper body: an upright tapered jersey torso with the shoulders
    // well below the eye, arms hanging at the sides
    this.group.add(this.upper)
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, 0.25, 6, 16)
        .scale(1.22, 1, 0.74)
        .translate(0, 0.27, 0),
      kitMat,
    )
    // taper: waist narrower than the chest
    {
      const pos = torso.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i)
        const k = 0.86 + 0.14 * clamp((y - 0.05) / 0.35, 0, 1)
        pos.setX(i, pos.getX(i) * k)
      }
      pos.needsUpdate = true
      torso.geometry.computeVertexNormals()
    }
    this.upper.add(outline(torso))

    const makeArm = (side: 1 | -1): Arm => {
      const shoulder = new THREE.Group()
      shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0.005)
      shoulder.add(outline(new THREE.Mesh(new THREE.SphereGeometry(0.072, 12, 10), kitMat)))
      shoulder.add(outline(new THREE.Mesh(limb(0.05, UPPER_ARM - 0.1, 0), skinMat)))
      shoulder.add(outline(new THREE.Mesh(limb(0.064, 0.07, -0.02), kitMat)))
      const elbow = new THREE.Group()
      elbow.position.set(0, -UPPER_ARM, 0)
      shoulder.add(elbow)
      elbow.add(outline(new THREE.Mesh(limb(0.045, 0.17, -0.02), skinMat)))
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8).scale(0.85, 1.15, 0.95).translate(0, -0.29, 0), skinMat)
      elbow.add(outline(hand))
      this.upper.add(shoulder)
      return { shoulder, elbow }
    }
    this.armL = makeArm(1)
    this.armR = makeArm(-1)

    this.group.renderOrder = 3
    // yaw first, then pitch/roll about the BODY's own axes (matches the camera
    // rig). The default 'XYZ' applied lean about the WORLD X axis, so at any
    // yaw but 0 the body tipped sideways.
    this.group.rotation.order = 'YXZ'
  }

  /**
   * Pin the body under the viewer: hips at the player's feet position, a hand
   * behind the eye (further back as the head tips down), yawed with the view.
   */
  place(x: number, z: number, yaw: number): void {
    const back = SPINE_BACK + SPINE_BACK_LOOK * this.look
    // forward is -Z rotated by yaw → "back" is +Z rotated by yaw
    this.group.position.set(x + Math.sin(yaw) * back, HIP_Y - this.hipDrop, z + Math.cos(yaw) * back)
    this.group.rotation.y = yaw
  }

  /**
   * The flair-skill action layer — distinct, readable choreography per skill,
   * all additive over the run cycle and envelope-blended at both ends.
   */
  private actionPose(a: LegActionState): ActionPose {
    const p: ActionPose = { legRx: 0, legRz: 0, legRpx: 0, legLx: 0, legLz: 0, groupY: 0, groupX: 0, groupZ: 0, swingDamp: 1, phaseRate: 1 }

    // ---- juggle: alternating knee/foot lifts phase-locked to the ball bounce
    if (a.juggle && a.kind === 0) {
      const cycle = Math.floor(a.jugglePhase)
      const frac = a.jugglePhase - cycle
      const even = cycle % 2 === 0
      // strike-through just after contact, small wind-up just before the next
      const strike = Math.exp(-Math.pow((frac - 0.08) / 0.16, 2))
      const wind = Math.exp(-Math.pow((frac - 0.93) / 0.09, 2)) * 0.35
      const lift = strike + wind
      if (even) {
        p.legRx = 0.62 * lift // right-foot bounce — knee raises up-forward (in view)
        p.legLx = 0.1
      } else {
        p.legLx = 0.8 * lift // left-knee bounce (higher read, in view)
        p.legRx = 0.08
      }
      p.groupY = 0.016 * lift
      p.swingDamp = 0.55
      return p
    }

    const u = clamp(1 - a.t / a.total, 0, 1)
    const e = actionEnv(u, a.total)
    const s = a.s >= 0 ? 1 : -1

    switch (a.kind) {
      case 1: {
        // RAINBOW — roll-up dip + inward sweep, heel flick UP behind, settle step
        const rollU = SKILL2.rainbow.riseTime / a.total
        if (u < rollU) {
          const r = smooth(u / rollU)
          p.groupY = -0.075 * Math.sin(r * Math.PI * 0.5) // body dips as the ball climbs
          p.legRz = 0.5 * r // boot sweeps a low arc inward toward the standing leg
          p.legRx = 0.3 * r // leg coils back for the flick
          p.swingDamp = 0.45
        } else {
          const f = clamp((u - rollU) / 0.24, 0, 1)
          if (f < 1) {
            const flick = Math.sin(Math.min(1, f * 1.35) * Math.PI) // fast up, ease over
            p.legRx = 1.45 * flick // right leg flicks UP behind — the heel read
            p.legRz = 0.5 * (1 - f)
            p.groupX = -0.16 * flick // body tilts back
            p.groupY = -0.075 * (1 - f) + 0.02 * flick
            p.swingDamp = 0.3
          } else {
            const st = clamp((u - rollU - 0.24) / (1 - rollU - 0.24), 0, 1)
            p.legLx = 0.4 * Math.sin(st * Math.PI) // step forward out of it
            p.groupY = 0.02 * (1 - st)
            p.swingDamp = 0.55
          }
        }
        break
      }
      case 2: {
        // RABONA — right leg crosses in front of the planted left, big sweep
        // behind the standing leg, hop dip, recover uncrossed
        const crossU = 0.38
        if (u < crossU) {
          const r = smooth(u / crossU)
          p.legRpx = 0.24 * r // position.x crosses over the planted leg
          p.legRx = 0.5 * r // leg swings up-forward across the body (in view)
          p.groupZ = -0.09 * r // body leans with the cross
          p.swingDamp = 0.35
        } else {
          const f = clamp((u - crossU) / 0.38, 0, 1)
          if (f < 1) {
            const sweep = Math.sin(Math.min(1, f * 1.4) * Math.PI)
            p.legRpx = 0.24 * (1 - f) // uncrosses through the strike
            p.legRx = 1.35 * sweep + 0.5 * (1 - f) // strike sweeps forward-down THROUGH the frame
            p.groupZ = -0.09 * (1 - f) + 0.06 * sweep
            p.groupY = -0.055 * Math.sin(f * Math.PI) // hop dip on the planted leg
            p.swingDamp = 0.3
          } else {
            const rec = clamp((u - crossU - 0.38) / (1 - crossU - 0.38), 0, 1)
            p.legLx = 0.38 * Math.sin(rec * Math.PI) // recover step forward, uncrossed
            p.swingDamp = 0.6
          }
        }
        break
      }
      case 3: {
        // ROULETTE — fast small shuffle steps + mid-spin sole-drag foot
        // (the camera does the 360° sweep; the legs dance beneath it)
        p.phaseRate = 2.5
        p.swingDamp = 0.5
        const mid = Math.sin(u * Math.PI)
        p.legRx = 0.72 * mid // sole-drag foot reaches up-forward, toe-down (in view)
        p.groupY = -0.05 * mid // slight crouch to match the camera dip
        p.groupZ = -s * 0.08 * mid // hips stay tilted into the spin
        break
      }
      case 4: {
        // ELASTICO — hips sway out with the push, toe-tap out, instap snap across
        const outU = SKILL2.elastico.outTime / a.total
        if (u < outU) {
          const r = smooth(u / outU)
          p.groupZ = s * 0.1 * r // hips sway out (with the ball push)
          p.legRz = s * 0.42 * r // toe-tap out on the push side
          p.legRx = 0.15 * r
          p.swingDamp = 0.5
        } else {
          const f = clamp((u - outU) / (1 - outU), 0, 1)
          const snap = Math.sin(Math.min(1, f * 1.6) * Math.PI)
          p.groupZ = s * 0.1 * (1 - f) - s * 0.13 * snap // hips snap back in
          p.legRz = s * 0.42 * (1 - f) - s * 0.35 * snap // instep snaps across the body
          p.legRx = 0.55 * snap // sweeping follow-through through the frame
          p.swingDamp = 0.4
        }
        break
      }
      case 5: {
        // CRUYFF — full kick backswing that BRAKES short, foot hooks down-back
        // behind the standing leg, body pivots with the 180° turn
        const windU = SKILL2.crouyff.windup / a.total
        if (u < windU) {
          const r = u / windU
          p.legRx = -0.85 * smooth(Math.min(1, r * 1.5)) // backswing cocks back (out of frame = the wind-up read)
          p.groupX = 0.06 * r // slight forward lean into the fake shot
          p.swingDamp = 0.35
        } else {
          const f = clamp((u - windU) / (1 - windU), 0, 1)
          const hook = Math.sin(Math.min(1, f * 1.3) * Math.PI)
          p.legRx = (-0.85 * (1 - f) - 0.45 * hook) * (1 - Math.max(0, (f - 0.7) / 0.3)) // releases, hooks down-back dragging the ball
          p.legRz = 0.3 * hook * (1 - Math.max(0, (f - 0.7) / 0.3)) // hooks behind the standing leg
          p.groupZ = -s * 0.12 * Math.sin(f * Math.PI * 0.5) // leans through the turn
          p.legLx = 0.4 * Math.sin(Math.max(0, (f - 0.55) / 0.45) * Math.PI) // step out of the turn
          p.swingDamp = 0.3
        }
        break
      }
      case 6: {
        // BACKHEEL — heel flicks back between the legs (toe-up read), slight
        // forward lean, quick recovery step
        const f = Math.sin(Math.min(1, u * 1.5) * Math.PI)
        p.legRx = -0.55 * f // heel snaps back between the legs (quick back-flick read)
        p.legRz = 0.18 * f
        p.groupX = 0.1 * f
        p.groupY = -0.03 * f
        if (u > 0.5) {
          const rec = clamp((u - 0.5) / 0.5, 0, 1)
          p.legLx = 0.45 * Math.sin(rec * Math.PI)
        }
        p.swingDamp = 0.45
        break
      }
      case 8: {
        // VOLLEY — drive off the left leg, right leg scissored high, body leans
        // back, landing settle
        const air = Math.sin(Math.min(1, u * 1.15) * Math.PI)
        p.legLx = -0.5 * clamp(u / 0.6, 0, 1) // left drive leg trails back
        p.legRx = 1.55 * Math.sin(Math.min(1, u * 1.6) * Math.PI) // right leg scissored HIGH through the frame
        p.groupX = -0.2 * air // body leans back
        p.groupY = 0.09 * air // airborne
        if (u > 0.72) {
          const land = clamp((u - 0.72) / 0.28, 0, 1)
          p.groupY = -0.05 * Math.sin(land * Math.PI) // landing settle
        }
        p.swingDamp = 0.3
        break
      }
    }

    // envelope the whole pose so entries/exits never snap
    p.legRx *= e
    p.legRz *= e
    p.legRpx *= e
    p.legLx *= e
    p.legLz *= e
    p.groupY *= e
    p.groupX *= e
    p.groupZ *= e
    p.swingDamp = 1 - (1 - p.swingDamp) * e
    return p
  }

  /**
   * @param speed01  0..1 movement speed
   * @param kickT    remaining kick follow-through (0..0.32)
   * @param cutS     body roll side during a cut
   * @param throwHold true while holding the ball for a throw-in (arms stay up)
   * @param throwT   remaining throw fling anim (0..0.5) — 0 when only holding
   * @param slide01  0..1 slide blend
   * @param stepSide -1..1 stepover feint sway envelope
   * @param flick01  0..1 flick toe-poke envelope
   * @param action   flair-skill action state (null = run cycle only)
   * @param lookPitch the camera's visual pitch (negative = looking down)
   */
  update(
    dt: number,
    speed01: number,
    kickT: number,
    cutS: number,
    throwHold = false,
    throwT = 0,
    slide01 = 0,
    stepSide = 0,
    flick01 = 0,
    action: LegActionState | null = null,
    lookPitch = 0,
  ): void {
    const act = action && (action.kind !== 0 || action.juggle) ? action : null
    const ap = act ? this.actionPose(act) : null

    // approach the pose blends smoothly
    const approach = (cur: number, target: number, rate: number): number => cur + (target - cur) * Math.min(1, rate * dt)
    this.throwBlend = approach(this.throwBlend, throwHold || throwT > 0 ? 1 : 0, 10)
    this.slideBlend = approach(this.slideBlend, slide01, 9)
    this.stepSway = approach(this.stepSway, stepSide, 11)
    this.flickPoke = approach(this.flickPoke, flick01, 12)
    this.look = clamp(-lookPitch / FULL_LOOK, 0, 1)

    this.phase += (2.4 + speed01 * 11.5) * dt * (speed01 > 0.03 && this.slideBlend < 0.5 ? 1 : 0.25) * (ap ? ap.phaseRate : 1)
    const damp = (1 - this.throwBlend * 0.85) * (1 - this.slideBlend) * (ap ? ap.swingDamp : 1)
    const swing = Math.sin(this.phase) * (0.14 + speed01 * 0.5) * damp
    // swing-phase knee lift: the leg travelling forward folds at the knee
    // (peaks as the thigh passes vertical), the planted leg stays near-straight
    const lift = Math.cos(this.phase) * damp
    const kneeRun = 0.12 + speed01 * 1.05
    const kneeBase = 0.06 + 0.08 * this.look

    // hip flexion that follows the look-down: the LEGS reach forward so the
    // boots stay in frame, the torso stays upright above them
    const reach = 0.04 + 0.22 * this.look

    let thighL: number
    let thighR: number
    let kneeL: number
    let kneeR: number
    let hipZL = 0
    let hipZR = 0
    let hipXR = -HIP_X

    if (this.slideBlend > 0.01) {
      // ---- slide: hips drop toward the turf, the lead (right) leg shoots out
      // straight along the ground, the trailing leg folds under
      const s = this.slideBlend
      thighR = s * 1.5 + swing * 0.08
      thighL = s * 1.15 + swing * 0.08
      kneeR = s * 0.05
      kneeL = s * 0.95
      hipZL = s * 0.12
      hipZR = -s * 0.1
      this.hipDrop = s * 0.5
    } else {
      this.hipDrop = 0
      // asymmetric stride: the lead leg sweeps forward at full amplitude, the
      // recovery leg only folds back 40% — both stay readable in the frame
      const fw = (v: number): number => (v > 0 ? v : v * 0.4)
      thighL = fw(swing) + reach - this.stepSway * 0.5
      kneeL = kneeBase + kneeRun * Math.pow(Math.max(0, lift), 1.4)
      if (kickT > 0) {
        // forward-up strike sweep through the lower half of the frame; the knee
        // snaps straight through contact
        const t = 1 - kickT / 0.32
        thighR = Math.sin(Math.min(1, t * 1.5) * Math.PI) * 0.95 + 0.3 * Math.max(0, 0.35 - t) + reach * 0.5
        kneeR = 0.55 * Math.max(0, 1 - t * 3) + 0.05
      } else {
        thighR = fw(-swing) + reach - this.stepSway * 0.5
        kneeR = kneeBase + kneeRun * Math.pow(Math.max(0, -lift), 1.4)
      }
      // flick: right toe jabs under and forward — up into view
      if (this.flickPoke > 0.01) {
        thighR += this.flickPoke * 0.85
        hipZR = -this.flickPoke * 0.12
      }

      // ---- flair action layer (additive over the base pose above)
      if (ap) {
        thighR += ap.legRx
        thighL += ap.legLx
        hipZR += ap.legRz
        hipZL += ap.legLz
        hipXR = -HIP_X + ap.legRpx * 0.8
        this.hipDrop = -ap.groupY
      }
    }

    // a leg swung BEHIND the hip folds at the knee (heel flicks, wind-ups)
    kneeL += Math.max(0, -thighL) * 0.9
    kneeR += Math.max(0, -thighR) * 0.9

    this.legL.hip.rotation.set(thighL, 0, hipZL)
    this.legR.hip.rotation.set(thighR, 0, hipZR)
    this.legR.hip.position.x = hipXR
    // knee flexion folds the shin BACK (negative X)
    this.legL.knee.rotation.x = -kneeL
    this.legR.knee.rotation.x = -kneeR

    // body sway: stepover feint + cut roll + action offsets (the whole body)
    this.group.rotation.z = -cutS * 0.06 - this.stepSway * 0.14 + (ap && this.slideBlend < 0.01 ? ap.groupZ : 0)
    this.group.rotation.x = ap && this.slideBlend < 0.01 ? ap.groupX : 0

    // torso: a touch of forward drive at speed, leans back into a slide
    this.upper.rotation.x = -speed01 * 0.06 * (1 - this.slideBlend) + this.slideBlend * 0.8

    // ---- arms: hang at the sides and counter-swing the legs; rise for throws
    const b = this.throwBlend
    // modest counter-swing: hands brush past the hips, only surfacing at the
    // edges of a look-down (a big pendulum reads as sticks waving in view)
    const armSwing = -swing * 0.6
    const elbowRun = 0.12 + speed01 * 0.5
    // throw: holding → arms raised overhead (t = 0.55), released (throwT > 0)
    // → fling forward over the last 30% of the countdown
    const tt = throwT > 0 ? 1 - throwT / 0.5 : 0.55
    const up = Math.min(1, tt / 0.7)
    const fling = tt > 0.7 ? (tt - 0.7) / 0.3 : 0
    const throwX = 2.35 * up - fling * 1.75
    const slideArm = this.slideBlend
    for (const [arm, side, sw] of [
      [this.armL, 1, armSwing],
      [this.armR, -1, -armSwing],
    ] as const) {
      // arms hang a touch behind the hips so the resting hands stay out of frame
      const runX = sw - 0.08 - slideArm * 0.55
      arm.shoulder.rotation.x = runX * (1 - b) + throwX * b
      arm.shoulder.rotation.z = side * ((0.09 + speed01 * 0.04 + slideArm * 0.55) * (1 - b) + (0.16 - fling * 0.12) * b)
      arm.elbow.rotation.x = (elbowRun + Math.max(0, sw) * 0.35) * (1 - b) * (1 - slideArm * 0.6)
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
      ;(m.material as THREE.Material | undefined)?.dispose?.()
    })
  }
}
