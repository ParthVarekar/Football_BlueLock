/**
 * The maidan: pitch, goals, gulmohar trees, boundary wall, crowd, sky, kites,
 * dust motes, power poles with sagging wires, painted hoardings and a hazy
 * city skyline. Built once, animated cheaply, density switchable at runtime.
 */
import * as THREE from 'three'
import { GOAL, NET_BACK_H, PALETTE, PITCH, type Quality, QUALITY } from '../core/constants'
import { makeToonMaterial } from './toon'
import { addOutline } from './outline'
import {
  makeApronTexture,
  makeBrickTexture,
  makeBuildingTexture,
  makeCrowdTexture,
  makeDotTexture,
  makeNetTexture,
  makePitchTexture,
  makePlasterTexture,
  makeTuftTexture,
} from './textures'
import { createSky } from './sky'
import { createTrees } from './trees'
import { createSkyline } from './skyline'
import { createAmbientPetals } from './petals'
import { makeRng } from '../core/math'

export interface World {
  readonly group: THREE.Group
  /** Advance ambient animation (kites, motes, canopy sway, crowd idle, sky). */
  step(dt: number, elapsed: number, camX: number, camZ: number): void
  /** Crowd jumps + cheers envelope for ~2 s. */
  cheerCrowd(): void
  /** Wobble the net at goal line `goalX` (±halfL) with 0..1 strength. */
  wobbleNet(goalX: number, strength: number): void
  /** Toggle the decorative density layer (poles, wires, hoardings, skyline). */
  setDetail(on: boolean): void
  /** Live-adjust instanced counts (graphics settings). */
  setCounts(tufts: number, crowd: number): void
  /** Re-tune the procedural sky (noise octaves, cirrus, birds). */
  setQuality(q: Quality): void
  dispose(): void
}

function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

function roundedRectPath(w: number, h: number, r: number): THREE.Path {
  const s = roundedRectShape(w, h, r)
  return new THREE.Path(s.getPoints(24).map((p) => new THREE.Vector2(p.x, p.y)))
}

/** Minimal indexed merge (position / normal / uv) for our primitive needs. */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const hasIndex = geos.every((g) => g.index !== null)
  const attrs: Array<keyof typeof geos[0]['attributes']> = ['position', 'normal', 'uv']
  const out = new THREE.BufferGeometry()
  const parts = attrs
    .map((name) => ({ name, arrays: geos.map((g) => g.getAttribute(name as string) as THREE.BufferAttribute | undefined) }))
    .map(({ name, arrays }) => ({ name, arrays: arrays.filter((a): a is THREE.BufferAttribute => !!a) }))
    .filter(({ arrays }) => arrays.length === geos.length)
  for (const { name, arrays } of parts) {
    const itemSize = arrays[0].itemSize
    const total = arrays.reduce((n, a) => n + a.count, 0)
    const data = new Float32Array(total * itemSize)
    let off = 0
    for (const a of arrays) {
      data.set(a.array as ArrayLike<number>, off)
      off += a.count * itemSize
    }
    out.setAttribute(name as string, new THREE.BufferAttribute(data, itemSize))
  }
  if (hasIndex) {
    const total = geos.reduce((n, g) => n + (g.index as THREE.BufferAttribute).count, 0)
    const index = new Uint32Array(total)
    let off = 0
    let base = 0
    for (const g of geos) {
      const idx = g.index as THREE.BufferAttribute
      for (let i = 0; i < idx.count; i++) index[off + i] = idx.getX(i) + base
      off += idx.count
      base += (g.getAttribute('position') as THREE.BufferAttribute).count
    }
    out.setIndex(new THREE.BufferAttribute(index, 1))
  }
  return out
}

/** A small painted hoarding panel texture (no text — brush bars + a ball). */
function makeHoardingTexture(hue: string, hue2: string): THREE.CanvasTexture {
  const W = 256
  const H = 96
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, hue)
  g.addColorStop(1, hue2)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  // hand brush bars
  const cols = ['#fbf3e2', '#2f2823', '#ffe9c4']
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = cols[i % cols.length]
    ctx.globalAlpha = 0.55 + (i % 2) * 0.25
    const y = 12 + i * 14
    ctx.beginPath()
    ctx.moveTo(16, y)
    ctx.quadraticCurveTo(W / 2, y + (i % 2 === 0 ? -8 : 8), W - 16, y + (i % 3 === 0 ? 3 : -3))
    ctx.lineTo(W - 16, y + 7)
    ctx.quadraticCurveTo(W / 2, y + (i % 2 === 0 ? 0 : 15), 16, y + 7)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalAlpha = 1
  // painted ball
  ctx.strokeStyle = '#2f2823'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(W - 42, H - 34, 17, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = '#fbf3e2'
  ctx.beginPath()
  ctx.arc(W - 42, H - 34, 15, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#2f2823'
  ctx.beginPath()
  ctx.arc(W - 42, H - 34, 5.5, 0, Math.PI * 2)
  ctx.fill()
  // frame
  ctx.strokeStyle = 'rgba(47,40,35,0.85)'
  ctx.lineWidth = 5
  ctx.strokeRect(2.5, 2.5, W - 5, H - 5)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

export function createWorld(scene: THREE.Scene, quality: Quality): World {
  const q = QUALITY[quality]
  const rng = makeRng(20240601)
  const group = new THREE.Group()
  scene.add(group)
  const disposables: Array<{ dispose(): void }> = []
  const texDisposables: Array<THREE.Texture> = []

  // fog opens later so the painted skyline holds its colour
  scene.fog = new THREE.Fog(PALETTE.fog, 84, 385)

  // ---------------------------------------------------------------- sky
  // Fully procedural shader dome (golden-hour ramp + flowing clouds); the
  // module recentres on the camera every frame so the horizon never parallaxes.
  const sky = createSky()
  sky.setQuality(quality)
  group.add(sky.group)
  // Glue the painted sun to the scene's key light (toon.ts rig, created before
  // the world): the only shadow-casting directional light. Fed live each step
  // so the sky sun follows the golden-hour sag exactly.
  let sunLight: THREE.DirectionalLight | null = null
  scene.traverse((o) => {
    const l = o as THREE.DirectionalLight
    if (!sunLight && l.isDirectionalLight && l.castShadow) sunLight = l
  })
  const sunScratch = new THREE.Vector3()

  // ---------------------------------------------------------------- ground
  const dustTex = makePlasterTexture()
  dustTex.repeat.set(90, 90)
  const dust = new THREE.Mesh(
    new THREE.CircleGeometry(500, 40),
    makeToonMaterial({ color: PALETTE.dust, map: dustTex }),
  )
  dust.rotation.x = -Math.PI / 2
  dust.position.y = -0.03
  dust.receiveShadow = true
  group.add(dust)

  const apronTex = makeApronTexture()
  apronTex.repeat.set(7, 5)
  const apronGeo = new THREE.ShapeGeometry(roundedRectShape(PITCH.wallL + 7, PITCH.wallW + 7, PITCH.wallR + 3.5), 18)
  apronGeo.rotateX(-Math.PI / 2)
  const apron = new THREE.Mesh(apronGeo, makeToonMaterial({ color: '#8fa668', map: apronTex }))
  apron.position.y = -0.015
  apron.receiveShadow = true
  group.add(apron)

  // Pitch — rounded rect, UVs remapped to the painted canvas.
  const pitchGeo = new THREE.ShapeGeometry(roundedRectShape(PITCH.L, PITCH.W, PITCH.cornerR), 28)
  {
    const pos = pitchGeo.getAttribute('position') as THREE.BufferAttribute
    const uv = pitchGeo.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) + PITCH.halfL) / PITCH.L, (pos.getY(i) + PITCH.halfW) / PITCH.W)
    }
    uv.needsUpdate = true
  }
  pitchGeo.rotateX(-Math.PI / 2)
  const pitchTex = makePitchTexture()
  const pitch = new THREE.Mesh(pitchGeo, makeToonMaterial({ color: '#ffffff', map: pitchTex }))
  pitch.receiveShadow = true
  group.add(pitch)

  // ---------------------------------------------------------------- boundary wall
  const wallShape = roundedRectShape(PITCH.wallL, PITCH.wallW, PITCH.wallR)
  wallShape.holes.push(roundedRectPath(PITCH.wallL - 0.8, PITCH.wallW - 0.8, PITCH.wallR - 0.4))
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, { depth: 1.02, bevelEnabled: false, curveSegments: 10 })
  wallGeo.rotateX(-Math.PI / 2)
  const wallTex = makePlasterTexture()
  wallTex.repeat.set(0.32, 0.32)
  const wall = new THREE.Mesh(wallGeo, makeToonMaterial({ color: PALETTE.plaster, map: wallTex }))
  wall.castShadow = true
  wall.receiveShadow = true
  group.add(wall)

  // painted goal-line flags on the wall corners — cheap carnival detail
  const flagPoles = new THREE.Group()
  for (const [fx, fz] of [[PITCH.halfL + 3.6, PITCH.halfW + 3.6], [-PITCH.halfL - 3.6, PITCH.halfW + 3.6], [PITCH.halfL + 3.6, -PITCH.halfW - 3.6], [-PITCH.halfL - 3.6, -PITCH.halfW - 3.6]] as const) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6), makeToonMaterial({ color: '#7d7568' }))
    pole.position.set(fx, 1.3, fz)
    pole.castShadow = true
    flagPoles.add(pole)
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.4), makeToonMaterial({ color: rng() < 0.5 ? PALETTE.saffron : PALETTE.teal, side: THREE.DoubleSide }))
    flag.position.set(fx + 0.33, 2.35, fz)
    flagPoles.add(flag)
  }
  group.add(flagPoles)

  // ---------------------------------------------------------------- goals
  const metalMat = makeToonMaterial({ color: PALETTE.metal, emissive: '#3a3631', emissiveIntensity: 0.35 })
  const brickTex = makeBrickTexture()
  const brickMat = makeToonMaterial({ color: '#d8a184', map: brickTex })
  const netTex = makeNetTexture()
  const netMat = makeToonMaterial({
    color: '#f7f1e2',
    map: netTex,
    side: THREE.DoubleSide,
    alphaTest: 0.34, // above the mip-blurred coverage average — no white sheets at distance
  })
  const netDepthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: netTex, alphaTest: 0.34 })
  disposables.push(netDepthMat)
  // faint veil behind the ropes so distant nets read as volume, not holes
  const netVeilMat = new THREE.MeshBasicMaterial({
    color: '#efe7d5',
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: true,
  })
  disposables.push(netVeilMat)

  const nets: Array<{ mesh: THREE.Mesh; wobble: number; phase: number }> = []

  const buildGoal = (side: 1 | -1) => {
    const g = new THREE.Group()
    const x = side * PITCH.halfL
    const postH = GOAL.height

    for (const zs of [-GOAL.halfW, GOAL.halfW]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(GOAL.postR, GOAL.postR, postH, 10), metalMat)
      post.position.set(x, postH / 2, zs)
      post.castShadow = true
      g.add(post)
      addOutline(post, { widthPx: q.outlinePx })

      const stub = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), brickMat)
      stub.position.set(x, 0.17, zs)
      stub.castShadow = true
      g.add(stub)

      // rear stanchion
      const stanchion = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, NET_BACK_H, 8), metalMat)
      stanchion.position.set(x + side * (GOAL.depth - 0.03), NET_BACK_H / 2, zs * 0.98)
      stanchion.castShadow = true
      g.add(stanchion)
    }

    // crossbar with a hint of sag
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(GOAL.postR, GOAL.postR, GOAL.halfW * 2 + GOAL.postR * 2, 10), metalMat)
    bar.rotation.x = Math.PI / 2
    bar.rotation.z = 0.022
    bar.position.set(x, postH, 0)
    bar.castShadow = true
    g.add(bar)
    addOutline(bar, { widthPx: q.outlinePx })

    // ---- the net box: back net as tall as the rear stanchions, side nets that
    // taper from the posts down to it, and a roof that slopes DOWN from the
    // crossbar to the back — every panel meets its neighbours at the edges.
    // Rope density is the same on every panel (UVs in metres, 3 m per tile).
    const backH = NET_BACK_H
    const depth = GOAL.depth
    const netW = GOAL.halfW * 2
    const TILE = 3
    const metreUVs = (geo: THREE.BufferGeometry, w: number, h: number): void => {
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / TILE, (uv.getY(i) * h) / TILE)
      uv.needsUpdate = true
    }
    /** Local goal space (d = depth behind the line, y up, z across) → world. */
    const wp = (d: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x + side * d, y, z)

    // back net (bulging away from the pitch, sagging at the bottom)
    const backGeo = new THREE.PlaneGeometry(netW, backH, 10, 5)
    {
      const pos = backGeo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i)
        const ly = pos.getY(i) // -h/2..h/2
        const t = 1 - Math.abs(lx) / GOAL.halfW
        const drop = (1 - (ly + backH / 2) / backH) * 0.5
        pos.setZ(i, t * (0.12 + drop * 0.22)) // bulge away from pitch
        pos.setY(i, ly - t * 0.06 * drop)
      }
      backGeo.computeVertexNormals()
      metreUVs(backGeo, netW, backH)
    }
    const backNet = new THREE.Mesh(backGeo, netMat)
    backNet.position.set(x + side * (depth - 0.02), backH / 2, 0)
    backNet.rotation.y = side * Math.PI / 2
    backNet.customDepthMaterial = netDepthMat
    backNet.castShadow = true
    g.add(backNet)
    nets.push({ mesh: backNet, wobble: 0, phase: side })

    const backVeil = new THREE.Mesh(backGeo, netVeilMat)
    backVeil.position.set(x + side * (depth - 0.06), backH / 2, 0)
    backVeil.rotation.y = side * Math.PI / 2
    backVeil.renderOrder = 1
    g.add(backVeil)

    /** A flat net panel through four world corners (a, b along the top/bottom edge). */
    const panel = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.Mesh => {
      // a—b top edge, d—c bottom edge
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z], 3))
      const w = a.distanceTo(b)
      const h = Math.max(a.distanceTo(d), b.distanceTo(c))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, h / TILE, w / TILE, h / TILE, w / TILE, 0, 0, 0], 2))
      geo.setIndex([0, 3, 1, 1, 3, 2])
      geo.computeVertexNormals()
      const m = new THREE.Mesh(geo, netMat)
      m.customDepthMaterial = netDepthMat
      return m
    }

    // side nets: trapezoids from the post (full height) back to the back net
    for (const zs of [-1, 1]) {
      const z = zs * (GOAL.halfW - 0.01)
      g.add(panel(wp(0.02, postH, z), wp(depth, backH, z), wp(depth, 0, z), wp(0.02, 0, z)))
    }

    // roof: crossbar → top of the back net
    g.add(panel(wp(0.02, postH, -GOAL.halfW), wp(0.02, postH, GOAL.halfW), wp(depth, backH, GOAL.halfW), wp(depth, backH, -GOAL.halfW)))

    group.add(g)
  }
  buildGoal(1)
  buildGoal(-1)

  // ---------------------------------------------------------------- trees + skyline + petals
  // Trees: tapered trunks with branch forks + faceted per-face-vertex-coloured
  // canopies, merged into a handful of draw calls, with GPU wind sway that also
  // drives the dappled depth shadows + ink outlines. The gust envelope it
  // returns feeds the ambient petals and the skyline blink lights.
  const trees = createTrees(quality)
  group.add(trees.group)

  // Two rings of painted canvas strip-billboards wrap the ground far beyond
  // the 3D mid-ground blocks (fog-tinted by distance, behind the shader dome).
  const skyline = createSkyline(quality)
  group.add(skyline.group)

  // Continuous petal fall from the gulmohar canopies + gust blowers.
  const petals = createAmbientPetals(trees.sites, quality)
  group.add(petals.group)

  // ---------------------------------------------------------------- grass tufts
  const tuftTex = makeTuftTexture()
  const tuftGeo = mergeGeometries([
    new THREE.PlaneGeometry(0.55, 0.36).translate(0, 0.17, 0),
    new THREE.PlaneGeometry(0.55, 0.36).translate(0, 0.17, 0).rotateY(Math.PI / 2),
  ])
  const tuftMat = makeToonMaterial({ map: tuftTex, alphaTest: 0.35, side: THREE.DoubleSide, color: '#c9d6a8' })
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, q.tufts)
  let tuftCount: number = q.tufts
  {
    const m = new THREE.Matrix4()
    const q4 = new THREE.Quaternion()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()
    for (let i = 0; i < q.tufts; i++) {
      const onPitch = rng() < 0.55
      let x: number
      let z: number
      if (onPitch) {
        x = (rng() - 0.5) * (PITCH.L - 2)
        z = (rng() - 0.5) * (PITCH.W - 2)
      } else {
        x = (rng() - 0.5) * (PITCH.wallL + 6)
        z = (rng() - 0.5) * (PITCH.wallW + 6)
        if (Math.abs(x) < PITCH.halfL + 1 && Math.abs(z) < PITCH.halfW + 1) z = Math.sign(z || 1) * (PITCH.halfW + 2)
      }
      pos.set(x, 0, z)
      q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI)
      const k = 0.7 + rng() * 0.8
      scl.set(k, k * (0.8 + rng() * 0.5), k)
      tufts.setMatrixAt(i, m.compose(pos, q4, scl))
    }
    tufts.instanceMatrix.needsUpdate = true
  }
  group.add(tufts)

  // ---------------------------------------------------------------- stands (stepped planks)
  const standMat = makeToonMaterial({ color: '#cfc2a4' })
  const standTrim = makeToonMaterial({ color: '#a5586f' })
  const buildStand = (
    cx: number,
    cz: number,
    len: number,
    rotY: number,
    rows: number,
  ): void => {
    const g = new THREE.Group()
    g.position.set(cx, 0, cz)
    g.rotation.y = rotY
    for (let row = 0; row < rows; row++) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(len, 0.42 + row * 0.42, 0.86),
        row === rows - 1 ? standTrim : standMat,
      )
      step.position.set(0, (0.42 + row * 0.42) / 2, row * -0.88)
      step.castShadow = true
      step.receiveShadow = true
      g.add(step)
    }
    group.add(g)
  }
  // far touchline bank (3 rows) + two goal-end banks (2 rows)
  buildStand(0, PITCH.wallW / 2 + 2.6, PITCH.wallL + 2, Math.PI, 3)
  buildStand(PITCH.wallL / 2 + 3.4, 0, PITCH.wallW - 4, Math.PI / 2, 2)
  buildStand(-PITCH.wallL / 2 - 3.4, 0, PITCH.wallW - 4, -Math.PI / 2, 2)

  // ---------------------------------------------------------------- crowd
  const crowdTex = makeCrowdTexture()
  const crowdMat = new THREE.MeshBasicMaterial({ map: crowdTex, alphaTest: 0.3, side: THREE.DoubleSide })
  const crowdMax = Math.max(QUALITY.high.crowd, q.crowd)
  const crowd = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.62, 0.88), crowdMat, crowdMax)
  let crowdCount: number = q.crowd
  const crowdBase: Float32Array = new Float32Array(crowdMax * 4) // x, y, z, phase
  {
    const m = new THREE.Matrix4()
    const q4 = new THREE.Quaternion()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()
    const col = new THREE.Color()
    // seat plan: 3 rows on the far bank, 2 rows behind each goal
    const banks: Array<{ n: number; place: (t: number, r: () => number) => [number, number, number, number] }> = [
      {
        n: Math.floor(crowdMax * 0.46),
        place: (t, r) => {
          const row = Math.floor(r() * 3)
          const x = (t - 0.5) * (PITCH.wallL - 4) + (r() - 0.5) * 1.3
          const z = PITCH.wallW / 2 + 1.35 + row * 0.88
          const y = 1.05 + 0.42 + row * 0.42 + r() * 0.05
          return [x, y, z, Math.PI + (r() - 0.5) * 0.5]
        },
      },
      {
        n: Math.floor(crowdMax * 0.27),
        place: (t, r) => {
          const row = Math.floor(r() * 2)
          const z = (t - 0.5) * (PITCH.wallW - 8) + (r() - 0.5) * 1.2
          const x = PITCH.wallL / 2 + 2.15 + row * 0.88
          const y = 1.05 + 0.42 + row * 0.42 + r() * 0.05
          return [x, y, z, -Math.PI / 2 + (r() - 0.5) * 0.5]
        },
      },
      {
        n: Math.floor(crowdMax * 0.27),
        place: (t, r) => {
          const row = Math.floor(r() * 2)
          const z = (t - 0.5) * (PITCH.wallW - 8) + (r() - 0.5) * 1.2
          const x = -PITCH.wallL / 2 - 2.15 - row * 0.88
          const y = 1.05 + 0.42 + row * 0.42 + r() * 0.05
          return [x, y, z, Math.PI / 2 + (r() - 0.5) * 0.5]
        },
      },
    ]
    let i = 0
    for (const bank of banks) {
      for (let k = 0; k < bank.n && i < crowdMax; k++, i++) {
        const t = bank.n <= 1 ? 0.5 : k / (bank.n - 1)
        const [x, y, z, rot] = bank.place(t, rng)
        crowdBase[i * 4] = x
        crowdBase[i * 4 + 1] = y
        crowdBase[i * 4 + 2] = z
        crowdBase[i * 4 + 3] = rng() * Math.PI * 2
        pos.set(x, y, z)
        q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot)
        const s = 0.85 + rng() * 0.35
        scl.set(s, s * (0.9 + rng() * 0.25), s)
        crowd.setMatrixAt(i, m.compose(pos, q4, scl))
        const shade = 0.8 + rng() * 0.35
        crowd.setColorAt(i, col.setRGB(shade, shade * (0.94 + rng() * 0.08), shade * 0.92))
      }
    }
    crowd.count = crowdCount
    crowd.instanceMatrix.needsUpdate = true
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true
  }
  group.add(crowd)
  let crowdCheerT = 0

  // ---------------------------------------------------------------- bench + pavilion + water tank
  const woodMat = makeToonMaterial({ color: '#8a6b4a' })
  const bench = new THREE.Group()
  bench.position.set(9, 0, PITCH.wallW / 2 - 1.4)
  bench.rotation.y = Math.PI
  for (let i = 0; i < 3; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.05, 0.16), woodMat)
    slat.position.set(0, 0.45, -0.18 + i * 0.18)
    slat.castShadow = true
    bench.add(slat)
  }
  for (const lx of [-0.85, 0.85]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.5), woodMat)
    leg.position.set(lx, 0.22, 0)
    leg.castShadow = true
    bench.add(leg)
  }
  group.add(bench)

  const pavilion = new THREE.Group()
  pavilion.position.set(-PITCH.wallL / 2 - 7, 0, PITCH.wallW / 2 + 5)
  pavilion.rotation.y = 0.5
  const slab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.35, 3.2), brickMat)
  slab.position.y = 0.17
  slab.castShadow = true
  slab.receiveShadow = true
  pavilion.add(slab)
  for (const [px, pz] of [[-1.9, -1.3], [1.9, -1.3], [-1.9, 1.3], [1.9, 1.3]] as const) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.5, 8), makeToonMaterial({ color: PALETTE.plaster }))
    post.position.set(px, 1.55, pz)
    post.castShadow = true
    pavilion.add(post)
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.14, 3.9), makeToonMaterial({ color: PALETTE.brick }))
  roof.position.y = 2.9
  roof.rotation.x = 0.1
  roof.castShadow = true
  pavilion.add(roof)
  group.add(pavilion)

  const tank = new THREE.Group()
  tank.position.set(PITCH.wallL / 2 + 8, 0, -PITCH.wallW / 2 - 6)
  for (const [px, pz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]] as const) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), metalMat)
    leg.position.set(px, 1.6, pz)
    leg.castShadow = true
    tank.add(leg)
  }
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 1.7, 14), makeToonMaterial({ color: '#9fb3b5' }))
  barrel.position.y = 4.0
  barrel.castShadow = true
  tank.add(barrel)
  group.add(tank)

  // ---------------------------------------------------------------- skyline (decor group)
  const decor = new THREE.Group()
  group.add(decor)

  // painted city blocks with lit windows
  const facadeBase = makeBuildingTexture()
  texDisposables.push(facadeBase)
  const facadeTexSmall = facadeBase.clone()
  facadeTexSmall.repeat.set(1.4, 1.4)
  facadeTexSmall.needsUpdate = true
  const facadeTexWide = facadeBase.clone()
  facadeTexWide.repeat.set(2.6, 2.1)
  facadeTexWide.needsUpdate = true
  texDisposables.push(facadeTexSmall, facadeTexWide)
  const roofMat = makeToonMaterial({ color: '#a4906f' })
  const buildingColors = ['#b7a58c', '#c4b39a', '#a99a85', '#c9b79b', '#b3a288', '#bcb094', '#ab9d86', '#c0ae92']
  const buildingSpots: Array<{ x: number; z: number; w: number; h: number; d: number; rot: number }> = []
  for (let i = 0; i < 22; i++) {
    const ang = (i / 22) * Math.PI * 2 + 0.17 + rng() * 0.22
    const dist = 112 + rng() * 88
    const w = 12 + rng() * 20
    const h = 8 + rng() * 26
    buildingSpots.push({
      x: Math.cos(ang) * dist,
      z: Math.sin(ang) * dist,
      w,
      h,
      d: w * (0.7 + rng() * 0.5),
      rot: rng() * Math.PI,
    })
  }
  // two hero towers on the sun side for a skyline read
  buildingSpots.push({ x: 148, z: 84, w: 22, h: 44, d: 16, rot: 0.4 })
  buildingSpots.push({ x: 176, z: 52, w: 16, h: 34, d: 14, rot: -0.2 })
  for (const b of buildingSpots) {
    const facade = b.w > 18 || b.h > 30 ? facadeTexWide : facadeTexSmall
    const sideMat = makeToonMaterial({ color: buildingColors[Math.floor(rng() * buildingColors.length)], map: facade })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat])
    mesh.position.set(b.x, b.h / 2, b.z)
    mesh.rotation.y = b.rot
    decor.add(mesh)
    if (rng() < 0.5) {
      const wt = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.2, 10), makeToonMaterial({ color: '#a8b3ac' }))
      wt.position.set(b.x + (rng() - 0.5) * b.w * 0.4, b.h + 1.1, b.z + (rng() - 0.5) * b.w * 0.4)
      decor.add(wt)
    }
  }

  // a stepped temple gopuram landmark + a lattice radio mast
  {
    const gopuram = new THREE.Group()
    gopuram.position.set(-150, 0, -110)
    gopuram.rotation.y = 0.7
    const gMat = makeToonMaterial({ color: '#c2a279' })
    let gw = 16
    let gy = 0
    for (let tier = 0; tier < 5; tier++) {
      const th = 7 - tier * 0.9
      const box = new THREE.Mesh(new THREE.BoxGeometry(gw, th, gw * 0.72), gMat)
      box.position.set(0, gy + th / 2, 0)
      gopuram.add(box)
      gy += th
      gw *= 0.78
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 2.2, 3.4, 8), makeToonMaterial({ color: '#d9b06a' }))
    cap.position.set(0, gy + 1.7, 0)
    gopuram.add(cap)
    decor.add(gopuram)
  }
  {
    const mast = new THREE.Group()
    mast.position.set(120, 0, -150)
    const mMat = makeToonMaterial({ color: '#9aa39b' })
    for (const [ox, oz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]] as const) {
      const legGeo = new THREE.CylinderGeometry(0.16, 0.28, 42, 5)
      legGeo.translate(0, 21, 0)
      const legMesh = new THREE.Mesh(legGeo, mMat)
      legMesh.position.set(ox, 0, oz)
      legMesh.rotation.x = -oz * 0.022
      legMesh.rotation.z = ox * 0.022
      mast.add(legMesh)
    }
    for (const hy of [12, 24, 34]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.22, 0.22), mMat)
      brace.position.set(0, hy, 0)
      mast.add(brace)
      const brace2 = brace.clone()
      brace2.rotation.y = Math.PI / 2
      mast.add(brace2)
    }
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 10, 5), mMat)
    antenna.position.y = 46
    mast.add(antenna)
    decor.add(mast)
  }

  // ---------------------------------------------------------------- power poles + sagging wires
  const poleMat = makeToonMaterial({ color: '#6e5b46' })
  const wireMat = new THREE.MeshBasicMaterial({ color: '#4a4038' })
  const wires = new THREE.Group()
  {
    const polePts: Array<{ x: number; z: number; h: number }> = []
    const ring = PITCH.wallL / 2 + 13.5
    const ringZ = PITCH.wallW / 2 + 11
    for (let i = 0; i < 10; i++) {
      const t = (i / 10) * Math.PI * 2 + 0.31
      // rounded-rect ring of poles around the ground
      const cx = Math.cos(t)
      const cz = Math.sin(t)
      const ax = Math.abs(cx)
      const az = Math.abs(cz)
      const x = (ax > az ? Math.sign(cx) * ring : cx * ring * 0.72)
      const z = (ax > az ? cz * ringZ * 0.72 : Math.sign(cz) * ringZ)
      polePts.push({ x, z, h: 7.4 + rng() * 0.8 })
    }
    for (const p of polePts) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, p.h, 6), poleMat)
      pole.position.set(p.x, p.h / 2, p.z)
      pole.castShadow = true
      wires.add(pole)
      const cross = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.1), poleMat)
      cross.position.set(p.x, p.h - 0.5, p.z)
      wires.add(cross)
    }
    // two sagging wires per span (catenary-ish quadratic bezier), offset to the crossarm ends
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3())
    for (let i = 0; i < polePts.length; i++) {
      const a = polePts[i]
      const b = polePts[(i + 1) % polePts.length]
      const mx = (a.x + b.x) / 2
      const mz = (a.z + b.z) / 2
      const sag = 0.85 + rng() * 0.5
      const spanX = b.x - a.x
      const spanZ = b.z - a.z
      const sl = Math.hypot(spanX, spanZ) || 1
      const px = -spanZ / sl
      const pz = spanX / sl
      for (const off of [-0.75, 0.75]) {
        curve.v0.set(a.x + px * off, a.h - 0.5, a.z + pz * off)
        curve.v1.set(mx, (a.h + b.h) / 2 - sag, mz)
        curve.v2.set(b.x + px * off, b.h - 0.5, b.z + pz * off)
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.018, 4, false), wireMat)
        wires.add(tube)
      }
    }
  }
  decor.add(wires)

  // ---------------------------------------------------------------- painted hoardings
  {
    const hoardingColors: Array<[string, string]> = [
      [PALETTE.saffron, PALETTE.saffronDeep],
      [PALETTE.teal, PALETTE.tealDeep],
      ['#c9b06a', '#a8853d'],
      ['#b98a8f', '#93626a'],
    ]
    const spots: Array<{ x: number; z: number; rot: number }> = [
      { x: 0, z: -PITCH.wallW / 2 - 2.1, rot: 0 },
      { x: -14, z: -PITCH.wallW / 2 - 2.1, rot: 0.04 },
      { x: 15, z: -PITCH.wallW / 2 - 2.1, rot: -0.03 },
      { x: -28, z: -PITCH.wallW / 2 - 2.1, rot: 0.06 },
      { x: 29, z: -PITCH.wallW / 2 - 2.1, rot: -0.06 },
    ]
    let hi = 0
    for (const s of spots) {
      const [c1, c2] = hoardingColors[hi % hoardingColors.length]
      hi++
      const tex = makeHoardingTexture(c1, c2)
      texDisposables.push(tex)
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(5.4, 1.5),
        makeToonMaterial({ map: tex, side: THREE.DoubleSide }),
      )
      board.position.set(s.x, 1.85, s.z)
      board.rotation.y = Math.PI + s.rot
      board.castShadow = true
      decor.add(board)
      for (const lx of [-2.4, 2.4]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), poleMat)
        leg.position.set(s.x + Math.cos(s.rot) * lx, 0.55, s.z)
        decor.add(leg)
      }
    }
  }

  // ---------------------------------------------------------------- circling kites (birds)
  const birdMat = new THREE.MeshBasicMaterial({ color: '#4a3f38' })
  const birds: Array<{ group: THREE.Group; wings: THREE.Mesh[]; r: number; h: number; speed: number; a: number; flap: number }> = []
  for (let i = 0; i < 3; i++) {
    const bird = new THREE.Group()
    const wings: THREE.Mesh[] = []
    for (const side of [-1, 1]) {
      const wingGeo = new THREE.BoxGeometry(0.62, 0.02, 0.2)
      wingGeo.translate(side * 0.31, 0, 0) // hinge at the body, extends outward
      const wing = new THREE.Mesh(wingGeo, birdMat)
      wings.push(wing)
      bird.add(wing)
    }
    group.add(bird)
    birds.push({
      group: bird,
      wings,
      r: 34 + i * 9,
      h: 17 + i * 6,
      speed: 0.1 + i * 0.035,
      a: rng() * Math.PI * 2,
      flap: 2 + rng() * 2,
    })
  }

  // ---------------------------------------------------------------- dust motes
  let motes: THREE.Points | null = null
  let moteVel: Float32Array | null = null
  if (q.motes) {
    const N = 130
    const positions = new Float32Array(N * 3)
    moteVel = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      positions[i * 3] = (rng() - 0.5) * 56
      positions[i * 3 + 1] = 0.25 + rng() * 3.2
      positions[i * 3 + 2] = (rng() - 0.5) * 40
      moteVel[i * 3] = (rng() - 0.5) * 0.14
      moteVel[i * 3 + 1] = (rng() - 0.5) * 0.05
      moteVel[i * 3 + 2] = (rng() - 0.5) * 0.14
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const moteMat = new THREE.PointsMaterial({
      map: makeDotTexture(),
      color: '#ffe9c0',
      size: 0.055,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
    })
    motes = new THREE.Points(geo, moteMat)
    motes.renderOrder = 5
    group.add(motes)
  }

  // ---------------------------------------------------------------- animation
  const crowdM = new THREE.Matrix4()
  const crowdQ = new THREE.Quaternion()
  const crowdP = new THREE.Vector3()
  const crowdS = new THREE.Vector3(1, 1, 1)

  const step = (dt: number, elapsed: number, camX: number, camZ: number) => {
    // sky: cloud drift + bird flock, dome follows the camera
    sky.update(dt, elapsed, camX, camZ)
    if (sunLight) sky.setSunDir(sunScratch.copy(sunLight.position).sub(sunLight.target.position))

    // birds
    for (const b of birds) {
      b.a += b.speed * dt
      const x = Math.cos(b.a) * b.r
      const z = Math.sin(b.a) * b.r
      b.group.position.set(x, b.h + Math.sin(b.a * 2.3) * 1.8, z)
      b.group.rotation.y = -b.a - Math.PI / 2
      const flap = Math.sin(elapsed * b.flap) * 0.55
      b.wings[0].rotation.z = flap
      b.wings[1].rotation.z = -flap
    }

    // motes
    if (motes && moteVel) {
      const pos = motes.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      for (let i = 0; i < pos.count; i++) {
        arr[i * 3] += moteVel[i * 3] * dt
        arr[i * 3 + 1] += moteVel[i * 3 + 1] * dt + Math.sin(elapsed * 0.7 + i) * 0.0004
        arr[i * 3 + 2] += moteVel[i * 3 + 2] * dt
        if (arr[i * 3 + 1] < 0.15) arr[i * 3 + 1] = 3.4
        if (arr[i * 3 + 1] > 3.5) arr[i * 3 + 1] = 0.2
        if (Math.abs(arr[i * 3]) > 29) arr[i * 3] *= -0.98
        if (Math.abs(arr[i * 3 + 2]) > 21) arr[i * 3 + 2] *= -0.98
      }
      pos.needsUpdate = true
    }

    // trees: GPU wind sway + gust envelope (feeds petals + skyline)
    const gust = trees.update(dt, elapsed)
    skyline.update(dt, elapsed, gust)
    petals.update(dt, elapsed, gust, camX, camZ)

    // crowd idle + cheer
    if (crowdCheerT > 0) crowdCheerT = Math.max(0, crowdCheerT - dt)
    for (let i = 0; i < crowdCount; i++) {
      const phase = crowdBase[i * 4 + 3]
      let y = crowdBase[i * 4 + 1] + Math.sin(elapsed * 1.3 + phase * 3.1) * 0.012
      if (crowdCheerT > 0) {
        const jump = Math.max(0, Math.sin(elapsed * 9 + phase * 4.0))
        y += jump * 0.26 * Math.min(1, crowdCheerT * 1.4)
      }
      crowdP.set(crowdBase[i * 4], y, crowdBase[i * 4 + 2])
      crowdQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + Math.sin(phase) * 0.2)
      crowd.setMatrixAt(i, crowdM.compose(crowdP, crowdQ, crowdS))
    }
    crowd.instanceMatrix.needsUpdate = true

    // net wobble decay
    for (const n of nets) {
      if (n.wobble > 0) {
        n.wobble = Math.max(0, n.wobble - dt * 1.4)
        const s = Math.sin(elapsed * 26 + n.phase) * 0.09 * n.wobble
        n.mesh.scale.set(1 + s, 1 - s * 0.6, 1)
        n.mesh.rotation.y = n.phase * Math.PI / 2 + s * 0.4
      }
    }
  }

  return {
    group,
    step,
    cheerCrowd() {
      crowdCheerT = 2.1
    },
    wobbleNet(goalX: number, strength: number) {
      let best: (typeof nets)[number] | null = null
      let bestD = Infinity
      for (const n of nets) {
        const d = Math.abs(n.mesh.position.x - goalX)
        if (d < bestD) {
          bestD = d
          best = n
        }
      }
      if (best) best.wobble = Math.max(best.wobble, strength)
    },
    setDetail(on: boolean) {
      decor.visible = on
      trees.setDetail(on)
      skyline.setDetail(on)
      if (motes) motes.visible = on
    },
    setCounts(t: number, c: number) {
      tuftCount = Math.min(t, q.tufts)
      tufts.count = tuftCount
      crowdCount = Math.min(c, crowdMax)
      crowd.count = crowdCount
    },
    setQuality(newQ: Quality) {
      sky.setQuality(newQ)
      petals.setQuality(newQ)
    },
    dispose() {
      scene.remove(group)
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
      })
      for (const d of disposables) d.dispose()
      netMat.dispose()
      standMat.dispose()
      standTrim.dispose()
      crowdMat.dispose()
      birdMat.dispose()
      metalMat.dispose()
      brickMat.dispose()
      woodMat.dispose()
      poleMat.dispose()
      wireMat.dispose()
      roofMat.dispose()
      for (const t of texDisposables) t.dispose()
      dustTex.dispose()
      apronTex.dispose()
      pitchTex.dispose()
      wallTex.dispose()
      sky.dispose()
      netTex.dispose()
      brickTex.dispose()
      tuftTex.dispose()
      crowdTex.dispose()
      if (motes) {
        motes.geometry.dispose()
        ;(motes.material as THREE.PointsMaterial).map?.dispose()
        ;(motes.material as THREE.Material).dispose()
      }
      trees.dispose()
      skyline.dispose()
      petals.dispose()
    },
  }
}
