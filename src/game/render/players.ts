/**
 * Procedural toon humans — rounded body, head, dot eyes, maybe a cap, team bib
 * over a white kit. No rigs, no external assets: the run cycle is code-driven.
 */
import * as THREE from 'three'
import { PALETTE, SKILL2, SKIN_TONES, type Quality, QUALITY } from '../core/constants'
import type { SampledPose, Team } from '../core/types'
import { clamp } from '../core/math'
import { makeToonMaterial } from './toon'
import { addOutline } from './outline'
import { makeNameTagTexture } from './textures'

const geoCache: Record<string, THREE.BufferGeometry> = {}
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  if (!geoCache[key]) geoCache[key] = make()
  return geoCache[key] as T
}

const smooth = (t: number): number => t * t * (3 - 2 * t)
const poseEnv = (u: number, total: number): number => {
  const inT = Math.min(0.08, total * 0.3)
  const fadeIn = smooth(clamp((u * total) / inT, 0, 1))
  const fadeOut = smooth(clamp((1 - u) / 0.22, 0, 1))
  return fadeIn * fadeOut
}

/** Total duration of a flair action by broadcast kind (for pose normalisation). */
const totalForKind = (kind: number): number => {
  switch (kind) {
    case 1:
      return SKILL2.rainbow.duration
    case 2:
      return SKILL2.rabona.lockTime
    case 3:
      return SKILL2.roulette.duration
    case 4:
      return SKILL2.elastico.total
    case 5:
      return SKILL2.crouyff.total
    case 6:
      return SKILL2.backheel.lockTime
    case 8:
      return SKILL2.volley.duration
    default:
      return 0.5
  }
}

const skinMats: THREE.MeshToonMaterial[] = SKIN_TONES.map((c) => makeToonMaterial({ color: c }))
const kitMat = makeToonMaterial({ color: '#f6f2e8' })
const bootMat = makeToonMaterial({ color: '#33291f' })
const eyeMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink })
const bibMats: Record<Team, THREE.MeshToonMaterial> = {
  A: makeToonMaterial({ color: PALETTE.saffron, emissive: '#4a2405', emissiveIntensity: 0.4 }),
  B: makeToonMaterial({ color: PALETTE.teal, emissive: '#083a37', emissiveIntensity: 0.4 }),
}
const capMats: Record<Team, THREE.MeshToonMaterial> = {
  A: makeToonMaterial({ color: PALETTE.saffronDeep }),
  B: makeToonMaterial({ color: PALETTE.tealDeep }),
}

export function teamColor(team: Team): string {
  return team === 'A' ? PALETTE.saffron : PALETTE.teal
}

export interface PlayerRigOpts {
  id: string
  name: string
  team: Team
  quality: Quality
}

export class PlayerRig {
  readonly group = new THREE.Group()
  /** Whole-body pivot (legs + body) so super statuses can topple / spin the
   * player without dragging the name tag along. */
  private readonly pose = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly legL: THREE.Group
  private readonly legR: THREE.Group
  private readonly armL: THREE.Group
  private readonly armR: THREE.Group
  private readonly nameSprite: THREE.Sprite
  private phase = 0
  private spd = 0
  private kickT = 0
  private cutS: -1 | 0 | 1 = 0
  private cutT = 0
  private flickT = 0
  private stepT = 0
  private slideT = 0
  private throwT = 0
  private act = 0
  private actT = 0
  private actTotal = 0
  private actS = 0
  private jugl: 0 | 1 = 0
  private jugglePhase = 0
  /** Super status (sealed / knocked / time-frozen / cyclone / glide / dragon) + timer. */
  private st = 0
  private stT = 0
  private stAge = 0
  private footstepAcc = 0
  private lastPhaseMod = 0
  private disposed = false

  constructor(opts: PlayerRigOpts) {
    const q = QUALITY[opts.quality]
    const rngSeed = [...opts.id].reduce((a, c) => a + c.charCodeAt(0) * 7, 13)
    const skin = skinMats[rngSeed % skinMats.length]

    // legs (pivot at hips)
    const makeLeg = (): THREE.Group => {
      const g = new THREE.Group()
      const leg = new THREE.Mesh(
        geo('leg', () => new THREE.CapsuleGeometry(0.075, 0.62, 4, 10).translate(0, -0.36, 0)),
        kitMat,
      )
      leg.castShadow = true
      g.add(leg)
      addOutline(leg, { widthPx: q.outlinePx })
      const boot = new THREE.Mesh(
        geo('boot', () => new THREE.SphereGeometry(0.095, 10, 8).scale(1, 0.72, 1.65).translate(0, -0.7, -0.045)),
        bootMat,
      )
      boot.castShadow = true
      g.add(boot)
      addOutline(boot, { widthPx: q.outlinePx })
      return g
    }
    this.legL = makeLeg()
    this.legR = makeLeg()
    this.legL.position.set(0.11, 0.9, 0)
    this.legR.position.set(-0.11, 0.9, 0)
    this.pose.add(this.legL, this.legR)
    this.group.add(this.pose)

    // body
    const torso = new THREE.Mesh(
      geo('torso', () => new THREE.CapsuleGeometry(0.21, 0.44, 4, 12).translate(0, 0.28, 0)),
      kitMat,
    )
    torso.position.set(0, 0.86, 0)
    torso.castShadow = true
    this.body.add(torso)
    addOutline(torso, { widthPx: q.outlinePx })

    const bib = new THREE.Mesh(
      geo('bib', () => new THREE.CapsuleGeometry(0.235, 0.26, 4, 12).translate(0, 0.2, 0)),
      bibMats[opts.team],
    )
    bib.position.set(0, 0.92, 0)
    this.body.add(bib)

    const head = new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.155, 14, 12)), skin)
    head.position.set(0, 1.62, 0)
    head.castShadow = true
    this.body.add(head)
    addOutline(head, { widthPx: q.outlinePx })

    for (const ex of [-0.052, 0.052]) {
      const eye = new THREE.Mesh(geo('eye', () => new THREE.SphereGeometry(0.018, 6, 6)), eyeMat)
      eye.position.set(ex, 1.645, -0.14)
      this.body.add(eye)
    }

    if (rngSeed % 2 === 0) {
      const cap = new THREE.Mesh(geo('cap', () => new THREE.CylinderGeometry(0.16, 0.165, 0.085, 12)), capMats[opts.team])
      cap.position.set(0, 1.745, 0.005)
      this.body.add(cap)
      addOutline(cap, { widthPx: q.outlinePx })
      const brim = new THREE.Mesh(geo('brim', () => new THREE.BoxGeometry(0.15, 0.02, 0.14)), capMats[opts.team])
      brim.position.set(0, 1.715, -0.19)
      this.body.add(brim)
    }

    const makeArm = (side: 1 | -1): THREE.Group => {
      const g = new THREE.Group()
      const arm = new THREE.Mesh(
        geo('arm', () => new THREE.CapsuleGeometry(0.052, 0.42, 4, 8).translate(0, -0.25, 0)),
        skin,
      )
      arm.castShadow = true
      g.add(arm)
      addOutline(arm, { widthPx: q.outlinePx })
      g.position.set(side * 0.27, 1.4, 0)
      return g
    }
    this.armL = makeArm(1)
    this.armR = makeArm(-1)
    this.body.add(this.armL, this.armR)
    this.pose.add(this.body)

    // name tag
    this.nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthTest: true, depthWrite: false }),
    )
    this.nameSprite.position.set(0, 2.14, 0)
    this.nameSprite.scale.set(1.35, 0.34, 1)
    this.nameSprite.visible = false
    this.group.add(this.nameSprite)
    makeNameTagTexture(opts.name, teamColor(opts.team))
      .then((tex) => {
        if (this.disposed) {
          tex.dispose()
          return
        }
        this.nameSprite.material.map = tex
        this.nameSprite.material.needsUpdate = true
        this.nameSprite.visible = true
      })
      .catch(() => {
        /* tag stays hidden — cosmetic only */
      })
  }

  /** Feed a remote/local pose; null keeps the last one. */
  apply(pose: SampledPose | null, dt: number): void {
    if (pose) {
      this.group.position.set(pose.x, this.group.position.y, pose.z)
      this.group.rotation.y = pose.yaw
      this.spd = pose.spd
      this.kickT = pose.kickT
      this.cutS = pose.cutS
      if (pose.flickT > this.flickT) this.flickT = pose.flickT
      if (pose.stepT > this.stepT) this.stepT = pose.stepT
      if (pose.slideT > this.slideT) this.slideT = pose.slideT
      if (pose.throwT > this.throwT) this.throwT = pose.throwT
      // flair actions: a new kind always takes over; a same-kind countdown only
      // ratchets up (the local step() counts it down between 20 Hz samples)
      if (pose.act !== this.act || pose.actT > this.actT) {
        this.act = pose.act
        this.actT = pose.actT
        this.actTotal = totalForKind(pose.act)
        this.actS = pose.actS
      }
      this.jugl = pose.jugl
      if (pose.st !== this.st) this.stAge = 0
      this.st = pose.st
      this.stT = pose.stT
    }
    this.step(dt)
  }

  step(dt: number): void {
    // ---- super statuses override everything
    this.stAge += dt
    if (this.st !== 0) {
      if (this.applyStatus(dt)) return
    } else if (this.pose.rotation.x !== 0 || this.pose.position.y !== 0 || this.pose.rotation.z !== 0 || this.pose.rotation.y !== 0) {
      // ease back upright after a status
      const k = Math.min(1, dt * 9)
      this.pose.rotation.x *= 1 - k
      this.pose.rotation.y *= 1 - k
      this.pose.rotation.z *= 1 - k
      this.pose.position.y *= 1 - k
      if (Math.abs(this.pose.rotation.x) < 1e-3) this.pose.rotation.x = 0
      if (Math.abs(this.pose.rotation.y) < 1e-3) this.pose.rotation.y = 0
      if (Math.abs(this.pose.rotation.z) < 1e-3) this.pose.rotation.z = 0
      if (Math.abs(this.pose.position.y) < 1e-3) this.pose.position.y = 0
    }
    const speed01 = Math.min(1, this.spd / 7.2)
    this.phase += this.spd * dt * 2.05

    if (this.kickT > 0) this.kickT = Math.max(0, this.kickT - dt)
    if (this.flickT > 0) this.flickT = Math.max(0, this.flickT - dt)
    if (this.stepT > 0) this.stepT = Math.max(0, this.stepT - dt)
    if (this.slideT > 0) this.slideT = Math.max(0, this.slideT - dt)
    if (this.throwT > 0) this.throwT = Math.max(0, this.throwT - dt)
    if (this.actT > 0) this.actT = Math.max(0, this.actT - dt)
    else if (this.act !== 0) this.act = 0
    if (this.jugl === 1) this.jugglePhase += dt * SKILL2.juggle.hz
    if (this.cutS !== 0) this.cutT = Math.min(1, this.cutT + dt * 6)
    else this.cutT = Math.max(0, this.cutT - dt * 6)

    const swing = (0.16 + speed01 * 0.82) * Math.min(1, this.spd / 2 + 0.15)
    const legL = Math.sin(this.phase) * swing
    const legR = -Math.sin(this.phase) * swing

    // ---- slide tackle pose (overrides everything — a committed lunge)
    if (this.slideT > 0) {
      const total = 0.8
      const t = Math.min(1, this.slideT / total) // 1 -> 0 over the slide
      const lean = Math.sin(Math.min(1, t * 1.5) * Math.PI * 0.5) // ramps in fast, holds
      this.body.rotation.x = lean * 1.15
      this.body.position.y = -lean * 0.62
      this.group.position.y = 0
      this.legL.rotation.x = lean * 1.25
      this.legR.rotation.x = lean * 1.05
      this.legL.rotation.z = lean * 0.18
      this.legR.rotation.z = -lean * 0.18
      this.armL.rotation.x = -lean * 0.9
      this.armR.rotation.x = -lean * 1.1
      this.armL.rotation.z = lean * 0.55
      this.armR.rotation.z = -lean * 0.75
      this.consumeFootstepsZero()
      return
    }
    this.body.position.y = 0
    this.legL.rotation.z = 0
    this.legR.rotation.z = 0
    this.armL.rotation.z = 0
    this.armR.rotation.z = 0

    // ---- throw-in: both arms overhead, snap forward on release
    if (this.throwT > 0) {
      const t = 1 - this.throwT / 0.5 // 0 -> 1
      const up = t < 0.7 ? t / 0.7 : 1
      const fling = t > 0.7 ? (t - 0.7) / 0.3 : 0
      // positive rotation.x raises the down-hung arm overhead toward the front
      const armX = 2.65 * up - fling * 1.95
      this.armL.rotation.x = armX
      this.armR.rotation.x = armX
      this.armL.rotation.z = -0.22 * up
      this.armR.rotation.z = 0.22 * up
      this.body.rotation.x = -0.18 * up + fling * 0.42
      this.legL.rotation.x = -0.12 * up
      this.legR.rotation.x = 0.1 * up
      this.legR.rotation.x += fling * 0.5
      this.group.position.y = 0
      this.consumeFootstepsZero()
      return
    }

    // ---- stepover feint: shoulders + hips swing one way, then burst the other
    if (this.stepT > 0) {
      const t = 1 - this.stepT / 0.46 // 0 -> 1 over the feint
      const sway = Math.sin(Math.min(1, t * 1.35) * Math.PI) // in-out envelope
      this.body.rotation.z = sway * 0.3
      this.body.rotation.x = -0.06 + sway * 0.1
      // circling leg over the ball
      const circle = t * Math.PI * 2
      this.legR.rotation.x = -0.55 + Math.sin(circle) * 0.5
      this.legR.rotation.z = 0.42 + Math.cos(circle) * 0.3
      this.legL.rotation.x = legL * 0.4 - 0.12
      this.legL.rotation.z = -0.1
      this.armL.rotation.x = -sway * 0.55
      this.armR.rotation.x = sway * 0.55
      this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.05 * speed01 + sway * 0.03
      this.countFootsteps()
      return
    }

    // ---- flair-skill silhouettes (recognisable at a glance)
    if (this.act !== 0 && this.actT > 0) {
      this.applyActionPose(speed01, legL, legR)
      this.consumeFootstepsZero()
      return
    }
    if (this.jugl === 1) {
      this.applyJugglePose(speed01, legL, legR)
      this.countFootsteps()
      return
    }
    this.legR.position.x = -0.11

    // ---- normal run cycle
    // right-leg kick animation overrides the run cycle briefly:
    // quick backswing, then the strike sweeps forward-up through the ball
    if (this.kickT > 0) {
      const t = 1 - this.kickT / 0.32
      const windup = Math.max(0, 0.25 - t) / 0.25
      const strike = Math.sin(Math.max(0, Math.min(1, (t - 0.12) / 0.88)) * Math.PI)
      this.legR.rotation.x = -0.9 * windup + 1.4 * strike
    } else {
      this.legR.rotation.x = legR
    }
    this.legL.rotation.x = legL

    this.armL.rotation.x = legR * 0.62
    this.armR.rotation.x = (this.kickT > 0 ? -0.9 : legL * 0.62)

    // ---- flick hop: quick toe-poke, both legs tuck
    const flick = this.flickT > 0 ? Math.sin((this.flickT / 0.55) * Math.PI) : 0
    const hop = flick * 0.24
    this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.05 * speed01 + hop
    this.body.rotation.x = speed01 * 0.13 + (this.kickT > 0 ? 0.1 : 0) - flick * 0.12
    this.body.rotation.z = this.cutS * 0.22 * this.cutT
    this.body.position.y = 0
    this.legL.rotation.z = 0
    this.legR.rotation.z = 0
    this.armL.rotation.z = 0
    this.armR.rotation.z = 0
    if (flick > 0) {
      // the poke leg jabs forward-under the ball
      this.legR.rotation.x = 0.95 * flick - 0.35 * (1 - flick)
      this.legL.rotation.x = 0.35 * flick
    }

    this.countFootsteps()
  }

  /**
   * Super-status silhouettes. Returns true when the status owns the pose this
   * frame (the run cycle is skipped).
   */
  private applyStatus(dt: number): boolean {
    const a = this.stAge
    switch (this.st) {
      case 1: {
        // SEALED — locked rigid mid-stride, arms flung out, trembling
        this.pose.rotation.set(0, 0, Math.sin(a * 61) * 0.035)
        this.pose.position.y = 0
        this.armL.rotation.set(-0.3, 0, 0.9)
        this.armR.rotation.set(-0.3, 0, -0.9)
        this.body.rotation.set(-0.12, 0, 0)
        this.legL.rotation.set(0.3, 0, 0.05)
        this.legR.rotation.set(-0.25, 0, -0.05)
        this.consumeFootstepsZero()
        return true
      }
      case 2: {
        // KNOCKED — flung onto the back, limbs splayed; springs up in the last beat
        const getUp = this.stT < 0.35 ? this.stT / 0.35 : 1
        const fall = Math.min(1, a / 0.18) * getUp
        this.pose.rotation.set(1.45 * fall, 0, 0.12 * fall)
        this.pose.position.y = 0.22 * fall
        this.armL.rotation.set(-0.4 * fall, 0, 1.3 * fall)
        this.armR.rotation.set(-0.6 * fall, 0, -1.1 * fall)
        this.legL.rotation.set(0.5 * fall, 0, 0.25 * fall)
        this.legR.rotation.set(0.9 * fall, 0, -0.2 * fall)
        this.body.rotation.set(0, 0, 0)
        this.consumeFootstepsZero()
        return true
      }
      case 3: {
        // FROZEN IN TIME — hold the last pose exactly (no phase, no timers)
        this.consumeFootstepsZero()
        return true
      }
      case 4: {
        // CYCLONE — lifted, spinning, limbs flailing
        const grip = Math.min(1, this.stT)
        this.pose.rotation.y += dt * 11 * grip
        this.pose.rotation.x = Math.sin(a * 5) * 0.4 * grip
        this.pose.position.y = (0.4 + Math.sin(a * 3.1) * 0.25) * grip
        this.armL.rotation.set(Math.sin(a * 13) * 1.2, 0, 1.2)
        this.armR.rotation.set(Math.cos(a * 11) * 1.2, 0, -1.2)
        this.legL.rotation.set(Math.sin(a * 9) * 0.8, 0, 0.2)
        this.legR.rotation.set(Math.cos(a * 10) * 0.8, 0, -0.2)
        this.consumeFootstepsZero()
        return true
      }
      case 5: {
        // EAGLE GLIDE — pitched forward like a diving bird, arms swept back as wings
        this.pose.rotation.set(-0.95, 0, Math.sin(a * 3) * 0.1)
        this.pose.position.y = 1.2 + Math.sin(a * 4) * 0.2
        this.armL.rotation.set(-2.2, 0, 0.5)
        this.armR.rotation.set(-2.2, 0, -0.5)
        this.legL.rotation.set(-0.25, 0, 0)
        this.legR.rotation.set(-0.35, 0, 0)
        this.body.rotation.set(0, 0, 0)
        this.consumeFootstepsZero()
        return true
      }
      case 6: {
        // DRAGON WIND-UP — coiled back, kicking leg cocked, arms wide
        const k = Math.min(1, a / 0.3)
        this.pose.rotation.set(0.12 * k, 0, 0)
        this.pose.position.y = 0
        this.body.rotation.set(-0.25 * k, 0, 0.1 * k)
        this.legR.rotation.set(-1.25 * k, 0, 0)
        this.legL.rotation.set(0.15 * k, 0, 0)
        this.armL.rotation.set(-0.2, 0, 1.1 * k)
        this.armR.rotation.set(0.4, 0, -1.2 * k)
        this.consumeFootstepsZero()
        return true
      }
    }
    return false
  }

  /** Third-person flair poses — each skill gets a distinct silhouette. */
  private applyActionPose(speed01: number, legL: number, legR: number): void {
    const total = this.actTotal > 0 ? this.actTotal : 0.5
    const u = clamp(1 - this.actT / total, 0, 1)
    const e = poseEnv(u, total)
    const s = this.actS >= 0 ? 1 : -1
    // neutral base pose the action blends away from at its edges
    const baseCut = this.cutS * 0.22 * this.cutT
    const baseGroupY = Math.abs(Math.sin(this.phase)) * 0.05 * speed01
    const baseLegL = legL * 0.3
    const baseLegR = legR * 0.3
    const baseArmL = legR * 0.4
    const baseArmR = legL * 0.4
    // reset the shared channels first
    this.body.position.y = 0
    this.body.rotation.x = 0
    this.body.rotation.z = baseCut
    this.group.position.y = baseGroupY
    this.legL.rotation.z = 0
    this.legR.rotation.z = 0
    this.armL.rotation.z = 0
    this.armR.rotation.z = 0
    this.legR.position.x = -0.11

    switch (this.act) {
      case 1: {
        // RAINBOW — arms flare, right leg flicks up BEHIND (heel read), body tilts back
        const arc = Math.sin(Math.min(1, u * 1.25) * Math.PI)
        this.armL.rotation.z = 1.05 * arc
        this.armR.rotation.z = -1.05 * arc
        this.armL.rotation.x = -0.4 * arc
        this.armR.rotation.x = -0.4 * arc
        this.legR.rotation.x = -1.25 * arc
        this.legR.rotation.z = -0.25 * arc
        this.legL.rotation.x = legL * 0.3 - 0.15 * arc
        this.body.rotation.x = -0.22 * arc
        this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.05 * speed01 + 0.06 * arc
        break
      }
      case 2: {
        // RABONA — right leg crosses in front, sweeps behind, hop on the plant
        const crossU = 0.38
        if (u < crossU) {
          const r = smooth(u / crossU)
          this.legR.position.x = -0.11 + 0.26 * r
          this.legR.rotation.x = 0.6 * r
          this.legL.rotation.x = -0.1
          this.body.rotation.z = -0.14 * r
          this.body.rotation.x = 0.05 * r
        } else {
          const f = clamp((u - crossU) / 0.4, 0, 1)
          const sweep = Math.sin(Math.min(1, f * 1.4) * Math.PI)
          this.legR.position.x = -0.11 + 0.26 * (1 - f)
          this.legR.rotation.x = 1.15 * sweep + 0.6 * (1 - f)
          this.legL.rotation.x = -0.12 - 0.15 * sweep
          this.body.rotation.x = 0.12 * sweep
          this.body.rotation.z = -0.14 * (1 - f) + 0.1 * sweep
          this.group.position.y = 0.05 * Math.sin(f * Math.PI)
          this.armL.rotation.z = 0.5 * sweep
          this.armR.rotation.z = -0.5 * sweep
        }
        break
      }
      case 3: {
        // ROULETTE — whole rig spins with the broadcast yaw; crouch + drag foot
        const mid = Math.sin(u * Math.PI)
        this.body.position.y = -0.3 * mid
        this.body.rotation.x = 0.18 * mid
        this.legR.rotation.x = 0.85 * mid + legR * 0.25
        this.legR.rotation.z = 0.2 * mid
        this.legL.rotation.x = legL * 0.35 - 0.35 * mid
        this.armL.rotation.z = 0.9 * mid
        this.armR.rotation.z = -0.9 * mid
        this.armL.rotation.x = -0.3 * mid
        this.armR.rotation.x = -0.3 * mid
        this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.05 * speed01
        break
      }
      case 4: {
        // ELASTICO — hip sway out then snap in, foot dances with the ball
        const outU = SKILL2.elastico.outTime / total
        if (u < outU) {
          const r = smooth(u / outU)
          this.body.rotation.z = s * 0.2 * r
          this.legR.rotation.z = -s * 0.5 * r
          this.legR.rotation.x = 0.2 * r
          this.legL.rotation.x = legL * 0.3
        } else {
          const f = clamp((u - outU) / (1 - outU), 0, 1)
          const snap = Math.sin(Math.min(1, f * 1.6) * Math.PI)
          this.body.rotation.z = s * 0.2 * (1 - f) - s * 0.24 * snap
          this.legR.rotation.z = -s * 0.5 * (1 - f) + s * 0.45 * snap
          this.legR.rotation.x = 0.7 * snap
          this.legL.rotation.x = legL * 0.3 - 0.1 * snap
        }
        break
      }
      case 5: {
        // CRUYFF — fake-kick backswing that brakes, drag foot hooks behind,
        // body leans through the (broadcast) 180° turn
        const windU = SKILL2.crouyff.windup / total
        if (u < windU) {
          const r = u / windU
          this.legR.rotation.x = -1.0 * smooth(Math.min(1, r * 1.5))
          this.legL.rotation.x = legL * 0.3
          this.body.rotation.x = 0.08 * r
          this.armL.rotation.x = 0.4 * r
          this.armR.rotation.x = -0.4 * r
        } else {
          const f = clamp((u - windU) / (1 - windU), 0, 1)
          const hook = Math.sin(Math.min(1, f * 1.3) * Math.PI)
          this.legR.rotation.x = (-1.0 * (1 - f) - 0.45 * hook) * (1 - Math.max(0, (f - 0.7) / 0.3))
          this.legR.rotation.z = 0.35 * hook * (1 - Math.max(0, (f - 0.7) / 0.3))
          this.legL.rotation.x = legL * 0.3 - 0.45 * Math.sin(Math.max(0, (f - 0.55) / 0.45) * Math.PI)
          this.body.rotation.z = -s * 0.18 * Math.sin(f * Math.PI * 0.5)
          this.armL.rotation.z = 0.55 * hook
          this.armR.rotation.z = -0.55 * hook
        }
        break
      }
      case 6: {
        // BACKHEEL — hop + heel clips back between the legs (toe-up read)
        const f = Math.sin(Math.min(1, u * 1.5) * Math.PI)
        this.legR.rotation.x = -1.05 * f
        this.legR.rotation.z = 0.22 * f
        this.legL.rotation.x = legL * 0.3 - 0.1
        this.body.rotation.x = 0.14 * f
        this.group.position.y = 0.07 * Math.sin(Math.min(1, u * 1.2) * Math.PI)
        this.armL.rotation.z = 0.45 * f
        this.armR.rotation.z = -0.45 * f
        break
      }
      case 8: {
        // VOLLEY — airborne scissor: drive leg trails back, kicking leg sweeps high forward
        const air = Math.sin(Math.min(1, u * 1.15) * Math.PI)
        this.legL.rotation.x = -0.55 * clamp(u / 0.6, 0, 1)
        this.legR.rotation.x = 1.65 * Math.sin(Math.min(1, u * 1.6) * Math.PI)
        this.body.rotation.x = -0.3 * air
        this.armL.rotation.z = 0.7 * air
        this.armR.rotation.z = -0.7 * air
        this.armL.rotation.x = -0.5 * air
        this.armR.rotation.x = -0.5 * air
        this.group.position.y = 0.22 * air - (u > 0.72 ? 0.06 * Math.sin(clamp((u - 0.72) / 0.28, 0, 1) * Math.PI) : 0)
        break
      }
    }
    // blend the finished pose toward the base by the envelope — no snapping
    this.body.position.y *= e
    this.body.rotation.x *= e
    this.body.rotation.z = baseCut + (this.body.rotation.z - baseCut) * e
    this.group.position.y = baseGroupY + (this.group.position.y - baseGroupY) * e
    this.legL.rotation.x = baseLegL + (this.legL.rotation.x - baseLegL) * e
    this.legR.rotation.x = baseLegR + (this.legR.rotation.x - baseLegR) * e
    this.legL.rotation.z *= e
    this.legR.rotation.z *= e
    this.armL.rotation.z *= e
    this.armR.rotation.z *= e
    this.armL.rotation.x = baseArmL + (this.armL.rotation.x - baseArmL) * e
    this.armR.rotation.x = baseArmR + (this.armR.rotation.x - baseArmR) * e
    this.legR.position.x = -0.11 + (this.legR.position.x + 0.11) * e
  }

  /** Sustained juggle — alternating knee/foot bounces in rhythm. */
  private applyJugglePose(speed01: number, legL: number, legR: number): void {
    const cycle = Math.floor(this.jugglePhase)
    const frac = this.jugglePhase - cycle
    const even = cycle % 2 === 0
    const strike = Math.exp(-Math.pow((frac - 0.08) / 0.16, 2))
    const wind = Math.exp(-Math.pow((frac - 0.93) / 0.09, 2)) * 0.35
    const lift = strike + wind
    this.body.position.y = 0
    this.legR.position.x = -0.11
    this.legL.rotation.z = 0
    this.legR.rotation.z = 0
    this.armL.rotation.z = 0.25
    this.armR.rotation.z = -0.25
    this.body.rotation.z = 0
    this.body.rotation.x = speed01 * 0.1
    if (even) {
      this.legR.rotation.x = 0.7 * lift // right-foot bounce, knee up-forward
      this.legL.rotation.x = legL * 0.25
    } else {
      this.legL.rotation.x = 0.9 * lift // left-knee bounce, higher read
      this.legR.rotation.x = legR * 0.25
    }
    this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.05 * speed01 + 0.02 * lift
    this.armL.rotation.x = legR * 0.3
    this.armR.rotation.x = legL * 0.3
  }

  private consumeFootstepsZero(): void {
    this.footstepAcc = 0
    const mod = Math.floor(this.phase / Math.PI)
    this.lastPhaseMod = mod
  }

  private countFootsteps(): void {
    // footstep counter (half-cycle zero crossings)
    const mod = Math.floor(this.phase / Math.PI)
    if (mod !== this.lastPhaseMod) {
      this.footstepAcc += mod - this.lastPhaseMod
      this.lastPhaseMod = mod
    }
  }

  /** Number of footfalls since last call (for spatial footsteps). */
  consumeFootsteps(): number {
    const n = this.footstepAcc
    this.footstepAcc = 0
    return n
  }

  /** Trigger the kick swing immediately (host-validated remote kicks). */
  playKick(): void {
    this.kickT = 0.32
  }

  /** Trigger the throw-in animation (arms overhead, fling forward). */
  playThrow(): void {
    this.throwT = 0.5
  }

  setTeam(team: Team): void {
    const bib = this.body.children.find((c) => (c as THREE.Mesh).material === bibMats.A || (c as THREE.Mesh).material === bibMats.B) as THREE.Mesh | undefined
    if (bib) bib.material = bibMats[team]
  }

  dispose(): void {
    this.disposed = true
    const mat = this.nameSprite.material
    if (mat.map) mat.map.dispose()
    mat.dispose()
  }
}
