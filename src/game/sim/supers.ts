/**
 * EGO super moves — the pure simulation half (no rendering, no net):
 * ground aiming, the Crimson Dragon's homing curve, Mountain Bastion peak
 * colliders, the Gulmohar Cyclone's pull field and the Eagle Talon arc.
 *
 * Everything here is deterministic from its inputs so every client can run
 * the same move from the same broadcast event and agree by construction.
 */
import { BALL, GOAL, PITCH, SUPER } from '../core/constants'
import { clamp, makeRng } from '../core/math'
import type { Team } from '../core/types'
import type { BallState } from './ball'

// ---------------------------------------------------------------- aiming

/**
 * Where the camera ray meets the turf, clamped to [minD, maxD] from the
 * player. Looking level or up falls back to `fallback` metres straight ahead.
 */
export function aimGroundPoint(
  px: number,
  pz: number,
  eyeY: number,
  yaw: number,
  pitch: number,
  minD: number,
  maxD: number,
  fallback: number,
): { x: number; z: number } {
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  let d = fallback
  if (pitch < -0.03) d = eyeY / Math.tan(-pitch)
  d = clamp(d, minD, maxD)
  const x = clamp(px + fx * d, -PITCH.halfL - 1, PITCH.halfL + 1)
  const z = clamp(pz + fz * d, -PITCH.halfW - 1, PITCH.halfW + 1)
  return { x, z }
}

/** +X goal is attacked by team A, -X by team B. */
export function attackGoalX(team: Team): number {
  return team === 'A' ? PITCH.halfL : -PITCH.halfL
}

// ---------------------------------------------------------------- dragon

/**
 * The Crimson Dragon's flight: a cubic bezier from the coiled ball to a spot
 * deep in the net. The middle controls swing wide and high so the ball
 * serpentines, and the last leg always runs straight down the goal's axis —
 * the ball enters through the mouth, never the side netting.
 */
export function dragonPath(
  sx: number,
  sy: number,
  sz: number,
  team: Team,
  seed: number,
): { path: number[]; flight: number } {
  const rng = makeRng(seed)
  const gx = attackGoalX(team)
  const s = Math.sign(gx)
  // target: a corner-ish pocket inside the goal
  const tz = (rng() < 0.5 ? -1 : 1) * (0.35 + rng() * 0.6)
  const ty = 0.55 + rng() * 0.9
  const x3 = gx + s * (GOAL.depth * 0.55)
  // approach control: straight out in front of the goal mouth
  const x2 = gx - s * clamp(Math.abs(gx - sx) * 0.3, 3, 9)
  const z2 = tz * 0.8
  // launch control: up and swinging out to one side (the serpentine)
  const side = rng() < 0.5 ? -1 : 1
  const dx = gx - sx
  const x1 = sx + dx * 0.3
  const z1 = clamp(sz + side * (3 + rng() * 5), -PITCH.halfW + 2, PITCH.halfW - 2)
  const y1 = 3.2 + rng() * 2.4
  const y2 = 1.6 + rng() * 1.4
  const path = [sx, sy, sz, x1, y1, z1, x2, y2, z2, x3, ty, tz]
  // arc length estimate for the flight time
  let len = 0
  let px = sx
  let py = sy
  let pz = sz
  const tmp = { x: 0, y: 0, z: 0 }
  for (let i = 1; i <= 16; i++) {
    bezierAt(path, i / 16, tmp)
    len += Math.hypot(tmp.x - px, tmp.y - py, tmp.z - pz)
    px = tmp.x
    py = tmp.y
    pz = tmp.z
  }
  const flight = clamp(len / SUPER.dragon.speed, SUPER.dragon.minFlight, SUPER.dragon.maxFlight)
  return { path, flight }
}

/** Position on the dragon's cubic bezier at u ∈ [0, 1]. */
export function bezierAt(p: readonly number[], u: number, out: { x: number; y: number; z: number }): void {
  const t = clamp(u, 0, 1)
  const a = (1 - t) * (1 - t) * (1 - t)
  const b = 3 * (1 - t) * (1 - t) * t
  const c = 3 * (1 - t) * t * t
  const d = t * t * t
  out.x = a * p[0] + b * p[3] + c * p[6] + d * p[9]
  out.y = a * p[1] + b * p[4] + c * p[7] + d * p[10]
  out.z = a * p[2] + b * p[5] + c * p[8] + d * p[11]
}

/** d/du of the bezier (for the ball's velocity + the dragon's heading). */
export function bezierTangent(p: readonly number[], u: number, out: { x: number; y: number; z: number }): void {
  const t = clamp(u, 0, 1)
  const a = 3 * (1 - t) * (1 - t)
  const b = 6 * (1 - t) * t
  const c = 3 * t * t
  out.x = a * (p[3] - p[0]) + b * (p[6] - p[3]) + c * (p[9] - p[6])
  out.y = a * (p[4] - p[1]) + b * (p[7] - p[4]) + c * (p[10] - p[7])
  out.z = a * (p[5] - p[2]) + b * (p[8] - p[5]) + c * (p[11] - p[8])
}

/**
 * The flight's timing curve: a beat of slow coil-out, then it rips.
 * Maps real progress → path progress.
 */
export function dragonEase(u: number): number {
  const t = clamp(u, 0, 1)
  return t < 0.18 ? 0.5 * (t / 0.18) * (t / 0.18) * 0.18 : 0.09 + (t - 0.18) * (0.91 / 0.82)
}

// ---------------------------------------------------------------- mountain

/** One rock peak — a cylinder collider (x, z, radius) of height `h` at full rise. */
export interface Peak {
  x: number
  z: number
  r: number
  h: number
}

/** A raised ridge: peaks + its birth time; heights follow the rise/sink envelope. */
export interface MountainWall {
  id: number
  peaks: Peak[]
  /** Ridge axis (unit) and centre, for knock-back direction. */
  cx: number
  cz: number
  nx: number
  nz: number
  age: number
  seed: number
}

/**
 * The ridge runs ACROSS the caster's line of sight (perpendicular to the
 * caster→point direction) so it walls off exactly what you aimed at.
 */
export function mountainPeaks(ax: number, az: number, fromX: number, fromZ: number, seed: number): { peaks: Peak[]; nx: number; nz: number } {
  const rng = makeRng(seed)
  let nx = ax - fromX
  let nz = az - fromZ
  const l = Math.hypot(nx, nz) || 1
  nx /= l
  nz /= l
  // ridge axis ⟂ facing
  const tx = -nz
  const tz = nx
  const n: number = SUPER.mountain.peaks
  const peaks: Peak[] = []
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : i / (n - 1) - 0.5
    const along = k * SUPER.mountain.span + (rng() - 0.5) * 0.5
    const off = (rng() - 0.5) * 0.7
    // tallest in the middle, jagged shoulders
    const h = 2.3 + (1 - Math.abs(k) * 1.4) * 1.9 + rng() * 0.8
    const r = SUPER.mountain.peakR * (0.85 + rng() * 0.35) * (0.8 + (1 - Math.abs(k)) * 0.35)
    peaks.push({ x: ax + tx * along + nx * off, z: az + tz * along + nz * off, r, h })
  }
  return { peaks, nx, nz }
}

/** 0..1 height envelope: bursts up, holds, sinks back into the turf. */
export function mountainScale(age: number): number {
  const m = SUPER.mountain
  if (age < 0) return 0
  if (age < m.rise) {
    const t = age / m.rise
    // overshoot like a heave out of the ground
    return Math.min(1.06, 1 - Math.pow(1 - t, 3) + Math.sin(t * Math.PI) * 0.08)
  }
  if (age < m.life) return 1
  const s = (age - m.life) / m.sink
  return Math.max(0, 1 - s * s)
}

export function mountainAlive(w: MountainWall): boolean {
  return w.age < SUPER.mountain.life + SUPER.mountain.sink
}

/** Solid rock for the ball: cylinder push-out + damped reflection. Returns the hit speed. */
export function collideBallWithWalls(b: BallState, walls: readonly MountainWall[]): number {
  let hit = 0
  for (const w of walls) {
    const s = mountainScale(w.age)
    if (s <= 0.02) continue
    for (const p of w.peaks) {
      // cone-ish: the collider narrows toward the tip
      const top = p.h * s
      if (b.y - BALL.r > top) continue
      const rAtY = p.r * (1 - clamp(b.y / Math.max(0.1, top), 0, 1) * 0.55)
      const dx = b.x - p.x
      const dz = b.z - p.z
      const d = Math.hypot(dx, dz)
      const minD = rAtY + BALL.r
      if (d < minD && d > 1e-5) {
        const nx = dx / d
        const nz = dz / d
        b.x = p.x + nx * minD
        b.z = p.z + nz * minD
        const vn = b.vx * nx + b.vz * nz
        if (vn < 0) {
          b.vx -= nx * vn * (1 + SUPER.mountain.ballRestitution)
          b.vz -= nz * vn * (1 + SUPER.mountain.ballRestitution)
          hit = Math.max(hit, -vn)
        }
      }
    }
  }
  return hit
}

/**
 * Keep a body (radius `r`) out of the rock. Returns the push applied and
 * whether it was caught INSIDE a rising peak (→ launched / knocked down).
 */
export function pushOutOfWalls(
  x: number,
  z: number,
  r: number,
  walls: readonly MountainWall[],
): { x: number; z: number; caught: MountainWall | null } {
  let caught: MountainWall | null = null
  for (const w of walls) {
    const s = mountainScale(w.age)
    if (s <= 0.15) continue
    for (const p of w.peaks) {
      const dx = x - p.x
      const dz = z - p.z
      const d = Math.hypot(dx, dz)
      const minD = p.r * 0.92 + r
      if (d < minD) {
        const rising = w.age < SUPER.mountain.rise
        if (rising && d < p.r * 0.9) caught = w
        const nx = d > 1e-4 ? dx / d : w.nx
        const nz = d > 1e-4 ? dz / d : w.nz
        x = p.x + nx * minD
        z = p.z + nz * minD
      }
    }
  }
  return { x, z, caught }
}

// ---------------------------------------------------------------- cyclone

export interface Cyclone {
  id: number
  x: number
  z: number
  age: number
  team: Team
  from: string
  seed: number
}

/** 0..1 strength envelope over the cyclone's life (spins up, holds, unwinds). */
export function cycloneStrength(age: number): number {
  const L = SUPER.cyclone.life
  if (age < 0 || age > L) return 0
  return clamp(age / 0.5, 0, 1) * clamp((L - age) / 0.6, 0, 1)
}

/**
 * Velocity the cyclone imposes on a body at (x, z): inward pull that grows
 * toward the eye, plus a counter-clockwise swirl. Returns zero outside the
 * pull radius. `k` is the 0..1 grip (1 = fully captured).
 */
export function cycloneVelocity(x: number, z: number, c: Cyclone): { vx: number; vz: number; k: number } {
  const s = cycloneStrength(c.age)
  const dx = c.x - x
  const dz = c.z - z
  const d = Math.hypot(dx, dz)
  const R = SUPER.cyclone.pullRadius
  if (s <= 0 || d > R) return { vx: 0, vz: 0, k: 0 }
  const nx = d > 1e-4 ? dx / d : 0
  const nz = d > 1e-4 ? dz / d : 0
  const k = s * clamp(1 - (d - SUPER.cyclone.innerRadius) / (R - SUPER.cyclone.innerRadius), 0, 1)
  // hold the victims on a tight ring around the eye instead of collapsing to a point
  const ring = SUPER.cyclone.innerRadius
  const pull = d > ring ? SUPER.cyclone.pull * (0.35 + 0.65 * k) : -(ring - d) * 3
  const swirl = SUPER.cyclone.swirl * (0.3 + 0.7 * k)
  return { vx: (nx * pull - nz * swirl) * s, vz: (nz * pull + nx * swirl) * s, k }
}

// ---------------------------------------------------------------- eagle

/** Glide seconds for a swoop of `d` metres. */
export function eagleDuration(d: number): number {
  return clamp(d / SUPER.eagle.speed, SUPER.eagle.minT, SUPER.eagle.maxT)
}

/** Lift arc (metres) at glide progress u — a hop up, a long glide, a hard dive. */
export function eagleLift(u: number): number {
  const t = clamp(u, 0, 1)
  return SUPER.eagle.apex * Math.sin(Math.pow(t, 0.8) * Math.PI) * (t < 0.85 ? 1 : 1 - (t - 0.85) * 2.4)
}
