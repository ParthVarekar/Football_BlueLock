/**
 * Inverted-hull outlines for hero objects (ball, goalposts, nearby trees,
 * view-model legs, other players).
 *
 * A back-faced shell is pushed along SMOOTHED normals; the push happens in
 * view space scaled by `w` (clip-space), giving a constant PIXEL width at any
 * distance — the hand-inked look that screen-space techniques fake.
 */
import * as THREE from 'three'

/** Per-frame shared uniforms, refreshed by the Game loop. */
export const OUTLINE_UNIFORMS = {
  uOutlinePx: { value: 2.6 },
  uOutlineRes: { value: new THREE.Vector2(1920, 1080) },
  uOutlineProj: { value: new THREE.Vector2(1, 1) }, // projectionMatrix[0][0], [1][1]
}

/** Vertex prelude for sway-aware outline hulls (exported for trees.ts). */
export const OUTLINE_VERT_PARS = /* glsl */ `
attribute vec3 aOutlineNormal;
uniform float uOutlinePx;
uniform vec2 uOutlineRes;
uniform vec2 uOutlineProj;
`

/** Clip-space hull projection replacing <project_vertex> (exported for trees.ts). */
export const OUTLINE_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
        mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
{
        vec3 nView = normalMatrix * aOutlineNormal;
        vec2 dir = nView.xy;
        float len = length( dir );
        if ( len > 1e-5 ) {
                dir /= len;
                vec2 px = uOutlinePx * 2.0 / uOutlineRes;
                float invz = max( 0.05, -mvPosition.z );
                mvPosition.x += dir.x * px.x * invz / uOutlineProj.x;
                mvPosition.y += dir.y * px.y * invz / uOutlineProj.y;
        }
}
gl_Position = projectionMatrix * mvPosition;
`

const materialCache = new Map<string, THREE.MeshBasicMaterial>()

function getOutlineMaterial(color: string, widthPx: number): THREE.MeshBasicMaterial {
  const key = `${color}|${widthPx}`
  const cached = materialCache.get(key)
  if (cached) return cached
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    side: THREE.BackSide,
    fog: true,
  })
  mat.onBeforeCompile = (shader) => {
    // width comes from the SHARED uniform — the whole ink layer can be
    // re-tuned at runtime by the graphics settings
    shader.uniforms.uOutlinePx = OUTLINE_UNIFORMS.uOutlinePx
    shader.uniforms.uOutlineRes = OUTLINE_UNIFORMS.uOutlineRes
    shader.uniforms.uOutlineProj = OUTLINE_UNIFORMS.uOutlineProj
    shader.vertexShader = OUTLINE_VERT_PARS + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', OUTLINE_PROJECT)
  }
  mat.customProgramCacheKey = () => `gg-outline-${widthPx}`
  materialCache.set(key, mat)
  return mat
}

/** Area-weighted per-vertex smoothed normals (for crack-free hulls on boxes). */
function computeSmoothedNormals(geometry: THREE.BufferGeometry): Float32Array {
  const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!normalAttr) return new Float32Array(geometry.getAttribute('position').count * 3)
  const count = normalAttr.count
  const out = new Float32Array(count * 3)
  const index = geometry.index
  if (!index) {
    out.set(normalAttr.array as ArrayLike<number>)
    return out
  }
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const cb = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const fn = new THREE.Vector3()
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i)
    const ib = index.getX(i + 1)
    const ic = index.getX(i + 2)
    a.fromBufferAttribute(pos, ia)
    b.fromBufferAttribute(pos, ib)
    c.fromBufferAttribute(pos, ic)
    cb.subVectors(c, b)
    ab.subVectors(a, b)
    fn.crossVectors(cb, ab)
    for (const vi of [ia, ib, ic]) {
      out[vi * 3] += fn.x
      out[vi * 3 + 1] += fn.y
      out[vi * 3 + 2] += fn.z
    }
  }
  for (let i = 0; i < count; i++) {
    const x = out[i * 3]
    const y = out[i * 3 + 1]
    const z = out[i * 3 + 2]
    const l = Math.hypot(x, y, z) || 1
    out[i * 3] = x / l
    out[i * 3 + 1] = y / l
    out[i * 3 + 2] = z / l
  }
  return out
}

export interface OutlineOpts {
  /** Ink width in CSS pixels; <= 0 skips the shell entirely (weak mobiles). */
  widthPx?: number
  color?: string
}

/**
 * Adds an inverted-hull outline shell as a child of `mesh`.
 * The shell shares the source geometry (an extra smoothed-normal attribute is
 * attached once) and never casts or receives shadows.
 */
export function addOutline(mesh: THREE.Mesh, opts: OutlineOpts = {}): THREE.Mesh | null {
  const widthPx = opts.widthPx ?? OUTLINE_UNIFORMS.uOutlinePx.value
  if (widthPx <= 0) return null
  const geo = mesh.geometry
  if (!geo.getAttribute('aOutlineNormal')) {
    geo.setAttribute('aOutlineNormal', new THREE.BufferAttribute(computeSmoothedNormals(geo), 3))
  }
  const shell = new THREE.Mesh(geo, getOutlineMaterial(opts.color ?? '#3a2e28', widthPx))
  shell.castShadow = false
  shell.receiveShadow = false
  shell.renderOrder = 2
  mesh.add(shell)
  return shell
}

/** Call once per frame from the Game loop. */
export function updateOutlineFrame(camera: THREE.PerspectiveCamera, width: number, height: number): void {
  OUTLINE_UNIFORMS.uOutlineRes.value.set(width, height)
  const p = camera.projectionMatrix.elements
  OUTLINE_UNIFORMS.uOutlineProj.value.set(p[0], p[5])
}

/** Re-tune the ink width at runtime (graphics settings). 0 hides the ink. */
export function setOutlineWidth(px: number): void {
  OUTLINE_UNIFORMS.uOutlinePx.value = Math.max(0, px)
}
