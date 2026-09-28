/**
 * GULMOHAR GROUND — FIRST PERSON
 * Procedural hand-painted texture factory (Task 2-b; sky, pitch markings and
 * the building facade overhauled in Task 3).
 *
 * Every texture is painted with 2D canvas in an "anime background painting" style:
 * flat colour bands, soft blotches, hand-jittered ink lines, warm golden-hour palette
 * and faint grain. No photorealism, no external assets.
 *
 * Conventions (all textures):
 *   - colorSpace = SRGBColorSpace, anisotropy = 4, mipmaps + LinearMipmapLinearFilter
 *   - tiling textures (apron, net, plaster, brick, building, leaf, leafAlpha)
 *     use RepeatWrapping
 *     and are drawn wrap-safe (features that cross an edge are re-drawn at the wrapped
 *     offset) so tiles have no visible seams
 *   - everything is driven by a seeded PRNG (mulberry32) → deterministic across loads,
 *     with a distinct seed per texture family
 */
import * as THREE from 'three'
import { PITCH, RULES } from '../core/constants'

/* ------------------------------------------------------------------ */
/* Types + seeded randomness                                          */
/* ------------------------------------------------------------------ */

type Ctx = CanvasRenderingContext2D
type RNG = () => number
type RGB = readonly [number, number, number]
type Pt = readonly [number, number]

/** Small fast seeded PRNG → [0, 1). Deterministic across loads. */
function mulberry32(seed: number): RNG {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic 2D integer hash → [0, 1). Used where randomness must be
 * PERIODIC (e.g. the net grid, per-brick jitter) so wrapped copies of a
 * tiling texture stay identical at the seams.
 */
function hash2(x: number, y: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y ^ 0xc2b2ae35, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** Anything we can pour a jittered polyline into (context or standalone path). */
interface PathBuilder {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
}

/* ------------------------------------------------------------------ */
/* Small math / colour helpers                                        */
/* ------------------------------------------------------------------ */

const rand = (r: RNG, lo: number, hi: number): number => lo + r() * (hi - lo)

function pick<T>(r: RNG, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const rgba = (c: RGB, a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  return { canvas, ctx }
}

/** Wrap the canvas in a THREE.CanvasTexture with the shared hand-painted conventions. */
function finishTexture(canvas: HTMLCanvasElement, tiling: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  const wrap = tiling ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  tex.wrapS = wrap
  tex.wrapT = wrap
  return tex
}

/** Soft radial blotch: solid-ish core fading to nothing at the rim. */
function softBlotch(ctx: Ctx, x: number, y: number, r: number, c: RGB, a: number): void {
  if (r <= 0 || a <= 0) return
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, rgba(c, a))
  g.addColorStop(0.62, rgba(c, a * 0.72))
  g.addColorStop(1, rgba(c, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Hand-drawn path builder: subdivides each edge into ~`seg` pieces and offsets every
 * point perpendicular to its piece by ±`jitter`. This is the "wobbly ink" look used
 * for chalk lines, ropes, cracks, pills, outlines — everywhere.
 */
function buildJitteredPath(
  target: PathBuilder,
  rng: RNG,
  pts: readonly Pt[],
  jitter: number,
  seg: number,
  close: boolean,
): void {
  if (pts.length < 2) return
  target.moveTo(pts[0][0] + (rng() * 2 - 1) * jitter, pts[0][1] + (rng() * 2 - 1) * jitter)
  const n = pts.length
  const edges = close ? n : n - 1
  for (let e = 0; e < edges; e++) {
    const a = pts[e]
    const b = pts[(e + 1) % n]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    const steps = Math.max(1, Math.round(len / seg))
    const ux = len > 0 ? dx / len : 0
    const uy = len > 0 ? dy / len : 0
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const j = (rng() * 2 - 1) * jitter
      target.lineTo(a[0] + dx * t - uy * j, a[1] + dy * t + ux * j)
    }
  }
  if (close) target.closePath()
}

/** One hand-jittered stroke from (x1,y1) to (x2,y2). */
function jitterLine(
  ctx: Ctx,
  rng: RNG,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  jitter: number,
  seg: number,
): void {
  buildJitteredPath(ctx, rng, [[x1, y1], [x2, y2]], jitter, seg, false)
  ctx.stroke()
}

/**
 * Tiling aid: run `fn` nine times with the canvas offset by (-w,0,w) x (-h,0,h).
 * Features that spill over an edge are then also painted at the wrapped position,
 * so repeated tiles join seamlessly. `fn` must be deterministic per call — re-seed
 * any RNG inside it.
 */
function wrapDraw(ctx: Ctx, w: number, h: number, fn: (ctx: Ctx) => void): void {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      ctx.save()
      ctx.translate(ox * w, oy * h)
      fn(ctx)
      ctx.restore()
    }
  }
}

/** Wrapped canvas positions a feature at (x, y) with radius r must be drawn at. */
function wrapPositions(x: number, y: number, r: number, w: number, h: number): Pt[] {
  const out: Pt[] = []
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const px = x + ox * w
      const py = y + oy * h
      if (px + r > 0 && px - r < w && py + r > 0 && py - r < h) out.push([px, py])
    }
  }
  return out
}

/** n points around a circle (endpoints exclusive of the wrap-around duplicate). */
function circlePoints(cx: number, cy: number, r: number, n: number, a0 = 0): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return pts
}

/** Polyline around a rounded rectangle (edges subdivided by `step`, corners by arcs). */
function roundedRectPoints(x: number, y: number, w: number, h: number, r: number, step: number): Pt[] {
  const pts: Pt[] = []
  const edge = (x1: number, y1: number, x2: number, y2: number): void => {
    const len = Math.hypot(x2 - x1, y2 - y1)
    const n = Math.max(1, Math.round(len / step))
    for (let i = 0; i < n; i++) {
      const t = i / n
      pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t])
    }
  }
  const arc = (cx: number, cy: number, a0: number): void => {
    const n = 7
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  edge(x + r, y, x + w - r, y)
  arc(x + w - r, y + r, -Math.PI / 2)
  edge(x + w, y + r, x + w, y + h - r)
  arc(x + w - r, y + h - r, 0)
  edge(x + w - r, y + h, x + r, y + h)
  arc(x + r, y + h - r, Math.PI / 2)
  edge(x, y + h - r, x, y + r)
  arc(x + r, y + r, Math.PI)
  return pts
}

/** n+1 samples along a quadratic bezier (for seam arcs, branch hints, blades). */
function quadPoints(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, n: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2])
  }
  return pts
}

/** Faint 1px grain specks (some lighter, some darker) — the paper-tooth feel. */
function addGrain(ctx: Ctx, rng: RNG, w: number, h: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = rand(rng, 0.02, 0.05)
    ctx.fillStyle =
      rng() < 0.5 ? `rgba(255,250,232,${a})` : `rgba(42,36,26,${a})`
    ctx.fillRect(rng() * (w - 1), rng() * (h - 1), 1, 1)
  }
}

/* ------------------------------------------------------------------ */
/* 1. Pitch — the whole painted pitch in one texture                  */
/* ------------------------------------------------------------------ */

export function makePitchTexture(): THREE.CanvasTexture {
  const W = 2048
  const H = 1311 // ~ 55:35, see PITCH.L / PITCH.W below for the exact metre mapping
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = mulberry32(0x51ce55)

  const sx = W / PITCH.L // px per metre along the pitch length (X)
  const sy = H / PITCH.W // px per metre along the pitch width (Z)
  const px = (mx: number): number => (mx + PITCH.L / 2) * sx
  const py = (mz: number): number => (mz + PITCH.W / 2) * sy

  // -- base warm green ------------------------------------------------
  ctx.fillStyle = '#7e9a4e'
  ctx.fillRect(0, 0, W, H)

  // -- mown stripes: 10 bands running along the pitch length, feathered
  const bands = 10
  const bandH = H / bands
  const feather = 14 // px of blur on each stripe edge
  const stripeA = hexToRgb('#8ca85a')
  const stripeB = hexToRgb('#74904a')
  for (let i = 0; i < bands; i++) {
    const y0 = i * bandH
    const span = bandH + 2 * feather
    const g = ctx.createLinearGradient(0, y0 - feather, 0, y0 + bandH + feather)
    const c = i % 2 === 0 ? stripeA : stripeB
    g.addColorStop(0, rgba(c, 0))
    g.addColorStop((2 * feather) / span, rgba(c, 1))
    g.addColorStop(bandH / span, rgba(c, 1))
    g.addColorStop(1, rgba(c, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, y0 - feather, W, span)
  }

  // -- large soft mottling --------------------------------------------
  const mottleDark = hexToRgb('#5f7a3e')
  const mottleLight = hexToRgb('#93ad60')
  for (let i = 0; i < 45; i++) {
    softBlotch(
      ctx,
      rng() * W,
      rng() * H,
      rand(rng, 80, 300),
      rng() < 0.5 ? mottleDark : mottleLight,
      rand(rng, 0.05, 0.09),
    )
  }

  // -- worn brown patches (denser near both goals + centre circle) -----
  const wornColors = [hexToRgb('#a78b58'), hexToRgb('#96804e')]
  for (let i = 0; i < 14; i++) {
    let mx = 0
    let mz = 0
    if (i < 5) {
      mx = -PITCH.L / 2 + rand(rng, 0.5, 6.5)
      mz = rand(rng, -1, 1) * PITCH.W * 0.36
    } else if (i < 10) {
      mx = PITCH.L / 2 - rand(rng, 0.5, 6.5)
      mz = rand(rng, -1, 1) * PITCH.W * 0.36
    } else if (i < 13) {
      mx = rand(rng, -1, 1) * 7.5
      mz = rand(rng, -1, 1) * 7.5
    } else {
      mx = rand(rng, -1, 1) * (PITCH.L / 2 - 2)
      mz = rand(rng, -1, 1) * (PITCH.W / 2 - 2)
    }
    const cx = px(mx)
    const cy = py(mz)
    const n = 3 + Math.floor(rng() * 4) // 3–6 overlapping soft circles
    for (let k = 0; k < n; k++) {
      softBlotch(
        ctx,
        cx + rand(rng, -26, 26),
        cy + rand(rng, -26, 26),
        rand(rng, 18, 56),
        pick(rng, wornColors),
        rand(rng, 0.22, 0.4),
      )
    }
  }

  // -- chalk lines ------------------------------------------------------
  ctx.strokeStyle = 'rgba(252,250,240,0.9)'
  ctx.lineWidth = 0.22 * sx // ≈ 0.22 m wide chalk
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = 'rgba(252,250,240,0.45)'
  ctx.shadowBlur = 4

  const inset = 0.8 // m inside the pitch edge
  const bx1 = px(-PITCH.L / 2 + inset)
  const by1 = py(-PITCH.W / 2 + inset)
  const bx2 = px(PITCH.L / 2 - inset)
  const by2 = py(PITCH.W / 2 - inset)

  // boundary: rounded rect, 6 m corner radius
  buildJitteredPath(
    ctx,
    rng,
    roundedRectPoints(bx1, by1, bx2 - bx1, by2 - by1, PITCH.cornerR * sx, 24),
    1.2,
    24,
    true,
  )
  ctx.stroke()

  // halfway line
  jitterLine(ctx, rng, px(0), by1, px(0), by2, 1.2, 24)

  // centre circle r = 5.5 m
  buildJitteredPath(ctx, rng, circlePoints(px(0), py(0), 5.5 * sx, 56), 1.2, 24, true)
  ctx.stroke()

  // centre spot
  ctx.fillStyle = 'rgba(252,250,240,0.9)'
  ctx.beginPath()
  ctx.arc(px(0), py(0), 0.22 * sx, 0, Math.PI * 2)
  ctx.fill()

  // penalty areas, goal areas, penalty spots + arcs — real dims from RULES
  const arcR = 6 // penalty arc radius (m), centred on the spot
  // half-angle of the "D": the span that escapes the box front line
  const arcHalf = Math.acos((RULES.boxDepth - RULES.penaltySpot) / arcR)
  for (const side of [-1, 1] as const) {
    const glx = side === -1 ? bx1 : bx2
    const boxX =
      side === -1 ? px(-PITCH.L / 2 + inset + RULES.boxDepth) : px(PITCH.L / 2 - inset - RULES.boxDepth)
    const gaX =
      side === -1
        ? px(-PITCH.L / 2 + inset + RULES.goalAreaDepth)
        : px(PITCH.L / 2 - inset - RULES.goalAreaDepth)
    // penalty box: 10 m deep x 22 m wide
    jitterLine(ctx, rng, glx, py(-RULES.boxHalfW), boxX, py(-RULES.boxHalfW), 1.2, 24)
    jitterLine(ctx, rng, glx, py(RULES.boxHalfW), boxX, py(RULES.boxHalfW), 1.2, 24)
    jitterLine(ctx, rng, boxX, py(-RULES.boxHalfW), boxX, py(RULES.boxHalfW), 1.2, 24)
    // six-yard box: 3.5 m deep x 9.5 m wide, inside the penalty box
    jitterLine(ctx, rng, glx, py(-RULES.goalAreaHalfW), gaX, py(-RULES.goalAreaHalfW), 1.2, 24)
    jitterLine(ctx, rng, glx, py(RULES.goalAreaHalfW), gaX, py(RULES.goalAreaHalfW), 1.2, 24)
    jitterLine(ctx, rng, gaX, py(-RULES.goalAreaHalfW), gaX, py(RULES.goalAreaHalfW), 1.2, 24)
    // penalty spot: 7 m from the goal line, centred
    const spotX =
      side === -1
        ? px(-PITCH.L / 2 + inset + RULES.penaltySpot)
        : px(PITCH.L / 2 - inset - RULES.penaltySpot)
    ctx.fillStyle = 'rgba(252,250,240,0.9)'
    ctx.beginPath()
    ctx.arc(spotX, py(0), 0.22 * sx, 0, Math.PI * 2)
    ctx.fill()
    // penalty arc ("D"): only the span outside the box, bulging toward halfway
    const a0 = side === -1 ? -arcHalf : Math.PI - arcHalf
    const arcPts: Pt[] = []
    const nArc = 22
    for (let k = 0; k <= nArc; k++) {
      const a = a0 + ((2 * arcHalf) / nArc) * k
      arcPts.push([spotX + Math.cos(a) * arcR * sx, py(0) + Math.sin(a) * arcR * sx])
    }
    buildJitteredPath(ctx, rng, arcPts, 1.2, 24, false)
    ctx.stroke()
  }

  // small 1 m corner arcs
  const car = 1 * sx
  const corners: readonly (readonly [number, number, number, number])[] = [
    [bx1, by1, 0, Math.PI / 2],
    [bx2, by1, Math.PI / 2, Math.PI],
    [bx2, by2, Math.PI, (Math.PI * 3) / 2],
    [bx1, by2, (Math.PI * 3) / 2, Math.PI * 2],
  ]
  for (const [ccx, ccy, a0, a1] of corners) {
    const pts: Pt[] = []
    for (let k = 0; k <= 5; k++) {
      const a = a0 + ((a1 - a0) * k) / 5
      pts.push([ccx + Math.cos(a) * car, ccy + Math.sin(a) * car])
    }
    buildJitteredPath(ctx, rng, pts, 1, 16, false)
    ctx.stroke()
  }
  ctx.shadowBlur = 0

  // -- faint grass-blade streaks, mostly along the pitch length ---------
  for (let i = 0; i < 380; i++) {
    const x = rng() * W
    const y = rng() * H
    const len = rand(rng, 1, 3)
    const ang = (rng() < 0.5 ? 0 : Math.PI) + rand(rng, -0.3, 0.3)
    const h = 82 + (rng() * 2 - 1) * 5
    const s = 33 + (rng() * 2 - 1) * 7
    const l = 45 + (rng() * 2 - 1) * 10 // ±10 lightness points
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(ang)
    ctx.fillStyle = `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,0.12)`
    ctx.fillRect(0, -0.5, len, 1)
    ctx.restore()
  }

  // -- grain ------------------------------------------------------------
  addGrain(ctx, rng, W, H, 4200)

  const tex = finishTexture(canvas, false)
  tex.userData.pxPerMeter = W / PITCH.L
  return tex
}

/* ------------------------------------------------------------------ */
/* 2. Apron — plain mottled grass around the pitch (tiling)           */
/* ------------------------------------------------------------------ */

export function makeApronTexture(): THREE.CanvasTexture {
  const S = 512
  const { canvas, ctx } = makeCanvas(S, S)
  ctx.fillStyle = '#74904a'
  ctx.fillRect(0, 0, S, S)

  const darker = hexToRgb('#5f7a3e')
  const lighter = hexToRgb('#93ad60')
  const dry = hexToRgb('#96804e')

  wrapDraw(ctx, S, S, (c) => {
    const r = mulberry32(0xa9c04a) // re-seeded per pass → identical wrapped copies
    for (let i = 0; i < 60; i++) {
      softBlotch(
        c,
        r() * S,
        r() * S,
        rand(r, 30, 110),
        r() < 0.5 ? darker : lighter,
        rand(r, 0.06, 0.12),
      )
    }
    for (let i = 0; i < 6; i++) {
      const x = r() * S
      const y = r() * S
      for (let k = 0; k < 3; k++) {
        softBlotch(c, x + rand(r, -18, 18), y + rand(r, -18, 18), rand(r, 20, 60), dry, 0.15)
      }
    }
  })
  addGrain(ctx, mulberry32(0x612313), S, S, 1800)
  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 3. Sky — rich dusk gradient, painted sun, clouds, ridges, birds    */
/* ------------------------------------------------------------------ */

/**
 * 2048x1024 dusk painting for the 420 m sky sphere.
 *
 * MAPPING NOTE: the sphere's equator (canvas y = 0.5H) is the visible
 * horizon — the fogged 500 m ground disc occludes everything painted below
 * it, which is why the old 0.76H sun never showed on screen. The whole dusk
 * ramp, the ridge lines and the sun therefore live in the upper half of the
 * canvas (the lower half just continues warm cream and is never sampled).
 */
export function makeSkyTexture(): THREE.CanvasTexture {
  const W = 2048
  const H = 1024
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = mulberry32(0x5e11c0)

  // -- vertical dusk gradient: blue-lavender zenith → amber → cream -----
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0.0, '#6f86c0') // deep dusk blue-lavender zenith
  g.addColorStop(0.1, '#7f8ec4')
  g.addColorStop(0.2, '#9d97c4') // lavender haze
  g.addColorStop(0.28, '#c2a0ac') // dusty rose
  g.addColorStop(0.35, '#e3b48c') // amber
  g.addColorStop(0.42, '#f6cf9c') // marigold
  g.addColorStop(0.475, '#ffe3b4')
  g.addColorStop(0.5, '#ffe9c4') // pale warm cream at the horizon
  g.addColorStop(0.62, '#ffefd2') // below the visible horizon
  g.addColorStop(1.0, '#fff3da')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // -- three soft horizontal colour band variations ----------------------
  const hband = (cy: number, hgt: number, hex: string, a: number): void => {
    const col = hexToRgb(hex)
    ctx.save()
    ctx.translate(W / 2, cy)
    ctx.rotate(rand(rng, -0.004, 0.004)) // barely tilted, not ruler-straight
    const bg = ctx.createLinearGradient(0, -hgt / 2, 0, hgt / 2)
    bg.addColorStop(0, rgba(col, 0))
    bg.addColorStop(0.5, rgba(col, a))
    bg.addColorStop(1, rgba(col, 0))
    ctx.fillStyle = bg
    ctx.fillRect(-W, -hgt / 2, W * 2, hgt)
    ctx.restore()
  }
  hband(H * 0.15, H * 0.13, '#8f9ccb', 0.07)
  hband(H * 0.3, H * 0.14, '#ecb28c', 0.08)
  hband(H * 0.435, H * 0.11, '#ffdca4', 0.09)

  const sunX = 0.63 * W
  const sunY = 0.455 * H // just above the visible horizon (see mapping note)

  // -- distant painted ridge silhouettes along the horizon ---------------
  const ridge = (baseY: number, amp: number, hex: string, alphaTop: number): void => {
    const col = hexToRgb(hex)
    const p1 = rng() * Math.PI * 2
    const p2 = rng() * Math.PI * 2
    const p3 = rng() * Math.PI * 2
    const step = 26
    const pts: Pt[] = []
    for (let x = -step; x <= W + step; x += step) {
      const y =
        baseY -
        (Math.sin((x / W) * Math.PI * 2 + p1) * 0.5 + 0.5) * amp -
        (Math.sin((x / W) * Math.PI * 5 + p2) * 0.5 + 0.5) * amp * 0.45 -
        Math.sin((x / W) * Math.PI * 11 + p3) * amp * 0.12 +
        rand(rng, -3, 3)
      pts.push([x, y])
    }
    const poly: Pt[] = [...pts]
    poly.push([W + step, H])
    poly.push([-step, H])
    // feathered crest + base dissolving into the horizon haze
    const fade = baseY + H * 0.075
    const fg = ctx.createLinearGradient(0, baseY - amp * 1.6 - 8, 0, fade)
    fg.addColorStop(0, rgba(col, 0))
    fg.addColorStop(0.16, rgba(col, alphaTop))
    fg.addColorStop(0.75, rgba(col, alphaTop * 0.45))
    fg.addColorStop(1, rgba(col, 0))
    ctx.fillStyle = fg
    buildJitteredPath(ctx, rng, poly, 2.5, 30, true)
    ctx.fill()
  }
  ridge(H * 0.455, H * 0.055, '#b9a9c9', 0.5) // far ridge — lighter, hazier
  ridge(H * 0.48, H * 0.035, '#9c8bab', 0.55) // near ridge — deeper mauve

  // -- painted sun: wide warm glow, soft disc, two wobbly halos ----------
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 252)
  glow.addColorStop(0, 'rgba(255,216,150,0.5)')
  glow.addColorStop(0.35, 'rgba(255,206,138,0.3)')
  glow.addColorStop(1, 'rgba(255,196,128,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(sunX, sunY, 252, 0, Math.PI * 2)
  ctx.fill()

  const sg = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 84)
  sg.addColorStop(0, 'rgba(255,247,224,1)')
  sg.addColorStop(0.55, 'rgba(255,244,216,0.95)')
  sg.addColorStop(1, 'rgba(255,242,210,0)')
  ctx.fillStyle = sg
  ctx.beginPath()
  ctx.arc(sunX, sunY, 84, 0, Math.PI * 2)
  ctx.fill()

  const halo = (radius: number, alpha: number, width: number): void => {
    ctx.strokeStyle = `rgba(255,242,216,${alpha})`
    ctx.lineWidth = width
    ctx.shadowColor = `rgba(255,242,216,${alpha})`
    ctx.shadowBlur = 6
    buildJitteredPath(ctx, rng, circlePoints(sunX, sunY, radius, 40), 2, 20, true)
    ctx.stroke()
    ctx.shadowBlur = 0
  }
  halo(124, 0.13, 5)
  halo(182, 0.07, 3.5)

  // -- clouds -------------------------------------------------------------
  /** A seeded point in the given box, kept clear of the sun's glow. */
  const spotAway = (xLo: number, xHi: number, yLo: number, yHi: number, minDist: number): Pt => {
    for (let a = 0; a < 60; a++) {
      const x = rand(rng, xLo, xHi)
      const y = rand(rng, yLo, yHi)
      if (Math.hypot(x - sunX, y - sunY) >= minDist) return [x, y]
    }
    return [(xLo + xHi) / 2, (yLo + yHi) / 2]
  }

  // (a) long thin cirrus streaks near the top
  for (let i = 0; i < 4; i++) {
    const cx = rand(rng, 140, W - 140)
    const cy = rand(rng, H * 0.035, H * 0.15)
    const len = rand(rng, 280, 460)
    const tilt = rand(rng, -0.045, 0.03)
    const strands = 2 + Math.floor(rng() * 2)
    for (let s = 0; s < strands; s++) {
      const sy = cy + s * rand(rng, 8, 13)
      const sl = len * rand(rng, 0.7, 1)
      ctx.save()
      ctx.translate(cx, sy)
      ctx.rotate(tilt)
      ctx.scale(1, 0.04)
      const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, sl / 2)
      cg.addColorStop(0, 'rgba(255,238,210,0)')
      cg.addColorStop(0.5, 'rgba(255,238,210,0.2)')
      cg.addColorStop(1, 'rgba(255,238,210,0)')
      ctx.fillStyle = cg
      ctx.beginPath()
      ctx.arc(0, 0, sl / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  // (b) large flat anvil cumulus banks — cream lit tops, dusty-rose bellies
  const underMauve = hexToRgb('#b98a8f')
  const cumulus = (cx: number, cy: number, rx: number, ry: number): void => {
    const blobs = 4 + Math.floor(rng() * 5) // 4–8 overlapping soft ellipse blobs
    const phase = rng() * Math.PI * 2
    for (let k = 0; k < blobs; k++) {
      const t = blobs === 1 ? 0.5 : k / (blobs - 1)
      const ex = cx + (t - 0.5) * rx * 1.18
      const ey = cy - Math.sin(t * Math.PI + phase) * ry * 0.22 + rand(rng, -4, 4)
      const erx = rx * rand(rng, 0.26, 0.42)
      const ery = ry * rand(rng, 0.75, 1.15)
      ctx.save()
      ctx.translate(ex, ey)
      ctx.scale(1, ery / erx)
      const eg = ctx.createRadialGradient(0, -erx * 0.2, 0, 0, 0, erx)
      eg.addColorStop(0, 'rgba(255,243,222,0.66)')
      eg.addColorStop(0.7, 'rgba(255,239,213,0.5)')
      eg.addColorStop(1, 'rgba(255,238,214,0)')
      ctx.fillStyle = eg
      ctx.beginPath()
      ctx.arc(0, 0, erx, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    // mauve under-mass + flatter, stronger jittered underline strokes
    softBlotch(ctx, cx, cy + ry * 0.5, rx * 0.6, underMauve, 0.22)
    ctx.strokeStyle = 'rgba(185,138,143,0.42)'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    const lines = 2 + Math.floor(rng() * 2)
    for (let k = 0; k < lines; k++) {
      const span = rx * rand(rng, 0.42, 0.58)
      const uy = cy + ry * (0.55 + k * 0.2) + rand(rng, -3, 3)
      jitterLine(ctx, rng, cx - span, uy, cx + span, uy + rand(rng, -4, 5), 2.2, 24)
    }
  }
  for (let i = 0; i < 8; i++) {
    const [cx, cy] = spotAway(110, W - 110, H * 0.07, H * 0.4, 330)
    cumulus(cx, cy, rand(rng, 150, 260), rand(rng, 30, 52))
  }

  // (c) tiny distant cloudlets near the horizon
  for (let i = 0; i < 5; i++) {
    const [cx, cy] = spotAway(60, W - 60, H * 0.355, H * 0.44, 280)
    const rx = rand(rng, 24, 50)
    const blobs = 2 + Math.floor(rng() * 2)
    for (let k = 0; k < blobs; k++) {
      const ex = cx + (k - (blobs - 1) / 2) * rx * 0.6
      const erx = rx * rand(rng, 0.4, 0.6)
      ctx.save()
      ctx.translate(ex, cy + rand(rng, -2, 2))
      ctx.scale(1, 0.28)
      const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, erx)
      eg.addColorStop(0, 'rgba(255,240,216,0.2)')
      eg.addColorStop(1, 'rgba(255,240,216,0)')
      ctx.fillStyle = eg
      ctx.beginPath()
      ctx.arc(0, 0, erx, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    ctx.strokeStyle = 'rgba(185,138,143,0.14)'
    ctx.lineWidth = 2
    jitterLine(ctx, rng, cx - rx * 0.5, cy + 4, cx + rx * 0.5, cy + 5, 1, 14)
  }

  // -- 7 tiny distant bird checks -----------------------------------------
  ctx.strokeStyle = 'rgba(74,63,56,0.65)'
  ctx.lineWidth = 2.6
  ctx.lineCap = 'round'
  for (let i = 0; i < 7; i++) {
    const x = rand(rng, 70, W - 70)
    const y = rand(rng, H * 0.06, H * 0.3)
    const s = rand(rng, 0.85, 1.25)
    jitterLine(ctx, rng, x - 7 * s, y + 3 * s, x, y, 0.7, 8)
    jitterLine(ctx, rng, x, y, x + 8 * s, y - 3.5 * s, 0.7, 8)
  }

  return finishTexture(canvas, false)
}

/* ------------------------------------------------------------------ */
/* 4. Net — hand-drawn rope grid (tiling)                             */
/* ------------------------------------------------------------------ */

/**
 * The grid uses 25.6 px spacing (256/10 — reads as the requested ~26 px) and
 * PERIODIC jitter/sag: every wobble is a function of position modulo the canvas
 * size, and each rope overhangs the edges by one segment. Repeated copies therefore
 * join exactly, with no half-drawn ropes on the tile boundaries.
 */
export function makeNetTexture(): THREE.CanvasTexture {
  const S = 256
  const { canvas, ctx } = makeCanvas(S, S)
  const STEP = S / 10 // ~26 px cell, tile-exact
  const SEG = 16
  const NS = S / SEG // 16 segments per period
  const JIT = 1.5
  const SAG = 3

  ctx.strokeStyle = 'rgba(245,240,225,0.85)'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  /** Stroke one rope as runs of segments; some segments are skipped (broken) or doubled. */
  const drawNetLine = (id: number, ptAt: (k: number) => Pt): void => {
    let run: Pt[] = []
    const flush = (): void => {
      if (run.length > 1) {
        ctx.beginPath()
        ctx.moveTo(run[0][0], run[0][1])
        for (let q = 1; q < run.length; q++) ctx.lineTo(run[q][0], run[q][1])
        ctx.stroke()
      }
      run = []
    }
    for (let k = -1; k <= NS; k++) {
      const si = ((k % NS) + NS) % NS // physical segment index (periodic)
      const broken = hash2(id, si * 2 + 101) < 0.015
      const doubled = hash2(id, si * 2 + 102) < 0.015
      const a = ptAt(k)
      const b = ptAt(k + 1)
      if (broken) {
        flush()
        run = [b]
      } else {
        if (run.length === 0) run = [a]
        run.push(b)
        if (doubled) {
          ctx.beginPath()
          ctx.moveTo(a[0] + 2.2, a[1] + 1.4)
          ctx.lineTo(b[0] + 2.2, b[1] + 1.4)
          ctx.stroke()
        }
      }
    }
    flush()
  }

  // vertical ropes (grid offset by half a step so no rope sits on a tile boundary)
  for (let i = 0; i < 10; i++) {
    const id = i
    const x0 = (i + 0.5) * STEP
    const sagA = (hash2(id, 911) * 2 - 1) * SAG
    const sagP = hash2(id, 313) * Math.PI * 2
    const ptAt = (k: number): Pt => {
      const y = k * SEG
      const kk = ((k % NS) + NS) % NS
      return [
        x0 + sagA * Math.sin((Math.PI * 2 * y) / S + sagP) + (hash2(id * 8 + 1, kk) * 2 - 1) * JIT,
        y + (hash2(id * 8 + 2, kk) * 2 - 1) * JIT * 0.6,
      ]
    }
    drawNetLine(id, ptAt)
  }

  // horizontal ropes
  for (let j = 0; j < 10; j++) {
    const id = j + 50
    const y0 = (j + 0.5) * STEP
    const sagA = (hash2(j, 727) * 2 - 1) * SAG
    const sagP = hash2(j, 131) * Math.PI * 2
    const ptAt = (k: number): Pt => {
      const x = k * SEG
      const kk = ((k % NS) + NS) % NS
      return [
        x + (hash2(id * 8 + 3, kk) * 2 - 1) * JIT * 0.6,
        y0 + sagA * Math.sin((Math.PI * 2 * x) / S + sagP) + (hash2(id * 8 + 4, kk) * 2 - 1) * JIT,
      ]
    }
    drawNetLine(id, ptAt)
  }

  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 5. Ball — classic paneled ball, equirectangular                    */
/* ------------------------------------------------------------------ */

export function makeBallTexture(): THREE.CanvasTexture {
  const W = 512
  const H = 256
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = mulberry32(0xba115)

  ctx.fillStyle = '#f7f2e6'
  ctx.fillRect(0, 0, W, H)

  // faint seam arcs (drawn under the panels)
  ctx.strokeStyle = 'rgba(90,80,70,0.18)'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  for (let i = 0; i < 6; i++) {
    const x1 = rng() * W
    const x2 = rng() * W
    const y1 = rng() < 0.5 ? 0 : H
    const y2 = y1 === 0 ? H : 0
    const cx = (x1 + x2) / 2 + rand(rng, -80, 80)
    const cy = H / 2 + rand(rng, -50, 50)
    buildJitteredPath(ctx, rng, quadPoints(x1, y1, cx, cy, x2, y2, 6), 1.5, 24, false)
    ctx.stroke()
  }

  // 12 hand-jittered rounded-pentagon-ish panels
  ctx.fillStyle = '#2b2622'
  ctx.strokeStyle = '#2b2622'
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  const rows: readonly { y: number; xs: readonly number[] }[] = [
    { y: 0.22, xs: [0.2, 0.5, 0.8] },
    { y: 0.5, xs: [0.125, 0.375, 0.625, 0.875] },
    { y: 0.78, xs: [0.2, 0.5, 0.8] },
    { y: 0.06, xs: [0.35] },
    { y: 0.94, xs: [0.65] },
  ]
  for (const row of rows) {
    for (const fx of row.xs) {
      const cx = (fx + rand(rng, -0.02, 0.02)) * W
      const cy = row.y * H + rand(rng, -4, 4)
      const r0 = rand(rng, 26, 40)
      const a0 = rng() * Math.PI * 2
      ctx.beginPath()
      for (let v = 0; v < 5; v++) {
        const a = a0 + (v / 5) * Math.PI * 2 + rand(rng, -0.09, 0.09)
        const rr = r0 * rand(rng, 0.84, 1.16)
        const x = cx + Math.cos(a) * rr + rand(rng, -2, 2)
        const y = cy + Math.sin(a) * rr + rand(rng, -2, 2)
        if (v === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke() // round-joins the corners a touch
    }
  }

  // subtle dirt smudges
  const dirt = hexToRgb('#8a6f4d')
  for (let i = 0; i < 3; i++) {
    softBlotch(ctx, rng() * W, rand(rng, 40, H - 40), rand(rng, 30, 60), dirt, 0.06)
  }

  return finishTexture(canvas, false)
}

/* ------------------------------------------------------------------ */
/* 6. Plaster — warm cream wall with stains (tiling)                  */
/* ------------------------------------------------------------------ */

export function makePlasterTexture(): THREE.CanvasTexture {
  const S = 512
  const { canvas, ctx } = makeCanvas(S, S)
  ctx.fillStyle = '#e8d9b8'
  ctx.fillRect(0, 0, S, S)

  const stainC = hexToRgb('#b99a6f')
  const mottleDark = hexToRgb('#d6c29c')
  const mottleLight = hexToRgb('#f4e8ca')

  wrapDraw(ctx, S, S, (c) => {
    const r = mulberry32(0x91a573) // re-seeded per pass → identical wrapped copies

    // soft mottling
    for (let i = 0; i < 26; i++) {
      softBlotch(
        c,
        r() * S,
        r() * S,
        rand(r, 40, 140),
        r() < 0.5 ? mottleDark : mottleLight,
        rand(r, 0.05, 0.08),
      )
    }

    // 8 stain streaks running down from the top edge (slightly leaning)
    for (let i = 0; i < 8; i++) {
      const x = r() * S
      const wdt = rand(r, 4, 10)
      const len = rand(r, 80, 240)
      const a = rand(r, 0.1, 0.16)
      const lean = rand(r, -0.09, 0.09)
      c.save()
      c.translate(x, len * 0.4)
      c.rotate(lean)
      c.scale(1, (len * 0.6) / (wdt / 2))
      const g = c.createRadialGradient(0, 0, 0, 0, 0, wdt / 2)
      g.addColorStop(0, rgba(stainC, a))
      g.addColorStop(1, rgba(stainC, 0))
      c.fillStyle = g
      c.beginPath()
      c.arc(0, 0, wdt / 2, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }

    // 5 thin jagged cracks (random walk, generally heading down)
    c.strokeStyle = 'rgba(111,91,66,0.35)'
    c.lineWidth = 1
    c.lineCap = 'round'
    for (let i = 0; i < 5; i++) {
      let x = r() * S
      let y = r() * S * 0.35
      let ang = Math.PI / 2 + rand(r, -0.5, 0.5)
      c.beginPath()
      c.moveTo(x, y)
      const steps = 6 + Math.floor(r() * 9)
      for (let s = 0; s < steps; s++) {
        ang = Math.min(Math.PI - 0.15, Math.max(0.15, ang + rand(r, -0.55, 0.55)))
        const len = rand(r, 8, 18)
        x += Math.cos(ang) * len
        y += Math.sin(ang) * len
        c.lineTo(x, y)
      }
      c.stroke()
    }
  })

  // bottom 15% darkened, soft top edge
  const bg = ctx.createLinearGradient(0, S * 0.85, 0, S)
  bg.addColorStop(0, 'rgba(201,180,142,0)')
  bg.addColorStop(1, 'rgba(201,180,142,0.5)')
  ctx.fillStyle = bg
  ctx.fillRect(0, S * 0.85, S, S * 0.15)

  addGrain(ctx, mulberry32(0x3e7ea7), S, S, 1600)
  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 7. Brick — terracotta bricks (tiling)                              */
/* ------------------------------------------------------------------ */

/**
 * 64x32 px cells (4 columns x 8 rows) with 3 px mortar joints give bricks that
 * read ~61x29 — the requested 64x26 look, but mathematically tile-exact.
 * Odd rows are offset by half a brick; the last brick of an offset row wraps
 * around the edge (handled by wrapDraw).
 */
export function makeBrickTexture(): THREE.CanvasTexture {
  const S = 256
  const { canvas, ctx } = makeCanvas(S, S)
  const mortar = '#e3d3b4'
  ctx.fillStyle = mortar
  ctx.fillRect(0, 0, S, S)

  const CW = 64
  const CH = 32
  const BW = 61
  const BH = 29

  wrapDraw(ctx, S, S, (c) => {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 4; col++) {
        const cellX = col * CW + (row % 2 === 1 ? CW / 2 : 0)
        const cellY = row * CH
        // per-cell deterministic jitter (same brick in every wrapped pass)
        const jr = (s: number): number => hash2(cellX + s * 131, cellY)
        // terracotta base #b0603c ≈ hsl(19,49%,46%) with ±6° hue jitter
        const h = 18.6 + (jr(1) * 2 - 1) * 6
        const sat = 49 + (jr(2) * 2 - 1) * 5
        const lig = 46 + (jr(3) * 2 - 1) * 4
        const x = cellX + 3 + (jr(4) * 2 - 1)
        const y = cellY + 3 + (jr(5) * 2 - 1)
        c.fillStyle = `hsl(${h.toFixed(1)},${sat.toFixed(1)}%,${lig.toFixed(1)}%)`
        c.fillRect(x, y, BW, BH)
        // soft painterly shading at the brick's foot
        c.fillStyle = 'rgba(80,40,22,0.12)'
        c.fillRect(x, y + BH - 3, BW, 3)
        // occasional chipped corner (mortar-coloured nick)
        if (jr(6) < 0.18) {
          const cs = 4 + jr(7) * 6
          const corner = Math.floor(jr(8) * 4)
          c.fillStyle = mortar
          c.beginPath()
          if (corner === 0) {
            c.moveTo(x, y)
            c.lineTo(x + cs, y)
            c.lineTo(x, y + cs)
          } else if (corner === 1) {
            c.moveTo(x + BW, y)
            c.lineTo(x + BW - cs, y)
            c.lineTo(x + BW, y + cs)
          } else if (corner === 2) {
            c.moveTo(x + BW, y + BH)
            c.lineTo(x + BW - cs, y + BH)
            c.lineTo(x + BW, y + BH - cs)
          } else {
            c.moveTo(x, y + BH)
            c.lineTo(x + cs, y + BH)
            c.lineTo(x, y + BH - cs)
          }
          c.closePath()
          c.fill()
        }
      }
    }
  })

  addGrain(ctx, mulberry32(0xbc0c5), S, S, 700)
  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 7-b. Building — painted Indian city facade (tiling)                */
/* ------------------------------------------------------------------ */

/**
 * One 256 px tile = 4 floors x 4 window columns of a dusk facade, meant for
 * the distant building boxes that sit deep in the fog. One tile ≈ 7x7 m of
 * facade — clone per building and set `repeat` ≈ (faceWidth / 7, height / 7).
 *
 * Tiles on both axes: the window grid never crosses a tile edge, pipes and
 * slab bands run full-height/full-width, stains are drawn wrap-safe via
 * wrapPositions. Deliberately mid-contrast — it should read as a suggestion,
 * not detail, once the fog has softened it.
 */
export function makeBuildingTexture(): THREE.CanvasTexture {
  const S = 256
  const CELL = 64
  const { canvas, ctx } = makeCanvas(S, S)
  const rng = mulberry32(0xfacade)

  // -- base warm plaster (PALETTE.plaster-ish, a touch duskier) -----------
  ctx.fillStyle = '#e6d5b2'
  ctx.fillRect(0, 0, S, S)

  // -- soft stains / weathering (wrap-safe) -------------------------------
  const stainA = hexToRgb('#c9b28a')
  const stainB = hexToRgb('#d9c9a4')
  for (let i = 0; i < 9; i++) {
    const x = rng() * S
    const y = rng() * S
    const r0 = rand(rng, 18, 60)
    const col = rng() < 0.5 ? stainA : stainB
    const a = rand(rng, 0.05, 0.1)
    for (const [wx, wy] of wrapPositions(x, y, r0, S, S)) {
      softBlotch(ctx, wx, wy, r0, col, a)
    }
  }

  // -- floor slab bands (full width → tile horizontally) ------------------
  for (let row = 0; row < 4; row++) {
    const bandY = row * CELL + 2
    const bg = ctx.createLinearGradient(0, bandY - 3, 0, bandY + 6)
    bg.addColorStop(0, 'rgba(120,100,75,0)')
    bg.addColorStop(0.5, 'rgba(120,100,75,0.22)')
    bg.addColorStop(1, 'rgba(120,100,75,0)')
    ctx.fillStyle = bg
    ctx.fillRect(0, bandY - 3, S, 9)
  }

  // -- two vertical pipe strokes in the wall strips between window columns
  const gap1 = Math.floor(hash2(2, 77) * 4)
  let gap2 = Math.floor(hash2(9, 13) * 4)
  if (gap2 === gap1) gap2 = (gap1 + 2) % 4
  for (const k of [gap1, gap2]) {
    const x = k * CELL + 60 + (hash2(k * 5 + 1, 31) - 0.5) * 6
    ctx.strokeStyle = 'rgba(146,122,92,0.45)'
    ctx.lineWidth = 2.6
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, S)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(240,225,195,0.22)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x - 0.8, 0)
    ctx.lineTo(x - 0.8, S)
    ctx.stroke()
  }

  // -- the 4x4 painted window grid -----------------------------------------
  const winA = hexToRgb('#463a35') // dark indigo-brown glass
  const winB = hexToRgb('#57493f')
  const litCore = hexToRgb('#ffd489') // warm amber light
  const clothColors = [hexToRgb('#b98a8f'), hexToRgb('#7d9a94'), hexToRgb('#c9b06a')]
  const clothAt = (v: number): RGB =>
    clothColors[Math.min(clothColors.length - 1, Math.floor(v * clothColors.length))]
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const h1 = (s: number): number => hash2(col * 31 + s, row * 17 + 5)
      const wx = col * CELL + 15 + (h1(1) - 0.5) * 5
      const wy = row * CELL + 19 + (h1(2) - 0.5) * 5
      const ww = 34 + (h1(3) - 0.5) * 4
      const wh = 36 + (h1(4) - 0.5) * 4
      // dark indigo-brown window, slightly varied, slight jitter
      ctx.fillStyle = rgba(mixRgb(winA, winB, h1(5)), 0.92)
      ctx.fillRect(wx, wy, ww, wh)
      // ~1 in 4 windows glow warm amber (soft inner gradient + light spill)
      if (h1(6) < 0.26) {
        const lg = ctx.createLinearGradient(0, wy, 0, wy + wh)
        lg.addColorStop(0, rgba(litCore, 0.95))
        lg.addColorStop(0.55, rgba(litCore, 0.8))
        lg.addColorStop(1, 'rgba(214,158,88,0.55)')
        ctx.fillStyle = lg
        ctx.fillRect(wx + 2.5, wy + 2.5, ww - 5, wh - 5)
        softBlotch(ctx, wx + ww / 2, wy + wh * 0.35, ww * 0.55, litCore, 0.22)
      }
      // painted sill + weather streak under the window (clamped inside the tile)
      ctx.fillStyle = 'rgba(214,196,160,0.75)'
      ctx.fillRect(wx - 2, wy + wh, ww + 4, 2.5)
      const stTop = wy + wh + 3
      const stBot = Math.min(stTop + 12, S - 3)
      if (stBot > stTop + 2) {
        const stg = ctx.createLinearGradient(0, stTop, 0, stBot)
        stg.addColorStop(0, 'rgba(139,113,82,0.2)')
        stg.addColorStop(1, 'rgba(139,113,82,0)')
        ctx.fillStyle = stg
        ctx.fillRect(wx + 3, stTop, ww - 6, stBot - stTop)
      }
      // occasional balcony: horizontal ledge + vertical railing bars
      if (h1(7) < 0.2) {
        const ledgeY = Math.min(wy + wh + 1, S - 4)
        ctx.fillStyle = 'rgba(107,90,72,0.85)'
        ctx.fillRect(wx - 6, ledgeY, ww + 12, 3.5)
        ctx.strokeStyle = 'rgba(84,70,56,0.55)'
        ctx.lineWidth = 1.4
        for (let b = 0; b < 4; b++) {
          const bx = wx - 4 + (b * (ww + 8)) / 3
          ctx.beginPath()
          ctx.moveTo(bx, ledgeY - 14)
          ctx.lineTo(bx, ledgeY)
          ctx.stroke()
        }
      }
      // occasional hanging cloth line to the next window in the row
      if (col < 3 && h1(8) < 0.18) {
        const nx = (col + 1) * CELL + 15 + (hash2((col + 1) * 31 + 1, row * 17 + 5) - 0.5) * 5
        const ny = row * CELL + 19 + (hash2((col + 1) * 31 + 2, row * 17 + 5) - 0.5) * 5 + 14
        const y0 = wy + 14
        const midX = (wx + ww + nx) / 2
        const midY = (y0 + ny) / 2 + 6 // sag
        ctx.strokeStyle = 'rgba(74,63,56,0.5)'
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.moveTo(wx + ww, y0)
        ctx.quadraticCurveTo(midX, midY, nx, ny)
        ctx.stroke()
        // 2-3 tiny cloth rectangles hanging from the line
        const nCloth = 2 + Math.floor(h1(9) * 2)
        for (let q = 0; q < nCloth; q++) {
          const t = 0.25 + (q * 0.5) / Math.max(1, nCloth - 1) + (h1(10 + q) - 0.5) * 0.12
          const u = 1 - t
          const lx = u * u * (wx + ww) + 2 * u * t * midX + t * t * nx
          const ly = u * u * y0 + 2 * u * t * midY + t * t * ny
          ctx.save()
          ctx.translate(lx, ly + 1)
          ctx.rotate((h1(13 + q) - 0.5) * 0.3)
          ctx.fillStyle = rgba(clothAt(h1(16 + q)), 0.85)
          ctx.fillRect(-2.5, 0, 5, 7.5)
          ctx.restore()
        }
      }
    }
  }

  // -- rooftop clutter along the top edge (occasional silhouettes) --------
  const tankPaint = (x: number, y: number, w: number, h: number): void => {
    ctx.fillStyle = 'rgba(66,56,47,0.85)'
    buildJitteredPath(ctx, rng, roundedRectPoints(x, y, w, h, 4, 8), 0.8, 10, true)
    ctx.fill()
    ctx.strokeStyle = 'rgba(240,222,188,0.3)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(x + 2, y + 1.2)
    ctx.lineTo(x + w - 2, y + 0.8)
    ctx.stroke()
  }
  tankPaint(28 + hash2(3, 91) * 36, 3, 26, 12) // water tank
  tankPaint(168 + hash2(5, 47) * 40, 4, 18, 10) // smaller tank
  const acX = 96 + hash2(9, 13) * 40 // AC unit with vent slats
  ctx.fillStyle = 'rgba(84,72,60,0.85)'
  ctx.fillRect(acX, 5, 15, 9)
  ctx.strokeStyle = 'rgba(40,33,27,0.5)'
  ctx.lineWidth = 1
  for (let v = 0; v < 3; v++) {
    ctx.beginPath()
    ctx.moveTo(acX + 2, 7.5 + v * 2.2)
    ctx.lineTo(acX + 13, 7.5 + v * 2.2)
    ctx.stroke()
  }

  addGrain(ctx, mulberry32(0x616263), S, S, 700)
  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 8. Leaf — gulmohar canopy colour mass (tiling)                     */
/* ------------------------------------------------------------------ */

export function makeLeafTexture(): THREE.CanvasTexture {
  const S = 256
  const { canvas, ctx } = makeCanvas(S, S)
  const rng = mulberry32(0x90f1a2)

  ctx.fillStyle = '#e8532f'
  ctx.fillRect(0, 0, S, S)

  // 900 blossom speckles (wrapped only where near an edge, for speed)
  const speckColors = [hexToRgb('#c93b1f'), hexToRgb('#f2703f'), hexToRgb('#ff8a4d')]
  for (let i = 0; i < 900; i++) {
    const x = rng() * S
    const y = rng() * S
    const r0 = rand(rng, 2, 7)
    const col = pick(rng, speckColors)
    const a = rand(rng, 0.25, 0.5)
    for (const [wx, wy] of wrapPositions(x, y, r0, S, S)) {
      if (r0 >= 4) {
        softBlotch(ctx, wx, wy, r0, col, a)
      } else {
        ctx.fillStyle = rgba(col, a)
        ctx.beginPath()
        ctx.arc(wx, wy, r0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // a few darker branch hints, thin curves
  wrapDraw(ctx, S, S, (c) => {
    const r = mulberry32(0x3a2b11)
    c.strokeStyle = 'rgba(122,42,18,0.2)'
    c.lineWidth = 2.5
    c.lineCap = 'round'
    for (let i = 0; i < 5; i++) {
      const x1 = r() * S
      const y1 = r() * S
      const x2 = x1 + rand(r, -140, 140)
      const y2 = y1 + rand(r, -140, 140)
      const cx = (x1 + x2) / 2 + rand(r, -50, 50)
      const cy = (y1 + y2) / 2 + rand(r, -50, 50)
      buildJitteredPath(c, r, quadPoints(x1, y1, cx, cy, x2, y2, 5), 2, 20, false)
      c.stroke()
    }
  })

  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 9. Leaf alpha — leafy holes pattern for dappled shadows (tiling)   */
/* ------------------------------------------------------------------ */

export function makeLeafAlphaTexture(): THREE.CanvasTexture {
  const S = 256
  const { canvas, ctx } = makeCanvas(S, S)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, S, S)

  const black: RGB = [0, 0, 0]
  wrapDraw(ctx, S, S, (c) => {
    const r = mulberry32(0xa17a1e) // re-seeded per pass → identical wrapped copies
    // 26 clustered soft holes around 5 cluster centres (~30% punched coverage)
    const clusterCounts = [6, 5, 5, 5, 5]
    for (let cluster = 0; cluster < clusterCounts.length; cluster++) {
      const cx = r() * S
      const cy = r() * S
      for (let b = 0; b < clusterCounts[cluster]; b++) {
        softBlotch(
          c,
          cx + rand(r, -38, 38),
          cy + rand(r, -38, 38),
          rand(r, 7, 20),
          black,
          rand(r, 0.75, 1),
        )
      }
    }
    // 40 tiny speck holes
    for (let i = 0; i < 40; i++) {
      const a = rand(r, 0.75, 1)
      c.fillStyle = `rgba(0,0,0,${a})`
      c.beginPath()
      c.arc(r() * S, r() * S, rand(r, 2, 4), 0, Math.PI * 2)
      c.fill()
    }
  })

  return finishTexture(canvas, true)
}

/* ------------------------------------------------------------------ */
/* 10. Tuft — grass tuft sprite                                       */
/* ------------------------------------------------------------------ */

export function makeTuftTexture(): THREE.CanvasTexture {
  const S = 128
  const { canvas, ctx } = makeCanvas(S, S)
  const rng = mulberry32(0x7adf5)

  const cA = hexToRgb('#6e8c46')
  const cB = hexToRgb('#93ac5e')
  const N = 9

  for (let i = 0; i < 8; i++) {
    const col = mixRgb(cA, cB, rng())
    const baseX = 64 + rand(rng, -6, 6)
    const baseY = 124
    const tipX = 64 + rand(rng, -46, 46)
    const tipY = rand(rng, 10, 52)
    const ctrlX = baseX + (tipX - baseX) * 0.25 + rand(rng, -18, 18)
    const ctrlY = baseY - rand(rng, 34, 64)

    // curved tapered blade: quadratic spine, width 5 → 1 px
    const left: Pt[] = []
    const right: Pt[] = []
    for (let s = 0; s <= N; s++) {
      const t = s / N
      const u = 1 - t
      const x = u * u * baseX + 2 * u * t * ctrlX + t * t * tipX
      const y = u * u * baseY + 2 * u * t * ctrlY + t * t * tipY
      const tx = 2 * u * (ctrlX - baseX) + 2 * t * (tipX - ctrlX)
      const ty = 2 * u * (ctrlY - baseY) + 2 * t * (tipY - ctrlY)
      const tl = Math.hypot(tx, ty) || 1
      const nx = -ty / tl
      const ny = tx / tl
      const wHalf = (5 + (1 - 5) * t) * 0.5
      left.push([x + nx * wHalf, y + ny * wHalf])
      right.push([x - nx * wHalf, y - ny * wHalf])
    }

    ctx.fillStyle = rgba(col, 0.96)
    ctx.beginPath()
    ctx.moveTo(left[0][0], left[0][1])
    for (let s = 1; s <= N; s++) ctx.lineTo(left[s][0], left[s][1])
    for (let s = N; s >= 0; s--) ctx.lineTo(right[s][0], right[s][1])
    ctx.closePath()
    ctx.fill()

    // highlight edge on 3 of the 8 blades
    if (i % 3 === 0) {
      ctx.strokeStyle = '#b3c47a'
      ctx.lineWidth = 1.2
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(left[1][0], left[1][1])
      for (let s = 2; s < N; s++) ctx.lineTo(left[s][0], left[s][1])
      ctx.stroke()
    }
  }

  return finishTexture(canvas, false)
}

/* ------------------------------------------------------------------ */
/* 11. Petal — one gulmohar petal                                     */
/* ------------------------------------------------------------------ */

export function makePetalTexture(): THREE.CanvasTexture {
  const S = 64
  const { canvas, ctx } = makeCanvas(S, S)
  const rng = mulberry32(0x9e41a7)

  // rounded-pointed oval, tip up
  ctx.beginPath()
  ctx.moveTo(32 + rand(rng, -1, 1), 58)
  ctx.bezierCurveTo(20, 54, 13, 36, 24, 18)
  ctx.bezierCurveTo(28, 11, 31, 8, 32, 5)
  ctx.bezierCurveTo(33, 8, 36, 11, 40, 18)
  ctx.bezierCurveTo(51, 36, 44, 54, 32, 58)
  ctx.closePath()
  const g = ctx.createRadialGradient(32, 36, 4, 32, 36, 30)
  g.addColorStop(0, '#e8532f')
  g.addColorStop(0.65, '#e8532f')
  g.addColorStop(1, '#c93b1f')
  ctx.fillStyle = g
  ctx.fill()

  // tiny lighter streak
  ctx.strokeStyle = '#ff9a6b'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(27, 44)
  ctx.quadraticCurveTo(25, 34, 28, 26)
  ctx.stroke()

  return finishTexture(canvas, false)
}

/* ------------------------------------------------------------------ */
/* 12. Dot — soft round warm dot                                      */
/* ------------------------------------------------------------------ */

export function makeDotTexture(): THREE.CanvasTexture {
  const S = 64
  const { canvas, ctx } = makeCanvas(S, S)
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30)
  g.addColorStop(0, 'rgba(255,242,220,1)')
  g.addColorStop(0.45, 'rgba(255,242,220,0.6)')
  g.addColorStop(1, 'rgba(255,242,220,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  return finishTexture(canvas, false)
}

/* ------------------------------------------------------------------ */
/* 13. Crowd — one painted spectator silhouette (from behind)         */
/* ------------------------------------------------------------------ */

export function makeCrowdTexture(): THREE.CanvasTexture {
  const S = 128
  const { canvas, ctx } = makeCanvas(S, S)
  const rng = mulberry32(0xc120d5)
  const body = 'rgba(64,48,40,0.95)'
  const outline = 'rgba(40,30,24,0.55)'

  ctx.lineJoin = 'round'

  // head — jittered circle
  const head = new Path2D()
  buildJitteredPath(
    head,
    rng,
    circlePoints(64 + rand(rng, -2, 2), 40, 15, 14),
    1.5,
    12,
    true,
  )
  ctx.fillStyle = body
  ctx.fill(head)
  ctx.strokeStyle = outline
  ctx.lineWidth = 1.5
  ctx.stroke(head)

  // shoulders blob + hint of torso — jittered rounded silhouette
  const torsoPts: readonly Pt[] = [
    [38, 64], [33, 78], [34, 96], [40, 112], [52, 121], [68, 123],
    [84, 119], [93, 106], [95, 88], [92, 70], [80, 59], [64, 60], [50, 58],
  ]
  const torso = new Path2D()
  buildJitteredPath(torso, rng, torsoPts, 2, 12, true)
  ctx.fill(torso)
  ctx.stroke(torso)

  // a few lighter clothing patches, clipped inside the torso
  ctx.save()
  ctx.clip(torso)
  const shirts: readonly string[] = ['#b98a5a', '#7a8a96', '#a86848']
  for (let i = 0; i < shirts.length; i++) {
    ctx.fillStyle = shirts[i]
    ctx.globalAlpha = 0.35
    ctx.beginPath()
    ctx.ellipse(
      46 + i * 18 + rand(rng, -4, 4),
      86 + rand(rng, -8, 8),
      rand(rng, 10, 16),
      rand(rng, 12, 20),
      rand(rng, -0.4, 0.4),
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()

  return finishTexture(canvas, false)
}

/* ------------------------------------------------------------------ */
/* 14. Name tag — handwritten player label (async: font load)         */
/* ------------------------------------------------------------------ */

export async function makeNameTagTexture(name: string, color: string): Promise<THREE.CanvasTexture> {
  const W = 256
  const H = 64
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = mulberry32(0x4a6e7)

  // best-effort load of the handwriting font (falls back to generic cursive)
  await document.fonts.load('700 34px Caveat').catch(() => {})

  let fontSize = 34
  ctx.font = `700 ${fontSize}px Caveat, cursive`
  let m = ctx.measureText(name)
  const maxTextW = 208
  if (m.width > maxTextW) {
    fontSize = Math.max(13, Math.floor((fontSize * maxTextW) / m.width))
    ctx.font = `700 ${fontSize}px Caveat, cursive`
    m = ctx.measureText(name)
  }
  const tw = Math.max(24, m.width)

  // soft pill behind the name, with a hand-jittered border in the team colour
  const pw = Math.min(W - 8, tw + 36)
  const ph = 46
  const px0 = (W - pw) / 2
  const py0 = (H - ph) / 2
  const pill = new Path2D()
  buildJitteredPath(pill, rng, roundedRectPoints(px0, py0, pw, ph, 19, 12), 0.8, 12, true)
  ctx.save()
  ctx.shadowColor = 'rgba(251,243,226,0.6)'
  ctx.shadowBlur = 8
  ctx.fillStyle = 'rgba(251,243,226,0.55)'
  ctx.fill(pill)
  ctx.restore()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke(pill)

  // the name, centred, slightly rotated
  ctx.save()
  ctx.translate(W / 2, H / 2 + 1)
  ctx.rotate((-2 * Math.PI) / 180)
  ctx.fillStyle = '#2f2823'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 0, 0)
  ctx.restore()

  // short colour underline swash (thick → thin)
  const swLen = Math.min(76, tw * 0.6 + 16)
  const sx0 = W / 2 - swLen / 2
  const sx1 = W / 2 + swLen / 2
  const sy = py0 + ph - 6
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(sx0, sy)
  ctx.quadraticCurveTo((sx0 + sx1) / 2, sy + 3, sx1, sy - 1)
  ctx.lineTo(sx1 - 1.5, sy - 3.5)
  ctx.quadraticCurveTo((sx0 + sx1) / 2, sy - 0.5, sx0 + 2.5, sy - 3)
  ctx.closePath()
  ctx.fill()

  return finishTexture(canvas, false)
}
