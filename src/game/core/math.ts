/** Small math helpers shared across engine modules. */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Framerate-independent exponential approach: how far toward `target` after `dt` at rate `lambda`. */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt))

export const wrapAngle = (a: number): number => {
  let x = a
  while (x > Math.PI) x -= Math.PI * 2
  while (x < -Math.PI) x += Math.PI * 2
  return x
}

/** Framerate-independent angle approach taking the short way around. */
export const dampAngle = (a: number, b: number, lambda: number, dt: number): number =>
  a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt))

/** Deterministic small PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Signed distance to a rounded rectangle on the XZ plane.
 * Negative inside. `qx/qz` are half extents, `r` the corner radius.
 */
export function sdRoundedRect(x: number, z: number, qx: number, qz: number, r: number): number {
  const dx = Math.abs(x) - (qx - r)
  const dz = Math.abs(z) - (qz - r)
  const ax = Math.max(dx, 0)
  const az = Math.max(dz, 0)
  const outside = Math.hypot(ax, az)
  const inside = Math.min(Math.max(dx, dz), 0)
  return outside + inside - r
}

/** Yaw conventions (camera.rotation.y, order YXZ). Forward is -Z at yaw 0. */
export function forwardXZ(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)]
}

export function rightXZ(yaw: number): [number, number] {
  return [Math.cos(yaw), -Math.sin(yaw)]
}

export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz)
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz)
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function randomName(taken: ReadonlyArray<string>, rng: () => number = Math.random): string {
  const pool = [
    'Arjun', 'Zoya', 'Rohan', 'Meera', 'Kabir', 'Tara', 'Dev', 'Ananya', 'Ishaan', 'Priya', 'Sam', 'Riya',
  ]
  const free = pool.filter((n) => !taken.some((t) => t.toLowerCase() === n.toLowerCase()))
  const src = free.length > 0 ? free : pool
  const base = src[Math.floor(rng() * src.length)]
  if (taken.some((t) => t.toLowerCase() === base.toLowerCase())) {
    return `${base} ${Math.floor(rng() * 90 + 10)}`
  }
  return base
}
