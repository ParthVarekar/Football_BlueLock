/**
 * First-person camera: 1.65 m eye height, settings FOV, head bob, kick dip,
 * goal shake, cut roll, sprint FOV, slide crouch, throw-in reach, plus the
 * flair-skill sweeps (roulette 360° spin, crouyff 180° turn, rainbow look-up,
 * backheel jolt, volley recoil). All effects are springs — nothing snaps.
 */
import * as THREE from 'three'
import { PLAYER, SLIDE } from '../core/constants'
import { clamp, damp } from '../core/math'

export interface CameraInput {
  /** Player world position (feet). */
  x: number
  z: number
  speed01: number
  sprinting: boolean
  grounded: boolean
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  yaw = 0
  pitch = 0

  /** Base FOV from settings (60..100). */
  private baseFov: number = PLAYER.fov

  private stride = 0
  private dip = 0
  private dipVel = 0
  private shakeT = 0
  private shakeAmp = 0
  private roll = 0
  private rollTarget = 0
  private fovCur: number = PLAYER.fov
  private bias = 0
  private biasTarget = 0
  /** 0..1 slide crouch blend. */
  private slideBlend = 0
  private slideTarget = 0
  /** 0..1 throw-in arm reach (camera rises a touch + tiny back lean). */
  private throwBlend = 0
  private throwTarget = 0
  /** Flair-skill yaw sweeps: full 360° spin (roulette) or persistent 180° turn (crouyff). */
  private spin: { startYaw: number; dir: number; p: number } | null = null
  private turn: { startYaw: number; dir: number; p: number; done: boolean } | null = null
  /** Rainbow look-up bias (spring-damped pitch offset). */
  private actionLook = 0
  private actionLookTarget = 0
  /** Volley pitch recoil spring. */
  private recoil = 0
  private recoilVel = 0
  /** Super FOV punch spring (degrees). */
  private fovKick = 0
  private fovKickVel = 0
  /** 0..1 knocked-down blend: the eye drops to the turf and rolls over. */
  private knockBlend = 0
  private knockTarget = 0
  private knockSide = 1
  /** Eagle glide lift (m), set directly each frame. */
  private lift = 0
  private readonly tmpRight = new THREE.Vector3()

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(PLAYER.fov, aspect, 0.08, 620)
    this.camera.rotation.order = 'YXZ'
  }

  setFov(fov: number): void {
    this.baseFov = clamp(fov, 55, 105)
  }

  applyLook(dx: number, dy: number, sens: number, invertY = false): void {
    // during a spin / turn the sweep owns the yaw — look input is heavily damped
    // and folded into the sweep's base so it never fights the animation
    const yawScale = this.spin ? 0.14 : this.turn && !this.turn.done ? 0.45 : 1
    const pitchScale = this.spin ? 0.35 : 1
    const dYaw = -dx * sens * yawScale
    this.yaw += dYaw
    if (this.spin) this.spin.startYaw += dYaw
    if (this.turn && !this.turn.done) this.turn.startYaw += dYaw
    this.pitch = clamp(this.pitch - dy * sens * (invertY ? -1 : 1) * pitchScale, -1.25, 1.25)
  }

  kickDip(strength = 1): void {
    this.dipVel -= 2.1 * strength
  }

  landDip(strength = 1): void {
    this.dipVel -= 1.3 * strength
  }

  goalShake(strength = 1): void {
    this.shakeT = 1.1
    this.shakeAmp = 0.13 * strength
  }

  /** Generic super shake: `strength` ~0.2 (rumble) … 1.5 (dragon impact). Never weakens a running shake. */
  shake(strength: number, duration = 0.8): void {
    const amp = 0.1 * strength
    const cur = this.shakeT > 0 ? this.shakeAmp * Math.pow(this.shakeT, 1.4) : 0
    if (amp * Math.pow(duration, 1.4) < cur) return
    this.shakeT = duration
    this.shakeAmp = amp
  }

  /** FOV punch (degrees, springs back) — the lens lurches on a super. */
  fovPunch(deg: number): void {
    this.fovKickVel += deg * 14
  }

  /** Knocked flat: blend the eye down to the turf (target 0/1). */
  setKnocked(on: boolean, side = 1): void {
    if (on && this.knockTarget === 0) this.knockSide = side >= 0 ? 1 : -1
    this.knockTarget = on ? 1 : 0
  }

  /** Eagle glide lift in metres (0 on the ground). */
  setLift(m: number): void {
    this.lift = m
  }

  cutRoll(side: number): void {
    this.rollTarget = side * 0.09
    setTimeout(() => {
      this.rollTarget = 0
    }, 260)
  }

  // ------------------------------------------------------------------ flair skills

  /**
   * ROULETTE: drive the full 360° yaw sweep from the action progress (called
   * every sim step while spinning — sim-authoritative so it stays time-correct
   * at any frame rate). `p` is the eased 0..1 sweep progress, `dir` ±1.
   */
  driveSpin(p: number, dir: number): void {
    if (this.spin === null || this.spin.dir !== dir || p < this.spin.p - 0.2) {
      this.spin = { startYaw: this.yaw - dir * Math.PI * 2 * p, dir, p }
    }
    this.spin.p = Math.max(this.spin.p, p)
    this.yaw = this.spin.startYaw + dir * Math.PI * 2 * p
    if (p >= 0.999) this.spin = null // 2π later — same facing as the start
  }

  /**
   * CRUYFF: drive the smooth 180° turn (0..1 eased progress). This one
   * PERSISTS — the turn is real, the camera keeps the new facing afterwards.
   */
  driveTurn(p: number, dir: number): void {
    if (this.turn === null || this.turn.dir !== dir || p < this.turn.p - 0.2) {
      this.turn = { startYaw: this.yaw - dir * Math.PI * p, dir, p, done: false }
    }
    this.turn.p = Math.max(this.turn.p, p)
    this.yaw = this.turn.startYaw + dir * Math.PI * p
    if (p >= 0.999) {
      this.yaw = this.turn.startYaw + dir * Math.PI
      this.turn.done = true
    }
  }

  /** Rainbow: spring-damped look-up bias while the ball passes overhead. */
  setRainbowLook(v: number): void {
    this.actionLookTarget = clamp(v, 0, 0.5)
  }

  /** Rabona: the hop landing reads as a deeper, rounder dip. */
  rabonaHop(): void {
    this.dipVel -= 1.55
    this.rollTarget = 0.05
    setTimeout(() => {
      this.rollTarget = 0
    }, 240)
  }

  /** Backheel: camera stays forward — just a small jolt. */
  backheelJolt(): void {
    this.dipVel -= 0.95
    this.rollTarget = -0.045
    setTimeout(() => {
      this.rollTarget = 0
    }, 150)
  }

  /** Volley: brief pitch-up recoil on the strike. */
  volleyRecoil(strength = 1): void {
    this.dipVel -= 1.6 * strength
    this.recoilVel += 0.95 * strength
  }

  /** Blend the camera down into a slide crouch (0..1 target, damped). */
  setSlideBlend(t: number): void {
    this.slideTarget = clamp(t, 0, 1)
  }

  /** Blend the throw-in reach (0..1 target, damped). */
  setThrowBlend(t: number): void {
    this.throwTarget = clamp(t, 0, 1)
  }

  /**
   * "Eyes on the ball": while dribbling the gaze eases DOWN so the ball at
   * your feet stays framed at the bottom of the view — the first-person
   * non-negotiable. Backs off when charging a kick (free aim for chips) or
   * when the player looks up. Stored as a positive magnitude; SUBTRACTED
   * from the pitch (negative pitch = looking down).
   */
  setDribbleBias(target: number): void {
    this.biasTarget = THREE.MathUtils.clamp(target, 0, 0.45)
  }

  /** The pitch the player actually sees (input − dribble drop). */
  get visualPitch(): number {
    return this.pitch - this.bias
  }

  update(dt: number, input: CameraInput, elapsed: number): void {
    // head bob
    const bobSpeed = 1.6 + input.speed01 * 7.2
    if (input.speed01 > 0.04) this.stride += dt * bobSpeed
    const bobY = Math.sin(this.stride * 2) * PLAYER.bobAmp * input.speed01
    const bobX = Math.sin(this.stride) * PLAYER.bobAmp * 0.55 * input.speed01

    // kick dip spring
    this.dipVel += -this.dip * 88 * dt - this.dipVel * 13 * dt
    this.dip += this.dipVel * dt

    // volley pitch recoil spring
    this.recoilVel += -this.recoil * 70 * dt - this.recoilVel * 11 * dt
    this.recoil += this.recoilVel * dt

    // goal shake
    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dt)
    const sh = this.shakeT > 0 ? this.shakeAmp * Math.pow(this.shakeT, 1.4) : 0
    const shakeX = Math.sin(elapsed * 39) * sh
    const shakeY = Math.cos(elapsed * 47) * sh * 0.8

    this.roll = damp(this.roll, this.rollTarget, 14, dt)
    this.knockBlend = damp(this.knockBlend, this.knockTarget, this.knockTarget > this.knockBlend ? 11 : 4.5, dt)
    // FOV punch spring
    this.fovKickVel += -this.fovKick * 120 * dt - this.fovKickVel * 14 * dt
    this.fovKick += this.fovKickVel * dt
    this.slideBlend = damp(this.slideBlend, this.slideTarget, 12, dt)
    this.throwBlend = damp(this.throwBlend, this.throwTarget, 9, dt)
    this.actionLook = damp(this.actionLook, this.actionLookTarget, this.actionLookTarget > this.actionLook ? 6 : 8.5, dt)

    // slide crouch: eye drops to ~0.75 m and picks up speed-rattle
    const slideEye = PLAYER.eye - this.slideBlend * 0.85
    const rattle = this.slideBlend * Math.sin(elapsed * 47) * 0.014
    // throw reach: rise slightly and lean back
    const throwEye = this.throwBlend * 0.08
    const throwLean = this.throwBlend * -0.05

    // roulette spin dressing: mid-spin crouch dip (~0.12 m) + slight roll tilt
    const spinArc = this.spin ? Math.sin(this.spin.p * Math.PI) : 0
    const spinEye = -spinArc * 0.12
    const spinRoll = this.spin ? this.spin.dir * 0.06 * spinArc : 0
    // crouyff turn: gentle lean through the 180°
    const turnArc = this.turn && !this.turn.done ? Math.sin(this.turn.p * Math.PI) : 0
    const turnRoll = this.turn ? this.turn.dir * 0.05 * turnArc : 0

    // knocked flat: eye to ~0.4 m, rolled onto one side
    const knockEye = -this.knockBlend * 1.22
    const knockRoll = this.knockBlend * 0.62 * this.knockSide
    this.camera.position.set(
      input.x + bobX + shakeX,
      slideEye + throwEye + spinEye + bobY + this.dip + shakeY + rattle + knockEye + this.lift,
      input.z,
    )

    this.bias = damp(this.bias, this.biasTarget, this.biasTarget > this.bias ? 3.4 : 5.2, dt)

    this.camera.rotation.y = this.yaw
    this.camera.rotation.x = this.pitch - this.bias + throwLean + this.actionLook + this.recoil
    this.camera.rotation.z = this.roll + spinRoll + turnRoll + knockRoll
    // knocked flat you stare half at the sky
    this.camera.rotation.x += this.knockBlend * 0.35

    const fovTarget = this.baseFov + (input.sprinting ? 3.4 : 0) + this.slideBlend * 2.5 + this.lift * 3
    this.fovCur = damp(this.fovCur, fovTarget, 6, dt)
    const fovNow = this.fovCur + this.fovKick
    if (Math.abs(fovNow - this.camera.fov) > 0.02) {
      this.camera.fov = fovNow
      this.camera.updateProjectionMatrix()
    }

    this.tmpRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion)
    void SLIDE
  }

  /** Slow cinematic drift for menus / lobby / victory. */
  updateCinematic(dt: number, elapsed: number): void {
    const a = elapsed * 0.043
    const r = 20 + Math.sin(elapsed * 0.05) * 4
    this.camera.position.set(Math.cos(a) * r, 4.2 + Math.sin(elapsed * 0.07) * 1.1, Math.sin(a) * r * 0.7)
    this.camera.rotation.z = 0
    this.camera.lookAt(Math.sin(elapsed * 0.03) * 6, 1.1, Math.cos(elapsed * 0.05) * 4)
    if (this.camera.fov !== 62) {
      this.camera.fov = 62
      this.camera.updateProjectionMatrix()
    }
    void dt
  }
}
