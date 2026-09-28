/**
 * Local player: acceleration-based movement, sprint + stamina, momentum, quick
 * stops, the three skill moves (cut, stepover, flick), the slide tackle and the
 * iteration-3 flair actions (rainbow / rabona / roulette / elastico / crouyff /
 * backheel / juggle / volley). Owns only the planar transform — the CameraRig
 * owns yaw/pitch.
 */
import { PLAYER, SKILL, SKILL2, SLIDE, STAMINA, SUPER } from '../core/constants'
import { clamp, forwardXZ, rightXZ } from '../core/math'
import type { PlayerStatus } from '../core/types'

export interface LocalPlayerEvents {
  onFootstep(): void
  onCut(side: number, x: number, z: number): void
  onStepover(x: number, z: number): void
  onFlick(x: number, z: number): void
  onSlide(x: number, z: number, dirX: number, dirZ: number): void
  /** Slide is over (clean or not — the Game decides fouls). */
  onSlideEnd(): void
}

interface StepoverState {
  plant: number
  burst: number
  dirX: number
  dirZ: number
  feintSide: 1 | -1
}

interface SlideState {
  t: number
  dirX: number
  dirZ: number
}

/** A running flair action (rainbow / rabona / roulette / elastico / crouyff / backheel / volley). */
export interface PlayerAction {
  /** 1 rainbow · 2 rabona · 3 roulette · 4 elastico · 5 crouyff · 6 backheel · 8 volley. */
  kind: number
  /** Seconds remaining. */
  t: number
  /** Total duration (progress = 1 - t/total). */
  total: number
  /** Side / direction param (±1). */
  s: number
  /** Facing at capture (unit vector). */
  dirX: number
  dirZ: number
}

export class LocalPlayer {
  x = 0
  z = 0
  vx = 0
  vz = 0
  stamina: number = STAMINA.max
  speed = 0
  sprinting = false

  cutCooldown = 0
  stepCooldown = 0
  flickCooldown = 0
  slideCooldown = 0
  rainbowCooldown = 0
  rouletteCooldown = 0
  elasticoCooldown = 0
  crouyffCooldown = 0
  backheelCooldown = 0
  rabonaCooldown = 0

  kickAnimT = 0
  cutAnimT = 0
  cutSide: -1 | 0 | 1 = 0
  flickAnimT = 0
  stepAnimT = 0
  slideAnimT = 0
  throwAnimT = 0

  /** Active flair action (drives FP legs + camera + remote rigs). */
  action: PlayerAction | null = null
  /** Latched-on juggle (T toggle) — walk-cap + rhythmic bounce while held. */
  juggling = false
  /** Juggle bounce phase (cycles at SKILL2.juggle.hz; even = foot, odd = knee). */
  jugglePhase = 0

  // ---- EGO super statuses (timers in seconds; the Game applies them)
  /** Thunder Seal: rooted to the spot. */
  sealT = 0
  /** Knocked flat (dragon / eagle / erupting rock). */
  knockT = 0
  /** Frozen in someone else's Zero Hour. */
  stopT = 0
  /** My own Zero Hour: the zap speed boost. */
  zapT = 0
  /** 0..1 cyclone grip this frame (set by the Game before step). */
  cycloneGrip = 0
  /** Eagle Talon glide in progress (the Game drives the position). */
  gliding = false
  /** Crimson Dragon wind-up (planted while the ball coils). */
  dragonT = 0
  /** External velocity this frame (cyclone pull, knock-back slide). */
  private extVX = 0
  private extVZ = 0

  private stepover: StepoverState | null = null
  private slide: SlideState | null = null
  private stridePhase = 0
  private lastStepMod = 0
  private lastSteerSide: 1 | -1 = 1

  constructor(private readonly events: LocalPlayerEvents) {}

  teleport(x: number, z: number): void {
    this.x = x
    this.z = z
    this.vx = 0
    this.vz = 0
    this.stepover = null
    this.slide = null
    this.slideAnimT = 0
    this.action = null
    this.juggling = false
    this.clearStatuses()
  }

  get busy(): boolean {
    return this.stepover !== null
  }

  /** A super status has taken control away (no moving, kicking or skills). */
  get disabled(): boolean {
    return this.sealT > 0 || this.knockT > 0 || this.stopT > 0 || this.gliding || this.dragonT > 0 || this.cycloneGrip > 0.55
  }

  /** Status code broadcast to the other clients (drives their rig poses). */
  get status(): { st: PlayerStatus; stT: number } {
    if (this.stopT > 0) return { st: 3, stT: this.stopT }
    if (this.knockT > 0) return { st: 2, stT: this.knockT }
    if (this.sealT > 0) return { st: 1, stT: this.sealT }
    if (this.cycloneGrip > 0.2) return { st: 4, stT: this.cycloneGrip }
    if (this.gliding) return { st: 5, stT: 0 }
    if (this.dragonT > 0) return { st: 6, stT: this.dragonT }
    return { st: 0, stT: 0 }
  }

  /** Add an external velocity for THIS step (cyclone pull, knock-back). */
  push(vx: number, vz: number): void {
    this.extVX += vx
    this.extVZ += vz
  }

  /** Bowled over: flat on your back for a beat, sliding away from the hit. */
  knockDown(dirX: number, dirZ: number, power = 1): void {
    this.knockT = Math.max(this.knockT, SUPER.knockTime)
    this.action = null
    this.juggling = false
    this.stepover = null
    this.slide = null
    this.vx = dirX * 6.5 * power
    this.vz = dirZ * 6.5 * power
  }

  /** Clear every super status (teleports, kickoffs, leaving). */
  clearStatuses(): void {
    this.sealT = 0
    this.knockT = 0
    this.stopT = 0
    this.zapT = 0
    this.cycloneGrip = 0
    this.gliding = false
    this.dragonT = 0
    this.extVX = 0
    this.extVZ = 0
  }

  get sliding(): boolean {
    return this.slide !== null
  }

  /** Facing of an active slide (for the ball poke + foul checks). */
  get slideDir(): { x: number; z: number } | null {
    return this.slide ? { x: this.slide.dirX, z: this.slide.dirZ } : null
  }

  step(
    dt: number,
    input: { moveX: number; moveY: number; sprint: boolean },
    yaw: number,
    frozen: boolean,
  ): void {
    this.cutCooldown = Math.max(0, this.cutCooldown - dt)
    this.stepCooldown = Math.max(0, this.stepCooldown - dt)
    this.flickCooldown = Math.max(0, this.flickCooldown - dt)
    this.slideCooldown = Math.max(0, this.slideCooldown - dt)
    this.rainbowCooldown = Math.max(0, this.rainbowCooldown - dt)
    this.rouletteCooldown = Math.max(0, this.rouletteCooldown - dt)
    this.elasticoCooldown = Math.max(0, this.elasticoCooldown - dt)
    this.crouyffCooldown = Math.max(0, this.crouyffCooldown - dt)
    this.backheelCooldown = Math.max(0, this.backheelCooldown - dt)
    this.rabonaCooldown = Math.max(0, this.rabonaCooldown - dt)
    if (this.kickAnimT > 0) this.kickAnimT = Math.max(0, this.kickAnimT - dt)
    if (this.cutAnimT > 0) this.cutAnimT = Math.max(0, this.cutAnimT - dt)
    else this.cutSide = 0
    if (this.flickAnimT > 0) this.flickAnimT = Math.max(0, this.flickAnimT - dt)
    if (this.stepAnimT > 0) this.stepAnimT = Math.max(0, this.stepAnimT - dt)
    if (this.throwAnimT > 0) this.throwAnimT = Math.max(0, this.throwAnimT - dt)
    if (this.action) {
      this.action.t -= dt
      if (this.action.t <= 0) this.action = null
    }
    if (this.juggling) this.jugglePhase += dt * SKILL2.juggle.hz
    if (this.sealT > 0) this.sealT = Math.max(0, this.sealT - dt)
    if (this.knockT > 0) this.knockT = Math.max(0, this.knockT - dt)
    if (this.stopT > 0) this.stopT = Math.max(0, this.stopT - dt)
    if (this.zapT > 0) this.zapT = Math.max(0, this.zapT - dt)
    if (this.dragonT > 0) this.dragonT = Math.max(0, this.dragonT - dt)
    // a status that takes control also drops whatever you were doing
    if (this.disabled) frozen = true

    const [fx, fz] = forwardXZ(yaw)
    const [rx, rz] = rightXZ(yaw)

    // flair actions scale steering + momentum — committed moves lock you in,
    // flow moves (elastico / backheel) keep you loose
    const act = this.action
    let steerScale = 1
    let momentumDamp = 0
    let carryFwd = 0
    if (act) {
      switch (act.kind) {
        case 1: // rainbow — committed drift forward
          steerScale = 0.18
          momentumDamp = 2.0
          carryFwd = 1.5
          break
        case 2: // rabona — planted on the standing leg
          steerScale = 0
          momentumDamp = 9
          break
        case 3: // roulette — pivoting on the ball
          steerScale = 0.2
          momentumDamp = 2.6
          carryFwd = 1.4
          break
        case 4: // elastico — keeps flow
          steerScale = 0.75
          momentumDamp = 0.8
          break
        case 5: // crouyff — committed through the turn
          steerScale = 0.3
          momentumDamp = 3.2
          break
        case 6: // backheel — keeps flow
          steerScale = 0.55
          momentumDamp = 4
          break
        case 8: // volley — committed scissor jump
          steerScale = 0.3
          momentumDamp = 3
          break
      }
    }

    let wishX = 0
    let wishZ = 0
    if (!frozen && !this.sliding) {
      wishX = fx * input.moveY + rx * input.moveX
      wishZ = fz * input.moveY + rz * input.moveX
      const wl = Math.hypot(wishX, wishZ)
      if (wl > 1) {
        wishX /= wl
        wishZ /= wl
      }
      wishX *= steerScale
      wishZ *= steerScale
    }

    // stamina + sprint gate (sprinting cancels the juggle — the Game drops the ball)
    const wantsSprint = input.sprint && (Math.abs(input.moveX) > 0.05 || Math.abs(input.moveY) > 0.05) && !frozen && !this.sliding
    const canSprint = wantsSprint && this.stamina > STAMINA.minToSprint && !this.juggling
    this.sprinting = canSprint
    if (canSprint) this.stamina = Math.max(0, this.stamina - STAMINA.drainPerSec * dt)
    else this.stamina = Math.min(STAMINA.max, this.stamina + STAMINA.regenPerSec * dt)

    let maxSpeed: number = canSprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed
    if (this.juggling) maxSpeed = Math.min(maxSpeed, SKILL2.juggle.walkCap)
    // Zero Hour zap: the only thing moving in a stopped world, and fast
    if (this.zapT > 0) {
      maxSpeed *= SUPER.timeStop.speedMult
      this.stamina = STAMINA.max
    }
    const accelBase = canSprint ? PLAYER.sprintAccel : PLAYER.accel

    if (this.sealT > 0 || this.stopT > 0 || this.gliding || this.dragonT > 0) {
      // rooted: sealed by lightning, stuck in stopped time, mid-glide (the
      // Game owns the position) or planted for the dragon strike
      this.vx = 0
      this.vz = 0
    } else if (this.knockT > 0) {
      // flat on the turf, skidding to a stop
      const d = Math.exp(-5.5 * dt)
      this.vx *= d
      this.vz *= d
    } else if (this.slide) {
      // slide tackle: fixed burst that decays, steering locked
      this.slide.t -= dt
      const k = clamp(this.slide.t / SLIDE.time, 0, 1)
      const s = SLIDE.speed * (0.35 + 0.65 * k)
      this.vx = this.slide.dirX * s
      this.vz = this.slide.dirZ * s
      if (this.slide.t <= 0) {
        this.slide = null
        this.events.onSlideEnd()
        // skid to a stop
        this.vx *= 0.25
        this.vz *= 0.25
      }
    } else if (this.stepover) {
      // plant (a beat of stillness + the feint), then burst
      if (this.stepover.plant > 0) {
        this.stepover.plant -= dt
        const d = Math.exp(-16 * dt)
        this.vx *= d
        this.vz *= d
        if (this.stepover.plant <= 0) this.events.onStepover(this.x, this.z)
      } else {
        this.stepover.burst -= dt
        const bx = this.stepover.dirX * maxSpeed * 1.16
        const bz = this.stepover.dirZ * maxSpeed * 1.16
        this.approachVelocity(bx, bz, accelBase * SKILL.stepBurstMult, dt)
        if (this.stepover.burst <= 0) this.stepover = null
      }
    } else if (act && momentumDamp > 0) {
      // flair action: momentum decays at the move's rate, optional forward carry
      const d = Math.exp(-momentumDamp * dt)
      this.vx *= d
      this.vz *= d
      if (carryFwd > 0) this.approachVelocity(fx * carryFwd, fz * carryFwd, 6, dt)
      // flow moves still accept (scaled) steering
      if (steerScale > 0 && (wishX !== 0 || wishZ !== 0)) {
        this.approachVelocity(wishX * maxSpeed, wishZ * maxSpeed, accelBase * steerScale, dt)
      }
    } else if (wishX === 0 && wishZ === 0) {
      // quick stops
      const d = Math.exp(-PLAYER.stopDamp * dt)
      this.vx *= d
      this.vz *= d
    } else {
      this.approachVelocity(wishX * maxSpeed, wishZ * maxSpeed, accelBase, dt)
    }

    this.x += (this.vx + this.extVX) * dt
    this.z += (this.vz + this.extVZ) * dt
    this.speed = Math.hypot(this.vx + this.extVX, this.vz + this.extVZ)
    this.extVX = 0
    this.extVZ = 0

    // stride + footsteps
    const speed01 = clamp(this.speed / PLAYER.sprintSpeed, 0, 1)
    if (this.speed > 0.4) this.stridePhase += dt * (1.6 + speed01 * 7.2)
    const mod = Math.floor(this.stridePhase / Math.PI)
    if (mod !== this.lastStepMod && this.speed > 0.6 && !this.sliding) {
      this.events.onFootstep()
    }
    this.lastStepMod = mod
  }

  /** Accelerate toward a target velocity with a per-second budget; turning gets a boost. */
  private approachVelocity(tx: number, tz: number, accel: number, dt: number): void {
    const dvx = tx - this.vx
    const dvz = tz - this.vz
    const dl = Math.hypot(dvx, dvz)
    if (dl < 1e-4) return
    const reversing = dvx * this.vx + dvz * this.vz < 0
    let budget = accel * dt * (reversing ? PLAYER.turnBoost : 1)
    if (this.stepover) budget *= 1.6
    if (dl <= budget) {
      this.vx = tx
      this.vz = tz
    } else {
      this.vx += (dvx / dl) * budget
      this.vz += (dvz / dl) * budget
    }
  }

  /** RMB sidestep cut — works from a standstill, stronger with speed. */
  tryCut(moveX: number, yaw: number): number {
    if (this.cutCooldown > 0 || this.sliding || this.busy || this.action) return 0
    let side: 1 | -1
    if (moveX > 0.15) side = 1
    else if (moveX < -0.15) side = -1
    else side = this.lastSteerSide
    this.lastSteerSide = side

    const [rx, rz] = rightXZ(yaw)
    const keep = SKILL.cutKeepMomentum
    // base impulse so a standstill cut still dodges; speed adds punch
    const impulse = SKILL.cutBaseImpulse + Math.min(this.speed, 7) * 0.52
    this.vx = this.vx * keep + rx * side * impulse
    this.vz = this.vz * keep + rz * side * impulse
    this.cutCooldown = SKILL.cutCooldown
    this.cutAnimT = 0.42
    this.cutSide = side === 1 ? 1 : -1
    this.events.onCut(side, this.x, this.z)
    return side
  }

  /** Q stepover feint — shoulder sway, a planted beat, then an explosive exit. */
  tryStepover(yaw: number, moveX: number, moveY: number): boolean {
    if (this.stepCooldown > 0 || this.stepover || this.sliding || this.action) return false
    const [fx, fz] = forwardXZ(yaw)
    const [rx, rz] = rightXZ(yaw)
    let dx = fx * (moveY >= 0 ? Math.max(moveY, 0.35) : moveY) + rx * moveX
    let dz = fz * (moveY >= 0 ? Math.max(moveY, 0.35) : moveY) + rz * moveX
    const l = Math.hypot(dx, dz)
    if (l < 0.05) {
      dx = fx
      dz = fz
    } else {
      dx /= l
      dz /= l
    }
    // the feint swings the opposite way of the exit
    const feintSide: 1 | -1 = moveX > 0.1 ? -1 : 1
    this.stepover = { plant: SKILL.stepPlantTime, burst: SKILL.stepBurstTime, dirX: dx, dirZ: dz, feintSide }
    this.stepCooldown = SKILL.stepCooldown
    this.stepAnimT = SKILL.stepPlantTime + SKILL.stepBurstTime
    return true
  }

  get stepoverFeintSide(): 1 | -1 {
    return this.stepover ? this.stepover.feintSide : 1
  }

  /** F flick hop (ball handling lives in the Game — needs ball access). */
  tryFlick(): boolean {
    if (this.flickCooldown > 0 || this.sliding || this.action) return false
    this.flickCooldown = SKILL.flickCooldown
    this.flickAnimT = 0.55
    this.events.onFlick(this.x, this.z)
    return true
  }

  /** C slide tackle — a committed lunge. Ball contact = clean poke; missing it risks a foul. */
  trySlide(yaw: number, moveX: number, moveY: number): boolean {
    if (this.slideCooldown > 0 || this.sliding || this.busy || this.action) return false
    const [fx, fz] = forwardXZ(yaw)
    const [rx, rz] = rightXZ(yaw)
    let dx = fx * (Math.abs(moveY) > 0.15 ? Math.max(moveY, 0.25) : 0.75) + rx * moveX * 0.55
    let dz = fz * (Math.abs(moveY) > 0.15 ? Math.max(moveY, 0.25) : 0.75) + rz * moveX * 0.55
    const l = Math.hypot(dx, dz)
    if (l < 0.05) {
      dx = fx
      dz = fz
    } else {
      dx /= l
      dz /= l
    }
    this.slide = { t: SLIDE.time, dirX: dx, dirZ: dz }
    this.slideCooldown = SLIDE.cooldown
    this.slideAnimT = SLIDE.time + 0.25
    this.events.onSlide(this.x, this.z, dx, dz)
    return true
  }

  // ------------------------------------------------------------------ flair actions

  private beginAction(kind: number, total: number, s: number, yaw: number): void {
    const [fx, fz] = forwardXZ(yaw)
    this.action = { kind, t: total, total, s, dirX: fx, dirZ: fz }
  }

  /** E rainbow — committed 0.55 s; ball work lives in the Game. */
  tryRainbow(yaw: number): boolean {
    if (this.rainbowCooldown > 0 || this.action || this.stepover || this.sliding) return false
    this.rainbowCooldown = SKILL2.rainbow.cooldown
    this.beginAction(1, SKILL2.rainbow.duration, 0, yaw)
    return true
  }

  /** Z rabona release — planted 0.42 s cross-legged strike. */
  tryRabona(yaw: number): boolean {
    if (this.rabonaCooldown > 0 || this.action || this.stepover || this.sliding) return false
    this.rabonaCooldown = SKILL2.rabona.flairCd
    this.beginAction(2, SKILL2.rabona.lockTime, 0, yaw)
    return true
  }

  /** X roulette / Marseille turn — 360° pivot, `s` = spin direction (±1). */
  tryRoulette(yaw: number, s: number): boolean {
    if (this.rouletteCooldown > 0 || this.action || this.stepover || this.sliding) return false
    this.rouletteCooldown = SKILL2.roulette.cooldown
    this.beginAction(3, SKILL2.roulette.duration, s, yaw)
    return true
  }

  /** V elastico — push out to `s` side then snap across; keeps flow. */
  tryElastico(yaw: number, s: number): boolean {
    if (this.elasticoCooldown > 0 || this.action || this.stepover || this.sliding) return false
    this.elasticoCooldown = SKILL2.elastico.cooldown
    this.beginAction(4, SKILL2.elastico.total, s, yaw)
    // the body sells the fake: a small lunge toward the push side
    const [rx, rz] = rightXZ(yaw)
    this.vx += rx * s * 0.85
    this.vz += rz * s * 0.85
    return true
  }

  /** G crouyff turn — fake shot, drag behind the standing leg, 180° exit. `s` = turn side (±1). */
  tryCrouyff(yaw: number, s: number): boolean {
    if (this.crouyffCooldown > 0 || this.action || this.stepover || this.sliding) return false
    this.crouyffCooldown = SKILL2.crouyff.cooldown
    this.beginAction(5, SKILL2.crouyff.total, s, yaw)
    return true
  }

  /** B backheel — heel clip opposite the facing; keeps flow. */
  tryBackheel(yaw: number): boolean {
    if (this.backheelCooldown > 0 || this.action || this.stepover || this.sliding) return false
    this.backheelCooldown = SKILL2.backheel.cooldown
    this.beginAction(6, SKILL2.backheel.lockTime, 0, yaw)
    return true
  }

  /** Automatic scissor volley (any kick with the ball above volley height). */
  startVolley(yaw: number): void {
    this.kickAnimT = 0
    this.beginAction(8, SKILL2.volley.duration, 0, yaw)
  }

  /** Broadcast-friendly anim flags. */
  animState(): {
    kickT: number
    cutS: -1 | 0 | 1
    flickT: number
    stepT: number
    slideT: number
    throwT: number
    act: number
    actT: number
    actS: number
    jugl: 0 | 1
  } {
    return {
      kickT: this.kickAnimT,
      cutS: this.cutAnimT > 0 ? this.cutSide : 0,
      flickT: this.flickAnimT,
      stepT: this.stepAnimT,
      slideT: this.slideAnimT,
      throwT: this.throwAnimT,
      act: this.action ? this.action.kind : 0,
      actT: this.action ? this.action.t : 0,
      actS: this.action ? this.action.s : 0,
      jugl: this.juggling ? 1 : 0,
    }
  }
}
