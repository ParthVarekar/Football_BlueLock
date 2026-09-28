/**
 * Ambient gulmohar fallout — the ground is never still.
 *
 * A single InstancedMesh of tinted petal sprites continuously rains from the
 * tree canopies (spawn sites come from trees.ts's main ring): per-petal
 * flutter (sine sway + spin + tilt wobble), ~2.5–5 s descents, a brief rest +
 * shrink on the ground, then respawn at a canopy. ~15% of spawns are green
 * neem leaves. Every 8–20 s a 2–3 s gust (driven by trees.ts's envelope)
 * strengthens the +X drift, spawns a burst of low "blowers" that stream across
 * the pitch apron from the upwind trees, and fades out downwind. Petals beyond
 * ~90 m of the camera recycle instantly, so the pool stays frustum-friendly.
 *
 * Bonus grounding: soft petal-carpet decals (one merged alpha mesh) under the
 * biggest gulmohars.
 */
import * as THREE from 'three'
import type { Quality } from '../core/constants'
import type { TreeSite } from './trees'

export interface PetalsModule {
  readonly group: THREE.Group
  update(dt: number, elapsed: number, gust: number, camX: number, camZ: number): void
  setQuality(q: Quality): void
  dispose(): void
}

const MAX = 420
const COUNTS: Record<Quality, number> = { low: 140, medium: 240, high: 420 }
const WIND_X = 0.42

const RED_TONES = ['#e8532f', '#f2703f', '#ef6338', '#e8642f', '#f28a2e', '#f2a13c']
const GREEN_TONES = ['#7fae5a', '#6b9c4f', '#8fbf68']

/** Neutral (near-white) petal sprite — instanceColor does the tinting. */
function makePetalSprite(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.beginPath()
  ctx.moveTo(32, 58)
  ctx.bezierCurveTo(20, 54, 13, 36, 24, 18)
  ctx.bezierCurveTo(28, 11, 31, 8, 32, 5)
  ctx.bezierCurveTo(33, 8, 36, 11, 40, 18)
  ctx.bezierCurveTo(51, 36, 44, 54, 32, 58)
  ctx.closePath()
  const g = ctx.createRadialGradient(32, 36, 4, 32, 36, 30)
  g.addColorStop(0, '#fff8ee')
  g.addColorStop(0.65, '#fdf4e6')
  g.addColorStop(1, '#e7d8c2')
  ctx.fillStyle = g
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(27, 44)
  ctx.quadraticCurveTo(25, 34, 28, 26)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  // NO mipmaps: at distance the mip-averaged alpha of the thin petal shape
  // falls below the alphaTest cut and the whole sprite vanishes
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

/** Scattered petal shapes for the carpet decals (tinted per decal via vColor). */
function makeCarpetTexture(): THREE.CanvasTexture {
  const S = 256
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  let seed = 0x7a3f21
  const rng = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const petal = (cx: number, cy: number, r: number, rot: number, dark: number): void => {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rot)
    ctx.beginPath()
    ctx.moveTo(0, -r)
    ctx.bezierCurveTo(-r * 0.9, -r * 0.5, -r * 0.75, r * 0.6, 0, r)
    ctx.bezierCurveTo(r * 0.75, r * 0.6, r * 0.9, -r * 0.5, 0, -r)
    ctx.closePath()
    const g = ctx.createRadialGradient(0, -r * 0.2, r * 0.1, 0, 0, r * 1.2)
    g.addColorStop(0, 'rgba(255,250,240,1)')
    g.addColorStop(1, `rgba(${Math.round(238 - dark * 40)},${Math.round(224 - dark * 60)},${Math.round(200 - dark * 70)},1)`)
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
  }
  for (let i = 0; i < 26; i++) {
    petal(20 + rng() * 216, 20 + rng() * 216, 7 + rng() * 9, rng() * Math.PI * 2, rng() * 0.6)
  }
  for (let i = 0; i < 6; i++) {
    ctx.save()
    ctx.translate(30 + rng() * 196, 30 + rng() * 196)
    ctx.rotate(rng() * Math.PI * 2)
    ctx.strokeStyle = 'rgba(236,238,214,1)'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.quadraticCurveTo(s * 10, -8, s * 16, -18)
      ctx.stroke()
    }
    ctx.restore()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

export function createAmbientPetals(sites: readonly TreeSite[], quality: Quality): PetalsModule {
  const group = new THREE.Group()
  const rng = Math.random // ambience may be non-deterministic

  const petalTex = makePetalSprite()
  const carpetTex = makeCarpetTexture()

  const mat = new THREE.MeshBasicMaterial({
    map: petalTex,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    fog: true,
  })
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.19, 0.13), mat, MAX)
  mesh.frustumCulled = false
  mesh.renderOrder = 3
  group.add(mesh)

  // ---- state (structure of arrays) ----
  const active = new Uint8Array(MAX)
  const kind = new Uint8Array(MAX) // 0 fall · 1 blow · 2 rest
  const px = new Float32Array(MAX)
  const py = new Float32Array(MAX)
  const pz = new Float32Array(MAX)
  const vx = new Float32Array(MAX)
  const vy = new Float32Array(MAX)
  const phase = new Float32Array(MAX)
  const rotV = new Float32Array(MAX)
  const tilt = new Float32Array(MAX)
  const restT = new Float32Array(MAX)
  const scl = new Float32Array(MAX)

  const redSites = sites.filter((s) => s.red)
  const greenSites = sites.filter((s) => !s.red)
  const bigRed = [...redSites].sort((a, b) => b.r - a.r).slice(0, 5)

  const scratchM = new THREE.Matrix4()
  const scratchQ = new THREE.Quaternion()
  const scratchE = new THREE.Euler()
  const scratchP = new THREE.Vector3()
  const scratchS = new THREE.Vector3()
  const tint = new THREE.Color()
  const zeroM = new THREE.Matrix4().makeScale(0, 0, 0)

  let nActive = 0
  let target = COUNTS[quality]
  let blowerTimer = 0
  let baseBlowTimer = 0.8
  let colorsDirty = false

  for (let i = 0; i < MAX; i++) {
    mesh.setMatrixAt(i, zeroM)
    mesh.setColorAt(i, tint.set('#ffffff'))
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

  const pickSite = (green: boolean, camX = 0, camZ = 0, nearBias = false): TreeSite | null => {
    const pool = green && greenSites.length > 0 ? greenSites : redSites.length > 0 ? redSites : sites
    if (pool.length === 0) return null
    if (!nearBias) return pool[Math.floor(rng() * pool.length)]
    // tournament pick — nearby sites win, so the player's tree showers hardest
    let best: TreeSite | null = null
    let bestD = Infinity
    for (let k = 0; k < 3; k++) {
      const s = pool[Math.floor(rng() * pool.length)]
      const d = Math.hypot(s.x - camX, s.z - camZ)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    return best
  }

  const tintFor = (): string => {
    if (rng() < 0.15 && greenSites.length > 0) return GREEN_TONES[Math.floor(rng() * GREEN_TONES.length)]
    return RED_TONES[Math.floor(rng() * RED_TONES.length)]
  }

  /** (Re)spawn a canopy faller in slot i. Returns false if no site near camera. */
  const spawnFaller = (i: number, camX: number, camZ: number, initial: boolean): boolean => {
    for (let tries = 0; tries < 5; tries++) {
      const site = pickSite(rng() < 0.15, camX, camZ, true)
      if (!site) return false
      const sx = site.x + (rng() - 0.5) * site.r * 1.5
      const sz = site.z + (rng() - 0.5) * site.r * 1.5
      if (Math.hypot(sx - camX, sz - camZ) > 90) continue
      const spawnY = initial ? 0.4 + rng() * (site.y - 0.4) : Math.min(4.6, site.y + (rng() - 0.25) * 1.4)
      if (!active[i]) nActive++
      active[i] = 1
      kind[i] = 0
      px[i] = sx
      py[i] = Math.max(0.6, spawnY)
      pz[i] = sz
      vx[i] = 0
      vy[i] = -(0.95 + rng() * 0.65)
      phase[i] = rng() * Math.PI * 2
      rotV[i] = (rng() - 0.5) * 7
      tilt[i] = (rng() - 0.5) * 2.2
      scl[i] = 0.85 + rng() * 0.5
      mesh.setColorAt(i, tint.set(tintFor()))
      colorsDirty = true
      return true
    }
    return false
  }

  /** Spawn a low gust blower that streams across the apron. */
  const spawnBlower = (i: number): boolean => {
    const west = sites.filter((s) => s.x < -18)
    const pool = west.length > 0 ? west : sites
    const site = pool[Math.floor(rng() * pool.length)]
    if (!site) return false
    if (!active[i]) nActive++
    active[i] = 1
    kind[i] = 1
    px[i] = site.x + (rng() - 0.5) * site.r
    pz[i] = site.z + (rng() - 0.5) * site.r * 2
    py[i] = 0.35 + rng() * 1.15
    vx[i] = 3.4 + rng() * 2.8
    vy[i] = -(0.08 + rng() * 0.28)
    phase[i] = rng() * Math.PI * 2
    rotV[i] = (rng() - 0.5) * 11
    tilt[i] = (rng() - 0.5) * 1.4
    scl[i] = 0.8 + rng() * 0.5
    mesh.setColorAt(i, tint.set(tintFor()))
    colorsDirty = true
    return true
  }

  const deactivate = (i: number): void => {
    if (active[i]) nActive--
    active[i] = 0
    mesh.setMatrixAt(i, zeroM)
  }

  const update = (dt: number, elapsed: number, gust: number, camX: number, camZ: number): void => {
    colorsDirty = false

    // maintain ambient density (fast ramp so a fresh page showers quickly)
    let spawns = 8
    while (spawns > 0 && nActive < target) {
      const i = active.indexOf(0)
      if (i < 0) break
      if (!spawnFaller(i, camX, camZ, elapsed < 3)) break
      spawns--
    }

    // gust blowers streaking low across the apron
    if (gust > 0.3) {
      blowerTimer -= dt
      if (blowerTimer <= 0) {
        blowerTimer = 0.09 + rng() * 0.09
        const i = active.indexOf(0)
        if (i >= 0) spawnBlower(i)
      }
    }

    // a light base stream always crosses the apron so the air is never dead
    baseBlowTimer -= dt
    if (baseBlowTimer <= 0) {
      baseBlowTimer = 0.35 + rng() * 0.45
      const i = active.indexOf(0)
      if (i >= 0 && nActive < target + 60) spawnBlower(i)
    }

    let anyMatrix = false
    for (let i = 0; i < MAX; i++) {
      if (!active[i]) continue
      anyMatrix = true

      if (kind[i] === 2) {
        // resting on the ground: flatten + shrink away
        restT[i] -= dt
        scl[i] = Math.max(0.08, scl[i] - dt * 0.9)
        tilt[i] += (-1.45 - tilt[i]) * Math.min(1, dt * 6)
        if (restT[i] <= 0) {
          deactivate(i)
          continue
        }
      } else {
        const blowing = kind[i] === 1
        const wind = WIND_X * (1 + gust * 2.4) + (blowing ? vx[i] : 0)
        px[i] += (wind + Math.sin(elapsed * 1.9 + phase[i]) * 0.5) * dt
        pz[i] += Math.cos(elapsed * 1.5 + phase[i] * 1.3) * 0.34 * dt
        py[i] += (vy[i] + Math.sin(elapsed * 2.6 + phase[i] * 1.7) * 0.16) * dt

        if (blowing) {
          if (px[i] > 55 || Math.hypot(px[i] - camX, pz[i] - camZ) > 95) {
            deactivate(i)
            continue
          }
          if (py[i] < 0.06) py[i] = 0.06 + rng() * 0.1 // skip along the grass
        } else if (py[i] <= 0.03) {
          kind[i] = 2
          restT[i] = 1.8 + rng() * 1.6
          py[i] = 0.035
        } else if (Math.hypot(px[i] - camX, pz[i] - camZ) > 90) {
          deactivate(i)
          spawnFaller(i, camX, camZ, false)
          continue
        }
      }

      const wobble = kind[i] === 2 ? 0.1 : Math.sin(elapsed * 3.1 + phase[i]) * 0.55
      // billboard toward the camera (+ flutter) — a randomly-tilted plane is
      // edge-on to the viewer half the time and reads as nothing
      const yawFace = Math.atan2(px[i] - camX, pz[i] - camZ)
      scratchE.set(tilt[i] * 0.6 + wobble * 0.6, yawFace + tilt[i] * 0.5 + elapsed * rotV[i] * 0.25, wobble * 0.8)
      scratchQ.setFromEuler(scratchE)
      scratchP.set(px[i], py[i], pz[i])
      const s = scl[i]
      mesh.setMatrixAt(i, scratchM.compose(scratchP, scratchQ, scratchS.set(s, s, s)))
    }

    if (anyMatrix) mesh.instanceMatrix.needsUpdate = true
    if (colorsDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  /* ---- petal-carpet decals under the biggest gulmohars ---- */
  let carpetMat: THREE.MeshBasicMaterial | null = null
  let carpetGeo: THREE.BufferGeometry | null = null
  if (bigRed.length > 0) {
    const decals: THREE.BufferGeometry[] = []
    const carpetTints = [new THREE.Color('#e8532f'), new THREE.Color('#d9431f'), new THREE.Color('#ef6338')]
    for (let s = 0; s < bigRed.length; s++) {
      const site = bigRed[s]
      const n = 2 + (s % 2)
      for (let k = 0; k < n; k++) {
        const size = 1.5 + rng() * 1.1
        const geo = new THREE.PlaneGeometry(size, size * (0.75 + rng() * 0.4))
        geo.rotateX(-Math.PI / 2)
        geo.rotateZ(rng() * Math.PI * 2)
        geo.translate(
          site.x + (rng() - 0.5) * site.r * 1.3,
          0.012 + k * 0.003,
          site.z + (rng() - 0.5) * site.r * 1.3,
        )
        const c = carpetTints[(s + k) % carpetTints.length]
        const a = 0.42 + rng() * 0.18
        const count = geo.getAttribute('position').count
        const colors = new Float32Array(count * 4)
        for (let v = 0; v < count; v++) {
          colors[v * 4] = c.r
          colors[v * 4 + 1] = c.g
          colors[v * 4 + 2] = c.b
          colors[v * 4 + 3] = a
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 4))
        decals.push(geo)
      }
    }
    carpetGeo = new THREE.BufferGeometry()
    const names = ['position', 'normal', 'uv', 'color'] as const
    for (const name of names) {
      const itemSize = (decals[0].getAttribute(name) as THREE.BufferAttribute).itemSize
      let total = 0
      for (const g of decals) total += (g.getAttribute(name) as THREE.BufferAttribute).count
      const data = new Float32Array(total * itemSize)
      let off = 0
      for (const g of decals) {
        const a = g.getAttribute(name) as THREE.BufferAttribute
        data.set(a.array as ArrayLike<number>, off)
        off += a.count * itemSize
      }
      carpetGeo.setAttribute(name, new THREE.BufferAttribute(data, itemSize))
    }
    for (const g of decals) g.dispose()
    carpetMat = new THREE.MeshBasicMaterial({
      map: carpetTex,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      fog: true,
    })
    const carpet = new THREE.Mesh(carpetGeo, carpetMat)
    carpet.renderOrder = 1
    group.add(carpet)
  }

  return {
    group,
    update,
    setQuality(q: Quality) {
      target = COUNTS[q]
    },
    dispose() {
      mesh.geometry.dispose()
      mat.dispose()
      petalTex.dispose()
      if (carpetGeo) carpetGeo.dispose()
      if (carpetMat) carpetMat.dispose()
      carpetTex.dispose()
      group.clear()
    },
  }
}
