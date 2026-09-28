/**
 * Distant skyline — two rings of painted canvas strip-billboards arranged as a
 * cylindrical panorama around the ground.
 *
 *   inner ring  r≈260 · 9 segments · ~189 m wide · 55 m tall — detailed Indian
 *               gully silhouettes (apartment blocks with amber lit windows,
 *               water tanks, antennas, rooftop billboards) + landmarks: a
 *               stepped temple gopuram, a mosque dome + minaret, a construction
 *               crane
 *   outer ring  r≈340 · 8 segments · ~282 m wide · 70 m tall — flatter, duskier
 *               two-tone silhouettes (density toggle + quality gate)
 *
 * Segments fade to the fog colour at their side edges (source-atop gradient),
 * so adjacent strips melt into each other through the haze. MeshBasicMaterial +
 * alphaTest keeps them in the opaque pass with correct depth; scene fog
 * (84→385) tints the rings by distance, sitting them inside the shader sky
 * dome (r 460) and behind the 24 mid-ground 3D buildings (r 112–200).
 *
 * Golden-hour logic: segments facing the sun (east) are backlit dusk plum with
 * sparse lit windows; segments facing away catch a warm front light — matching
 * toon.ts's key light direction.
 */
import * as THREE from 'three'
import { PALETTE, type Quality } from '../core/constants'
import { makeRng } from '../core/math'

export interface SkylineModule {
  readonly group: THREE.Group
  /** Antenna-warning-light blink (slightly faster in gusts). */
  update(dt: number, elapsed: number, gust: number): void
  /** Density toggle — hides the far ring. */
  setDetail(on: boolean): void
  dispose(): void
}

const TEX_W = 1024
const TEX_H = 320
const FOG = PALETTE.fog

/** toon.ts key light at progress 0: (1, 0.36, 0.42) → xz. */
const SUN_XZ: [number, number] = [0.922, 0.388]

/* ------------------------------------------------------------------ */
/* tiny colour helpers (canvas strings)                                */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbStr(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const k = Math.max(0, Math.min(1, t))
  return rgbStr(ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k)
}

function shade(hex: string, k: number): string {
  const c = hexToRgb(hex)
  return rgbStr(c[0] * k, c[1] * k, c[2] * k)
}

/* ------------------------------------------------------------------ */
/* painters                                                            */
/* ------------------------------------------------------------------ */

/** Solid haze band with a hand-jittered top edge (kept ≥ alpha 0.9 for alphaTest). */
function paintHaze(ctx: CanvasRenderingContext2D, top: number, alpha: number, rng: () => number): void {
  ctx.globalAlpha = alpha
  ctx.fillStyle = mixHex(FOG, '#e9d0a6', 0.35)
  let x = 0
  while (x < TEX_W) {
    const w = 26 + rng() * 44
    const bump = rng() * 10
    ctx.fillRect(x, top - bump, w + 2, TEX_H - top + bump + 4)
    x += w
  }
  ctx.globalAlpha = 1
}

interface Tip {
  x: number
  y: number
}

/** One apartment block; returns its antenna tip if it grew one. */
function paintBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  w: number,
  h: number,
  groundY: number,
  rng: () => number,
  warm: number,
  detailed: boolean,
  wantTip: boolean,
): Tip | null {
  const body = mixHex(mixHex('#584450', '#6d565c', rng()), '#97705a', warm * 0.75 + rng() * 0.12)
  const g = ctx.createLinearGradient(0, groundY - h, 0, groundY)
  g.addColorStop(0, body)
  g.addColorStop(1, shade(body, 0.76))
  ctx.fillStyle = g
  ctx.fillRect(x, groundY - h, w, h)

  // parapet notches — the flat-roof read
  ctx.fillStyle = body
  for (let nx = x + 5; nx < x + w - 12; nx += 16 + rng() * 24) {
    ctx.fillRect(nx, groundY - h - 5 - rng() * 4, 9 + rng() * 9, 7)
  }

  // windows
  if (detailed) {
    const cols = Math.max(2, Math.floor((w - 14) / 13))
    const rows = Math.max(2, Math.floor((h - 24) / 17))
    const stepX = (w - 16) / cols
    const stepY = (h - 22) / rows
    const litP = 0.16 + warm * 0.22
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (rng() < 0.08) continue // missing window / balcony gap
        const wx = x + 8 + c * stepX
        const wy = groundY - h + 9 + r * stepY
        if (rng() < litP) {
          ctx.fillStyle = rng() < 0.5 ? '#ffc266' : rng() < 0.5 ? '#ffd68a' : '#ff9e4d'
          ctx.fillRect(wx, wy, 6, 9)
          if (rng() < 0.3) {
            ctx.fillStyle = '#ffe9b0'
            ctx.fillRect(wx + 1.5, wy + 2, 3, 4)
          }
        } else {
          ctx.fillStyle = mixHex('#453743', '#6a5348', warm * 0.5)
          ctx.fillRect(wx, wy, 6, 9)
        }
      }
    }
  } else {
    // far ring: sparse faint dots
    const n = Math.floor((w * h) / 2600)
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(200,160,120,0.55)'
      ctx.fillRect(x + 6 + rng() * (w - 12), groundY - h + 8 + rng() * (h - 20), 4, 5)
    }
  }

  // rooftop furniture
  const roofY = groundY - h
  let tip: Tip | null = null
  if (rng() < 0.32) {
    // black sintex-style water tank
    const tx = x + 8 + rng() * Math.max(4, w - 30)
    ctx.fillStyle = mixHex('#3c363c', '#5a4a48', warm * 0.6)
    ctx.fillRect(tx, roofY - 15, 17, 12)
    ctx.beginPath()
    ctx.ellipse(tx + 8.5, roofY - 15, 8.5, 3.2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(tx + 2, roofY - 3, 2, 3)
    ctx.fillRect(tx + 13, roofY - 3, 2, 3)
  }
  if (rng() < 0.38) {
    // antenna (records its tip for a blink light)
    const ax = x + 10 + rng() * Math.max(4, w - 20)
    const ah = 20 + rng() * 30
    ctx.strokeStyle = mixHex('#3f3438', '#6b534a', warm * 0.5)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(ax, roofY)
    ctx.lineTo(ax, roofY - ah)
    ctx.stroke()
    ctx.lineWidth = 1
    for (let by = 6; by < ah - 4; by += 7) {
      ctx.beginPath()
      ctx.moveTo(ax - 4, roofY - by)
      ctx.lineTo(ax + 4, roofY - by - 3)
      ctx.stroke()
    }
    if (wantTip && ah > 34) tip = { x: ax, y: roofY - ah }
  }
  if (detailed && rng() < 0.2) {
    // rooftop billboard — pale internally-lit panel
    const bx = x + 12 + rng() * Math.max(4, w - 56)
    ctx.fillStyle = '#4a3c40'
    ctx.fillRect(bx, roofY - 22, 38, 15)
    ctx.fillStyle = mixHex('#f0e0b8', '#ffd9a0', rng() * 0.4)
    ctx.fillRect(bx + 2, roofY - 20, 34, 11)
    ctx.fillStyle = '#4a3c40'
    ctx.fillRect(bx + 17, roofY - 7, 3, 7)
  }
  return tip
}

/** Stepped temple gopuram. */
function paintGopuram(ctx: CanvasRenderingContext2D, cx: number, groundY: number, scale: number, rng: () => number, warm: number): void {
  const tone = mixHex('#8a7050', '#a8865e', warm * 0.7 + rng() * 0.15)
  let w = 120 * scale
  let y = groundY
  let tier = 42 * scale
  for (let t = 0; t < 5; t++) {
    ctx.fillStyle = t % 2 === 0 ? tone : shade(tone, 0.88)
    ctx.beginPath()
    ctx.moveTo(cx - w / 2, y)
    ctx.lineTo(cx + w / 2, y)
    ctx.lineTo(cx + w / 2 - w * 0.09, y - tier)
    ctx.lineTo(cx - w / 2 + w * 0.09, y - tier)
    ctx.closePath()
    ctx.fill()
    // tiny shrine windows
    ctx.fillStyle = mixHex('#ffc266', '#ff9e4d', rng())
    const nWin = Math.max(1, Math.floor(w / 34))
    for (let i = 0; i < nWin; i++) {
      if (rng() < 0.5) ctx.fillRect(cx - w / 2 + 8 + (i * (w - 16)) / nWin, y - tier * 0.62, 5, 7)
    }
    y -= tier
    w *= 0.76
    tier *= 0.86
  }
  // kalasha finial
  ctx.fillStyle = shade(tone, 1.15)
  ctx.beginPath()
  ctx.ellipse(cx, y - 8, 7, 9, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(cx - 1.5, y - 22, 3, 14)
}

/** Mosque: onion dome + minaret. */
function paintMosque(ctx: CanvasRenderingContext2D, cx: number, groundY: number, scale: number, rng: () => number, warm: number): void {
  const tone = mixHex('#6d5a64', '#94705e', warm * 0.7)
  const bodyW = 110 * scale
  const bodyH = 64 * scale
  ctx.fillStyle = tone
  ctx.fillRect(cx - bodyW / 2, groundY - bodyH, bodyW, bodyH)
  // sparse lit windows
  ctx.fillStyle = '#ffcf87'
  for (let i = 0; i < 5; i++) {
    if (rng() < 0.6) ctx.fillRect(cx - bodyW / 2 + 12 + i * 20, groundY - bodyH + 14, 6, 10)
  }
  // onion dome
  const dy = groundY - bodyH
  const dw = bodyW * 0.52
  ctx.fillStyle = shade(tone, 1.12)
  ctx.beginPath()
  ctx.moveTo(cx - dw / 2, dy)
  ctx.bezierCurveTo(cx - dw / 2 - 6, dy - 14 * scale, cx - dw * 0.22, dy - 26 * scale, cx - dw * 0.22, dy - 34 * scale)
  ctx.bezierCurveTo(cx - dw * 0.22, dy - 46 * scale, cx + dw * 0.22, dy - 46 * scale, cx + dw * 0.22, dy - 34 * scale)
  ctx.bezierCurveTo(cx + dw * 0.22, dy - 26 * scale, cx + dw / 2 + 6, dy - 14 * scale, cx + dw / 2, dy)
  ctx.closePath()
  ctx.fill()
  ctx.fillRect(cx - 1.5, dy - 52 * scale, 3, 12 * scale)
  // minaret
  const mx = cx + bodyW / 2 + 16 * scale
  const mh = 118 * scale
  ctx.fillStyle = tone
  ctx.fillRect(mx - 6, groundY - mh, 12, mh)
  ctx.fillStyle = shade(tone, 1.1)
  ctx.fillRect(mx - 11, groundY - mh + 16 * scale, 22, 5) // balcony
  ctx.beginPath()
  ctx.ellipse(mx, groundY - mh - 7 * scale, 8, 10, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(mx - 1.5, groundY - mh - 20 * scale, 3, 14 * scale)
}

/** Construction crane silhouette. */
function paintCrane(ctx: CanvasRenderingContext2D, cx: number, groundY: number, scale: number, warm: number): void {
  const col = mixHex('#574b52', '#7d6154', warm * 0.6)
  ctx.strokeStyle = col
  ctx.fillStyle = col
  const mh = 190 * scale
  const topY = groundY - mh
  // mast (tapering lattice)
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(cx - 7, groundY)
  ctx.lineTo(cx - 2.5, topY)
  ctx.moveTo(cx + 7, groundY)
  ctx.lineTo(cx + 2.5, topY)
  ctx.stroke()
  ctx.lineWidth = 1.2
  for (let y = groundY; y > topY; y -= 16 * scale) {
    const frac = (groundY - y) / mh
    const halfW = 2.5 + (7 - 2.5) * frac
    ctx.beginPath()
    ctx.moveTo(cx - halfW, y)
    ctx.lineTo(cx + halfW, y - 8 * scale)
    ctx.moveTo(cx + halfW, y)
    ctx.lineTo(cx - halfW, y - 8 * scale)
    ctx.stroke()
  }
  // jib + counter-jib
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.moveTo(cx - 62 * scale, topY + 3)
  ctx.lineTo(cx + 150 * scale, topY + 9)
  ctx.stroke()
  // apex + tie lines
  ctx.beginPath()
  ctx.moveTo(cx, topY)
  ctx.lineTo(cx, topY - 26 * scale)
  ctx.stroke()
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx, topY - 26 * scale)
  ctx.lineTo(cx + 146 * scale, topY + 9)
  ctx.moveTo(cx, topY - 26 * scale)
  ctx.lineTo(cx - 58 * scale, topY + 3)
  ctx.stroke()
  // hook line + hook
  ctx.beginPath()
  ctx.moveTo(cx + 104 * scale, topY + 9)
  ctx.lineTo(cx + 104 * scale, topY + 52 * scale)
  ctx.stroke()
  ctx.fillRect(cx + 100 * scale, topY + 52 * scale, 8, 6)
  // counterweight
  ctx.fillRect(cx - 60 * scale, topY + 6, 16, 12)
}

/** Paint one skyline strip. Returns candidate blink-light antenna tips. */
function paintSegment(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  warm: number,
  detailed: boolean,
  landmark: 'none' | 'gopuram' | 'mosque' | 'crane',
): Tip[] {
  const groundY = TEX_H - 6
  const tips: Tip[] = []

  paintHaze(ctx, TEX_H - (detailed ? 58 : 72), 0.92, rng)

  if (landmark === 'gopuram') paintGopuram(ctx, TEX_W * 0.34, groundY, 1.35, rng, warm)
  if (landmark === 'mosque') paintMosque(ctx, TEX_W * 0.4, groundY, 1.3, rng, warm)
  if (landmark === 'crane') paintCrane(ctx, TEX_W * 0.62, groundY, 1.25, warm)

  let x = -18
  let guard = 0
  while (x < TEX_W - 24 && guard++ < 18) {
    const w = detailed ? 64 + rng() * 108 : 110 + rng() * 150
    const maxH = TEX_H * (detailed ? 0.82 : 0.9)
    const nearLandmark = landmark !== 'none' && Math.abs(x + w / 2 - TEX_W * 0.38) < w * 0.7 + 90
    let h = maxH * (0.3 + rng() * 0.68)
    if (nearLandmark) h *= 0.55 // landmarks own the sky
    const tip = paintBlock(ctx, x, w, h, groundY, rng, warm, detailed, tips.length < 2)
    if (tip) tips.push(tip)
    x += w + (detailed ? 6 + rng() * 26 : 14 + rng() * 42)
  }

  // seat the bases in haze
  ctx.globalAlpha = 0.72
  ctx.fillStyle = mixHex(FOG, '#e9d0a6', 0.3)
  let hx = 0
  while (hx < TEX_W) {
    const w = 30 + rng() * 50
    ctx.fillRect(hx, groundY - 26 - rng() * 8, w + 2, 40)
    hx += w
  }
  ctx.globalAlpha = 1

  // side-edge melt to the fog colour so adjacent segments blend through haze
  const EW = detailed ? 84 : 130
  ctx.globalCompositeOperation = 'source-atop'
  for (const [x0, x1] of [[0, EW], [TEX_W, TEX_W - EW]] as const) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0)
    g.addColorStop(0, 'rgba(242,221,190,1)')
    g.addColorStop(1, 'rgba(242,221,190,0)')
    ctx.fillStyle = g
    ctx.fillRect(Math.min(x0, x1), 0, EW, TEX_H)
  }
  ctx.globalCompositeOperation = 'source-over'

  return tips
}

/* ------------------------------------------------------------------ */
/* module                                                              */
/* ------------------------------------------------------------------ */

interface RingSpec {
  radius: number
  segments: number
  height: number
  detailed: boolean
}

export function createSkyline(quality: Quality): SkylineModule {
  const group = new THREE.Group()
  const farAllowed = quality !== 'low'
  const textures: THREE.CanvasTexture[] = []
  const materials: THREE.MeshBasicMaterial[] = []
  const geometries: THREE.PlaneGeometry[] = []
  const blinkLights: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }> = []

  const ringGroup = (spec: RingSpec, landmarks: Array<'none' | 'gopuram' | 'mosque' | 'crane'>): THREE.Group => {
    const ring = new THREE.Group()
    const width = 2 * spec.radius * Math.tan(Math.PI / spec.segments)
    for (let i = 0; i < spec.segments; i++) {
      const a = (i / spec.segments) * Math.PI * 2 + 0.18
      // outward normal faces the sun → backlit; away → warm front light
      const warm = Math.max(0, Math.min(1, 0.5 - 0.5 * (Math.cos(a) * SUN_XZ[0] + Math.sin(a) * SUN_XZ[1])))
      const canvas = document.createElement('canvas')
      canvas.width = TEX_W
      canvas.height = TEX_H
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const rng = makeRng(0x51c0 + i * 7919 + (spec.detailed ? 0 : 991))
      const tips = paintSegment(ctx, rng, warm, spec.detailed, landmarks[i % landmarks.length])

      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      tex.generateMipmaps = true
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      textures.push(tex)

      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        alphaTest: 0.35,
        fog: true,
        depthWrite: true,
      })
      materials.push(mat)

      const geo = new THREE.PlaneGeometry(width, spec.height)
      geometries.push(geo)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(Math.cos(a) * spec.radius, spec.height / 2, Math.sin(a) * spec.radius)
      mesh.lookAt(0, spec.height / 2, 0)
      mesh.renderOrder = -5
      ring.add(mesh)

      // blink lights on the tallest antenna tips (near ring only)
      if (spec.detailed && farAllowed && tips.length > 0 && blinkLights.length < 4) {
        const tip = tips[0]
        const lightMat = new THREE.MeshBasicMaterial({
          color: '#ff5040',
          transparent: true,
          opacity: 0.8,
          fog: false,
          depthWrite: false,
        })
        materials.push(lightMat)
        const lightGeo = new THREE.PlaneGeometry(1.05, 1.05)
        geometries.push(lightGeo)
        const light = new THREE.Mesh(lightGeo, lightMat)
        const local = new THREE.Vector3(
          (tip.x / TEX_W - 0.5) * width,
          (0.5 - tip.y / TEX_H) * spec.height + 0.6,
          0,
        )
        light.position.copy(mesh.localToWorld(local))
        light.lookAt(0, light.position.y, 0)
        light.renderOrder = 1
        ring.add(light)
        blinkLights.push({ mesh: light, mat: lightMat, phase: rng() * Math.PI * 2 })
      }
    }
    return ring
  }

  const nearRing = ringGroup(
    { radius: 260, segments: 9, height: 55, detailed: true },
    ['none', 'gopuram', 'none', 'none', 'none', 'mosque', 'none', 'crane', 'none'],
  )
  group.add(nearRing)

  const farRing = ringGroup({ radius: 340, segments: 8, height: 70, detailed: false }, ['none', 'none', 'none', 'none'])
  farRing.visible = farAllowed
  group.add(farRing)

  return {
    group,
    update(_dt: number, elapsed: number, gust: number): void {
      const rate = 1.9 + gust * 1.6
      for (const l of blinkLights) {
        const b = Math.sin(elapsed * rate + l.phase)
        l.mat.opacity = b > 0.05 ? 0.35 + 0.6 * Math.min(1, (b - 0.05) / 0.35) : 0.1
      }
    },
    setDetail(on: boolean) {
      farRing.visible = on && farAllowed
    },
    dispose() {
      for (const t of textures) t.dispose()
      for (const m of materials) m.dispose()
      for (const g of geometries) g.dispose()
      group.clear()
    },
  }
}
