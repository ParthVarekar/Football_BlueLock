/**
 * Gulmohar ground trees — density + quality rework.
 *
 * Every tree is built in world space and then MERGED into a handful of
 * geometries (main-ring / second-row × palette buckets, plus shrubs), so the
 * whole forest costs ~15 draw calls:
 *
 *   trunk  = tapered cylinder + 2-3 branch forks reaching into the canopy
 *   canopy = 5-8 faceted clumps (non-indexed icosahedra) carrying per-face
 *            vertex colours from a 5-tone palette — the painted style the VLM
 *            praised — clustered into an asymmetric, per-tree-biased blob
 *
 * Palette mix across the ring: ~60% gulmohar reds, ~30% green neems,
 * ~10% mixed/amber. Trunks vary through dark browns (vertex colours).
 *
 * WIND SWAY runs on the GPU: the canopy, trunk, dappled-shadow DEPTH material
 * and the ink OUTLINE hulls all get the same `onBeforeCompile` vertex patch,
 * so shading, outlines and shadows stay glued to the swaying geometry.
 * A per-vertex `aBend` weight (≈ localHeight²) scales the bend; `aPhase` is
 * per clump; `aFlutter` decorrelates a high-frequency shimmer. The gust
 * envelope lives here (world.ts feeds it to the petals + skyline).
 */
import * as THREE from 'three'
import { PITCH, type Quality, QUALITY } from '../core/constants'
import { makeToonMaterial } from './toon'
import { makeLeafAlphaTexture } from './textures'
import { makeRng } from '../core/math'
import { OUTLINE_PROJECT, OUTLINE_UNIFORMS, OUTLINE_VERT_PARS } from './outline'

export interface TreeSite {
  x: number
  z: number
  /** canopy centre height (m) */
  y: number
  /** canopy horizontal radius (m) */
  r: number
  /** gulmohar (blossom) vs neem (green) — petals pick spawn + tint from this */
  red: boolean
}

export interface TreesModule {
  readonly group: THREE.Group
  /** Petal spawn sites for the main (always-visible) ring. */
  readonly sites: readonly TreeSite[]
  /** Advances the shared wind uniforms + gust envelope; returns gust 0..1. */
  update(dt: number, elapsed: number): number
  /** Toggle the second density row. */
  setDetail(on: boolean): void
  dispose(): void
}

/* ------------------------------------------------------------------ */
/* Wind shader plumbing                                                */
/* ------------------------------------------------------------------ */

/** Shared by every sway-patched material (canopy, trunk, depth, outlines). */
export const WIND_UNIFORMS = {
  uTime: { value: 0 },
  uGust: { value: 0 },
}

const SWAY_PARS = /* glsl */ `
attribute float aPhase;
attribute float aBend;
attribute float aFlutter;
uniform float uTime;
uniform float uGust;
`

const SWAY_CODE = /* glsl */ `
{
  float sway = sin( uTime * 1.3 + aPhase ) + 0.5 * sin( uTime * 2.7 + aPhase * 1.7 );
  float gust = 1.0 + uGust * 0.8;
  transformed.x += aBend * sway * 0.085 * gust;
  transformed.z += aBend * cos( uTime * 1.1 + aPhase * 1.3 ) * 0.028 * gust;
  transformed.x += aBend * sin( uTime * 6.3 + aFlutter * 19.0 ) * 0.02 * ( 0.55 + uGust );
  transformed.y -= aBend * abs( sway ) * 0.014 * gust;
}
`

/** Patch an arbitrary material's vertex shader with the sway displacement. */
function injectSway(mat: THREE.Material, key: string): void {
  const base = mat.onBeforeCompile.bind(mat)
  mat.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer)
    shader.uniforms.uTime = WIND_UNIFORMS.uTime
    shader.uniforms.uGust = WIND_UNIFORMS.uGust
    shader.vertexShader = SWAY_PARS + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + SWAY_CODE,
    )
  }
  mat.customProgramCacheKey = () => key
}

/** Inverted-hull ink shell that FOLLOWS the sway (shares the outline uniforms). */
function makeSwayOutlineMaterial(color: string, key: string): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, fog: true })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlinePx = OUTLINE_UNIFORMS.uOutlinePx
    shader.uniforms.uOutlineRes = OUTLINE_UNIFORMS.uOutlineRes
    shader.uniforms.uOutlineProj = OUTLINE_UNIFORMS.uOutlineProj
    shader.uniforms.uTime = WIND_UNIFORMS.uTime
    shader.uniforms.uGust = WIND_UNIFORMS.uGust
    shader.vertexShader = SWAY_PARS + OUTLINE_VERT_PARS + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + SWAY_CODE,
    )
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', OUTLINE_PROJECT)
  }
  mat.customProgramCacheKey = () => key
  return mat
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const MERGE_ATTRS = ['position', 'normal', 'uv', 'color', 'aPhase', 'aBend', 'aFlutter'] as const

/** Merge non-indexed geometries sharing our attribute set (copies + frees sources). */
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  for (const name of MERGE_ATTRS) {
    const first = geos[0].getAttribute(name) as THREE.BufferAttribute
    const itemSize = first.itemSize
    let total = 0
    for (const g of geos) total += (g.getAttribute(name) as THREE.BufferAttribute).count
    const data = new Float32Array(total * itemSize)
    let off = 0
    for (const g of geos) {
      const a = g.getAttribute(name) as THREE.BufferAttribute
      data.set(a.array as ArrayLike<number>, off)
      off += a.count * itemSize
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, itemSize))
  }
  for (const g of geos) g.dispose()
  return out
}

/** One clump: per-face tones + a per-vertex top-lit lift (painterly curve). */
function buildClump(r: number, detail: number, tones: THREE.Color[], rng: () => number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(r, detail)
  geo.scale(1, 0.6 + rng() * 0.16, 1) // hand-squashed crown
  geo.rotateY(rng() * Math.PI)
  const pos = geo.getAttribute('position')
  const count = pos.count
  const colors = new Float32Array(count * 3)
  // vertical extent for the top-light gradient
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i)
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const span = Math.max(1e-4, maxY - minY)
  for (let f = 0; f < count; f += 3) {
    const tone = tones[Math.floor(rng() * tones.length)]
    const warm = 0.88 + rng() * 0.24
    for (let v = 0; v < 3; v++) {
      const i = f + v
      // lift toward the light on the vertex's own height — softens the flat
      // facets into a curved, hand-painted dome read
      const yN = Math.pow((pos.getY(i) - minY) / span, 1.35)
      const lift = 0.86 + 0.26 * yN
      colors[i * 3] = tone.r * warm * lift
      colors[i * 3 + 1] = tone.g * warm * lift
      colors[i * 3 + 2] = tone.b * warm * (lift * 0.985 + 0.015)
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

interface SwayBake {
  phase: number
  /** y where bending starts → y where it saturates */
  bendBase: number
  bendSpan: number
  maxHoriz: number
  /** overall multiplier (trunks get a damped weight) */
  weight: number
  rng: () => number
}

/** Bake per-vertex sway attributes after the clump is positioned (tree-local). */
function stampSway(geo: THREE.BufferGeometry, bake: SwayBake): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  const phases = new Float32Array(n)
  const bends = new Float32Array(n)
  const fluts = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const t = THREE.MathUtils.clamp((y - bake.bendBase) / bake.bendSpan, 0, 1)
    const hd = Math.min(1, Math.hypot(x, z) / bake.maxHoriz)
    bends[i] = t * t * (0.55 + 0.45 * hd) * bake.weight
    phases[i] = bake.phase
    fluts[i] = bake.rng()
  }
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
  geo.setAttribute('aBend', new THREE.BufferAttribute(bends, 1))
  geo.setAttribute('aFlutter', new THREE.BufferAttribute(fluts, 1))
}

/** Solid-colour a whole geometry (trunks / branches in merged-vertex-colour land). */
function stampColor(geo: THREE.BufferGeometry, color: THREE.Color): void {
  const n = geo.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/* ------------------------------------------------------------------ */
/* Placement — a ring around the boundary wall (rounded-rect perimeter) */
/* ------------------------------------------------------------------ */

const HL = PITCH.wallL / 2
const HW = PITCH.wallW / 2
const RR = PITCH.wallR

interface RingPoint {
  x: number
  z: number
  nx: number
  nz: number
  seg: number
}

/** Point + outward normal on the wall's rounded rect, t ∈ [0,1) around the ring. */
function ringPoint(t: number): RingPoint {
  const arc = (Math.PI / 2) * RR
  const eL = HL - RR
  const eW = HW - RR
  const P = 4 * eL + 4 * eW + 4 * arc
  let d = (((t % 1) + 1) % 1) * P
  // segment walk (ccw from the east edge): [edge, arc, edge, arc, ...]
  const lens = [2 * eW, arc, 2 * eL, arc, 2 * eW, arc, 2 * eL, arc]
  let seg = 0
  while (seg < 7 && d > lens[seg]) {
    d -= lens[seg]
    seg++
  }
  switch (seg) {
    case 0: return { x: HL, z: -eW + d, nx: 1, nz: 0, seg }
    case 1: {
      const a = d / RR
      return { x: eL + Math.cos(a) * RR, z: eW + Math.sin(a) * RR, nx: Math.cos(a), nz: Math.sin(a), seg }
    }
    case 2: return { x: eL - d, z: HW, nx: 0, nz: 1, seg }
    case 3: {
      const a = Math.PI / 2 + d / RR
      return { x: -eL + Math.cos(a) * RR, z: eW + Math.sin(a) * RR, nx: Math.cos(a), nz: Math.sin(a), seg }
    }
    case 4: return { x: -HL, z: eW - d, nx: -1, nz: 0, seg }
    case 5: {
      const a = Math.PI + d / RR
      return { x: -eL + Math.cos(a) * RR, z: -eW + Math.sin(a) * RR, nx: Math.cos(a), nz: Math.sin(a), seg }
    }
    case 6: return { x: -eL + d, z: -HW, nx: 0, nz: -1, seg }
    default: {
      const a = 1.5 * Math.PI + d / RR
      return { x: eL + Math.cos(a) * RR, z: -eW + Math.sin(a) * RR, nx: Math.cos(a), nz: Math.sin(a), seg }
    }
  }
}

/** Known props the trunks must not swallow (flags, pavilion, water tank). */
const OBSTACLES: ReadonlyArray<{ x: number; z: number; r: number }> = [
  { x: -PITCH.wallL / 2 - 7, z: PITCH.wallW / 2 + 5, r: 5 }, // pavilion
  { x: PITCH.wallL / 2 + 8, z: -PITCH.wallW / 2 - 6, r: 5 }, // water tank
  { x: PITCH.halfL + 3.6, z: PITCH.halfW + 3.6, r: 2.6 },
  { x: -PITCH.halfL - 3.6, z: PITCH.halfW + 3.6, r: 2.6 },
  { x: PITCH.halfL + 3.6, z: -PITCH.halfW - 3.6, r: 2.6 },
  { x: -PITCH.halfL - 3.6, z: -PITCH.halfW - 3.6, r: 2.6 },
]

interface Spot {
  x: number
  z: number
  seg: number
}

function placeRing(count: number, jitterT: number, offsetFor: (seg: number, rng: () => number) => number, rng: () => number): Spot[] {
  const out: Spot[] = []
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count + (rng() - 0.5) * jitterT
    const p = ringPoint(t)
    let off = offsetFor(p.seg, rng)
    // nudge clear of any prop
    let x = p.x + p.nx * off
    let z = p.z + p.nz * off
    for (const o of OBSTACLES) {
      const d = Math.hypot(x - o.x, z - o.z)
      if (d < o.r + 1.6) {
        off += o.r + 1.6 - d + 1.4
        x = p.x + p.nx * off
        z = p.z + p.nz * off
      }
    }
    out.push({ x, z, seg: p.seg })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Palettes                                                            */
/* ------------------------------------------------------------------ */

const TONES_RED = ['#e8532f', '#d9431f', '#f2703f', '#c93b1f', '#ef6338'].map((c) => new THREE.Color(c))
const TONES_GREEN = ['#7fae5a', '#6b9c4f', '#8fbf68', '#5f8f45', '#86b35f'].map((c) => new THREE.Color(c))
const TONES_MIXED = ['#e8532f', '#f2a13c', '#ef6338', '#d9431f', '#f2b45c'].map((c) => new THREE.Color(c))
const TRUNK_TONES = ['#5c4032', '#6b4a36', '#503527', '#63483a'].map((c) => new THREE.Color(c))

type Palette = 'red' | 'green' | 'mixed'

/** Low-discrepancy pick so the 60/30/10 mix holds on every ring. */
function pickPalette(u: number): Palette {
  return u < 0.6 ? 'red' : u < 0.9 ? 'green' : 'mixed'
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export function createTrees(quality: Quality): TreesModule {
  const rng = makeRng(0x5e17a)
  const group = new THREE.Group()
  const sites: TreeSite[] = []
  const detail2Hero = quality !== 'low'

  interface Bucket {
    canopy: THREE.BufferGeometry[]
    trunk: THREE.BufferGeometry[]
  }
  const buckets: Record<'main' | 'row2' | 'shrub', Record<Palette, Bucket>> = {
    main: { red: { canopy: [], trunk: [] }, green: { canopy: [], trunk: [] }, mixed: { canopy: [], trunk: [] } },
    row2: { red: { canopy: [], trunk: [] }, green: { canopy: [], trunk: [] }, mixed: { canopy: [], trunk: [] } },
    shrub: { red: { canopy: [], trunk: [] }, green: { canopy: [], trunk: [] }, mixed: { canopy: [], trunk: [] } },
  }

  const UP = new THREE.Vector3(0, 1, 0)
  const branchQuat = new THREE.Quaternion()
  const branchMat = new THREE.Matrix4()
  const branchMid = new THREE.Vector3()
  const branchDir = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)

  /** Build one tree in world space, pushing geometry into `bucket`. */
  const buildTree = (x: number, z: number, big: boolean, palette: Palette, bucket: Bucket, wantSite: boolean): void => {
    const treePhase = rng() * Math.PI * 2
    const trunkTone = TRUNK_TONES[Math.floor(rng() * TRUNK_TONES.length)]
    const branchTone = trunkTone.clone().multiplyScalar(1.18)

    const trunkH = big ? 3.4 + rng() * 1.3 : 2.5 + rng() * 0.9
    const botR = (big ? 0.27 : 0.2) + rng() * (big ? 0.08 : 0.05)
    const topR = botR * 0.55
    const leanX = (rng() - 0.5) * 0.09
    const leanZ = (rng() - 0.5) * 0.09

    // ---- trunk (tapered, slight lean) ----
    const trunkGeo = new THREE.CylinderGeometry(topR, botR, trunkH, 7, 1, true)
    trunkGeo.translate(0, trunkH / 2, 0)
    trunkGeo.rotateZ(leanX)
    trunkGeo.rotateX(leanZ)
    const trunk = trunkGeo.index ? trunkGeo.toNonIndexed() : trunkGeo
    if (trunk !== trunkGeo) trunkGeo.dispose()
    stampColor(trunk, trunkTone)
    stampSway(trunk, { phase: treePhase, bendBase: 0, bendSpan: trunkH, maxHoriz: 1, weight: 0.34, rng })
    const treeTrunks: THREE.BufferGeometry[] = [trunk]

    // ---- canopy: asymmetric clump cluster around the (leaned) trunk top ----
    const topX = -Math.sin(leanX) * trunkH
    const topZ = Math.sin(leanZ) * trunkH
    const heroR = big ? 2.1 + rng() * 0.7 : 1.45 + rng() * 0.5
    const heroDetail = detail2Hero && big && palette === 'red' && rng() < 0.85 ? 2 : 1
    const spread = palette === 'red' ? (big ? 1.02 : 0.85) : palette === 'green' ? 0.66 : 0.84
    const canopyY = trunkH + heroR * 0.38
    const biasA = rng() * Math.PI * 2

    const clumpSpecs: Array<{ cx: number; cy: number; cz: number; r: number; detail: number }> = []
    clumpSpecs.push({
      cx: topX + Math.cos(biasA) * 0.25,
      cy: canopyY,
      cz: topZ + Math.sin(biasA) * 0.25,
      r: heroR,
      detail: heroDetail,
    })
    const sats = big ? 4 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 2)
    for (let i = 0; i < sats; i++) {
      const a = biasA + (rng() - 0.5) * 2.7
      const d = heroR * (0.5 + rng() * 0.7) * spread + 0.45
      clumpSpecs.push({
        cx: topX + Math.cos(a) * d,
        cy: canopyY + (rng() - 0.42) * heroR * (palette === 'red' ? 0.85 : 1.0),
        cz: topZ + Math.sin(a) * d,
        r: heroR * (0.42 + rng() * 0.33),
        detail: 1,
      })
    }

    const tones = palette === 'red' ? TONES_RED : palette === 'green' ? TONES_GREEN : TONES_MIXED
    const bendBase = trunkH * 0.5
    const bendSpan = Math.max(1.2, canopyY + heroR * 0.8 - bendBase)
    const treeCanopy: THREE.BufferGeometry[] = []

    for (let i = 0; i < clumpSpecs.length; i++) {
      const spec = clumpSpecs[i]
      // mixed trees occasionally carry one green satellite clump
      const clumpTones =
        palette === 'mixed' && i > 0 && rng() < 0.22 ? TONES_GREEN : tones
      const clump = buildClump(spec.r, spec.detail, clumpTones, rng)
      clump.translate(spec.cx, spec.cy, spec.cz)
      stampSway(clump, {
        phase: treePhase + i * 1.13 + rng() * 0.5,
        bendBase,
        bendSpan,
        maxHoriz: heroR * 1.5 * spread + 0.6,
        weight: 1,
        rng,
      })
      treeCanopy.push(clump)
    }

    // ---- branch forks reaching toward three of the satellite clumps ----
    const nBranch = big ? 3 : 2
    for (let k = 0; k < nBranch && k + 1 < clumpSpecs.length; k++) {
      const spec = clumpSpecs[k + 1]
      branchMid.set(topX * 0.5, trunkH * (0.62 + rng() * 0.2), topZ * 0.5)
      branchDir.set(spec.cx * 0.82 - branchMid.x, spec.cy * 0.8 - branchMid.y, spec.cz * 0.82 - branchMid.z)
      const len = branchDir.length()
      if (len < 0.4) continue
      branchQuat.setFromUnitVectors(UP, branchDir.normalize())
      branchMat.compose(branchMid.addScaledVector(branchDir, len * 0.5), branchQuat, one)
      const bg = new THREE.CylinderGeometry(0.042, 0.085, len, 5, 1, true)
      bg.applyMatrix4(branchMat)
      const branch = bg.index ? bg.toNonIndexed() : bg
      if (branch !== bg) bg.dispose()
      stampColor(branch, branchTone)
      stampSway(branch, {
        phase: treePhase + k * 0.8,
        bendBase: trunkH * 0.45,
        bendSpan: Math.max(1, canopyY - trunkH * 0.45),
        maxHoriz: heroR,
        weight: 0.62,
        rng,
      })
      treeTrunks.push(branch)
    }

    // move everything from tree-local to world, then hand over to the bucket
    for (const g of treeCanopy) {
      g.translate(x, 0, z)
      bucket.canopy.push(g)
    }
    for (const g of treeTrunks) {
      g.translate(x, 0, z)
      bucket.trunk.push(g)
    }

    if (wantSite) {
      sites.push({ x, z, y: canopyY + heroR * 0.1, r: heroR * 1.12, red: palette !== 'green' })
    }
  }

  // ---- main ring: 17 big trees hugging the outside of the boundary wall ----
  const mainSpots = placeRing(
    17,
    0.02,
    (seg, r) => 6 + r() * 3.2,
    rng,
  )
  mainSpots.forEach((s, i) => {
    const palette = pickPalette((i * 0.618 + rng() * 0.1) % 1)
    buildTree(s.x, s.z, true, palette, buckets.main[palette], true)
  })

  // ---- second row: 19 smaller trees, wider out (density toggle) ----
  const row2Spots = placeRing(
    19,
    0.03,
    (seg, r) => {
      // E/W: clear the power-pole ring at |x| = 45.5; N/S + arcs: snugger
      if (seg === 0 || seg === 4) return 21.5 + r() * 4.5
      if (seg === 2 || seg === 6) return 14 + r() * 4.5
      return 15 + r() * 5
    },
    rng,
  )
  row2Spots.forEach((s, i) => {
    const palette = pickPalette((i * 0.618 + 0.31 + rng() * 0.1) % 1)
    buildTree(s.x, s.z, false, palette, buckets.row2[palette], false)
  })

  // ---- shrubs: low bushes at the wall corners + two outside the compound ----
  const shrubSpots: Array<[number, number]> = [
    [PITCH.halfL + 6.4, PITCH.halfW + 5.6],
    [-PITCH.halfL - 6.8, PITCH.halfW + 4.6],
    [PITCH.halfL + 5.2, -PITCH.halfW - 6.2],
    [-PITCH.halfL - 5.6, -PITCH.halfW - 5.2],
    [-PITCH.wallL / 2 - 3.4, PITCH.wallW / 2 + 9.6], // by the pavilion approach
    [PITCH.wallL / 2 + 4.6, -PITCH.wallW / 2 - 4.4], // by the water-tank side
  ]
  for (const [sx, sz] of shrubSpots) {
    const palette: Palette = rng() < 0.7 ? 'green' : 'mixed'
    const bucket = buckets.shrub[palette]
    const n = 2 + Math.floor(rng() * 2)
    for (let i = 0; i < n; i++) {
      const r = 0.45 + rng() * 0.42
      const tones = palette === 'green' ? TONES_GREEN : TONES_MIXED
      const clump = buildClump(r, 1, tones, rng)
      const cx = sx + (rng() - 0.5) * 1.1
      const cy = 0.34 + rng() * 0.34 + r * 0.4
      const cz = sz + (rng() - 0.5) * 1.1
      clump.translate(cx, cy, cz)
      stampSway(clump, {
        phase: rng() * Math.PI * 2,
        bendBase: 0.1,
        bendSpan: 1.1,
        maxHoriz: 1.2,
        weight: 0.5,
        rng,
      })
      bucket.canopy.push(clump)
    }
  }

  /* ---- materials (shared; sway patched) ---- */
  const leafAlpha = makeLeafAlphaTexture()
  const makeCanopyMat = (emissive: string, key: string): THREE.MeshToonMaterial => {
    const mat = makeToonMaterial({
      color: '#ffffff',
      vertexColors: true,
      emissive,
      emissiveIntensity: 0.28,
    })
    injectSway(mat, key)
    return mat
  }
  const matCanopyRed = makeCanopyMat('#611606', 'gg-tree-toon-red')
  const matCanopyGreen = makeCanopyMat('#16380e', 'gg-tree-toon-green')
  const matCanopyMixed = makeCanopyMat('#57300b', 'gg-tree-toon-mixed')
  const matTrunk = makeToonMaterial({ color: '#ffffff', vertexColors: true })
  injectSway(matTrunk, 'gg-tree-toon-trunk')

  const canopyDepthMat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    alphaMap: leafAlpha,
    alphaTest: 0.5,
  })
  injectSway(canopyDepthMat, 'gg-tree-depth-canopy')
  const trunkDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  injectSway(trunkDepthMat, 'gg-tree-depth-trunk')

  const matOutlineCanopy = makeSwayOutlineMaterial('#4b2113', 'gg-tree-outline-canopy')
  const matOutlineTrunk = makeSwayOutlineMaterial('#3a2e28', 'gg-tree-outline-trunk')

  const addShell = (mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial): void => {
    const geo = mesh.geometry
    if (!geo.getAttribute('aOutlineNormal')) {
      const n = geo.getAttribute('normal') as THREE.BufferAttribute
      // non-indexed → face normals ARE the smoothed hull normals (matches addOutline)
      geo.setAttribute('aOutlineNormal', new THREE.BufferAttribute(new Float32Array(n.array as Float32Array), 3))
    }
    const shell = new THREE.Mesh(geo, mat)
    shell.renderOrder = 2
    mesh.add(shell)
  }

  const row2Meshes: THREE.Mesh[] = []
  const buildRing = (
    ring: 'main' | 'row2',
    outline: boolean,
  ): void => {
    for (const palette of ['red', 'green', 'mixed'] as const) {
      const bucket = buckets[ring][palette]
      if (bucket.canopy.length === 0) continue
      const canopyMesh = new THREE.Mesh(mergeAll(bucket.canopy), palette === 'red' ? matCanopyRed : palette === 'green' ? matCanopyGreen : matCanopyMixed)
      canopyMesh.castShadow = true
      canopyMesh.customDepthMaterial = canopyDepthMat
      group.add(canopyMesh)
      if (outline) addShell(canopyMesh, matOutlineCanopy)
      if (ring === 'row2') row2Meshes.push(canopyMesh)
    }
    const trunkMesh = new THREE.Mesh(mergeAll(buckets[ring].red.trunk.concat(buckets[ring].green.trunk, buckets[ring].mixed.trunk)), matTrunk)
    trunkMesh.castShadow = true
    trunkMesh.customDepthMaterial = trunkDepthMat
    group.add(trunkMesh)
    if (outline) addShell(trunkMesh, matOutlineTrunk)
    if (ring === 'row2') row2Meshes.push(trunkMesh)
  }
  buildRing('main', true)
  buildRing('row2', false)

  // shrubs (always visible)
  {
    const shrubGeos = buckets.shrub.red.canopy
      .concat(buckets.shrub.green.canopy, buckets.shrub.mixed.canopy)
    if (shrubGeos.length > 0) {
      const shrubMesh = new THREE.Mesh(mergeAll(shrubGeos), matCanopyGreen)
      shrubMesh.castShadow = true
      shrubMesh.customDepthMaterial = canopyDepthMat
      group.add(shrubMesh)
    }
  }

  /* ---- gust envelope (petals + skyline read this too) ---- */
  let gust = 0
  let nextGustIn = 4 + rng() * 7
  let gustT = -1
  let gustDur = 2.5

  const update = (dt: number, elapsed: number): number => {
    WIND_UNIFORMS.uTime.value = elapsed
    if (gustT < 0) {
      nextGustIn -= dt
      if (nextGustIn <= 0) {
        gustT = 0
        gustDur = 2 + rng() * 1.2
      }
    } else {
      gustT += dt
      const t = gustT / gustDur
      if (t >= 1) {
        gust = 0
        gustT = -1
        nextGustIn = 8 + rng() * 12
      } else {
        gust = Math.pow(Math.sin(Math.PI * t), 0.65)
      }
    }
    WIND_UNIFORMS.uGust.value = gust
    return gust
  }

  return {
    group,
    sites,
    update,
    setDetail(on: boolean) {
      for (const m of row2Meshes) m.visible = on
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
      })
      matCanopyRed.dispose()
      matCanopyGreen.dispose()
      matCanopyMixed.dispose()
      matTrunk.dispose()
      canopyDepthMat.dispose()
      trunkDepthMat.dispose()
      matOutlineCanopy.dispose()
      matOutlineTrunk.dispose()
      leafAlpha.dispose()
    },
  }
}
