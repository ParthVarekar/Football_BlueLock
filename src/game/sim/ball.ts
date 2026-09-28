/**
 * Ball physics — one shared step used by the HOST (authority) and by the local
 * client (prediction while dribbling / just kicked). Gravity, bounce, rolling
 * friction, soft player bumps, rounded-wall bounce, posts, goals, net box.
 */
import { BALL, GOAL, NET_BACK_H, PITCH, PLAYER, RULES, SKILL2 } from '../core/constants'
import { forwardXZ, rightXZ, sdRoundedRect } from '../core/math'
import type { Team } from '../core/types'

export interface BallState {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  lastTouch: string | null
}

export interface BallPlayerRef {
  id: string
  x: number
  z: number
  vx: number
  vz: number
}

export interface BallStepEvents {
  goal: Team | null
  bounce: number
  postHit: boolean
  netTouch: boolean
  playerTouch: string | null
}

const WALL_QX = PITCH.wallL / 2 - 0.45
const WALL_QZ = PITCH.wallW / 2 - 0.45
const WALL_R = PITCH.wallR - 0.22

function sdfWall(x: number, z: number): number {
  return sdRoundedRect(x, z, WALL_QX, WALL_QZ, WALL_R)
}

export function stepBall(b: BallState, dt: number, players: readonly BallPlayerRef[]): BallStepEvents {
  const ev: BallStepEvents = { goal: null, bounce: 0, postHit: false, netTouch: false, playerTouch: null }
  const r = BALL.r

  // integrate + gravity + air drag
  b.vy += BALL.gravity * dt
  const airborne = b.y > r + 0.03
  if (airborne) {
    const d = Math.exp(-BALL.airDamp * dt)
    b.vx *= d
    b.vy *= d
    b.vz *= d
  }
  b.x += b.vx * dt
  b.y += b.vy * dt
  b.z += b.vz * dt

  // ground
  if (b.y < r) {
    b.y = r
    if (b.vy < -0.9) {
      ev.bounce = Math.min(1, -b.vy / 9)
      b.vy = -b.vy * BALL.restitution
      if (b.vy < 0.55) b.vy = 0
    } else {
      b.vy = 0
    }
  }
  const grounded = b.y <= r + 0.02
  if (grounded) {
    // rolling friction
    const d = Math.exp(-BALL.rollDamp * dt)
    b.vx *= d
    b.vz *= d
    const sp = Math.hypot(b.vx, b.vz)
    if (sp > 0) {
      const ns = Math.max(0, sp - BALL.rollDecel * dt)
      if (ns < BALL.restSpeed && b.vy === 0) {
        b.vx = 0
        b.vz = 0
      } else {
        b.vx *= ns / sp
        b.vz *= ns / sp
      }
    }
  }

  // player body bumps (soft elastic — you can body-feint opponents off the ball)
  for (const p of players) {
    const dx = b.x - p.x
    const dz = b.z - p.z
    const d = Math.hypot(dx, dz)
    const minD = r + 0.42
    if (d < minD && d > 1e-5 && b.y < 1.15) {
      const nx = dx / d
      const nz = dz / d
      b.x = p.x + nx * minD
      b.z = p.z + nz * minD
      const relvn = (b.vx - p.vx) * nx + (b.vz - p.vz) * nz
      if (relvn < 0) {
        b.vx -= nx * relvn * 1.45
        b.vz -= nz * relvn * 1.45
      }
      b.vx += p.vx * 0.22
      b.vz += p.vz * 0.22
      if (Math.abs(relvn) > 0.8) {
        ev.playerTouch = p.id
        b.lastTouch = p.id // rules: possession changes on any body contact
      }
    }
  }

  // goal check (before wall/net so the ball can enter the mouth)
  if (
    Math.abs(b.x) > PITCH.halfL + r * 0.4 &&
    Math.abs(b.z) < GOAL.halfW - r * 0.25 &&
    b.y < GOAL.height - r * 0.2
  ) {
    const side: Team = b.x > 0 ? 'A' : 'B' // +X goal is defended by B, scored by A
    if (Math.abs(b.x) > PITCH.halfL + GOAL.lineEps) {
      ev.goal = side
    }
  }

  // net box (behind either goal line) — the SAME box the renderer draws: side
  // nets at ±halfW, back net at depth, roof sloping from the crossbar down to
  // the back net. A ball inside stays inside; a ball outside bounces off the
  // outside of the netting instead of being pulled in.
  const behind = Math.abs(b.x) - PITCH.halfL
  if (behind > 0 && behind < GOAL.depth + r && Math.abs(b.z) < GOAL.halfW + r + 0.05) {
    const s = Math.sign(b.x)
    const d = Math.min(behind, GOAL.depth)
    const roofY = GOAL.height - (GOAL.height - NET_BACK_H) * (d / GOAL.depth)
    const inside = Math.abs(b.z) < GOAL.halfW && b.y < roofY + r * 0.5
    if (inside) {
      // loose nets swallow momentum — the ball dies in the back of the net
      const swallow = Math.exp(-3.2 * dt)
      b.vx *= swallow
      b.vz *= swallow
      if (b.y <= r + 0.02) b.vy *= Math.exp(-2 * dt)
      const backX = PITCH.halfL + GOAL.depth - r
      if (Math.abs(b.x) > backX) {
        b.x = s * backX
        b.vx *= -0.1
        b.vz *= 0.4
        ev.netTouch = true
      }
      const sideZ = GOAL.halfW - r
      if (Math.abs(b.z) > sideZ) {
        b.z = Math.sign(b.z) * sideZ
        b.vz *= -0.2
        ev.netTouch = true
      }
      if (b.y > roofY - r) {
        b.y = roofY - r
        b.vy = Math.min(b.vy, 0)
        ev.netTouch = true
      }
    } else if (b.y < roofY + r) {
      // outside the netting: a side-net / back-net / roof bounce
      if (Math.abs(b.z) >= GOAL.halfW) {
        b.z = Math.sign(b.z) * (GOAL.halfW + r)
        if (b.vz * Math.sign(b.z) < 0) b.vz *= -0.35
      } else if (behind > GOAL.depth) {
        b.x = s * (PITCH.halfL + GOAL.depth + r)
        if (b.vx * s < 0) b.vx *= -0.35
      } else {
        b.y = roofY + r
        if (b.vy < 0) b.vy *= -0.3
      }
      b.vx *= 0.85
      b.vz *= 0.85
      ev.netTouch = true
    }
  }

  // posts + crossbar
  for (const s of [-1, 1] as const) {
    const px = s * PITCH.halfL
    if (Math.abs(b.x - px) < r + 0.3) {
      for (const pz of [-GOAL.halfW, GOAL.halfW]) {
        const dx = b.x - px
        const dz = b.z - pz
        const d = Math.hypot(dx, dz)
        if (d < r + GOAL.postR && d > 1e-5 && b.y < GOAL.height + 0.1) {
          const nx = dx / d
          const nz = dz / d
          b.x = px + nx * (r + GOAL.postR)
          b.z = pz + nz * (r + GOAL.postR)
          const vn = b.vx * nx + b.vz * nz
          if (vn < 0) {
            b.vx -= nx * vn * 1.7
            b.vz -= nz * vn * 1.7
            ev.postHit = Math.abs(vn) > 1.2
          }
        }
      }
      // crossbar (circle in the XY plane at the goal centre line)
      if (Math.abs(b.z) < GOAL.halfW) {
        const dx = b.x - px
        const dy = b.y - GOAL.height
        const d = Math.hypot(dx, dy)
        if (d < r + GOAL.postR && d > 1e-5) {
          const nx = dx / d
          const ny = dy / d
          b.x = px + nx * (r + GOAL.postR)
          b.y = GOAL.height + ny * (r + GOAL.postR)
          const vn = b.vx * nx + b.vy * ny
          if (vn < 0) {
            b.vx -= nx * vn * 1.7
            b.vy -= ny * vn * 1.7
            ev.postHit = Math.abs(vn) > 1.2
          }
        }
      }
    }
  }

  // boundary wall (rounded rect) — reflect with damping
  const sd = sdfWall(b.x, b.z)
  if (sd > -r) {
    const e = 0.03
    const gx = (sdfWall(b.x + e, b.z) - sdfWall(b.x - e, b.z)) / (2 * e)
    const gz = (sdfWall(b.x, b.z + e) - sdfWall(b.x, b.z - e)) / (2 * e)
    const gl = Math.hypot(gx, gz) || 1
    const nx = gx / gl
    const nz = gz / gl
    const push = sd + r
    b.x -= nx * push
    b.z -= nz * push
    const vn = b.vx * nx + b.vz * nz
    if (vn > 0) {
      b.vx -= nx * vn * (1 + BALL.wallRestitution)
      b.vz -= nz * vn * (1 + BALL.wallRestitution)
      if (vn > 1.5) ev.bounce = Math.max(ev.bounce, Math.min(1, vn / 10))
    }
  }

  // speed cap
  const sp = Math.hypot(b.vx, b.vy, b.vz)
  if (sp > BALL.maxSpeed) {
    const k = BALL.maxSpeed / sp
    b.vx *= k
    b.vy *= k
    b.vz *= k
  }

  return ev
}

// ---------------------------------------------------------------- kick impulse

/**
 * Shared kick impulse — the local client predicts with it and the HOST applies
 * it after validation, so both agree by construction.
 */
export function kickVelocity(power: number, loftN: number, dirX: number, dirZ: number): { vx: number; vy: number; vz: number } {
  const p = Math.min(Math.max(power, 0), 1)
  const loft = Math.min(Math.max(loftN, 0), 1)
  const speed = 9 + (24.5 - 9) * Math.pow(p, 1.5)
  // vy ceiling 9.6 → apex ~2.3 m: full-loft chips clear standing defenders
  const vy = 0.9 + (9.6 - 0.9) * loft
  const l = Math.hypot(dirX, dirZ) || 1
  return { vx: (dirX / l) * speed, vy, vz: (dirZ / l) * speed }
}

/** Throw-in release: two hands, slower than any kick, loft from the release angle. */
export function throwVelocity(power: number, loftN: number, dirX: number, dirZ: number): { vx: number; vy: number; vz: number } {
  const p = Math.min(Math.max(power, 0), 1)
  const loft = Math.min(Math.max(loftN, 0), 1)
  const speed = RULES.throwSpeedMin + (RULES.throwSpeedMax - RULES.throwSpeedMin) * Math.pow(p, 1.3)
  const vy = 1.6 + 4.6 * loft
  const l = Math.hypot(dirX, dirZ) || 1
  return { vx: (dirX / l) * speed, vy, vz: (dirZ / l) * speed }
}

// ---------------------------------------------------------------- flair skills (SKILL2)

/** Reference frame the skill ball helpers need from the acting player. */
export interface SkillPlayerRef {
  x: number
  z: number
  yaw: number
  vx: number
  vz: number
}

const smooth = (t: number): number => t * t * (3 - 2 * t)
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/**
 * RAINBOW roll-up: the ball climbs the standing leg. `u` is the roll phase
 * progress (0..1 over SKILL2.rainbow.riseTime); the ball eases from its start
 * point to the player's side, rising to riseHeight. Kinematic — sets position
 * and a derivative velocity so the ball view keeps spinning naturally.
 */
export function rainbowRoll(b: BallState, p: SkillPlayerRef, startX: number, startZ: number, u: number): void {
  const [fx, fz] = forwardXZ(p.yaw)
  const [rx, rz] = rightXZ(p.yaw)
  const k = smooth(Math.min(1, Math.max(0, u)))
  const tx = p.x + rx * -0.16 + fx * 0.14
  const tz = p.z + rz * -0.16 + fz * 0.14
  const nx = startX + (tx - startX) * k
  const nz = startZ + (tz - startZ) * k
  const ny = BALL.r + (SKILL2.rainbow.riseHeight - BALL.r) * k
  b.vx = 0
  b.vy = (ny - b.y) * 8
  b.vz = 0
  b.x = nx
  b.z = nz
  b.y = ny
}

/** RAINBOW heel flick: up-and-over launch (fwd impulse + strong vy). */
export function rainbowFlick(b: BallState, p: SkillPlayerRef, fx: number, fz: number): void {
  b.vx = fx * SKILL2.rainbow.flickFwd + p.vx * 0.45
  b.vy = SKILL2.rainbow.flickVy
  b.vz = fz * SKILL2.rainbow.flickFwd + p.vz * 0.45
}

/**
 * ROULETTE / CRUYFF sole pin: re-project the ball's original offset from the
 * player into the player's CURRENT frame (local forward/right at capture are
 * `fwd0`/`right0`; the body has since turned). The ball orbits with the body.
 */
export function soleDrag(
  b: BallState,
  p: SkillPlayerRef,
  fwd0X: number,
  fwd0Z: number,
  right0X: number,
  right0Z: number,
  radiusScale = 1,
  lift = 0,
): void {
  const [fx, fz] = forwardXZ(p.yaw)
  const [rx, rz] = rightXZ(p.yaw)
  const ox = b.x - p.x
  const oz = b.z - p.z
  const lf = ox * fwd0X + oz * fwd0Z
  const lr = ox * right0X + oz * right0Z
  b.x = p.x + fx * lf * radiusScale + rx * lr * radiusScale
  b.z = p.z + fz * lf * radiusScale + rz * lr * radiusScale
  b.y = BALL.r + lift
  b.vx = p.vx
  b.vz = p.vz
  b.vy = 0
}

/**
 * ELASTICO out phase: the ball is pushed out to `side` (kinematic pin easing
 * from its capture point to outDist away from the player).
 */
export function elasticoPush(b: BallState, p: SkillPlayerRef, side: number, startX: number, startZ: number, u: number): void {
  const [fx, fz] = forwardXZ(p.yaw)
  const [rx, rz] = rightXZ(p.yaw)
  const k = smooth(Math.min(1, Math.max(0, u)))
  const out = 0.38 + (SKILL2.elastico.outDist - 0.38) * k
  const tx = p.x + rx * side * out + fx * 0.3
  const tz = p.z + rz * side * out + fz * 0.3
  b.x = startX + (tx - startX) * k
  b.z = startZ + (tz - startZ) * k
  b.y = BALL.r
  b.vx = p.vx
  b.vz = p.vz
  b.vy = 0
}

/** ELASTICO snap: hard instep cut that exits diagonally PAST the standing leg. */
export function elasticoSnap(b: BallState, p: SkillPlayerRef, side: number, fx: number, fz: number): void {
  const [rx, rz] = rightXZ(p.yaw)
  // forward-biased on purpose: a pure lateral snap would send the ball through
  // the player's own body column and the soft body-bump would scatter it
  b.vx = fx * SKILL2.elastico.crossFwd - rx * side * SKILL2.elastico.crossSpeed + p.vx * 0.3
  b.vz = fz * SKILL2.elastico.crossFwd - rz * side * SKILL2.elastico.crossSpeed + p.vz * 0.3
  b.vy = 0.25
}

/** BACKHEEL: the heel clips the ball through the legs — the ball is placed
 * behind the body on contact (a path through the own-body column would be
 * eaten by the soft body-bump), then struck opposite the facing. */
export function backheelClip(b: BallState, p: SkillPlayerRef, fx: number, fz: number): void {
  b.x = p.x - fx * 0.66
  b.z = p.z - fz * 0.66
  b.vx = -fx * SKILL2.backheel.speed + p.vx * 0.2
  b.vy = SKILL2.backheel.hopVy
  b.vz = -fz * SKILL2.backheel.speed + p.vz * 0.2
}

/**
 * JUGGLE: rhythmic bounce + homing. Phase advances at SKILL2.juggle.hz; even
 * cycles are foot bounces, odd cycles knee bounces (alternating contact
 * heights, both peaking at the shared apex). Returns true on the frame the
 * ball touches a contact point (for the touch sound).
 */
export function juggleBounce(
  b: BallState,
  p: SkillPlayerRef,
  phase: number,
  dt: number,
  out?: { vy: number },
): boolean {
  const j = SKILL2.juggle
  const cycle = Math.floor(phase)
  const frac = phase - cycle
  const even = cycle % 2 === 0
  const c0 = even ? j.footY : j.kneeY
  const c1 = even ? j.kneeY : j.footY
  // parabolic arc between the two contact heights, peaking at the apex
  const mid = (c0 + c1) / 2
  const y = c0 + (c1 - c0) * frac + (j.apex - mid) * 4 * frac * (1 - frac)
  const dy = ((c1 - c0) + (j.apex - mid) * 4 * (1 - 2 * frac)) * j.hz
  // homing spring keeps the ball a half-step ahead, swaying gently
  const [fx, fz] = forwardXZ(p.yaw)
  const [rx, rz] = rightXZ(p.yaw)
  const sway = Math.sin(phase * Math.PI) * 0.05
  const tx = p.x + fx * j.ahead + rx * sway
  const tz = p.z + fz * j.ahead + rz * sway
  const k = 1 - Math.exp(-9 * dt)
  const prevX = b.x
  const prevZ = b.z
  b.x += (tx - b.x) * k
  b.z += (tz - b.z) * k
  b.y = y
  b.vy = dy
  if (dt > 1e-4) {
    b.vx = (b.x - prevX) / dt
    b.vz = (b.z - prevZ) / dt
  } else {
    b.vx = p.vx
    b.vz = p.vz
  }
  if (out) out.vy = dy
  // contact the frame the phase crosses a cycle boundary
  return frac < dt * j.hz + 0.001
}

/** JUGGLE drop: hand the kinematic ball back to physics with its current velocity. */
export function juggleDrop(b: BallState): void {
  b.vy = Math.max(0.2, b.vy)
}

/** Shared eased sweep used by the camera spin / turn (kept here so ball + camera agree). */
export const easedSweep = easeInOutCubic

// ---------------------------------------------------------------- dribbling

export interface Dribbler {
  id: string
  x: number
  z: number
  vx: number
  vz: number
  yaw: number
  sprinting: boolean
  touchTimer: number
}

export interface DribbleEvents {
  touched: boolean
  sprintTouch: boolean
}

/**
 * Automatic close-control touches. Walking keeps the ball glued a half-step
 * ahead; sprinting knocks it 2–3 m forward so you have to chase — Haxball-ish
 * risk/reward. Touches only fire while actually moving: a stationary player
 * rests the ball at their feet. Runs on the host (authority) and locally
 * (prediction).
 */
export function dribbleStep(b: BallState, p: Dribbler, dt: number): DribbleEvents {
  const ev: DribbleEvents = { touched: false, sprintTouch: false }
  const dx = b.x - p.x
  const dz = b.z - p.z
  const d = Math.hypot(dx, dz)
  const within = d < PLAYER.dribbleRadius && b.y < 0.72
  const pSpeed = Math.hypot(p.vx, p.vz)
  const [fx, fz] = forwardXZ(p.yaw)

  if (within) {
    p.touchTimer -= dt
    // gentle magnet between touches while walking — the ball "sticks"
    if (!p.sprinting && b.y <= BALL.r + 0.02 && pSpeed > 0.4 && d > 0.5) {
      const targetX = p.x + fx * 0.48
      const targetZ = p.z + fz * 0.48
      b.vx += (targetX - b.x) * 5.2 * dt
      b.vz += (targetZ - b.z) * 5.2 * dt
    }
    // close-control touch — only while moving; standing still never kicks the
    // ball away, so it stays parked at your toe
    if (p.touchTimer <= 0 && pSpeed > 0.55) {
      if (p.sprinting && pSpeed > 5.4) {
        const s = pSpeed * 1.24 + 3.8
        b.vx = fx * s
        b.vz = fz * s
        b.vy = Math.max(b.vy, 0.35)
        p.touchTimer = 0.32
        ev.touched = true
        ev.sprintTouch = true
      } else {
        const s = Math.max(pSpeed * 1.14, 1.15) + (p.sprinting ? 0.8 : 0)
        b.vx = fx * s
        b.vz = fz * s
        p.touchTimer = 0.4
        ev.touched = true
      }
      b.lastTouch = p.id
    }
  }
  // you've stopped — gather the ball back to your feet (from inside or just
  // outside the dribble radius, so the last touch settles at your toe)
  if (!p.sprinting && b.y <= BALL.r + 0.02 && d < 2.3 && pSpeed < 0.6) {
    // just outside the body-bump radius so the reel and the bump agree
    const targetX = p.x + fx * 0.62
    const targetZ = p.z + fz * 0.62
    if (Math.hypot(b.vx, b.vz) < 0.9) {
      // slow ball — reel it in positionally: the rolling-rest freeze would eat
      // a force-based pull, so carry it the last stretch instead
      const k = 1 - Math.exp(-3.4 * dt)
      b.x += (targetX - b.x) * k
      b.z += (targetZ - b.z) * k
      b.vx = 0
      b.vz = 0
    } else {
      b.vx += (targetX - b.x) * 4.6 * dt
      b.vz += (targetZ - b.z) * 4.6 * dt
      const kill = Math.exp(-2.2 * dt)
      b.vx *= kill
      b.vz *= kill
    }
  }
  return ev
}

/** Nearest player who may act on the ball (touch within dribble radius, or gather within 2.3 m). */
export function nearestDribbler(ball: BallState, players: readonly Dribbler[]): Dribbler | null {
  let best: Dribbler | null = null
  let bestD = Infinity
  for (const p of players) {
    if (ball.y > 0.72) continue
    const d = Math.hypot(ball.x - p.x, ball.z - p.z)
    if (d < PLAYER.dribbleRadius + 1.25 && d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}
