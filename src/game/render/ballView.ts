/** The ball: paneled sphere with roll, squash, and a faint motion trail. */
import * as THREE from 'three'
import { BALL, type Quality, QUALITY } from '../core/constants'
import { makeToonMaterial } from './toon'
import { addOutline } from './outline'
import { makeBallTexture, makeDotTexture } from './textures'

const TRAIL = 11

export class BallView {
  readonly group = new THREE.Group()
  private readonly mesh: THREE.Mesh
  private readonly trail: THREE.Sprite[] = []
  private readonly history: THREE.Vector3[] = []
  private readonly dotTex = makeDotTexture()
  private squash = 0
  private squashAxis = new THREE.Vector3(0, 1, 0)
  private readonly rollAxis = new THREE.Vector3()

  constructor(quality: Quality) {
    const q = QUALITY[quality]
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.r, 22, 16),
      makeToonMaterial({ color: '#ffffff', map: makeBallTexture() }),
    )
    this.mesh.castShadow = true
    this.group.add(this.mesh)
    addOutline(this.mesh, { widthPx: q.outlinePx })

    for (let i = 0; i < TRAIL; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.dotTex,
        color: '#fff2dc',
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const s = new THREE.Sprite(mat)
      s.scale.setScalar(0.16 - i * 0.008)
      s.renderOrder = 4
      this.group.add(s)
      this.trail.push(s)
    }
    for (let i = 0; i < TRAIL; i++) this.history.push(new THREE.Vector3())
  }

  /** Call with the ball's rendered position each frame. */
  update(dt: number, pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.group.position.copy(pos)

    // rolling
    const planar = Math.hypot(vel.x, vel.z)
    if (planar > 0.02 && pos.y < BALL.r * 1.6) {
      this.rollAxis.set(vel.z, 0, -vel.x).normalize()
      const q = new THREE.Quaternion().setFromAxisAngle(this.rollAxis, (planar / BALL.r) * dt * 0.92)
      this.mesh.quaternion.premultiply(q)
    }

    // squash spring
    if (this.squash > 0) this.squash = Math.max(0, this.squash - dt * 7)
    const s = this.squash
    const squashDot = Math.abs(this.squashAxis.y)
    this.mesh.scale.set(1 + s * 0.16 * (1 - squashDot * 0.4), 1 - s * 0.3 * squashDot, 1 + s * 0.16 * (1 - squashDot * 0.4))

    // trail from position history
    this.history[0].copy(pos)
    for (let i = this.history.length - 1; i > 0; i--) this.history[i].copy(this.history[i - 1])
    const strength = THREE.MathUtils.clamp((planar - 7.5) / 12, 0, 1) * 0.34
    for (let i = 0; i < this.trail.length; i++) {
      const h = this.history[Math.min(this.history.length - 1, Math.ceil((i + 1) * 0.9))]
      this.trail[i].position.copy(h)
      this.trail[i].material.opacity = strength * (1 - i / this.trail.length)
    }
  }

  /** Trigger an impact squash. strength 0..1, axis = impact normal (world). */
  impact(strength: number, axis: THREE.Vector3): void {
    this.squash = Math.max(this.squash, Math.min(1, strength))
    this.squashAxis.copy(axis).normalize()
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    const mat = this.mesh.material as THREE.MeshToonMaterial
    mat.map?.dispose()
    mat.dispose()
    for (const s of this.trail) s.material.dispose()
    this.dotTex.dispose()
  }
}
