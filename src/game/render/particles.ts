/**
 * Painterly particles: grass kick-ups, dust puffs, and gulmohar petal confetti.
 * One custom-shader Points pool for dots + one InstancedMesh pool for petals.
 */
import * as THREE from 'three'
import { makeDotTexture, makePetalTexture } from './textures'

const DOTS = 320
const PETALS = 140

const DOT_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
	vAlpha = aAlpha;
	vColor = aColor;
	vec4 mv = modelViewMatrix * vec4( position, 1.0 );
	gl_PointSize = aSize * 340.0 / max( 0.5, -mv.z );
	gl_Position = projectionMatrix * mv;
}
`

const DOT_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
	vec4 t = texture2D( uMap, gl_PointCoord );
	float a = t.a * vAlpha;
	if ( a < 0.012 ) discard;
	gl_FragColor = vec4( vColor, a );
}
`

interface Dot {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  life: number
  maxLife: number
  size: number
  r: number
  g: number
  b: number
  gravity: number
}

interface Petal {
  active: boolean
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  rot: number
  rotV: number
  tilt: number
  life: number
  maxLife: number
  phase: number
}

export class Particles {
  private readonly dotTex = makeDotTexture()
  private readonly petalTex = makePetalTexture()
  private readonly points: THREE.Points
  private readonly dotGeo = new THREE.BufferGeometry()
  private readonly dots: Dot[] = []
  private readonly dotPos = new Float32Array(DOTS * 3)
  private readonly dotSize = new Float32Array(DOTS)
  private readonly dotAlpha = new Float32Array(DOTS)
  private readonly dotColor = new Float32Array(DOTS * 3)

  private readonly petalMesh: THREE.InstancedMesh
  private readonly petals: Petal[] = []
  private readonly petalM = new THREE.Matrix4()
  private readonly petalQ = new THREE.Quaternion()
  private readonly petalE = new THREE.Euler()
  private readonly petalP = new THREE.Vector3()
  private readonly petalS = new THREE.Vector3(1, 1, 1)

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < DOTS; i++) {
      this.dots.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0.06, r: 1, g: 1, b: 1, gravity: -9 })
    }
    this.dotGeo.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3))
    this.dotGeo.setAttribute('aSize', new THREE.BufferAttribute(this.dotSize, 1))
    this.dotGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.dotAlpha, 1))
    this.dotGeo.setAttribute('aColor', new THREE.BufferAttribute(this.dotColor, 3))
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.dotTex } },
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      transparent: true,
      depthWrite: false,
    })
    this.points = new THREE.Points(this.dotGeo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    scene.add(this.points)

    const petalMat = new THREE.MeshBasicMaterial({
      map: this.petalTex,
      alphaTest: 0.28,
      side: THREE.DoubleSide,
    })
    this.petalMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.085, 0.055), petalMat, PETALS)
    this.petalMesh.frustumCulled = false
    for (let i = 0; i < PETALS; i++) {
      this.petals.push({ active: false, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, rot: 0, rotV: 0, tilt: 0, life: 0, maxLife: 1, phase: 0 })
      this.petalM.makeScale(0, 0, 0)
      this.petalMesh.setMatrixAt(i, this.petalM)
    }
    scene.add(this.petalMesh)
  }

  private spawnDot(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: [number, number, number], gravity: number): void {
    const d = this.dots.find((c) => c.life <= 0)
    if (!d) return
    d.x = x
    d.y = y
    d.z = z
    d.vx = vx
    d.vy = vy
    d.vz = vz
    d.life = life
    d.maxLife = life
    d.size = size
    d.r = color[0]
    d.g = color[1]
    d.b = color[2]
    d.gravity = gravity
  }

  /** Grass torn up by a kick, cut, or hard stop. */
  grassBurst(x: number, z: number, n = 10, dx = 0, dz = 0, power = 1): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = (0.6 + Math.random() * 1.7) * power
      this.spawnDot(
        x + (Math.random() - 0.5) * 0.2,
        0.04 + Math.random() * 0.1,
        z + (Math.random() - 0.5) * 0.2,
        Math.cos(a) * s * 0.8 + dx * s * 0.6,
        (1.1 + Math.random() * 1.9) * power,
        Math.sin(a) * s * 0.8 + dz * s * 0.6,
        0.45 + Math.random() * 0.3,
        0.05 + Math.random() * 0.05,
        Math.random() < 0.7 ? [0.36, 0.48, 0.22] : [0.52, 0.44, 0.24],
        -9.5,
      )
    }
  }

  /** Little dust puff for sharp stops and landings. */
  dustPuff(x: number, z: number, power = 1): void {
    for (let i = 0; i < Math.min(10, 4 + power * 8); i++) {
      const a = Math.random() * Math.PI * 2
      const s = 0.3 + Math.random() * 0.8
      this.spawnDot(
        x + (Math.random() - 0.5) * 0.3,
        0.06,
        z + (Math.random() - 0.5) * 0.3,
        Math.cos(a) * s,
        0.4 + Math.random() * 0.7,
        Math.sin(a) * s,
        0.5 + Math.random() * 0.4,
        0.09 + Math.random() * 0.07,
        [0.78, 0.68, 0.5],
        -1.2,
      )
    }
  }

  private spawnPetal(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): void {
    const p = this.petals.find((c) => !c.active)
    if (!p) return
    p.active = true
    p.x = x
    p.y = y
    p.z = z
    p.vx = vx
    p.vy = vy
    p.vz = vz
    p.rot = Math.random() * Math.PI * 2
    p.rotV = (Math.random() - 0.5) * 9
    p.tilt = (Math.random() - 0.5) * 2.4
    p.life = life
    p.maxLife = life
    p.phase = Math.random() * Math.PI * 2
  }

  /** Confetti burst from a goal mouth. */
  petalBurst(x: number, y: number, z: number, n = 30): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 0.8 + Math.random() * 2.4
      this.spawnPetal(
        x + (Math.random() - 0.5) * 1.2,
        y + Math.random() * 1.4,
        z + (Math.random() - 0.5) * 1.4,
        Math.cos(a) * s,
        1.2 + Math.random() * 2.6,
        Math.sin(a) * s,
        2.2 + Math.random() * 1.6,
      )
    }
  }

  /** Slow celebratory rain around a point. */
  petalRain(cx: number, cz: number, radius: number, n = 34): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * radius
      this.spawnPetal(
        cx + Math.cos(a) * r,
        4.5 + Math.random() * 3,
        cz + Math.sin(a) * r,
        (Math.random() - 0.5) * 0.5,
        -0.55 - Math.random() * 0.5,
        (Math.random() - 0.5) * 0.5,
        4 + Math.random() * 2.5,
      )
    }
  }

  step(dt: number, elapsed: number): void {
    for (let i = 0; i < DOTS; i++) {
      const d = this.dots[i]
      if (d.life > 0) {
        d.life -= dt
        d.vy += d.gravity * dt
        d.x += d.vx * dt
        d.y += d.vy * dt
        d.z += d.vz * dt
        if (d.y < 0.02) {
          d.y = 0.02
          d.vy *= -0.25
          d.vx *= 0.6
          d.vz *= 0.6
        }
        const t = Math.max(0, d.life / d.maxLife)
        this.dotPos[i * 3] = d.x
        this.dotPos[i * 3 + 1] = d.y
        this.dotPos[i * 3 + 2] = d.z
        this.dotSize[i] = d.size * (0.5 + t * 0.5)
        this.dotAlpha[i] = Math.min(1, t * 1.6)
        this.dotColor[i * 3] = d.r
        this.dotColor[i * 3 + 1] = d.g
        this.dotColor[i * 3 + 2] = d.b
      } else {
        this.dotAlpha[i] = 0
        this.dotPos[i * 3 + 1] = -99
      }
    }
    this.dotGeo.attributes.position.needsUpdate = true
    this.dotGeo.attributes.aSize.needsUpdate = true
    this.dotGeo.attributes.aAlpha.needsUpdate = true
    this.dotGeo.attributes.aColor.needsUpdate = true

    let anyPetal = false
    for (let i = 0; i < PETALS; i++) {
      const p = this.petals[i]
      if (p.active) {
        anyPetal = true
        p.life -= dt
        if (p.life <= 0 || p.y < 0.015) {
          p.active = false
          this.petalM.makeScale(0, 0, 0)
          this.petalMesh.setMatrixAt(i, this.petalM)
          continue
        }
        p.vy = Math.max(p.vy - 2.4 * dt, -1.35)
        p.x += (p.vx + Math.sin(elapsed * 2.1 + p.phase) * 0.45) * dt
        p.y += p.vy * dt
        p.z += (p.vz + Math.cos(elapsed * 1.7 + p.phase) * 0.4) * dt
        p.rot += p.rotV * dt
        this.petalE.set(p.tilt, p.rot, Math.sin(elapsed * 3 + p.phase) * 0.6)
        this.petalQ.setFromEuler(this.petalE)
        this.petalP.set(p.x, p.y, p.z)
        this.petalMesh.setMatrixAt(i, this.petalM.compose(this.petalP, this.petalQ, this.petalS))
      }
    }
    if (anyPetal) this.petalMesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.points.removeFromParent()
    this.dotGeo.dispose()
    ;(this.points.material as THREE.ShaderMaterial).dispose()
    this.petalMesh.removeFromParent()
    this.petalMesh.geometry.dispose()
    ;(this.petalMesh.material as THREE.MeshBasicMaterial).dispose()
    this.dotTex.dispose()
    this.petalTex.dispose()
  }
}
