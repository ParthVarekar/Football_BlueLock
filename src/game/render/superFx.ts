/**
 * EGO super moves — the 3D half. Everything is built from the same kit as the
 * rest of the maidan: patched toon materials, inverted-hull ink outlines,
 * hand-painted canvas textures. No emissive glow, no additive neon.
 *
 *  - Crimson Dragon: a serpentine toon dragon (jaw, horns, mane, whiskers,
 *    four clawed legs, finned spine) coiling round the ball, then carrying it
 *    in its jaws along the homing curve
 *  - Mountain Bastion: jagged rock peaks with painted strata that heave out
 *    of a cracked-ink scar in the turf
 *  - Eagle Talon: a golden spirit eagle that dives in and carries you
 *  - Thunder Seal: ink-and-paper lightning, scorch splashes, paper talismans
 *    (封) orbiting sealed players over a glyph ring
 *  - Gulmohar Cyclone: brush-stroke funnel layers full of gulmohar petals
 */
import * as THREE from 'three'
import { type Quality, QUALITY, SUPER } from '../core/constants'
import { makeRng } from '../core/math'
import { bezierAt, bezierTangent, type Cyclone, cycloneStrength, type MountainWall, mountainScale } from '../sim/supers'
import { makeToonMaterial } from './toon'
import { addOutline } from './outline'
import { makePetalTexture } from './textures'

const INK = '#2f2823'

// ------------------------------------------------------------------ shared helpers

function outlined(mesh: THREE.Mesh, px: number): THREE.Mesh {
  addOutline(mesh, { widthPx: px })
  return mesh
}

function canvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d') as CanvasRenderingContext2D
  return { c, g }
}

function tex(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
  }
  t.needsUpdate = true
  return t
}

/** Hand-jittered ink crack network radiating from a centre line (ground scar). */
function makeCrackTexture(): THREE.CanvasTexture {
  const { c, g } = canvas(512, 256)
  const r = makeRng(0x5ca7)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  // soft umber bruise under the cracks
  const grd = g.createRadialGradient(256, 128, 10, 256, 128, 250)
  grd.addColorStop(0, 'rgba(90,60,40,0.55)')
  grd.addColorStop(0.6, 'rgba(90,60,40,0.18)')
  grd.addColorStop(1, 'rgba(90,60,40,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 512, 256)
  const crack = (x: number, y: number, a: number, len: number, w: number, depth: number): void => {
    g.strokeStyle = `rgba(47,40,35,${0.75 - depth * 0.15})`
    g.lineWidth = w
    g.beginPath()
    g.moveTo(x, y)
    let cx = x
    let cy = y
    const steps = 6
    for (let i = 0; i < steps; i++) {
      a += (r() - 0.5) * 0.9
      cx += Math.cos(a) * (len / steps)
      cy += Math.sin(a) * (len / steps)
      g.lineTo(cx, cy)
      if (depth < 2 && r() < 0.35) crack(cx, cy, a + (r() - 0.5) * 1.6, len * 0.5, w * 0.6, depth + 1)
    }
    g.stroke()
  }
  for (let i = 0; i < 22; i++) {
    const x = 40 + r() * 432
    crack(x, 128 + (r() - 0.5) * 20, r() < 0.5 ? -Math.PI / 2 : Math.PI / 2, 60 + r() * 60, 3 + r() * 2, 0)
  }
  g.strokeStyle = 'rgba(47,40,35,0.85)'
  g.lineWidth = 5
  g.beginPath()
  g.moveTo(24, 128)
  for (let x = 24; x <= 488; x += 22) g.lineTo(x, 128 + (r() - 0.5) * 14)
  g.stroke()
  return tex(c)
}

/** Ink splash for bolt strikes. */
function makeScorchTexture(): THREE.CanvasTexture {
  const { c, g } = canvas(256, 256)
  const r = makeRng(0x5c0c)
  g.fillStyle = 'rgba(47,40,35,0.8)'
  g.beginPath()
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2
    const rad = 52 + r() * 34 + (i % 3 === 0 ? 30 : 0)
    const x = 128 + Math.cos(a) * rad
    const y = 128 + Math.sin(a) * rad
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.fill()
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2
    const d = 95 + r() * 25
    g.beginPath()
    g.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 3 + r() * 6, 0, Math.PI * 2)
    g.fill()
  }
  // paper-bright burn in the middle
  g.fillStyle = 'rgba(246,212,106,0.85)'
  g.beginPath()
  g.arc(128, 128, 22, 0, Math.PI * 2)
  g.fill()
  return tex(c)
}

/** The seal ring: ink double circle with 封 glyphs and tick marks. */
function makeSealRingTexture(): THREE.CanvasTexture {
  const { c, g } = canvas(512, 512)
  g.translate(256, 256)
  g.strokeStyle = 'rgba(47,40,35,0.95)'
  g.lineWidth = 10
  g.beginPath()
  g.arc(0, 0, 236, 0, Math.PI * 2)
  g.stroke()
  g.lineWidth = 4
  g.beginPath()
  g.arc(0, 0, 196, 0, Math.PI * 2)
  g.stroke()
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2
    g.lineWidth = i % 4 === 0 ? 6 : 2
    g.beginPath()
    g.moveTo(Math.cos(a) * 200, Math.sin(a) * 200)
    g.lineTo(Math.cos(a) * 228, Math.sin(a) * 228)
    g.stroke()
  }
  g.fillStyle = 'rgba(47,40,35,0.95)'
  g.font = '64px "Yuji Syuku", "Yu Mincho", serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (let i = 0; i < 4; i++) {
    g.save()
    g.rotate((i / 4) * Math.PI * 2)
    g.fillText('封', 0, -150)
    g.restore()
  }
  // inner star
  g.lineWidth = 3
  g.beginPath()
  for (let i = 0; i <= 5; i++) {
    const a = (i * 2 * (Math.PI * 2)) / 5 - Math.PI / 2
    const x = Math.cos(a) * 110
    const y = Math.sin(a) * 110
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke()
  return tex(c)
}

/** Paper talisman (ofuda): cream strip, ink 封, vermilion seal stamp. */
function makeTalismanTexture(): THREE.CanvasTexture {
  const { c, g } = canvas(64, 192)
  g.fillStyle = '#f6ecd6'
  g.fillRect(0, 0, 64, 192)
  g.strokeStyle = '#2f2823'
  g.lineWidth = 3
  g.strokeRect(4, 4, 56, 184)
  g.fillStyle = '#2f2823'
  g.font = '44px "Yuji Syuku", "Yu Mincho", serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('雷', 32, 50)
  g.fillText('封', 32, 104)
  g.fillStyle = '#c93b1f'
  g.fillRect(18, 140, 28, 28)
  g.fillStyle = '#f6ecd6'
  g.fillRect(24, 146, 16, 16)
  return tex(c)
}

/** Brush-stroke streaks for the cyclone funnel (alpha, tiles horizontally). */
function makeCycloneTexture(seed: number, tint: [number, number, number]): THREE.CanvasTexture {
  const { c, g } = canvas(256, 512)
  const r = makeRng(seed)
  g.lineCap = 'round'
  for (let i = 0; i < 70; i++) {
    const x = r() * 256
    const y = r() * 512
    const len = 60 + r() * 160
    const w = 2 + r() * 9
    const ink = r() < 0.22
    const a = ink ? 0.55 : 0.18 + r() * 0.4
    g.strokeStyle = ink ? `rgba(47,40,35,${a})` : `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`
    g.lineWidth = ink ? Math.max(1.5, w * 0.35) : w
    for (const off of [-256, 0, 256]) {
      g.beginPath()
      g.moveTo(x + off, y)
      g.quadraticCurveTo(x + off + len * 0.5, y - len * 0.12, x + off + len, y - len * 0.3)
      g.stroke()
    }
  }
  return tex(c, true)
}

// ------------------------------------------------------------------ dragon

const DRAGON_SEGMENTS = 46
const SEG_LEN = 0.27

interface DragonState {
  root: THREE.Group
  head: THREE.Group
  jaw: THREE.Group
  segs: THREE.Mesh[]
  fins: Array<{ mesh: THREE.Object3D; seg: number }>
  legs: Array<{ group: THREE.Group; seg: number; side: number }>
  path: number[]
  flight: number
  castAt: number
  strikeAt: number
  /** Arc-length LUT over the bezier. */
  lut: Float32Array
  len: number
  endedAt: number
  startX: number
  startY: number
  startZ: number
}

// ------------------------------------------------------------------ eagle

interface EagleState {
  root: THREE.Group
  wingL: THREE.Group
  wingR: THREE.Group
  outerL: THREE.Group
  outerR: THREE.Group
  talons: THREE.Group
  seen: number
  fade: number
}

// ------------------------------------------------------------------ bolts

interface Bolt {
  group: THREE.Group
  born: number
  life: number
  scorch: THREE.Mesh | null
}

interface Seal {
  ring: THREE.Mesh
  strips: THREE.Mesh[]
  sparks: THREE.Group
  lastSpark: number
  seen: number
}

interface CycloneView {
  root: THREE.Group
  layers: THREE.Mesh[]
  petals: THREE.InstancedMesh
  petalData: Array<{ h: number; a: number; s: number; rf: number; size: number }>
  base: THREE.Mesh
}

export interface EagleView {
  /** Caster eye-ish position + facing. */
  x: number
  y: number
  z: number
  yaw: number
  /** 0..1 glide progress; >1 = releasing (pulling up). */
  u: number
}

export class SuperFx {
  private readonly scene: THREE.Scene
  private readonly px: number
  private readonly mats: Record<string, THREE.Material> = {}
  /** Geometry built once and shared by every cast (per-cast geometry is disposed with the cast). */
  private readonly shared = new Map<string, THREE.BufferGeometry>()
  private readonly texs: THREE.Texture[] = []
  private dragons = new Map<number, DragonState>()
  private walls = new Map<number, { group: THREE.Group; peaks: THREE.Group[]; heights: number[]; scar: THREE.Mesh }>()
  private eagles = new Map<string, EagleState>()
  private bolts: Bolt[] = []
  private seals = new Map<string, Seal>()
  private cyclones = new Map<number, CycloneView>()
  private readonly crackTex: THREE.CanvasTexture
  private readonly scorchTex: THREE.CanvasTexture
  private readonly sealTex: THREE.CanvasTexture
  private readonly stripTex: THREE.CanvasTexture
  private readonly petalTex: THREE.CanvasTexture
  private readonly cycloneTex: THREE.CanvasTexture[]
  private readonly tmp = { x: 0, y: 0, z: 0 }
  private readonly tmp2 = { x: 0, y: 0, z: 0 }
  private readonly v1 = new THREE.Vector3()
  private readonly v2 = new THREE.Vector3()
  private readonly m4 = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()

  constructor(scene: THREE.Scene, quality: Quality) {
    this.scene = scene
    this.px = QUALITY[quality].outlinePx
    const toon = (key: string, color: string, extra: Parameters<typeof makeToonMaterial>[0] = {}): THREE.Material => {
      const m = makeToonMaterial({ color, ...extra })
      this.mats[key] = m
      return m
    }
    toon('crimson', '#d4432b')
    toon('crimsonDeep', '#a52d1e')
    toon('cream', '#f3d9a8')
    toon('bone', '#f6ead2')
    toon('saffron', '#f28a2e')
    toon('gold', '#e9b73c')
    toon('umber', '#6b4a36')
    toon('umberDeep', '#3f2c22')
    toon('fawn', '#a47a52')
    toon('paper', '#fbf3e2')
    toon('rock', '#ffffff', { vertexColors: true })
    // faceted rock: flat normals per face (toon supports it at runtime; the typings omit it)
    ;(this.mats.rock as unknown as { flatShading: boolean }).flatShading = true
    this.mats.ink = new THREE.MeshBasicMaterial({ color: INK })
    this.mats.boltInk = new THREE.MeshBasicMaterial({ color: INK, side: THREE.DoubleSide })
    this.mats.boltCore = new THREE.MeshBasicMaterial({ color: '#fff4d2', side: THREE.DoubleSide })
    this.mats.boltGold = new THREE.MeshBasicMaterial({ color: '#f6d46a', side: THREE.DoubleSide })
    this.crackTex = makeCrackTexture()
    this.scorchTex = makeScorchTexture()
    this.sealTex = makeSealRingTexture()
    this.stripTex = makeTalismanTexture()
    this.petalTex = makePetalTexture()
    this.cycloneTex = [makeCycloneTexture(0xc1, [243, 230, 204]), makeCycloneTexture(0xc2, [201, 138, 58]), makeCycloneTexture(0xc3, [232, 83, 47])]
    this.texs.push(this.crackTex, this.scorchTex, this.sealTex, this.stripTex, this.petalTex, ...this.cycloneTex)
  }

  private sg(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.shared.get(key)
    if (!g) {
      g = make()
      this.shared.set(key, g)
    }
    return g
  }

  private isShared(g: THREE.BufferGeometry): boolean {
    for (const v of this.shared.values()) if (v === g) return true
    return false
  }

  private mesh(g: THREE.BufferGeometry, mat: string, outline = true): THREE.Mesh {
    const m = new THREE.Mesh(g, this.mats[mat])
    m.castShadow = true
    if (outline) outlined(m, this.px)
    return m
  }

  // ================================================================== DRAGON

  spawnDragon(key: number, path: number[], flight: number, castAt: number, strikeAt: number): void {
    this.endDragonNow(key)
    const root = new THREE.Group()
    root.renderOrder = 3
    // ---- head (built facing +Z; origin at the back of the skull)
    const head = new THREE.Group()
    const sph = this.sg('sph', () => new THREE.SphereGeometry(1, 14, 10))
    const skull = this.mesh(sph, 'crimson')
    skull.scale.set(0.42, 0.32, 0.46)
    skull.position.set(0, 0.08, 0)
    head.add(skull)
    const snout = this.mesh(sph, 'crimson')
    snout.scale.set(0.26, 0.18, 0.5)
    snout.position.set(0, 0.03, 0.48)
    head.add(snout)
    const nose = this.mesh(sph, 'crimsonDeep')
    nose.scale.set(0.2, 0.12, 0.14)
    nose.position.set(0, 0.12, 0.9)
    head.add(nose)
    // brow ridges + eyes (saffron iris, ink slit)
    for (const s of [-1, 1]) {
      const brow = this.mesh(sph, 'crimsonDeep')
      brow.scale.set(0.16, 0.07, 0.2)
      brow.position.set(s * 0.22, 0.3, 0.2)
      brow.rotation.z = s * 0.35
      head.add(brow)
      const eye = this.mesh(sph, 'saffron')
      eye.scale.setScalar(0.085)
      eye.position.set(s * 0.25, 0.2, 0.28)
      head.add(eye)
      const slit = new THREE.Mesh(sph, this.mats.ink)
      slit.scale.set(0.018, 0.07, 0.03)
      slit.position.set(s * 0.29, 0.2, 0.34)
      head.add(slit)
      // swept horns
      const horn = this.mesh(this.sg('horn', () => new THREE.ConeGeometry(0.075, 0.95, 7).translate(0, 0.475, 0)), 'bone')
      horn.position.set(s * 0.18, 0.3, -0.05)
      horn.rotation.set(-1.15, 0, -s * 0.35)
      head.add(horn)
      // nostril
      const nos = new THREE.Mesh(sph, this.mats.ink)
      nos.scale.setScalar(0.03)
      nos.position.set(s * 0.08, 0.18, 0.99)
      head.add(nos)
      // whiskers — long ink tubes trailing back
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(s * 0.14, 0.05, 0.92),
        new THREE.Vector3(s * 0.5, -0.05, 0.9),
        new THREE.Vector3(s * 0.85, 0.1, 0.3),
        new THREE.Vector3(s * 1.1, -0.1, -0.5),
      ])
      const whisk = new THREE.Mesh(this.sg(`whisker${s}`, () => new THREE.TubeGeometry(curve, 16, 0.022, 5)), this.mats.saffron)
      head.add(whisk)
    }
    // upper teeth
    for (let i = 0; i < 4; i++) {
      for (const s of [-1, 1]) {
        const tooth = new THREE.Mesh(this.sg('tooth', () => new THREE.ConeGeometry(0.028, 0.1, 5)), this.mats.bone)
        tooth.position.set(s * (0.13 - i * 0.012), -0.07, 0.8 - i * 0.12)
        tooth.rotation.x = Math.PI
        head.add(tooth)
      }
    }
    // mane: saffron + blossom fins fanning back
    for (let i = 0; i < 9; i++) {
      const a = (i / 8 - 0.5) * 2.6
      const fin = this.mesh(this.sg('mane', () => new THREE.ConeGeometry(0.11, 0.8, 4).translate(0, 0.4, 0)), i % 2 === 0 ? 'saffron' : 'crimsonDeep')
      fin.position.set(Math.sin(a) * 0.3, 0.1 + Math.cos(a) * 0.22, -0.22)
      fin.rotation.set(-1.9, 0, -a * 0.7)
      head.add(fin)
    }
    // jaw (hinged at the back)
    const jaw = new THREE.Group()
    jaw.position.set(0, -0.06, 0.05)
    const jawMesh = this.mesh(sph, 'cream')
    jawMesh.scale.set(0.22, 0.09, 0.5)
    jawMesh.position.set(0, -0.06, 0.4)
    jaw.add(jawMesh)
    for (let i = 0; i < 3; i++) {
      for (const s of [-1, 1]) {
        const tooth = new THREE.Mesh(this.sg('tooth2', () => new THREE.ConeGeometry(0.025, 0.09, 5)), this.mats.bone)
        tooth.position.set(s * (0.12 - i * 0.015), 0.02, 0.72 - i * 0.13)
        jaw.add(tooth)
      }
    }
    // beard tuft
    const beard = this.mesh(this.sg('beard', () => new THREE.ConeGeometry(0.08, 0.5, 5).translate(0, -0.25, 0)), 'saffron')
    beard.position.set(0, -0.12, 0.35)
    beard.rotation.x = -0.5
    jaw.add(beard)
    head.add(jaw)
    root.add(head)

    // ---- body segments (sphere chain, tapering), alternating scale bands
    const segs: THREE.Mesh[] = []
    const fins: Array<{ mesh: THREE.Object3D; seg: number }> = []
    const finGeo = this.sg('fin', () => new THREE.ConeGeometry(0.1, 0.5, 4).translate(0, 0.25, 0))
    for (let i = 0; i < DRAGON_SEGMENTS; i++) {
      const m = this.mesh(sph, i % 2 === 0 ? 'crimson' : 'crimsonDeep')
      const k = i / (DRAGON_SEGMENTS - 1)
      const r = 0.33 * (1 - k * 0.78) * (i < 2 ? 0.9 : 1)
      m.scale.setScalar(r)
      root.add(m)
      segs.push(m)
      if (i % 3 === 1 && i < DRAGON_SEGMENTS - 2) {
        const fin = this.mesh(finGeo, i % 2 === 0 ? 'saffron' : 'gold')
        fin.scale.setScalar(1 - k * 0.6)
        root.add(fin)
        fins.push({ mesh: fin, seg: i })
      }
    }
    // tail flame-fan
    for (let j = 0; j < 3; j++) {
      const fan = this.mesh(this.sg('fan', () => new THREE.ConeGeometry(0.09, 0.7, 4).translate(0, 0.35, 0)), j === 1 ? 'saffron' : 'crimsonDeep')
      root.add(fan)
      fins.push({ mesh: fan, seg: DRAGON_SEGMENTS - 1 + (j - 1) * 0.001 })
    }
    // four clawed legs
    const legs: Array<{ group: THREE.Group; seg: number; side: number }> = []
    const legGeo = this.sg('dleg', () => new THREE.CapsuleGeometry(0.06, 0.32, 4, 8).translate(0, -0.2, 0))
    const clawGeo = this.sg('dclaw', () => new THREE.ConeGeometry(0.025, 0.12, 5))
    for (const seg of [4, 15]) {
      for (const side of [-1, 1]) {
        const g = new THREE.Group()
        g.add(this.mesh(legGeo, 'crimsonDeep'))
        for (let c = 0; c < 3; c++) {
          const claw = new THREE.Mesh(clawGeo, this.mats.bone)
          claw.position.set((c - 1) * 0.045, -0.42, 0.05)
          claw.rotation.x = 1.4
          g.add(claw)
        }
        root.add(g)
        legs.push({ group: g, seg, side })
      }
    }

    // arc-length LUT
    const N = 96
    const lut = new Float32Array(N + 1)
    let len = 0
    bezierAt(path, 0, this.tmp)
    let lx = this.tmp.x
    let ly = this.tmp.y
    let lz = this.tmp.z
    for (let i = 1; i <= N; i++) {
      bezierAt(path, i / N, this.tmp)
      len += Math.hypot(this.tmp.x - lx, this.tmp.y - ly, this.tmp.z - lz)
      lut[i] = len
      lx = this.tmp.x
      ly = this.tmp.y
      lz = this.tmp.z
    }
    this.scene.add(root)
    this.dragons.set(key, {
      root,
      head,
      jaw,
      segs,
      fins,
      legs,
      path,
      flight,
      castAt,
      strikeAt,
      lut,
      len,
      endedAt: -1,
      startX: path[0],
      startY: path[1],
      startZ: path[2],
    })
  }

  /** The ball hit the net: the dragon bursts apart (tail first). */
  endDragon(key: number, now: number): void {
    const d = this.dragons.get(key)
    if (d && d.endedAt < 0) d.endedAt = now
  }

  private endDragonNow(key: number): void {
    const d = this.dragons.get(key)
    if (!d) return
    this.scene.remove(d.root)
    this.dragons.delete(key)
  }

  /** u (0..1 of arc length) → bezier parameter via the LUT. */
  private uAtDistance(d: DragonState, dist: number): number {
    const lut = d.lut
    const N = lut.length - 1
    if (dist <= 0) return 0
    if (dist >= d.len) return 1
    let lo = 0
    let hi = N
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (lut[mid] < dist) lo = mid
      else hi = mid
    }
    const f = (dist - lut[lo]) / Math.max(1e-5, lut[hi] - lut[lo])
    return (lo + f) / N
  }

  /**
   * Place a body point `s` metres behind the head. Before it has been pulled
   * onto the path it rides a helix coiled round the launch point.
   */
  private bodyPoint(d: DragonState, headDist: number, s: number, now: number, coilPhase: number, out: THREE.Vector3): void {
    const along = headDist - s
    if (along >= 0) {
      bezierAt(d.path, this.uAtDistance(d, along), this.tmp)
      out.set(this.tmp.x, this.tmp.y, this.tmp.z)
    } else {
      const rem = -along
      const R = 0.8
      const a = coilPhase - rem / R
      out.set(d.startX + Math.cos(a) * R, d.startY - 0.25 + rem * 0.09 + Math.sin(rem * 1.3) * 0.08, d.startZ + Math.sin(a) * R)
    }
    // serpentine wiggle perpendicular to travel
    const wig = Math.sin(s * 1.1 - now * 8) * 0.28 * Math.min(1, s / 2)
    out.y += wig * 0.6
    out.x += Math.cos(s * 0.9 + now * 5) * 0.12 * Math.min(1, s / 2)
  }

  private updateDragon(d: DragonState, now: number, ballX: number, ballY: number, ballZ: number): boolean {
    const tCast = now - d.castAt
    const flying = now >= d.strikeAt
    const u = flying ? Math.min(1, (now - d.strikeAt) / d.flight) : 0
    const emerge = Math.min(1, tCast / 0.35)
    // head distance along the curve: glued to the ball while it flies
    let headDist = 0
    if (flying) {
      bezierAt(d.path, 0, this.tmp)
      // project the ball onto the LUT by its parameter (ball follows the same bezier)
      headDist = d.len * Math.min(1, u * 1.0)
      // find the closest arc distance to the ball cheaply: search around u
      let best = headDist
      let bestErr = Infinity
      for (let i = 0; i <= 24; i++) {
        const dist = (i / 24) * d.len
        bezierAt(d.path, this.uAtDistance(d, dist), this.tmp)
        const err = Math.hypot(this.tmp.x - ballX, this.tmp.y - ballY, this.tmp.z - ballZ)
        if (err < bestErr) {
          bestErr = err
          best = dist
        }
      }
      headDist = best
    }
    const coilPhase = now * 7
    const bursting = d.endedAt >= 0 ? (now - d.endedAt) / 0.7 : 0
    if (bursting >= 1) return false

    // head: coils round the ball during the wind-up, then leads it
    if (!flying) {
      const a = coilPhase
      this.v1.set(d.startX + Math.cos(a) * 0.8, d.startY + 0.2 + Math.sin(now * 3) * 0.1, d.startZ + Math.sin(a) * 0.8)
      this.v2.set(d.startX + Math.cos(a + 0.4) * 0.8, d.startY + 0.2, d.startZ + Math.sin(a + 0.4) * 0.8)
      d.head.position.copy(this.v1)
      d.head.lookAt(this.v2)
    } else {
      bezierTangent(d.path, this.uAtDistance(d, headDist), this.tmp2)
      const tl = Math.hypot(this.tmp2.x, this.tmp2.y, this.tmp2.z) || 1
      // mouth around the ball: head origin sits ~0.75 m behind it
      d.head.position.set(ballX - (this.tmp2.x / tl) * 0.72, ballY - (this.tmp2.y / tl) * 0.72 + 0.05, ballZ - (this.tmp2.z / tl) * 0.72)
      this.v2.set(ballX + this.tmp2.x / tl, ballY + this.tmp2.y / tl, ballZ + this.tmp2.z / tl)
      d.head.lookAt(this.v2)
    }
    const roar = flying ? 0.35 + 0.25 * Math.sin(now * 14) : 0.2 + 0.4 * Math.max(0, Math.sin(tCast * 5))
    d.jaw.rotation.x = roar
    const headScale = emerge * (1 - Math.max(0, bursting) * 0.7) * 1.25
    d.head.scale.setScalar(Math.max(0.001, headScale))

    // body chain
    const offset = flying ? 0.55 : 0.3
    for (let i = 0; i < d.segs.length; i++) {
      const s = offset + i * SEG_LEN
      this.bodyPoint(d, flying ? headDist - 0.7 : -0.0001, s, now, coilPhase, this.v1)
      const seg = d.segs[i]
      // each segment is stretched along the body toward the one ahead: one continuous serpent
      const ahead = i === 0 ? d.head.position : d.segs[i - 1].position
      seg.position.copy(this.v1)
      seg.lookAt(ahead)
      const k = i / (d.segs.length - 1)
      const baseR = 0.33 * (1 - k * 0.78)
      const grow = Math.min(1, Math.max(0, emerge * 1.4 - k * 0.4))
      const burstK = bursting > 0 ? Math.max(0, 1 - Math.max(0, bursting * 1.6 - (1 - k) * 0.6)) : 1
      const r = Math.max(0.001, baseR * grow * burstK * 1.2)
      seg.scale.set(r, r * 0.92, r * 1.9)
    }
    // fins ride the segment tops
    for (const f of d.fins) {
      const i = Math.min(d.segs.length - 1, Math.floor(f.seg))
      const seg = d.segs[i]
      const next = d.segs[Math.max(0, i - 1)]
      f.mesh.position.copy(seg.position)
      f.mesh.position.y += seg.scale.x * 0.7
      this.v1.copy(next.position).sub(seg.position)
      const yaw = Math.atan2(this.v1.x, this.v1.z)
      f.mesh.rotation.set(-1.9, yaw, 0, 'YXZ')
      f.mesh.scale.setScalar(Math.max(0.001, seg.scale.x * 2.6))
    }
    // legs hang under their segments, paddling
    for (const l of d.legs) {
      const seg = d.segs[l.seg]
      const next = d.segs[Math.max(0, l.seg - 1)]
      this.v1.copy(next.position).sub(seg.position)
      const yaw = Math.atan2(this.v1.x, this.v1.z)
      l.group.position.set(
        seg.position.x + Math.cos(yaw) * l.side * seg.scale.x * 0.8,
        seg.position.y - seg.scale.x * 0.3,
        seg.position.z - Math.sin(yaw) * l.side * seg.scale.x * 0.8,
      )
      l.group.rotation.set(Math.sin(now * 9 + l.seg) * 0.7, yaw, l.side * 0.5, 'YXZ')
      l.group.scale.setScalar(Math.max(0.001, seg.scale.x * 3.2))
    }
    return true
  }

  /** Head position of a live dragon (for sfx anchoring), or null. */
  dragonHead(key: number): THREE.Vector3 | null {
    const d = this.dragons.get(key)
    return d ? d.head.position : null
  }

  // ================================================================== MOUNTAINS

  /** Mirror the sim walls: create new ridges, animate rise/sink, drop dead ones. */
  syncWalls(walls: readonly MountainWall[]): void {
    const live = new Set<number>()
    for (const w of walls) {
      live.add(w.id)
      let v = this.walls.get(w.id)
      if (!v) {
        v = this.buildWall(w)
        this.walls.set(w.id, v)
      }
      const s = mountainScale(w.age)
      const rising = w.age < SUPER.mountain.rise
      for (let i = 0; i < v.peaks.length; i++) {
        const p = v.peaks[i]
        const h = v.heights[i]
        // heave up out of the scar (a little stagger per peak), sink back down
        const stagger = rising ? Math.max(0, Math.min(1, s * 1.15 - i * 0.03)) : s
        p.position.y = -h * (1 - stagger)
        const jit = rising ? 0.06 * (1 - w.age / SUPER.mountain.rise) : 0
        p.position.x = p.userData.bx + (Math.random() - 0.5) * jit
        p.position.z = p.userData.bz + (Math.random() - 0.5) * jit
      }
      const scarMat = v.scar.material as THREE.MeshBasicMaterial
      scarMat.opacity = Math.min(1, w.age / 0.2) * Math.min(1, s * 1.4 + 0.25)
    }
    for (const [id, v] of this.walls) {
      if (live.has(id)) continue
      this.scene.remove(v.group)
      v.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry && !this.isShared(m.geometry)) m.geometry.dispose()
      })
      ;(v.scar.material as THREE.Material).dispose()
      this.walls.delete(id)
    }
  }

  private buildWall(w: MountainWall): { group: THREE.Group; peaks: THREE.Group[]; heights: number[]; scar: THREE.Mesh } {
    const group = new THREE.Group()
    const rng = makeRng(w.seed)
    const peaks: THREE.Group[] = []
    const heights: number[] = []
    const strata = [new THREE.Color('#7a4f2e'), new THREE.Color('#a8683c'), new THREE.Color('#c98a3a'), new THREE.Color('#dcb27a'), new THREE.Color('#f1e2c4')]
    const makeRock = (r: number, h: number, seg: number): THREE.BufferGeometry => {
      const g = new THREE.ConeGeometry(r, h, seg, 5).translate(0, h / 2, 0)
      const pos = g.getAttribute('position') as THREE.BufferAttribute
      const colors = new Float32Array(pos.count * 3)
      const c = new THREE.Color()
      // jitter by vertex POSITION so shared seam vertices stay welded
      const jitterOf = (x: number, y: number, z: number): number => {
        const k = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + w.seed) * 43758.5453
        return k - Math.floor(k)
      }
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i)
        const y = pos.getY(i)
        const z = pos.getZ(i)
        const yk = y / h
        const j = jitterOf(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100))
        const j2 = jitterOf(Math.round(z * 100), Math.round(x * 100), Math.round(y * 100))
        if (yk < 0.98) {
          pos.setX(i, x * (0.82 + j * 0.36))
          pos.setZ(i, z * (0.82 + j2 * 0.36))
          pos.setY(i, y + (j - 0.5) * h * 0.06)
        }
        // painted strata: warm bands, wobbling with the jitter, pale caps
        const band = Math.min(strata.length - 1, Math.max(0, Math.floor(yk * 4.2 + (j - 0.5) * 0.9)))
        c.copy(strata[band])
        if (yk > 0.86) c.lerp(strata[4], 0.7)
        colors[i * 3] = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      g.computeVertexNormals()
      return g
    }
    for (let i = 0; i < w.peaks.length; i++) {
      const p = w.peaks[i]
      const pg = new THREE.Group()
      const main = new THREE.Mesh(makeRock(p.r * 1.3, p.h, 7), this.mats.rock)
      main.castShadow = true
      main.receiveShadow = true
      outlined(main, this.px)
      main.rotation.y = rng() * Math.PI
      pg.add(main)
      // shoulder spurs for a jagged ridge silhouette
      for (let k = 0; k < 2; k++) {
        const hh = p.h * (0.35 + rng() * 0.3)
        const spur = new THREE.Mesh(makeRock(p.r * (0.55 + rng() * 0.3), hh, 6), this.mats.rock)
        spur.castShadow = true
        outlined(spur, this.px)
        const a = rng() * Math.PI * 2
        spur.position.set(Math.cos(a) * p.r * 0.9, 0, Math.sin(a) * p.r * 0.9)
        spur.rotation.set((rng() - 0.5) * 0.3, rng() * Math.PI, (rng() - 0.5) * 0.3)
        pg.add(spur)
      }
      // rubble at the foot
      for (let k = 0; k < 3; k++) {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16 + rng() * 0.22, 0), this.mats.rock)
        const colors = new Float32Array(rock.geometry.getAttribute('position').count * 3).fill(0.55)
        for (let q = 0; q < colors.length; q += 3) {
          colors[q] = 0.66
          colors[q + 1] = 0.44
          colors[q + 2] = 0.3
        }
        rock.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        outlined(rock, this.px)
        const a = rng() * Math.PI * 2
        rock.position.set(Math.cos(a) * p.r * 1.5, 0.1, Math.sin(a) * p.r * 1.5)
        rock.rotation.set(rng() * 3, rng() * 3, rng() * 3)
        pg.add(rock)
      }
      pg.position.set(p.x, -p.h, p.z)
      pg.userData.bx = p.x
      pg.userData.bz = p.z
      group.add(pg)
      peaks.push(pg)
      heights.push(p.h + 0.3)
    }
    // the cracked-ink scar in the turf, along the ridge
    const scarMat = new THREE.MeshBasicMaterial({ map: this.crackTex, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2 })
    const scar = new THREE.Mesh(this.sg('plane', () => new THREE.PlaneGeometry(1, 1)), scarMat)
    scar.rotation.x = -Math.PI / 2
    const ridgeYaw = Math.atan2(-w.nz, w.nx) + Math.PI / 2
    scar.rotation.z = ridgeYaw
    scar.scale.set(SUPER.mountain.span + 5, 5.2, 1)
    scar.position.set(w.cx, 0.025, w.cz)
    scar.renderOrder = 1
    group.add(scar)
    this.scene.add(group)
    return { group, peaks, heights, scar }
  }

  // ================================================================== EAGLE

  private buildEagle(): EagleState {
    const root = new THREE.Group()
    const sph = this.sg('sph', () => new THREE.SphereGeometry(1, 14, 10))
    const body = this.mesh(sph, 'umber')
    body.scale.set(0.34, 0.3, 0.62)
    root.add(body)
    const chest = this.mesh(sph, 'fawn')
    chest.scale.set(0.3, 0.27, 0.38)
    chest.position.set(0, -0.06, 0.22)
    root.add(chest)
    const head = this.mesh(sph, 'paper')
    head.scale.set(0.2, 0.2, 0.24)
    head.position.set(0, 0.16, 0.68)
    root.add(head)
    const beak = this.mesh(this.sg('beak', () => new THREE.ConeGeometry(0.08, 0.3, 6).rotateX(Math.PI / 2)), 'saffron')
    beak.position.set(0, 0.1, 0.94)
    root.add(beak)
    const hook = this.mesh(sph, 'saffron')
    hook.scale.set(0.05, 0.06, 0.05)
    hook.position.set(0, 0.06, 1.06)
    root.add(hook)
    for (const s of [-1, 1]) {
      const eye = this.mesh(sph, 'gold')
      eye.scale.setScalar(0.045)
      eye.position.set(s * 0.13, 0.22, 0.8)
      root.add(eye)
      const pupil = new THREE.Mesh(sph, this.mats.ink)
      pupil.scale.setScalar(0.022)
      pupil.position.set(s * 0.16, 0.22, 0.83)
      root.add(pupil)
      const brow = new THREE.Mesh(sph, this.mats.ink)
      brow.scale.set(0.07, 0.015, 0.03)
      brow.position.set(s * 0.13, 0.28, 0.82)
      brow.rotation.z = s * 0.4
      root.add(brow)
    }
    // wings: an inner panel + outer hand with fanned primaries
    const innerShape = new THREE.Shape()
    innerShape.moveTo(0, 0.3)
    innerShape.lineTo(1.15, 0.28)
    innerShape.lineTo(1.2, -0.3)
    innerShape.quadraticCurveTo(0.6, -0.42, 0, -0.34)
    innerShape.closePath()
    // shapes are drawn in XY with +Y = leading edge; rotateX(+90°) lays them in XZ with the leading edge forward (+Z)
    const innerGeo = this.sg('wingInner', () => new THREE.ExtrudeGeometry(innerShape, { depth: 0.05, bevelEnabled: false }).rotateX(Math.PI / 2))
    const featherShape = new THREE.Shape()
    featherShape.moveTo(0, 0.07)
    featherShape.quadraticCurveTo(0.6, 0.1, 1.0, 0)
    featherShape.quadraticCurveTo(0.6, -0.1, 0, -0.07)
    featherShape.closePath()
    const featherGeo = this.sg('feather', () => new THREE.ExtrudeGeometry(featherShape, { depth: 0.035, bevelEnabled: false }).rotateX(Math.PI / 2))
    const makeWing = (side: 1 | -1): { wing: THREE.Group; outer: THREE.Group } => {
      const wing = new THREE.Group()
      wing.position.set(side * 0.22, 0.1, 0.1)
      const inner = this.mesh(innerGeo, 'umber')
      inner.scale.x = side
      wing.add(inner)
      const outer = new THREE.Group()
      outer.position.set(side * 1.15, 0, 0)
      for (let f = 0; f < 6; f++) {
        const fe = this.mesh(featherGeo, f % 2 === 0 ? 'umberDeep' : 'umber')
        fe.scale.set(side * (1.05 - f * 0.06), 1, 1)
        fe.rotation.y = side * (0.35 - f * 0.17)
        fe.position.z = 0.2 - f * 0.1
        outer.add(fe)
      }
      wing.add(outer)
      root.add(wing)
      return { wing, outer }
    }
    const L = makeWing(1)
    const R = makeWing(-1)
    // tail fan
    for (let f = 0; f < 5; f++) {
      const fe = this.mesh(featherGeo, f === 2 ? 'paper' : 'umberDeep')
      fe.scale.set(0.7, 1, 1)
      fe.rotation.y = Math.PI / 2 + (f - 2) * 0.22
      fe.position.set(0, 0.02, -0.45)
      root.add(fe)
    }
    // talons, swung forward for the strike
    const talons = new THREE.Group()
    talons.position.set(0, -0.28, 0.1)
    for (const s of [-1, 1]) {
      const leg = this.mesh(this.sg('eleg', () => new THREE.CapsuleGeometry(0.045, 0.22, 4, 8).translate(0, -0.14, 0)), 'saffron')
      leg.position.x = s * 0.12
      talons.add(leg)
      for (let c = 0; c < 3; c++) {
        const claw = new THREE.Mesh(this.sg('eclaw', () => new THREE.ConeGeometry(0.022, 0.12, 5)), this.mats.ink)
        claw.position.set(s * 0.12 + (c - 1) * 0.04, -0.3, 0.05)
        claw.rotation.x = 1.3
        talons.add(claw)
      }
    }
    root.add(talons)
    root.scale.setScalar(1.25)
    this.scene.add(root)
    return { root, wingL: L.wing, wingR: R.wing, outerL: L.outer, outerR: R.outer, talons, seen: 0, fade: 0 }
  }

  /** Drive (or spawn) the eagle for caster `key` this frame. */
  setEagle(key: string, v: EagleView, now: number): void {
    let e = this.eagles.get(key)
    if (!e) {
      e = this.buildEagle()
      this.eagles.set(key, e)
    }
    e.seen = now
    const fx = -Math.sin(v.yaw)
    const fz = -Math.cos(v.yaw)
    const u = v.u
    // dive in from high behind, hold the glide slot ahead-above, pull up on release
    let ahead: number
    let up: number
    if (u < 0.22) {
      const k = u / 0.22
      const kk = 1 - Math.pow(1 - k, 3)
      ahead = -6 + kk * 9
      up = 11 - kk * 8.6
    } else if (u <= 1) {
      ahead = 3 + Math.sin(u * 9) * 0.15
      up = 2.4 + Math.sin(u * 7) * 0.2
    } else {
      const k = Math.min(1, u - 1)
      ahead = 3 + k * 7
      up = 2.4 + k * k * 9
    }
    e.root.position.set(v.x + fx * ahead, v.y + up - 1.2, v.z + fz * ahead)
    const pitch = u < 0.22 ? 0.5 : u > 1 ? -0.6 : 0.08
    e.root.rotation.set(pitch, v.yaw + Math.PI, 0, 'YXZ')
    // flight: slow powerful beats while gliding, folded in the dive
    const beat = u < 0.22 ? 0.9 : u > 1 ? Math.sin(now * 11) * 0.7 : Math.sin(now * 5.5) * 0.35 - 0.05
    e.wingL.rotation.z = beat
    e.wingR.rotation.z = -beat
    const fold = u < 0.22 ? 0.9 : Math.sin(now * 5.5 - 0.6) * 0.3
    e.outerL.rotation.z = fold
    e.outerR.rotation.z = -fold
    e.talons.rotation.x = u > 0.75 && u <= 1 ? -1.2 : -0.2
    const scale = u > 1 ? Math.max(0.001, 1.25 * (1 - Math.min(1, u - 1) * 0.9)) : 1.25
    e.root.scale.setScalar(scale)
    e.root.visible = true
  }

  // ================================================================== THUNDER

  /** A lightning bolt from the storm to (x, z): ink ribbon, paper core, branches, scorch. */
  bolt(x: number, z: number, seed: number, now: number, camera: THREE.Camera, scale = 1): void {
    const r = makeRng(seed)
    const group = new THREE.Group()
    group.renderOrder = 8
    const top = new THREE.Vector3(x + (r() - 0.5) * 6, 26 * scale, z + (r() - 0.5) * 6)
    const bottom = new THREE.Vector3(x, 0.05, z)
    const pts = this.jagged(top, bottom, 7, 2.2 * scale, r)
    const toCam = new THREE.Vector3().subVectors(camera.position, bottom).setY(0).normalize()
    group.add(this.ribbon(pts, 0.55 * scale, 'boltInk', toCam))
    group.add(this.ribbon(pts, 0.2 * scale, 'boltCore', toCam, 0.02))
    // forks
    for (let b = 0; b < 3; b++) {
      const i = 2 + Math.floor(r() * (pts.length - 4))
      const from = pts[i]
      const to = from.clone().add(new THREE.Vector3((r() - 0.5) * 7, -4 - r() * 5, (r() - 0.5) * 7))
      const fork = this.jagged(from, to, 4, 1.2 * scale, r)
      group.add(this.ribbon(fork, 0.3 * scale, 'boltInk', toCam))
      group.add(this.ribbon(fork, 0.1 * scale, 'boltCore', toCam, 0.02))
    }
    this.scene.add(group)
    let scorch: THREE.Mesh | null = null
    if (scale >= 0.99) {
      const mat = new THREE.MeshBasicMaterial({ map: this.scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 })
      scorch = new THREE.Mesh(this.sg('plane', () => new THREE.PlaneGeometry(1, 1)), mat)
      scorch.scale.setScalar(3.2)
      scorch.rotation.x = -Math.PI / 2
      scorch.rotation.z = r() * Math.PI * 2
      scorch.position.set(x, 0.03, z)
      this.scene.add(scorch)
    }
    this.bolts.push({ group, born: now, life: scale >= 0.99 ? 0.42 : 0.12, scorch })
  }

  private jagged(a: THREE.Vector3, b: THREE.Vector3, depth: number, spread: number, r: () => number): THREE.Vector3[] {
    let pts = [a.clone(), b.clone()]
    let amp = spread
    for (let d = 0; d < depth; d++) {
      const next: THREE.Vector3[] = []
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i]
        const q = pts[i + 1]
        next.push(p)
        next.push(new THREE.Vector3((p.x + q.x) / 2 + (r() - 0.5) * amp, (p.y + q.y) / 2 + (r() - 0.5) * amp * 0.3, (p.z + q.z) / 2 + (r() - 0.5) * amp))
      }
      next.push(pts[pts.length - 1])
      pts = next
      amp *= 0.55
      if (pts.length > 70) break
    }
    return pts
  }

  /** Flat ribbon through `pts`, widened sideways relative to the viewer. */
  private ribbon(pts: THREE.Vector3[], width: number, mat: string, toCam: THREE.Vector3, bias = 0): THREE.Mesh {
    const pos = new Float32Array(pts.length * 2 * 3)
    const idx: number[] = []
    const side = new THREE.Vector3()
    const dir = new THREE.Vector3()
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(pts.length - 1, i + 1)]
      dir.subVectors(b, a).normalize()
      side.crossVectors(dir, toCam).normalize()
      const taper = width * (0.55 + 0.45 * (1 - i / pts.length))
      const p = pts[i]
      pos.set([p.x + side.x * taper + toCam.x * bias, p.y + side.y * taper, p.z + side.z * taper + toCam.z * bias], i * 6)
      pos.set([p.x - side.x * taper + toCam.x * bias, p.y - side.y * taper, p.z - side.z * taper + toCam.z * bias], i * 6 + 3)
      if (i < pts.length - 1) {
        const k = i * 2
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setIndex(idx)
    const m = new THREE.Mesh(g, this.mats[mat])
    m.frustumCulled = false
    return m
  }

  /** Mirror sealed players: glyph ring underfoot, talismans orbiting, sparks crackling. */
  setSeals(list: ReadonlyArray<{ key: string; x: number; z: number; t: number }>, now: number, camera: THREE.Camera): void {
    const live = new Set<string>()
    for (const s of list) {
      live.add(s.key)
      let v = this.seals.get(s.key)
      if (!v) {
        const ringMat = new THREE.MeshBasicMaterial({ map: this.sealTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
        const ring = new THREE.Mesh(this.sg('plane', () => new THREE.PlaneGeometry(1, 1)), ringMat)
        ring.rotation.x = -Math.PI / 2
        this.scene.add(ring)
        const strips: THREE.Mesh[] = []
        const stripMat = new THREE.MeshBasicMaterial({ map: this.stripTex, side: THREE.DoubleSide })
        this.mats[`strip-${s.key}`] = stripMat
        for (let i = 0; i < 4; i++) {
          const m = new THREE.Mesh(this.sg('plane', () => new THREE.PlaneGeometry(1, 1)), stripMat)
          this.scene.add(m)
          strips.push(m)
        }
        const sparks = new THREE.Group()
        this.scene.add(sparks)
        v = { ring, strips, sparks, lastSpark: 0, seen: now }
        this.seals.set(s.key, v)
      }
      v.seen = now
      const fadeIn = Math.min(1, (SUPER.thunder.seal - s.t + 0.05) / 0.25)
      const fadeOut = Math.min(1, s.t / 0.3)
      const k = Math.max(0, Math.min(fadeIn, fadeOut))
      v.ring.position.set(s.x, 0.04, s.z)
      v.ring.rotation.z = now * 0.8
      v.ring.scale.setScalar(2.4 * (0.4 + 0.6 * k))
      ;(v.ring.material as THREE.MeshBasicMaterial).opacity = k
      for (let i = 0; i < v.strips.length; i++) {
        const a = now * 1.6 + (i / v.strips.length) * Math.PI * 2
        const m = v.strips[i]
        m.position.set(s.x + Math.cos(a) * 0.75, 0.75 + Math.sin(now * 3 + i) * 0.2 + (i % 2) * 0.45, s.z + Math.sin(a) * 0.75)
        m.rotation.set(0, -a + Math.PI / 2, Math.sin(now * 5 + i) * 0.15)
        m.scale.set(0.22 * Math.max(0.001, k), 0.66 * Math.max(0.001, k), 1)
      }
      // crackle: rebuild a couple of tiny bolts round the body every ~80 ms
      if (now - v.lastSpark > 0.08) {
        v.lastSpark = now
        for (const c of [...v.sparks.children]) {
          v.sparks.remove(c)
          ;(c as THREE.Mesh).geometry.dispose()
        }
        const r = makeRng(Math.floor(now * 1000) ^ s.key.length)
        const toCam = new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(s.x, 1, s.z)).setY(0).normalize()
        for (let b = 0; b < 2; b++) {
          const a = r() * Math.PI * 2
          const y = 0.3 + r() * 1.3
          const p0 = new THREE.Vector3(s.x + Math.cos(a) * 0.35, y, s.z + Math.sin(a) * 0.35)
          const p1 = p0.clone().add(new THREE.Vector3((r() - 0.5) * 0.7, (r() - 0.5) * 0.6, (r() - 0.5) * 0.7))
          const pts = this.jagged(p0, p1, 3, 0.25, r)
          v.sparks.add(this.ribbon(pts, 0.05, 'boltInk', toCam))
          v.sparks.add(this.ribbon(pts, 0.02, 'boltGold', toCam, 0.01))
        }
      }
    }
    for (const [key, v] of this.seals) {
      if (live.has(key)) continue
      this.scene.remove(v.ring)
      ;(v.ring.material as THREE.Material).dispose()
      for (const m of v.strips) this.scene.remove(m)
      this.mats[`strip-${key}`]?.dispose()
      delete this.mats[`strip-${key}`]
      for (const c of v.sparks.children) (c as THREE.Mesh).geometry.dispose()
      this.scene.remove(v.sparks)
      this.seals.delete(key)
    }
  }

  // ================================================================== CYCLONE

  syncCyclones(list: readonly Cyclone[], dt: number, now: number): void {
    const live = new Set<number>()
    for (const c of list) {
      live.add(c.id)
      let v = this.cyclones.get(c.id)
      if (!v) {
        v = this.buildCyclone(c)
        this.cyclones.set(c.id, v)
      }
      const s = cycloneStrength(c.age)
      const grow = Math.max(0.001, Math.min(1, c.age / 0.45)) * (0.2 + 0.8 * s)
      v.root.position.set(c.x + Math.sin(now * 1.3) * 0.25, 0, c.z + Math.cos(now * 1.1) * 0.25)
      v.root.scale.set(grow, Math.max(0.001, Math.min(1, c.age / 0.6)) * (0.3 + 0.7 * s), grow)
      for (let i = 0; i < v.layers.length; i++) {
        const layer = v.layers[i]
        layer.rotation.y += dt * (3.2 + i * 1.4) * (i % 2 === 0 ? 1 : 1.2)
        const mat = layer.material as THREE.MeshBasicMaterial
        if (mat.map) mat.map.offset.y -= dt * (0.25 + i * 0.1)
        mat.opacity = (0.55 + i * 0.1) * Math.min(1, s * 1.5)
      }
      v.base.rotation.z -= dt * 5
      ;(v.base.material as THREE.MeshBasicMaterial).opacity = 0.7 * s
      // petals + leaves spiral up the funnel
      for (let i = 0; i < v.petalData.length; i++) {
        const p = v.petalData[i]
        p.h += dt * (1.6 + p.s * 1.4)
        if (p.h > 9) p.h -= 9
        p.a += dt * (4.2 - p.h * 0.18) * (1 + p.s)
        const rad = (0.7 + p.h * 0.32) * p.rf
        this.v1.set(Math.cos(p.a) * rad, p.h, Math.sin(p.a) * rad)
        this.e.set(p.a * 2, p.a, p.h)
        this.q.setFromEuler(this.e)
        this.v2.setScalar(p.size * Math.min(1, s * 1.4))
        this.m4.compose(this.v1, this.q, this.v2)
        v.petals.setMatrixAt(i, this.m4)
      }
      v.petals.instanceMatrix.needsUpdate = true
    }
    for (const [id, v] of this.cyclones) {
      if (live.has(id)) continue
      this.scene.remove(v.root)
      for (const l of v.layers) {
        const m = l.material as THREE.MeshBasicMaterial
        m.map?.dispose()
        m.dispose()
        l.geometry.dispose()
      }
      ;(v.base.material as THREE.Material).dispose()
      ;(v.petals.material as THREE.Material).dispose()
      v.petals.dispose()
      this.cyclones.delete(id)
    }
  }

  private buildCyclone(c: Cyclone): CycloneView {
    const root = new THREE.Group()
    const layers: THREE.Mesh[] = []
    const H = 10
    const shells: Array<[number, number, number]> = [
      [0.55, 3.8, 0],
      [0.8, 4.4, 1],
      [0.4, 3.0, 2],
    ]
    for (let i = 0; i < shells.length; i++) {
      const [rb, rt, ti] = shells[i]
      const g = new THREE.CylinderGeometry(rt, rb, H, 32, 12, true).translate(0, H / 2, 0)
      // twist + lean: the funnel corkscrews and bends a touch
      const pos = g.getAttribute('position') as THREE.BufferAttribute
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k)
        const y = pos.getY(k)
        const z = pos.getZ(k)
        const a = y * 0.28
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        pos.setXYZ(k, x * ca - z * sa + Math.sin(y * 0.3) * 0.6, y, x * sa + z * ca)
      }
      g.computeVertexNormals()
      const map = this.cycloneTex[ti].clone()
      map.needsUpdate = true
      map.repeat.set(2, 1)
      const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.6 })
      const m = new THREE.Mesh(g, mat)
      m.renderOrder = 5
      root.add(m)
      layers.push(m)
    }
    const petals = new THREE.InstancedMesh(
      this.sg('petal', () => new THREE.PlaneGeometry(0.14, 0.09)),
      new THREE.MeshBasicMaterial({ map: this.petalTex, alphaTest: 0.28, side: THREE.DoubleSide }),
      110,
    )
    petals.frustumCulled = false
    root.add(petals)
    const r = makeRng(c.seed)
    const petalData = Array.from({ length: 110 }, () => ({ h: r() * 9, a: r() * Math.PI * 2, s: r(), rf: 0.7 + r() * 0.7, size: 0.8 + r() * 1.2 }))
    const baseMat = new THREE.MeshBasicMaterial({ map: this.cycloneTex[1], transparent: true, depthWrite: false, opacity: 0 })
    const base = new THREE.Mesh(this.sg('cring', () => new THREE.RingGeometry(0.6, 3.6, 40)), baseMat)
    base.rotation.x = -Math.PI / 2
    base.position.y = 0.05
    root.add(base)
    this.scene.add(root)
    return { root, layers, petals, petalData, base }
  }

  // ================================================================== frame

  /**
   * Per-frame upkeep. `dragonBalls` maps live dragon keys to the ball each
   * one is carrying (the Game's authoritative/predicted ball).
   */
  update(dt: number, now: number, dragonBall: { x: number; y: number; z: number }): void {
    for (const [key, d] of this.dragons) {
      if (!this.updateDragon(d, now, dragonBall.x, dragonBall.y, dragonBall.z)) this.endDragonNow(key)
    }
    // eagles not driven this frame fade out
    for (const [key, e] of this.eagles) {
      if (now - e.seen > 0.05) {
        e.fade += dt * 3
        e.root.scale.multiplyScalar(0.85)
        if (e.fade > 0.6) {
          this.scene.remove(e.root)
          this.eagles.delete(key)
        }
      } else {
        e.fade = 0
      }
    }
    // bolts flicker, then leave a fading scorch
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]
      const t = now - b.born
      b.group.visible = t < b.life && !(t > 0.07 && t < 0.11)
      if (t > b.life && b.group.parent) {
        this.scene.remove(b.group)
        for (const c of b.group.children) (c as THREE.Mesh).geometry.dispose()
      }
      if (b.scorch) {
        const mat = b.scorch.material as THREE.MeshBasicMaterial
        mat.opacity = Math.max(0, 1 - Math.max(0, t - 1.2) / 1.2)
      }
      if (t > 2.6) {
        if (b.scorch) {
          this.scene.remove(b.scorch)
          ;(b.scorch.material as THREE.Material).dispose()
        }
        this.bolts.splice(i, 1)
      }
    }
  }

  /** Is a dragon still on screen (bursting or flying)? */
  hasDragon(key: number): boolean {
    return this.dragons.has(key)
  }

  clear(): void {
    for (const key of [...this.dragons.keys()]) this.endDragonNow(key)
    this.syncWalls([])
    for (const [key, e] of this.eagles) {
      this.scene.remove(e.root)
      this.eagles.delete(key)
    }
    for (const b of this.bolts) {
      this.scene.remove(b.group)
      if (b.scorch) this.scene.remove(b.scorch)
    }
    this.bolts = []
    this.setSeals([], 0, new THREE.PerspectiveCamera())
    this.syncCyclones([], 0, 0)
  }

  dispose(): void {
    this.clear()
    for (const g of this.shared.values()) g.dispose()
    for (const t of this.texs) t.dispose()
    for (const m of Object.values(this.mats)) m.dispose()
  }
}
